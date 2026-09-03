// Failure-mode tests for the harness server that need their own process:
// a heartbeat that cannot fit in a timer, an SSE client that never drains, a
// workspace whose data directory stops accepting writes, and imports that
// arrive at the same instant. Each of these either changes boot-time
// configuration or briefly makes the workspace unusable, so none of them can
// share the long-lived server in index.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { HAS_POSIX_FILE_MODES } from "./testing/platform.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 29000 + Math.floor(Math.random() * 9_000);
const BASE = `http://127.0.0.1:${PORT}`;
const WEBHOOK_PORT = PORT + 1;
/** Small enough that a stalled reader crosses it in a handful of frames. */
const SSE_CLIENT_BUFFER_BYTES = 64_000;

let child: ChildProcess;
let home: string;
let dataDir: string;
let fakeClaudeDump: string;
let stderr = "";

const testRequestBodySchema = z.unknown();
type TestRequestBody = z.input<typeof testRequestBodySchema>;

const api = async (
  method: string,
  path: string,
  body?: TestRequestBody,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: any }> => {
  const headers = method === "GET" || extraHeaders["content-type"] !== undefined
    ? extraHeaders
    : { ...extraHeaders, "content-type": "application/json" };
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

/** A raw SSE connection that is never read from: the frames the server writes
 * for it pile up in its socket instead of being consumed. */
const stalledEventStream = () => {
  const socket = connect(PORT, "127.0.0.1", () => {
    socket.write(
      `GET /api/events?screens=off HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\n`
      + `Origin: ${BASE}\r\nAccept: text/event-stream\r\n\r\n`,
    );
  });
  let closed = false;
  socket.on("close", () => (closed = true));
  socket.on("error", () => (closed = true));
  return { socket, isClosed: () => closed };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "hry-resilience-test-"));
  dataDir = join(home, ".helmryth");
  fakeClaudeDump = join(home, "fake-claude-dump.json");
  mkdirSync(dataDir, { recursive: true });
  // A workspace as it can already exist on disk today: a room whose roster
  // still names an operator that was deleted before rosters were cleaned up,
  // and whose lead is that missing operator. Nothing cleans this up after the
  // fact — the operator it points at is already gone — so the room has to
  // answer for itself.
  writeFileSync(
    join(dataDir, "bots.json"),
    JSON.stringify([{
      id: "legacy-survivor",
      threadId: "legacy-survivor-thread",
      name: "Legacy survivor",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      resumeCursors: {},
      createdAt: 1,
      tasks: [{ threadId: "legacy-survivor-thread", title: "Untitled run", createdAt: 1, resumeCursors: {} }],
    }]),
  );
  writeFileSync(
    join(dataDir, "groups.json"),
    JSON.stringify([{
      id: "legacy-room",
      threadId: "legacy-room-thread",
      name: "Room from an older install",
      memberIds: ["legacy-survivor", "legacy-departed"],
      defaultResponder: { kind: "member", botId: "legacy-departed" },
      bulletin: "",
      unread: false,
      createdAt: 1,
      setupCompletedAt: 1,
      setupSkippedAt: null,
      tasks: [{ threadId: "legacy-room-thread", title: "Untitled run", createdAt: 1 }],
    }]),
  );
  writeFileSync(
    join(dataDir, "config.json"),
    JSON.stringify({
      instances: {
        claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLAUDE_CLI } },
      },
    }),
  );

  const childEnvironment: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    HELMRYTH_PORT: String(PORT),
    HELMRYTH_WEBHOOK_PORT: String(WEBHOOK_PORT),
    HELMRYTH_UI_ORIGIN: BASE,
    // Larger than a 32-bit signed integer on purpose: setInterval silently
    // truncates this to 1ms, and the clamp is what stops the ping flood.
    HELMRYTH_SSE_HEARTBEAT_MS: "3000000000",
    HELMRYTH_SSE_CLIENT_BUFFER_BYTES: String(SSE_CLIENT_BUFFER_BYTES),
    FAKE_CLAUDE_MODE: "hang",
    FAKE_CLAUDE_DUMP: fakeClaudeDump,
  };
  if (process.env.PATH) childEnvironment.PATH = process.env.PATH;
  if (process.env.SystemRoot) childEnvironment.SystemRoot = process.env.SystemRoot;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}, 30_000);

afterAll(async () => {
  // Whatever a test did to the data directory, the cleanup has to be able to
  // remove it.
  try {
    chmodSync(dataDir, 0o700);
  } catch {
    /* already gone or already writable */
  }
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("harness resilience", () => {
  it("clamps an SSE heartbeat that cannot fit in a timer", async () => {
    // setInterval keeps its delay in a 32-bit signed integer, so a heartbeat
    // above 2^31-1 became a ~1ms interval and flooded every connected client
    // with pings — thousands of frames in the window below.
    const { socket } = stalledEventStream();
    let received = "";
    socket.on("data", (chunk) => (received += chunk.toString()));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    socket.destroy();
    expect(received).toContain(`"kind":"hello"`);
    expect(received.split(`"kind":"ping"`).length - 1).toBe(0);
  });

  it("drops an SSE client that never drains instead of buffering for it forever", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Fan-out source" })).body.bot;
    const stalled = stalledEventStream();
    // A healthy client that keeps reading, to prove eviction is about
    // backpressure and not about disconnecting whoever is listening.
    const healthy = stalledEventStream();
    let healthyBytes = 0;
    healthy.socket.on("data", (chunk) => (healthyBytes += chunk.length));
    await new Promise((resolve) => setTimeout(resolve, 250));

    const description = "x".repeat(4_000);
    // res.write() queues in memory when the socket will not drain, and Node
    // queues without limit: before the cap, this loop grew the server by every
    // frame it produced and the stalled client was never let go. Enough
    // frames here to fill the socket buffers and then cross the cap.
    //
    // writableLength only begins climbing once the KERNEL send buffer is
    // already full, and Linux auto-tunes those into the megabytes where macOS
    // does not. 600 frames overflowed one kernel and left writableLength at
    // zero on the other, so the eviction under test never fired on Linux CI
    // while passing on every developer laptop. The count is sized to clear the
    // larger buffer, not the smaller one.
    for (let write = 0; write < 5_000; write++) {
      await api("PATCH", `/api/bots/${bot.id}`, { description: write % 2 ? description : description.slice(1) });
    }
    // A paused socket does not notice the server hanging up until it reads,
    // so resume it: with the cap it reaches the end of the stream, and
    // without it the connection is still open with nothing more to say.
    stalled.socket.resume();
    await expect.poll(() => stalled.isClosed(), { timeout: 10_000 }).toBe(true);

    const healthyBytesAtEviction = healthyBytes;
    await api("PATCH", `/api/bots/${bot.id}`, { description: "still streaming" });
    await expect.poll(() => healthyBytes, { timeout: 5_000 }).toBeGreaterThan(healthyBytesAtEviction);
    healthy.socket.destroy();
    await api("DELETE", `/api/bots/${bot.id}`);
  }, 240_000);

  it("says so when a crew's lead no longer exists instead of dropping the message", async () => {
    // The room still has a surviving member, so nothing reported "everyone is
    // archived", and the missing lead was not archived either — the send was
    // accepted with a 202 and then discarded with no answer and no error.
    expect((await api("POST", "/api/groups/legacy-room/messages", { text: "anyone home?" })).status).toBe(202);
    const room = (await api("GET", "/api/bots?messages=20")).body.groups
      .find((candidate: { id: string }) => candidate.id === "legacy-room");
    expect(room.messages.at(-1)).toMatchObject({
      kind: "activity",
      tool: {
        name: "This crew's default responder no longer exists. Choose another default responder or mention a crew member.",
        ok: false,
      },
    });
    // And the dangling id must not read as a valid lead either: membership
    // alone used to be the whole check, so a client could re-arm an operator
    // that does not exist while a never-issued id was refused.
    expect((await api("PATCH", "/api/groups/legacy-room", {
      defaultResponder: { kind: "member", botId: "legacy-departed" },
    })).status).toBe(400);
    expect((await api("PATCH", "/api/groups/legacy-room", {
      defaultResponder: { kind: "member", botId: "legacy-survivor" },
    })).status).toBe(200);
  });

  it("reports an unconfigured connected-apps setup instead of a server fault", async () => {
    // No conduit and no API key is the ordinary state of a workspace that
    // never connected an app. relayMcp throws for it, and the catch-all
    // turned that into a 500.
    const bot = (await api("POST", "/api/bots", {
      name: "Connector relay",
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
    })).body.bot;
    try {
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "open the toolbox" })).status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 10_000 }).toBe(true);
      const dump = z.object({
        mcpConfig: z.object({
          mcpServers: z.object({
            agents: z.object({ env: z.object({ HELMRYTH_COMMS_TOKEN: z.string() }) }),
          }),
        }),
      }).parse(JSON.parse(readFileSync(fakeClaudeDump, "utf8")));
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);

      const relayed = await fetch(`${BASE}/api/internal/connectors/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${dump.mcpConfig.mcpServers.agents.env.HELMRYTH_COMMS_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(relayed.status).toBe(409);
      expect(await relayed.json()).toEqual({ error: "Connected apps are not configured" });
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  }, 30_000);

  it("holds the workspace ceiling when crew imports arrive together", async () => {
    // The ceiling was checked before the import transaction, so N imports
    // that each saw room all committed. Two 60-operator crews on a workspace
    // of one took it to 121 against a cap of 100.
    const crew = (tag: string) => ({
      format: "helmryth.crew",
      version: 1,
      crew: {
        name: `Simultaneous ${tag}`,
        operators: Array.from({ length: 60 }, (_unused, index) => ({
          key: `member${index}`,
          name: `Simultaneous ${tag} ${index}`,
          appearance: { color: "green" },
        })),
      },
    });
    const [first, second] = await Promise.all([
      api("POST", "/api/teams/import", crew("A"), { "idempotency-key": "resilience-race-a" }),
      api("POST", "/api/teams/import", crew("B"), { "idempotency-key": "resilience-race-b" }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
    const visible = (await api("GET", "/api/bots?messages=0")).body.bots
      .filter((bot: { hidden?: boolean }) => !bot.hidden);
    expect(visible.length).toBeLessThanOrEqual(100);
  }, 120_000);

  // Same shape: the unfinishable erasure is simulated with
  // `chmodSync(workspaces, 0o500)`, which NTFS ignores, so the removal
  // succeeds and the erasure reports "complete" instead of "pending".
  it.skipIf(!HAS_POSIX_FILE_MODES)("does not report an erasure that did not finish when the operator is deleted", async () => {
    // The delete answered { ok: true } from the roster write alone. A private
    // workspace whose removal failed is still on disk and only queued for the
    // post-restart retry — and the receipt beside `ok` already said so.
    const bot = (await api("POST", "/api/bots", { name: "Unerasable desk" })).body.bot;
    const workspaces = join(dataDir, "workspaces");
    mkdirSync(join(workspaces, bot.id), { recursive: true });
    writeFileSync(join(workspaces, bot.id, "notes.md"), "private");
    chmodSync(workspaces, 0o500);
    let deleted: { status: number; body: any };
    try {
      deleted = await api("DELETE", `/api/bots/${bot.id}`);
    } finally {
      chmodSync(workspaces, 0o700);
    }
    expect(deleted.status).toBe(200);
    expect(deleted.body.workspaceErasure.state).toBe("pending");
    expect(deleted.body.workspaceErasure.errors.length).toBeGreaterThan(0);
    expect(deleted.body.ok).toBe(false);
    expect(existsSync(join(workspaces, bot.id))).toBe(true);

    // And the ordinary delete still reports the erasure it really completed.
    const clean = (await api("POST", "/api/bots", { name: "Erasable desk" })).body.bot;
    const cleanDelete = await api("DELETE", `/api/bots/${clean.id}`);
    expect(cleanDelete.status).toBe(200);
    expect(cleanDelete.body.ok).toBe(true);
    expect(cleanDelete.body.workspaceErasure.state).toBe("complete");
    expect(cleanDelete.body.erasures.every((erasure: { state: string }) => erasure.state === "complete")).toBe(true);
  }, 30_000);

  it("does not let the API archive the last active operator", async () => {
    // The sidebar disables Archive at one visible operator; PATCH had no such
    // check, so a script or tool call could empty the roster the UI protects.
    const visible = () => api("GET", "/api/bots?messages=0")
      .then((state) => state.body.bots.filter((bot: { hidden?: boolean }) => !bot.hidden));
    const before: { id: string; chiefOfStaff?: boolean }[] = await visible();
    expect(before.length).toBeGreaterThan(0);
    const survivor = before[before.length - 1]!;
    const archived: { id: string; chiefOfStaff?: boolean }[] = [];
    try {
      for (const bot of before.slice(0, -1)) {
        expect((await api("PATCH", `/api/bots/${bot.id}`, { hidden: true, chiefOfStaff: false })).status).toBe(200);
        archived.push(bot);
      }
      const refused = await api("PATCH", `/api/bots/${survivor.id}`, { hidden: true });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe("Keep at least one active operator");
      expect((await visible()).map((bot: { id: string }) => bot.id)).toEqual([survivor.id]);
    } finally {
      for (const bot of archived) {
        await api("PATCH", `/api/bots/${bot.id}`, { hidden: false });
        if (bot.chiefOfStaff) await api("PATCH", `/api/bots/${bot.id}`, { chiefOfStaff: true });
      }
    }
  }, 60_000);

  // Simulates the persist failure with `chmodSync(dataDir, 0o500)`. NTFS
  // ignores that — Windows permissions are ACLs and the mode argument is not
  // honoured — so the write succeeds, the route answers 201, and the case is
  // asserting a failure the platform will not produce. See testing/platform.ts.
  it.skipIf(!HAS_POSIX_FILE_MODES)("does not leave an operator behind when the create cannot be persisted", async () => {
    // store.createBot adds the operator to the live roster and then persists
    // it. When the persist failed, the 500 went back to the client while the
    // operator stayed live: GET served it, and the next unrelated write
    // committed it to disk for good.
    const before = (await api("GET", "/api/bots?messages=0")).body.bots;
    const survivor = before[0];
    chmodSync(dataDir, 0o500);
    let failed: { status: number; body: any };
    try {
      failed = await api("POST", "/api/bots", { name: "Phantom" });
    } finally {
      chmodSync(dataDir, 0o700);
    }
    expect(failed.status).toBe(500);

    const names = (bots: { name: string }[]) => bots.map((bot) => bot.name);
    expect(names((await api("GET", "/api/bots?messages=0")).body.bots)).not.toContain("Phantom");
    // An unrelated later write is what used to make the phantom permanent.
    expect((await api("PATCH", `/api/bots/${survivor.id}`, { title: "unrelated write" })).status).toBe(200);
    const persisted = z.array(z.object({ name: z.string() })).parse(
      JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")),
    );
    expect(names(persisted)).not.toContain("Phantom");
  }, 30_000);
});
