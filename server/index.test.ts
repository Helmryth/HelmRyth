// API smoke test: boots the real harness server (node server/index.ts)
// against a throwaway home directory and exercises the HTTP surface the
// app depends on. The config pins one deliberately-unknown driver so the
// suite is deterministic with or without agent CLIs installed — and pins
// the shadow-instance behavior end to end while it's at it.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { connect } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";
import { IMAGE_MAX_BYTES } from "./attachments.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAKE_ACP_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const WEBHOOK_PORT = 39000 + Math.floor(Math.random() * 10_000);
const WEBHOOK_BASE = `http://127.0.0.1:${WEBHOOK_PORT}`;
const LEGACY_HELMRYTH_TEAM_FORMAT = "helmryth.team" as const;
const testRequestBodySchema = z.unknown();
type TestRequestBody = z.input<typeof testRequestBodySchema>;

let child: ChildProcess;
/** stands in for the box provider so config saving never touches the network */
let boxStub: Server;
let boxStubPort = 0;
let home: string;
let staticDir: string;
let fakeClaudeDump: string;
let stderr = "";
const connectedComposioToolkits = new Set<string>();

const api = async (
  method: string,
  path: string,
  body?: TestRequestBody,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: any }> => {
  const mutation = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  const headers = { ...extraHeaders };
  if (mutation && headers["content-type"] === undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

let crewImportRequest = 0;
const importCrew = (path: string, body: TestRequestBody) =>
  api("POST", path, body, { "idempotency-key": `index-test-import-${++crewImportRequest}` });

const storedMessageCount = (threadId: string): number => {
  const db = new DatabaseSync(join(home, ".helmryth", "messages.db"), { readOnly: true });
  try {
    const row = z.object({ count: z.number() }).parse(
      db.prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?").get(threadId),
    );
    return row.count;
  } finally {
    db.close();
  }
};

const uploadAvatar = async (mime = "image/png"): Promise<string> => {
  const response = await fetch(`${BASE}/api/attachments`, {
    method: "POST",
    headers: { "content-type": mime },
    body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  });
  expect(response.status).toBe(201);
  const saved = z.object({ path: z.string() }).parse(await response.json());
  const name = saved.path.replaceAll("\\", "/").split("/").pop();
  if (!name) throw new Error("attachment response did not include a filename");
  return `/api/attachments/${name}`;
};

const statusWithHeaders = (headers: Record<string, string>): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: PORT, path: "/api/health", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "hry-api-test-"));
  staticDir = join(home, "static");
  fakeClaudeDump = join(home, "fake-claude-dump.json");
  // a fleet of exactly one unknown driver: no CLI probes, no network
  mkdirSync(join(home, ".helmryth"), { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Packaged Helmryth</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body { color: white; }");
  writeFileSync(
    join(home, ".helmryth", "config.json"),
    JSON.stringify({
      instances: {
        ghost: { driver: "not-a-real-driver", displayName: "Ghost" },
        claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLAUDE_CLI } },
        cadenceGate: {
          driver: "grokAgent",
          displayName: "Cadence gate fixture",
          environment: { FAKE_ACP_MODE: "permission" },
          config: { cli: FAKE_ACP_CLI, fullAuto: false },
        },
      },
    }),
  );
  writeFileSync(
    join(home, ".helmryth", "groups.json"),
    JSON.stringify([
      {
        id: "test-dm",
        threadId: "test-dm-thread",
        name: "Private channel",
        memberIds: ["test-bot-a", "test-bot-b"],
        defaultResponder: { kind: "mentions" },
        bulletin: "",
        unread: false,
        createdAt: 1,
        dm: true,
      },
      {
        id: "test-stranded-room",
        threadId: "test-stranded-room-thread",
        name: "Stranded room",
        memberIds: ["test-bot-a"],
        defaultResponder: { kind: "member", botId: "test-bot-a" },
        bulletin: "",
        unread: false,
        createdAt: 3,
      },
      {
        id: "test-cancel-room",
        threadId: "test-cancel-room-thread",
        name: "Cancel room",
        memberIds: ["test-bot-a"],
        defaultResponder: { kind: "member", botId: "test-bot-a" },
        bulletin: "",
        unread: false,
        createdAt: 4,
      },
      {
        id: "test-pinned-room",
        threadId: "test-pinned-room-thread",
        name: "Pinned room",
        memberIds: ["test-bot-a"],
        defaultResponder: { kind: "member", botId: "test-bot-a" },
        bulletin: "",
        unread: false,
        createdAt: 2,
        pinnedCwd: null,
      },
    ]),
  );

  // A room transcript carrying an approval that outlived its turn: the card
  // is durable, but busyBotId is in-memory only and never survives a restart.
  writeFileSync(
    join(home, ".helmryth", "messages-test-stranded-room-thread.json"),
    JSON.stringify({
      activeLeafId: "stranded-card",
      messages: [
        {
          id: "stranded-card",
          at: 3,
          parentId: null,
          role: "bot",
          kind: "options",
          card: {
            title: "Approval needed",
            subtitle: "rm -rf /tmp/scratch",
            options: ["Allow", "Deny"],
            requestId: "stranded-request",
            tool: "Bash",
            allowKey: "Bash:rm",
          },
          from: { botId: "test-bot-a", name: "Test bot A", color: "purple" },
        },
      ],
    }),
  );

  // A room holding an approval nobody has answered yet, so "Cancel turn"
  // has something open to close.
  writeFileSync(
    join(home, ".helmryth", "messages-test-cancel-room-thread.json"),
    JSON.stringify({
      activeLeafId: "cancel-card",
      messages: [
        {
          id: "cancel-card",
          at: 4,
          parentId: null,
          role: "bot",
          kind: "options",
          card: {
            title: "Approval needed",
            subtitle: "rm -rf /tmp/scratch",
            options: ["Allow", "Deny"],
            requestId: "cancel-request",
            tool: "Bash",
            allowKey: "Bash:rm",
          },
          from: { botId: "test-bot-a", name: "Test bot A", color: "purple" },
        },
      ],
    }),
  );

  boxStub = createServer(async (req, res) => {
    if (req.url?.startsWith("/api/v3.1/tool_router/session")) {
      if (req.method === "GET" && req.url.includes("/toolkits")) {
        const requested = new URL(req.url, "http://127.0.0.1").searchParams.get("toolkits")?.split(",") ?? [];
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          items: requested
            .filter((slug) => connectedComposioToolkits.has(slug))
            .map((slug) => ({
              slug,
              connected_account: { id: `account_${slug}`, status: "ACTIVE" },
            })),
        }));
      }
      if (req.headers["x-api-key"] !== "ak_good") {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "invalid project key" } }));
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      res.writeHead(201, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        session_id: "trs_config_test",
        mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/trs_config_test/mcp" },
        config: { user_id: body.user_id },
      }));
    }
    if (req.headers.authorization === "Bearer box_slow") {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const ok = req.headers.authorization === "Bearer box_good" || req.headers.authorization === "Bearer box_slow";
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { ok: true, boxes: [] } : { ok: false, code: "unauthorized" }));
  });
  await new Promise<void>((r) => boxStub.listen(0, "127.0.0.1", r));
  boxStubPort = z.object({ port: z.number() }).parse(boxStub.address()).port;

  const childEnvironment: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    HELMRYTH_PORT: String(PORT),
    HELMRYTH_WEBHOOK_PORT: String(WEBHOOK_PORT),
    HELMRYTH_BOX_API: `http://127.0.0.1:${boxStubPort}`,
    HELMRYTH_COMPOSIO_API: `http://127.0.0.1:${boxStubPort}/api/v3.1`,
    HELMRYTH_STATIC_DIR: staticDir,
    HELMRYTH_UI_ORIGIN: BASE,
    HELMRYTH_MANAGED_CONFIG_SOURCE: "packaged",
    HELMRYTH_MANAGED_CONFIG_STATE: "ready",
    HELMRYTH_MANAGED_REGISTRY_ORIGIN: "https://registry.example.test",
    HELMRYTH_MANAGED_CONDUIT_ORIGIN: "https://conduit.example.test",
    // Production uses 15s. Keep the real timer path while making the
    // browser-visible heartbeat assertion fast and deterministic.
    HELMRYTH_SSE_HEARTBEAT_MS: "50",
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
  child.stderr!.on("data", (c) => (stderr += c));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}, 30_000);

afterAll(async () => {
  boxStub?.close();
  // Upstream fixed this same Linux scratch-cleanup flake with an inline
  // retry loop; these helpers are that fix plus the cause — the retry AND
  // an exit that is actually waited for before the delete begins.
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("harness HTTP API", () => {
  it("answers a malformed request target instead of dying on it", async () => {
    // `GET //` is a legal HTTP request line but a protocol-relative URL with an
    // empty host, so `new URL` throws. That parse runs before the authority and
    // origin gates, so an unguarded throw escaped the handler and killed the
    // process — any web page could stop a running Helmryth with one fetch.
    const rawRequest = (target: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = connect(PORT, "127.0.0.1", () => {
          socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\n\r\n`);
        });
        let seen = "";
        socket.setTimeout(5_000, () => { socket.destroy(); reject(new Error(`timeout on ${target}`)); });
        socket.on("data", (chunk) => { seen += chunk.toString(); });
        socket.on("end", () => resolve(seen.split("\r\n")[0] ?? ""));
        socket.on("error", reject);
      });

    for (const target of ["//", "///", "//@", "//[", "http://", "//#", "//?x=1"]) {
      expect(await rawRequest(target), target).toContain("400");
    }
    // The listener must still be the same live process afterwards.
    expect(await statusWithHeaders({ origin: BASE })).toBe(200);
  });

  it("pins Host and Origin to the packaged renderer without loopback aliases", async () => {
    expect(await statusWithHeaders({ host: `127.0.0.1:${PORT}` })).toBe(200);
    expect(await statusWithHeaders({ origin: BASE })).toBe(200);

    for (const host of [
      "example.com",
      `example.com:${PORT}`,
      `localhost:${PORT}`,
      `localhost.:${PORT}`,
      `127.0.0.2:${PORT}`,
      `127.0.0.1:${PORT + 1}`,
      `[::1]:${PORT}`,
      `example.com@127.0.0.1:${PORT}`,
    ]) {
      expect(await statusWithHeaders({ host }), host).toBe(403);
    }

    for (const origin of [
      "https://example.com",
      "null",
      "file://",
      `${BASE}/`,
      `http://localhost:${PORT}`,
      `http://127.0.0.2:${PORT}`,
      `http://127.0.0.1:${PORT + 1}`,
      `https://127.0.0.1:${PORT}`,
      `http://user@127.0.0.1:${PORT}`,
    ]) {
      expect(await statusWithHeaders({ origin }), origin).toBe(403);
    }
  });

  it("denies browser preflight and simple mutations before any state change", async () => {
    const before = await api("GET", "/api/bots");
    const beforeCount = before.body.groups.length;

    const hostilePreflight = await fetch(`${BASE}/api/groups`, {
      method: "OPTIONS",
      headers: {
        origin: "https://attacker.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(hostilePreflight.status).toBe(403);
    expect(hostilePreflight.headers.get("access-control-allow-origin")).toBeNull();

    const hostileSimple = await fetch(`${BASE}/api/groups`, {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "text/plain" },
      body: JSON.stringify({ name: "Cross-origin form-shaped request" }),
    });
    expect(hostileSimple.status).toBe(403);

    const simple = await fetch(`${BASE}/api/groups`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "text/plain" },
      body: JSON.stringify({ name: "Must not exist" }),
    });
    expect(simple.status).toBe(415);

    const hostileJson = await fetch(`${BASE}/api/groups`, {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ name: "Must not exist either" }),
    });
    expect(hostileJson.status).toBe(403);

    const after = await api("GET", "/api/bots");
    expect(after.body.groups).toHaveLength(beforeCount);
  });

  it("keeps explicitly documented originless native JSON mutations working", async () => {
    const bot = (await api("GET", "/api/bots")).body.bots[0];
    const created = await api("POST", "/api/groups", { name: "Native originless probe", memberIds: [bot.id] });
    expect(created.status).toBe(201);
    const removed = await api("DELETE", `/api/groups/${created.body.group.id}`);
    expect(removed.status).toBe(200);
  });

  it("applies the JSON media contract to bodyless public mutations", async () => {
    const routes = [
      ["POST", "/api/routines/no-such-cadence/run"],
      ["POST", "/api/routine-runs/no-such-run/cancel"],
      ["POST", "/api/routine-runs/no-such-run/seen"],
      ["POST", "/api/webhooks/no-such-webhook/rotate"],
      ["POST", "/api/teams/imports/no-such-import/undo"],
      ["POST", "/api/bots/no-such-operator/read"],
      ["POST", "/api/groups/no-such-crew/read"],
      ["DELETE", "/api/bots/no-such-operator"],
    ] as const;
    for (const [method, path] of routes) {
      const missingMedia = await fetch(`${BASE}${path}`, { method });
      expect(missingMedia.status, `${method} ${path} without JSON`).toBe(415);
      const routed = await fetch(`${BASE}${path}`, {
        method,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
      expect(routed.status, `${method} ${path} with JSON`).not.toBe(415);
    }
  });

  it("identifies itself on /api/health", async () => {
    const { status, body } = await api("GET", "/api/health");
    expect(status).toBe(200);
    expect(body.app).toBe("helmryth");
    expect(z.object({ pid: z.number() }).parse(body).pid).toBeTypeOf("number");
    expect(body.static).toBe(true);
  });

  it("serves packaged UI assets and preserves API 404s", async () => {
    const root = await fetch(`${BASE}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toBe("text/html");
    expect(await root.text()).toContain("Packaged Helmryth");

    const asset = await fetch(`${BASE}/assets/smoke.css`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("text/css");
    expect(await asset.text()).toContain("color: white");

    const spa = await fetch(`${BASE}/settings/desktop`);
    expect(spa.status).toBe(200);
    expect(spa.headers.get("content-type")).toBe("text/html");
    expect(await spa.text()).toContain("Packaged Helmryth");

    const unknownApi = await api("GET", "/api/not-a-real-route");
    expect(unknownApi.status).toBe(404);
    expect(unknownApi.body.error).toContain("/api/not-a-real-route");
  });

  it("rejects malformed and oversized JSON bodies without hanging", async () => {
    const malformed = await fetch(`${BASE}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid JSON body" });

    const oversized = await fetch(`${BASE}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: "x".repeat(1_000_001) } }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "body too large" });

    expect((await fetch(`${BASE}/api/health`)).status).toBe(200);
  });

  it("seeds one starter bot with its greeting", async () => {
    const { status, body } = await api("GET", "/api/bots");
    expect(status).toBe(200);
    expect(body.bots.length).toBeGreaterThanOrEqual(1);
    expect(body.bots[0].messages.length).toBeGreaterThanOrEqual(2);
  });

  it("projects privacy-safe live team-map metadata", async () => {
    const response = await api("GET", "/api/team-map");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ collaborations: expect.any(Array), queued: [], running: [] });
    for (const collaboration of response.body.collaborations) {
      expect(collaboration).toEqual({
        groupId: expect.any(String),
        botIds: [expect.any(String), expect.any(String)],
        lastAt: expect.any(Number),
      });
    }
    expect(JSON.stringify(response.body)).not.toContain("messages");
    expect(JSON.stringify(response.body)).not.toContain("prompt");
  });

  it("rejects non-object bot and channel create bodies without writing records", async () => {
    const before = await api("GET", "/api/bots?messages=0");
    for (const path of ["/api/bots", "/api/groups"]) {
      for (const body of ["null", "[]"]) {
        const response = await fetch(`${BASE}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: expect.stringMatching(/JSON object/) });
      }
    }
    const after = await api("GET", "/api/bots?messages=0");
    expect(after.body.bots).toHaveLength(before.body.bots.length);
    expect(after.body.groups).toHaveLength(before.body.groups.length);
  });

  it("adds and removes room members through PATCH", async () => {
    const [first, second, third] = await Promise.all([
      api("POST", "/api/bots"),
      api("POST", "/api/bots"),
      api("POST", "/api/bots"),
    ]).then((created) => created.map((response) => response.body.bot));
    const room = (await api("POST", "/api/groups", { name: "Roster", memberIds: [first.id, second.id] })).body.group;
    try {
      const added = await api("PATCH", `/api/groups/${room.id}`, { memberIds: [first.id, second.id, third.id] });
      expect(added.status).toBe(200);
      expect(added.body.group.memberIds).toEqual([first.id, second.id, third.id]);

      const removed = await api("PATCH", `/api/groups/${room.id}`, { memberIds: [third.id] });
      expect(removed.status).toBe(200);
      expect(removed.body.group.memberIds).toEqual([third.id]);

      const state = (await api("GET", "/api/bots")).body;
      expect(state.groups.find((group: { id: string }) => group.id === room.id).memberIds).toEqual([third.id]);
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      for (const bot of [first, second, third]) await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("refuses to empty a room's roster", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Never empty", memberIds: [bot.id] })).body.group;
    try {
      for (const memberIds of [[], ["no-such-bot"]]) {
        const attempted = await api("PATCH", `/api/groups/${room.id}`, { memberIds });
        expect(attempted.status).toBe(400);
        expect(attempted.body.error).toMatch(/at least one operator|unknown room member/i);
      }
      const state = (await api("GET", "/api/bots")).body;
      expect(state.groups.find((group: { id: string }) => group.id === room.id).memberIds).toEqual([bot.id]);
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("deduplicates repeated room members while preserving their first-seen order", async () => {
    const [first, second] = await Promise.all([api("POST", "/api/bots"), api("POST", "/api/bots")]).then(
      (created) => created.map((response) => response.body.bot),
    );
    const room = (await api("POST", "/api/groups", { name: "Unique roster", memberIds: [first.id] })).body.group;
    try {
      const patched = await api("PATCH", `/api/groups/${room.id}`, {
        memberIds: [second.id, first.id, second.id, first.id],
      });
      expect(patched.status).toBe(200);
      expect(patched.body.group.memberIds).toEqual([second.id, first.id]);
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      for (const bot of [first, second]) await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("keeps direct-message channels a fixed pair at the API boundary", async () => {
    const attempted = await api("PATCH", "/api/groups/test-dm", { memberIds: ["test-bot-a"] });
    expect(attempted.status).toBe(400);
    expect(attempted.body.error).toMatch(/direct-message.*members/i);
    const state = await api("GET", "/api/bots");
    const dm = state.body.groups.find((group: { id: string }) => group.id === "test-dm");
    expect(dm.memberIds).toEqual(["test-bot-a", "test-bot-b"]);
  });

  it("hands the lead to a remaining member when the lead leaves the room", async () => {
    const [lead, other] = await Promise.all([api("POST", "/api/bots"), api("POST", "/api/bots")]).then((created) =>
      created.map((response) => response.body.bot),
    );
    const room = (await api("POST", "/api/groups", { name: "Handover", memberIds: [lead.id, other.id] })).body.group;
    try {
      expect(room.defaultResponder).toEqual({ kind: "member", botId: lead.id });
      const patched = await api("PATCH", `/api/groups/${room.id}`, { memberIds: [other.id] });
      expect(patched.status).toBe(200);
      expect(patched.body.group.defaultResponder).toEqual({ kind: "member", botId: other.id });
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      for (const bot of [lead, other]) await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("persists room setup and blocks the first message until it is finished", async () => {
    const bot = (await api("GET", "/api/bots")).body.bots[0];
    const created = await api("POST", "/api/groups", { name: "Setup probe", memberIds: [bot.id] });
    expect(created.status).toBe(201);
    const group = created.body.group;
    try {
      expect(group).toMatchObject({ setupCompletedAt: null, setupSkippedAt: null, messages: [] });
      const blocked = await api("POST", `/api/groups/${group.id}/messages`, { text: "before setup" });
      expect(blocked.status).toBe(409);
      expect((await api("GET", "/api/bots")).body.groups.find((candidate: { id: string }) => candidate.id === group.id).messages).toHaveLength(0);

      const invalid = await api("PATCH", `/api/groups/${group.id}/setup`, {
        action: "complete",
        cwd: null,
        bulletin: "",
        defaultResponder: { kind: "member", botId: "missing" },
      });
      expect(invalid.status).toBe(400);

      const completed = await api("PATCH", `/api/groups/${group.id}/setup`, {
        action: "complete",
        cwd: null,
        bulletin: "shared brief",
        defaultResponder: { kind: "member", botId: bot.id },
      });
      expect(completed.status).toBe(200);
      expect(completed.body.group).toMatchObject({ bulletin: "shared brief", setupCompletedAt: expect.any(Number) });
      expect((await api("GET", "/api/bots")).body.groups.find((candidate: { id: string }) => candidate.id === group.id)).toMatchObject({
        bulletin: "shared brief",
        setupSkippedAt: null,
      });
    } finally {
      await api("DELETE", `/api/groups/${group.id}`);
    }
  });

  it("creates an MCP-ready channel in one request without exposing partial setup", async () => {
    const bot = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    const created = await api("POST", "/api/groups", {
      name: "Atomic setup",
      memberIds: [bot.id],
      section: "Work",
      setup: {
        bulletin: "Keep updates concise.",
        defaultResponder: { kind: "mentions" },
      },
    });
    expect(created.status).toBe(201);
    const group = created.body.group;
    try {
      expect(group).toMatchObject({
        name: "Atomic setup",
        memberIds: [bot.id],
        section: "Work",
        bulletin: "Keep updates concise.",
        defaultResponder: { kind: "mentions" },
        setupSkippedAt: null,
      });
      expect(group.setupCompletedAt).toEqual(expect.any(Number));
      expect((await api("POST", `/api/groups/${group.id}/messages`, { text: "A quiet update" })).status).toBe(202);
    } finally {
      await api("POST", `/api/groups/${group.id}/interrupt`, {});
      await api("DELETE", `/api/groups/${group.id}`);
    }
  });

  it("returns the canonical stored user message for direct and channel sends", async () => {
    const created = await api("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    let room: any;
    try {
      const direct = await api("POST", `/api/bots/${bot.id}/messages`, { text: "canonical direct" });
      expect(direct.status).toBe(202);
      expect(direct.body).toMatchObject({
        ok: true,
        threadId: bot.threadId,
        message: {
          id: expect.any(String),
          at: expect.any(Number),
          role: "user",
          kind: "text",
          text: "canonical direct",
        },
      });
      const afterDirect = (await api("GET", "/api/bots?messages=20")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(afterDirect.messages.find((message: { id: string }) => message.id === direct.body.message.id))
        .toEqual(direct.body.message);

      expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy;
      }, { timeout: 5_000 }).toBe(false);

      room = (await api("POST", "/api/groups", {
        name: "Canonical response room",
        memberIds: [bot.id],
        setup: { bulletin: "", defaultResponder: { kind: "mentions" } },
      })).body.group;
      const channel = await api("POST", `/api/groups/${room.id}/messages`, { text: "canonical channel" });
      expect(channel.status).toBe(202);
      expect(channel.body).toMatchObject({
        ok: true,
        threadId: room.threadId,
        message: {
          id: expect.any(String),
          at: expect.any(Number),
          role: "user",
          kind: "text",
          text: "canonical channel",
        },
      });
      const afterChannel = (await api("GET", "/api/bots?messages=20")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      );
      expect(afterChannel.messages.find((message: { id: string }) => message.id === channel.body.message.id))
        .toEqual(channel.body.message);
    } finally {
      if (room) await api("DELETE", `/api/groups/${room.id}`);
      await api("POST", `/api/bots/${bot.id}/interrupt`).catch(() => undefined);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("deduplicates direct send retries by sendId, including after the accepted task becomes inactive", async () => {
    const created = await api("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const originalThreadId = bot.threadId;
    const sendId = "direct_retry_1234567890";
    const request = { text: "retry this direct message once", threadId: originalThreadId, sendId };
    try {
      const first = await api("POST", `/api/bots/${bot.id}/messages`, request);
      expect(first.status).toBe(202);
      expect(first.body).toMatchObject({
        ok: true,
        threadId: originalThreadId,
        message: { role: "user", kind: "text", text: request.text, sendId },
      });

      const duplicate = await api("POST", `/api/bots/${bot.id}/messages`, request);
      expect(duplicate.status).toBe(202);
      expect(duplicate.body).toEqual(first.body);

      const conflict = await api("POST", `/api/bots/${bot.id}/messages`, {
        ...request,
        text: "a different message cannot reuse that identity",
      });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error).toMatch(/sendId already belongs/i);

      const invalid = await api("POST", `/api/bots/${bot.id}/messages`, {
        text: "invalid identity must not land",
        threadId: originalThreadId,
        sendId: "short",
      });
      expect(invalid.status).toBe(400);

      const accepted = (await api("GET", "/api/bots?messages=50")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(accepted.messages.filter((message: { role: string; sendId?: string }) =>
        message.role === "user" && message.sendId === sendId
      )).toHaveLength(1);
      expect(accepted.messages.some((message: { text?: string }) => message.text === "invalid identity must not land"))
        .toBe(false);

      await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: originalThreadId });
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        return state?.busy;
      }, { timeout: 5_000 }).toBe(false);

      const nextTask = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Now active" });
      expect(nextTask.status).toBe(201);
      expect(nextTask.body.task.threadId).not.toBe(originalThreadId);

      const inactiveRetry = await api("POST", `/api/bots/${bot.id}/messages`, request);
      expect(inactiveRetry.status).toBe(202);
      expect(inactiveRetry.body).toEqual(first.body);
      const current = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(current.threadId).toBe(nextTask.body.task.threadId);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("deduplicates channel send retries by sendId", async () => {
    const member = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    const room = (await api("POST", "/api/groups", {
      name: "Idempotent channel",
      memberIds: [member.id],
      setup: { bulletin: "", defaultResponder: { kind: "mentions" } },
    })).body.group;
    const sendId = "channel_retry_123456789";
    const request = { text: "one canonical channel message", threadId: room.threadId, sendId };
    try {
      const first = await api("POST", `/api/groups/${room.id}/messages`, request);
      expect(first.status).toBe(202);
      expect(first.body).toMatchObject({
        ok: true,
        threadId: room.threadId,
        message: { role: "user", kind: "text", text: request.text, sendId },
      });

      const duplicate = await api("POST", `/api/groups/${room.id}/messages`, request);
      expect(duplicate.status).toBe(202);
      expect(duplicate.body).toEqual(first.body);

      const snapshot = (await api("GET", "/api/bots?messages=50")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      );
      expect(snapshot.messages.filter((message: { role: string; sendId?: string }) =>
        message.role === "user" && message.sendId === sendId
      )).toHaveLength(1);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
      await api("DELETE", `/api/groups/${room.id}`);
    }
  });

  it("rejects an entire channel roster when any requested member is unknown", async () => {
    const bot = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    const before = (await api("GET", "/api/bots?messages=0")).body.groups.length;
    const rejectedCreate = await api("POST", "/api/groups", {
      name: "No partial roster",
      memberIds: [bot.id, "missing-bot"],
    });
    expect(rejectedCreate.status).toBe(400);
    expect(rejectedCreate.body.error).toContain("missing-bot");
    expect((await api("GET", "/api/bots?messages=0")).body.groups).toHaveLength(before);

    const room = (await api("POST", "/api/groups", { name: "Stable roster", memberIds: [bot.id] })).body.group;
    try {
      const rejectedPatch = await api("PATCH", `/api/groups/${room.id}`, {
        memberIds: [bot.id, "missing-bot"],
      });
      expect(rejectedPatch.status).toBe(400);
      const reread = (await api("GET", "/api/bots?messages=0")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      );
      expect(reread.memberIds).toEqual([bot.id]);
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
    }
  });

  it("creates, switches, renames and deletes independent channel tasks", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Parallel work", memberIds: [bot.id] })).body.group;
    try {
      expect(room.tasks).toHaveLength(1);
      expect(room.tasks[0].threadId).toBe(room.threadId);
      const originalThread = room.threadId;

      const created = await api("POST", `/api/groups/${room.id}/tasks`, { title: "Launch plan" });
      expect(created.status).toBe(201);
      expect(created.body.group.threadId).toBe(created.body.task.threadId);
      expect(created.body.group.messages).toEqual([]);
      expect(created.body.group.tasks).toHaveLength(2);

      const newThread = created.body.task.threadId;
      const renamed = await api("PATCH", `/api/groups/${room.id}/tasks/${newThread}`, {
        title: "Release plan",
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body.task.title).toBe("Release plan");

      const switched = await api("POST", `/api/groups/${room.id}/tasks/${originalThread}`);
      expect(switched.status).toBe(200);
      expect(switched.body.group.threadId).toBe(originalThread);
      expect(switched.body.group.tasks.find((task: { threadId: string }) => task.threadId === newThread).title).toBe("Release plan");

      const removed = await api("DELETE", `/api/groups/${room.id}/tasks/${newThread}`);
      expect(removed.status).toBe(200);
      expect(removed.body.group.tasks).toHaveLength(1);
      expect((await api("DELETE", `/api/groups/${room.id}/tasks/${originalThread}`)).status).toBe(400);
      expect((await api("POST", `/api/groups/${room.id}/tasks/missing-thread`)).status).toBe(404);
      expect((await api("POST", `/api/groups/${room.id}/tasks`, { title: 42 })).status).toBe(400);
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("lets a Chief create operators from its direct and channel tasks but not from channels it cannot access", async () => {
    const chief = (await api("POST", "/api/bots")).body.bot;
    const outsider = (await api("POST", "/api/bots")).body.bot;
    let channel: any;
    let outsiderChannel: any;
    const createdBotIds: string[] = [];
    try {
      const selected = await api("PATCH", `/api/bots/${chief.id}`, {
        name: "Channel Chief",
        section: "Channel creation test",
        chiefOfStaff: true,
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      });
      expect(selected.status).toBe(200);

      rmSync(fakeClaudeDump, { force: true });
      expect((await api("POST", `/api/bots/${chief.id}/messages`, { text: "prepare the team" })).status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);
      const dump = z.object({
        mcpConfig: z.object({
          mcpServers: z.object({
            agents: z.object({ env: z.object({ HELMRYTH_COMMS_TOKEN: z.string() }) }),
          }),
        }),
      }).parse(JSON.parse(readFileSync(fakeClaudeDump, "utf8")));
      const internalHeaders = {
        authorization: `Bearer ${dump.mcpConfig.mcpServers.agents.env.HELMRYTH_COMMS_TOKEN}`,
        "content-type": "application/json",
      };
      expect((await api("POST", `/api/bots/${chief.id}/interrupt`)).status).toBe(200);

      const createOperator = async (fromThreadId: string, name: string, fromBotId = chief.id) => {
        const response = await fetch(`${BASE}/api/internal/create-bot`, {
          method: "POST",
          headers: internalHeaders,
          body: JSON.stringify({
            fromBotId,
            fromThreadId,
            name,
            role: "Research operator",
            instructions: "Research the assigned question and report concise findings.",
          }),
        });
        const body = z.object({
          id: z.string().optional(),
          section: z.string().optional(),
          error: z.string().optional(),
        }).passthrough().parse(await response.json());
        if (response.status === 201 && body.id) createdBotIds.push(body.id);
        return { status: response.status, body };
      };

      const direct = await createOperator(chief.threadId, "Direct Task Operator");
      expect(direct).toMatchObject({ status: 201, body: { section: "Channel creation test" } });

      channel = (await api("POST", "/api/groups", {
        name: "Chief member channel",
        memberIds: [chief.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: chief.id } },
      })).body.group;
      const rootThreadId = channel.threadId;
      const channelTask = await api("POST", `/api/groups/${channel.id}/tasks`, { title: "Research task" });
      expect(channelTask.status).toBe(201);
      const rootTask = await createOperator(rootThreadId, "Channel Root Operator");
      expect(rootTask.status).toBe(201);
      const nestedTask = await createOperator(channelTask.body.task.threadId, "Channel Task Operator");
      expect(nestedTask.status).toBe(201);

      outsiderChannel = (await api("POST", "/api/groups", {
        name: "Outsider-only channel",
        memberIds: [outsider.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: outsider.id } },
      })).body.group;
      const nonChief = await createOperator(outsiderChannel.threadId, "Non-Chief Operator", outsider.id);
      expect(nonChief).toEqual({
        status: 403,
        body: { error: "Only a section's lead operator can create operators" },
      });
      const denied = await createOperator(outsiderChannel.threadId, "Forbidden Operator");
      expect(denied).toEqual({
        status: 403,
        body: { error: "source conversation does not belong to sender" },
      });
      const state = (await api("GET", "/api/bots?messages=0")).body;
      expect(state.bots.some((bot: { name: string }) => bot.name === "Forbidden Operator")).toBe(false);
    } finally {
      await api("POST", `/api/bots/${chief.id}/interrupt`);
      if (outsiderChannel?.id) await api("DELETE", `/api/groups/${outsiderChannel.id}`);
      if (channel?.id) await api("DELETE", `/api/groups/${channel.id}`);
      for (const botId of createdBotIds) await api("DELETE", `/api/bots/${botId}`);
      await api("DELETE", `/api/bots/${outsider.id}`);
      await api("DELETE", `/api/bots/${chief.id}`);
    }
  });

  it("rejects null and array task, channel, and bot mutation bodies", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Object bodies", memberIds: [bot.id] })).body.group;
    try {
      const routes = [
        ["POST", `/api/groups/${room.id}/tasks`],
        ["PATCH", `/api/groups/${room.id}/tasks/${room.threadId}`],
        ["PATCH", `/api/groups/${room.id}`],
        ["PATCH", `/api/bots/${bot.id}`],
      ] as const;
      for (const [method, path] of routes) {
        for (const body of ["null", "[]"]) {
          const response = await fetch(`${BASE}${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body,
          });
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({ error: "body must be a JSON object" });
        }
      }
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("keeps direct-message channels single-threaded and blocks task changes on an open gate", async () => {
    const dm = await api("POST", "/api/groups/test-dm/tasks", {});
    expect(dm.status).toBe(400);
    expect(dm.body.error).toMatch(/one canonical run/i);

    const blocked = await api("POST", "/api/groups/test-stranded-room/tasks", {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/waiting on you/i);
  });

  it("keeps direct-message channels folderless at the API boundary", async () => {
    const attempted = await api("PATCH", "/api/groups/test-dm", { cwd: home });
    expect(attempted.status).toBe(400);
    expect(attempted.body.error).toMatch(/direct-message.*working folder/i);
    const state = await api("GET", "/api/bots");
    expect(state.body.groups.find((group: { id: string }) => group.id === "test-dm")).not.toHaveProperty("cwd");
    expect((await api("DELETE", "/api/groups/test-dm")).status).toBe(200);
  });

  it("rejects working-folder changes after a room has pinned its first turn", async () => {
    const attempted = await api("PATCH", "/api/groups/test-pinned-room", { cwd: home });
    expect(attempted.status).toBe(409);
    expect(attempted.body.error).toMatch(/fixed after its first turn/i);
    const state = await api("GET", "/api/bots");
    expect(state.body.groups.find((group: { id: string }) => group.id === "test-pinned-room")).not.toHaveProperty("cwd");
    expect((await api("DELETE", "/api/groups/test-pinned-room")).status).toBe(200);
  });

  it("renames rooms through a bounded non-empty name", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Old room", memberIds: [bot.id] })).body.group;
    try {
      const renamed = await api("PATCH", `/api/groups/${room.id}`, { name: "  Project Atlas  " });
      expect(renamed.status).toBe(200);
      expect(renamed.body.group.name).toBe("Project Atlas");

      for (const name of ["", "   ", 42, "x".repeat(101)]) {
        expect((await api("PATCH", `/api/groups/${room.id}`, { name })).status).toBe(400);
      }

      const state = (await api("GET", "/api/bots")).body;
      expect(state.groups.find((group: { id: string }) => group.id === room.id).name).toBe("Project Atlas");
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("describes the configured fleet, shadows included", async () => {
    const { status, body } = await api("GET", "/api/instances");
    expect(status).toBe(200);
    const ghost = body.instances.find((instance: { instanceId: string }) => instance.instanceId === "ghost");
    expect(ghost).toMatchObject({
      instanceId: "ghost",
      driverKind: "not-a-real-driver",
      displayName: "Ghost",
      snapshot: { state: "unavailable" },
    });
    expect(ghost.snapshot.reason).toContain("not-a-real-driver");
    expect(body.instances).toContainEqual(expect.objectContaining({
      instanceId: "claude",
      driverKind: "claudeAgent",
      displayName: "Fixture Claude",
    }));
  });

  it("searches transcripts and exports a conversation", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    // every new bot opens with a seeded greeting — a known searchable string
    const hits = await api("GET", "/api/search?q=move%20the%20work");
    expect(hits.status).toBe(200);
    const hit = hits.body.hits.find((h: { botId?: string }) => h.botId === bot.id);
    expect(hit).toMatchObject({
      botId: bot.id,
      threadId: bot.threadId,
      name: bot.name,
      kind: "text",
      onActivePath: true,
    });
    expect(hit.snippet.toLowerCase()).toContain("move the work");
    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength).toLowerCase()).toBe("move the work");
    expect((await api("GET", "/api/search?q=")).body.hits).toEqual([]);
    const scoped = await api("GET", `/api/search?q=move%20the%20work&threadId=${bot.threadId}`);
    expect(scoped.status).toBe(200);
    expect(scoped.body.hits.every((candidate: { threadId: string }) => candidate.threadId === bot.threadId)).toBe(true);
    expect((await api("GET", "/api/search?q=hello&threadId=missing-thread")).status).toBe(404);

    const markdown = await fetch(`${BASE}/api/threads/${bot.threadId}/export`);
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    expect(markdown.headers.get("content-disposition")).toContain("attachment");
    const text = await markdown.text();
    expect(text).toContain("move the work and surface every gate");

    const asJson = await api("GET", `/api/threads/${bot.threadId}/export?format=json`);
    expect(asJson.status).toBe(200);
    expect(asJson.body.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(asJson.body)).not.toContain('"png"');
    expect((await api("GET", `/api/threads/${bot.threadId}/export?format=pdf`)).status).toBe(400);
    expect((await api("GET", "/api/threads/nope/export")).status).toBe(404);

    // one pinned message per thread: pin, round-trip, replace, clear; the
    // id is stored verbatim — resolution is the UI's job
    const pin = await api("PATCH", `/api/bots/${bot.id}`, { pinnedMessageId: "msg-abc_123" });
    expect(pin.status).toBe(200);
    expect(pin.body.bot).toMatchObject({ pinnedMessageId: "msg-abc_123" });
    const repin = await api("PATCH", `/api/bots/${bot.id}`, { pinnedMessageId: "msg-second" });
    expect(repin.body.bot).toMatchObject({ pinnedMessageId: "msg-second" });
    expect((await api("PATCH", `/api/bots/${bot.id}`, { pinnedMessageId: "not an id!" })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { pinnedMessageId: 42 })).status).toBe(400);
    const unpinned = await api("PATCH", `/api/bots/${bot.id}`, { pinnedMessageId: null });
    expect(unpinned.status).toBe(200);
    expect(unpinned.body.bot).not.toHaveProperty("pinnedMessageId");

    const room = (await api("POST", "/api/groups", { name: "Pins", memberIds: [bot.id] })).body.group;
    const roomPin = await api("PATCH", `/api/groups/${room.id}`, { pinnedMessageId: "msg-room_1" });
    expect(roomPin.status).toBe(200);
    expect(roomPin.body.group).toMatchObject({ pinnedMessageId: "msg-room_1" });
    const roomRepin = await api("PATCH", `/api/groups/${room.id}`, { pinnedMessageId: "msg-room_2" });
    expect(roomRepin.body.group).toMatchObject({ pinnedMessageId: "msg-room_2" });
    expect((await api("PATCH", `/api/groups/${room.id}`, { pinnedMessageId: "not an id!" })).status).toBe(400);
    expect((await api("PATCH", `/api/groups/${room.id}`, { pinnedMessageId: 42 })).status).toBe(400);
    const roomCleared = await api("PATCH", `/api/groups/${room.id}`, { pinnedMessageId: "" });
    expect(roomCleared.status).toBe(200);
    expect(roomCleared.body.group).not.toHaveProperty("pinnedMessageId");

    // deleted conversations drop out of search rather than 404ing it
    await api("DELETE", `/api/bots/${bot.id}`);
    const after = await api("GET", "/api/search?q=nice%20to%20meet");
    expect(after.body.hits.find((h: { botId?: string }) => h.botId === bot.id)).toBeUndefined();
  });

  it("stores a room reply as a flat reference and rejects foreign targets", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const foreign = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Reply room", memberIds: [bot.id] })).body.group;
    try {
      await api("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" });
      await api("PATCH", `/api/groups/${room.id}`, { defaultResponder: { kind: "mentions" } });
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "First thought" })).status).toBe(202);
      let current = (await api("GET", "/api/bots?messages=20")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      );
      const original = current.messages.at(-1);
      expect((await api("POST", `/api/groups/${room.id}/messages`, {
        text: "Following up",
        replyToId: original.id,
      })).status).toBe(202);
      current = (await api("GET", "/api/bots?messages=20")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      );
      expect(current.messages.at(-1)).toMatchObject({ text: "Following up", replyToId: original.id });
      expect((await api("POST", `/api/groups/${room.id}/messages`, {
        text: "Wrong conversation",
        replyToId: foreign.messages[0].id,
      })).status).toBe(404);
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
      await api("DELETE", `/api/bots/${foreign.id}`);
    }
  });

  it("creates, patches, and deletes a bot", async () => {
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const bot = created.body.bot;

    const patched = await api("PATCH", `/api/bots/${bot.id}`, { name: "Renamed", pinned: true });
    expect(patched.status).toBe(200);
    expect(patched.body.bot).toMatchObject({ name: "Renamed", pinned: true });

    const missing = await api("PATCH", "/api/bots/does-not-exist", { name: "x" });
    expect(missing.status).toBe(404);

    // persona fields are bounded at the write boundary — they reach system
    // prompts (Chief roster, room rosters), so an unbounded PATCH is a
    // token-burn and prompt-injection surface
    expect((await api("PATCH", `/api/bots/${bot.id}`, { name: "N".repeat(101) })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { name: "   " })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { title: "T".repeat(201) })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { description: "D".repeat(4001) })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { description: 7 })).status).toBe(400);

    // the per-bot composio gate is a boolean, and it round-trips
    expect((await api("PATCH", `/api/bots/${bot.id}`, { composio: "yes" })).status).toBe(400);
    const gated = await api("PATCH", `/api/bots/${bot.id}`, { composio: false });
    expect(gated.status).toBe(200);

    // sidebar sections: assign, round-trip, trim, clear — and the field
    // drops off the record entirely once cleared rather than lingering
    // as an empty string through exports and wire frames
    const sectioned = await api("PATCH", `/api/bots/${bot.id}`, { section: "  Research  " });
    expect(sectioned.status).toBe(200);
    expect(sectioned.body.bot).toMatchObject({ section: "Research" });
    expect((await api("PATCH", `/api/bots/${bot.id}`, { section: 7 })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { section: "S".repeat(61) })).status).toBe(400);
    const cleared = await api("PATCH", `/api/bots/${bot.id}`, { section: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.bot).not.toHaveProperty("section");
    const clearedEmpty = await api("PATCH", `/api/bots/${bot.id}`, { section: "   " });
    expect(clearedEmpty.status).toBe(200);
    expect(clearedEmpty.body.bot).not.toHaveProperty("section");

    // Channels can be born inside a Work/Personal/project context, and can
    // later move through the same context contract as bots.
    const createdInContext = await api("POST", "/api/groups", {
      name: "Filed",
      memberIds: [bot.id, bot.id],
      section: "  Work  ",
    });
    expect(createdInContext.status).toBe(201);
    expect(createdInContext.body.group).toMatchObject({ section: "Work", memberIds: [bot.id] });
    expect((await api("POST", "/api/groups", { name: 7, memberIds: [bot.id] })).status).toBe(400);
    expect((await api("POST", "/api/groups", { name: "N".repeat(101), memberIds: [bot.id] })).status).toBe(400);
    expect((await api("POST", "/api/groups", { name: "Bad context", memberIds: [bot.id], section: 7 })).status).toBe(400);
    expect((await api("POST", "/api/groups", { name: "Long context", memberIds: [bot.id], section: "S".repeat(61) })).status).toBe(400);
    const sectionRoom = createdInContext.body.group;
    const roomSectioned = await api("PATCH", `/api/groups/${sectionRoom.id}`, { section: "  Clients  " });
    expect(roomSectioned.status).toBe(200);
    expect(roomSectioned.body.group).toMatchObject({ section: "Clients" });
    expect((await api("PATCH", `/api/groups/${sectionRoom.id}`, { section: 7 })).status).toBe(400);
    expect((await api("PATCH", `/api/groups/${sectionRoom.id}`, { section: "S".repeat(61) })).status).toBe(400);
    const roomSectionCleared = await api("PATCH", `/api/groups/${sectionRoom.id}`, { section: null });
    expect(roomSectionCleared.status).toBe(200);
    expect(roomSectionCleared.body.group).not.toHaveProperty("section");
    const roomSectionEmpty = await api("PATCH", `/api/groups/${sectionRoom.id}`, { section: "   " });
    expect(roomSectionEmpty.status).toBe(200);
    expect(roomSectionEmpty.body.group).not.toHaveProperty("section");
    expect((await api("DELETE", `/api/groups/${sectionRoom.id}`)).status).toBe(200);
    expect(gated.body.bot.composio).toBe(false);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { composio: true })).body.bot.composio).toBe(true);

    const deleted = await api("DELETE", `/api/bots/${bot.id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.workspaceErasure).toMatchObject({
      botId: bot.id,
      state: "complete",
      removed: { workspace: true },
      retained: { checkpointShadows: true },
    });
    const after = await api("GET", "/api/bots");
    expect(after.body.bots.find((b: { id: string }) => b.id === bot.id)).toBeUndefined();
  });

  it("elects one Chief of Staff per section and preserves other section Chiefs", async () => {
    const workA = (await api("POST", "/api/bots")).body.bot;
    const workB = (await api("POST", "/api/bots")).body.bot;
    const personal = (await api("POST", "/api/bots")).body.bot;
    try {
      await api("PATCH", `/api/bots/${workA.id}`, { section: "Work", chiefOfStaff: true });
      await api("PATCH", `/api/bots/${workB.id}`, { section: "Work" });
      await api("PATCH", `/api/bots/${personal.id}`, { section: "Personal", chiefOfStaff: true });

      let bots = (await api("GET", "/api/bots")).body.bots;
      expect(bots.find((bot: { id: string }) => bot.id === workA.id).chiefOfStaff).toBe(true);
      expect(bots.find((bot: { id: string }) => bot.id === personal.id).chiefOfStaff).toBe(true);

      await api("PATCH", `/api/bots/${workB.id}`, { chiefOfStaff: true });
      bots = (await api("GET", "/api/bots")).body.bots;
      expect(bots.find((bot: { id: string }) => bot.id === workA.id).chiefOfStaff).toBe(false);
      expect(bots.find((bot: { id: string }) => bot.id === workB.id).chiefOfStaff).toBe(true);
      expect(bots.find((bot: { id: string }) => bot.id === personal.id).chiefOfStaff).toBe(true);

      // Moving a Chief keeps its role and hands off only in the destination.
      await api("PATCH", `/api/bots/${workB.id}`, { section: "Personal" });
      bots = (await api("GET", "/api/bots")).body.bots;
      expect(bots.find((bot: { id: string }) => bot.id === workB.id).chiefOfStaff).toBe(true);
      expect(bots.find((bot: { id: string }) => bot.id === personal.id).chiefOfStaff).toBe(false);
    } finally {
      for (const bot of [workA, workB, personal]) await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("explains when archived room members cannot respond", async () => {
    const archived = (await api("POST", "/api/bots")).body.bot;
    const active = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Archived member feedback",
      memberIds: [archived.id, active.id],
    })).body.group;

    try {
      expect((await api("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" })).status).toBe(200);
      const archivedBot = await api("PATCH", `/api/bots/${archived.id}`, {
        name: "Quill",
        hidden: true,
        chiefOfStaff: false,
      });
      expect(archivedBot.status).toBe(200);
      await api("PATCH", `/api/bots/${active.id}`, {
        name: "Atlas",
        modelSelection: { instanceId: "ghost", model: "ghost-1" },
      });
      await api("PATCH", `/api/groups/${room.id}`, { defaultResponder: { kind: "mentions" } });

      const archivedError = "Quill is archived and cannot respond. Restore it or mention an active crew member.";
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "@Quill take this" })).status).toBe(202);
      let state = (await api("GET", "/api/bots?messages=20")).body;
      let messages = state.groups.find((group: { id: string }) => group.id === room.id).messages;
      expect(messages.at(-1)).toMatchObject({
        kind: "activity",
        tool: {
          name: archivedError,
          ok: false,
        },
      });

      const beforeMixedMention = messages.filter((message: { tool?: { name?: string } }) =>
        message.tool?.name === archivedError
      ).length;
      await api("POST", `/api/groups/${room.id}/messages`, { text: "@Quill and @Atlas take this" });
      await expect.poll(async () => {
        state = (await api("GET", "/api/bots?messages=20")).body;
        messages = state.groups.find((group: { id: string }) => group.id === room.id).messages;
        return {
          archivedErrors: messages.filter((message: { tool?: { name?: string } }) =>
            message.tool?.name === archivedError
          ).length,
          activeDispatched: messages.some((message: { tool?: { name?: string } }) =>
            message.tool?.name === "error: Atlas's model is unavailable"
          ),
        };
      }).toEqual({ archivedErrors: beforeMixedMention + 1, activeDispatched: true });

      await api("PATCH", `/api/groups/${room.id}`, {
        defaultResponder: { kind: "member", botId: archived.id },
      });
      await api("POST", `/api/groups/${room.id}/messages`, { text: "use the default responder" });
      state = (await api("GET", "/api/bots?messages=20")).body;
      messages = state.groups.find((group: { id: string }) => group.id === room.id).messages;
      expect(messages.at(-1)?.tool).toEqual({ name: archivedError, ok: false });

      await api("PATCH", `/api/groups/${room.id}`, { defaultResponder: { kind: "mentions" } });

      const beforeUnmentioned = messages.length;
      await api("POST", `/api/groups/${room.id}/messages`, { text: "no mention" });
      state = (await api("GET", "/api/bots?messages=20")).body;
      messages = state.groups.find((group: { id: string }) => group.id === room.id).messages;
      expect(messages).toHaveLength(beforeUnmentioned + 1);
      expect(messages.at(-1)).toMatchObject({ kind: "text", role: "user", text: "no mention" });

      await api("PATCH", `/api/bots/${active.id}`, { hidden: true });
      await api("POST", `/api/groups/${room.id}/messages`, { text: "hello everyone" });
      state = (await api("GET", "/api/bots?messages=20")).body;
      messages = state.groups.find((group: { id: string }) => group.id === room.id).messages;
      expect(messages.at(-1)).toMatchObject({
        kind: "activity",
        tool: {
          name: "No active crew members can respond. Restore an archived operator or add an active operator.",
          ok: false,
        },
      });
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${archived.id}`);
      await api("DELETE", `/api/bots/${active.id}`);
    }
  });

  it("saves, serves, and guards image attachments", async () => {
    // a real 1x1 PNG so the bytes round-trip intact
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );

    const wrongType = await fetch(`${BASE}/api/attachments`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not an image",
    });
    expect(wrongType.status).toBe(400);

    const saved = await fetch(`${BASE}/api/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(png),
    });
    expect(saved.status).toBe(201);
    const { path: savedPath, mime, bytes } = z.object({
      path: z.string(),
      mime: z.string(),
      bytes: z.number(),
    }).parse(await saved.json());
    expect(mime).toBe("image/png");
    expect(bytes).toBe(png.byteLength);
    expect(savedPath).toContain("attachments");

    const name = savedPath.split(/[\\/]/).pop();
    const served = await fetch(`${BASE}/api/attachments/${name}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await served.arrayBuffer()).equals(png)).toBe(true);

    // the serving route is name-locked to the attachments dir
    const traversal = await fetch(`${BASE}/api/attachments/..%2F..%2Fconfig.json`);
    expect(traversal.status).toBe(404);
    const unknown = await fetch(`${BASE}/api/attachments/00000000-0000-0000-0000-000000000000.png`);
    expect(unknown.status).toBe(404);

    const tooBig = await fetch(`${BASE}/api/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: Buffer.alloc(IMAGE_MAX_BYTES + 1),
    });
    expect(tooBig.status).toBe(413);
  });

  it("persists only app-owned bot avatars and supported crop shapes", async () => {
    const created = await api("POST", "/api/bots");
    const bot = created.body.bot;
    const avatarUrl = await uploadAvatar("image/webp");

    const saved = await api("PATCH", `/api/bots/${bot.id}`, { avatarUrl, avatarCrop: "rounded" });
    expect(saved.status).toBe(200);
    expect(saved.body.bot).toMatchObject({ avatarUrl, avatarCrop: "rounded" });

    expect((await api("PATCH", `/api/bots/${bot.id}`, {
      avatarUrl: "https://tracker.example/avatar.png",
    })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, {
      avatarUrl: "/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp",
    })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { avatarCrop: "hexagon" })).status).toBe(400);

    const cleared = await api("PATCH", `/api/bots/${bot.id}`, { avatarUrl: null, avatarCrop: "sigil" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.bot.avatarUrl).toBeNull();
    expect(cleared.body.bot.avatarCrop).toBe("sigil");
  });

  it("limits paired profile writes to validated profile fields and broadcasts the result", async () => {
    const created = await api("POST", "/api/bots");
    const bot = created.body.bot;
    const avatarUrl = await uploadAvatar();
    const stream = await openSse(`${BASE}/api/events`);
    try {
      await stream.until((frame) => frame.kind === "hello");
      const saved = await api("PATCH", `/api/bots/${bot.id}/profile`, {
        name: "Paired Profile",
        title: "Mobile-safe agent",
        description: "Only profile data crosses this boundary.",
        notifications: false,
        avatarUrl,
        avatarCrop: "circle",
        voice: "voice_fixture",
        speakReplies: true,
      });
      expect(saved.status).toBe(200);
      expect(saved.body.bot).toMatchObject({
        name: "Paired Profile",
        title: "Mobile-safe agent",
        description: "Only profile data crosses this boundary.",
        notifications: false,
        avatarUrl,
        avatarCrop: "circle",
        voice: "voice_fixture",
        speakReplies: true,
      });
      const frame = await stream.until(
        (candidate) => candidate.kind === "bot" && candidate.bot?.id === bot.id,
      );
      expect(frame.bot).toMatchObject({ id: bot.id, avatarUrl, avatarCrop: "circle" });

      for (const invalid of [
        { color: "red" },
        { avatarUrl: "https://tracker.example/avatar.png" },
        { avatarUrl: "/api/attachments/123e4567-e89b-12d3-a456-426614174000.png" },
        { avatarCrop: "hexagon" },
        { name: 42 },
        { notifications: "yes" },
        { voice: null },
        { speakReplies: 1 },
      ]) {
        expect((await api("PATCH", `/api/bots/${bot.id}/profile`, invalid)).status).toBe(400);
      }

      const cleared = await api("PATCH", `/api/bots/${bot.id}/profile`, {
        avatarUrl: null,
        avatarCrop: "sigil",
        voice: "",
        speakReplies: false,
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body.bot).toMatchObject({
        avatarUrl: null,
        avatarCrop: "sigil",
        voice: "",
        speakReplies: false,
      });
    } finally {
      stream.close();
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("exports every visible bot and imports the team without creating a room", async () => {
    const first = (await api("POST", "/api/bots")).body.bot;
    const second = (await api("POST", "/api/bots")).body.bot;
    const hidden = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${first.id}`, {
      name: "Mira",
      title: "Project Lead",
      description: "Coordinates the crew",
      color: "purple",
      sigilExpression: "focused",
      autoApprove: true,
      alwaysAllow: ["Bash:git"],
    });
    await api("PATCH", `/api/bots/${second.id}`, {
      name: "Scout",
      title: "Researcher",
      description: "Finds evidence",
      color: "cyan",
    });
    await api("PATCH", `/api/bots/${hidden.id}`, { name: "Archived", hidden: true });

    const stateBefore = (await api("GET", "/api/bots")).body;
    const roomsBefore = stateBefore.groups.length;
    const visibleNames = stateBefore.bots
      .filter((bot: { hidden?: boolean }) => !bot.hidden)
      .map((bot: { name: string }) => bot.name);
    const exported = await api("POST", "/api/teams/export", { name: "Field Team" });
    expect(exported.status).toBe(200);
    expect(exported.body).toMatchObject({ format: "helmryth.crew", version: 1, crew: { name: "Field Team" } });
    expect(exported.body.crew.operators.map((member: { name: string }) => member.name)).toEqual(visibleNames);
    expect(exported.body.crew.operators).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "mira", name: "Mira", title: "Project Lead", appearance: { color: "purple", sigilExpression: "focused" } }),
      expect.objectContaining({ key: "scout", name: "Scout", title: "Researcher", appearance: { color: "cyan" } }),
    ]));
    expect(exported.body.crew).not.toHaveProperty("room");
    expect(JSON.stringify(exported.body)).not.toMatch(/Archived|autoApprove|alwaysAllow|modelSelection|threadId/);
    const markdownExport = await api("POST", "/api/teams/export", { name: "Field Team", format: "package" });
    expect(markdownExport.status).toBe(200);
    expect(markdownExport.body).toMatchObject({ name: "Field Team", members: visibleNames.length });
    expect(markdownExport.body.markdown).toContain("## Activation");
    expect(markdownExport.body.markdown).toContain("Give this file to your lead operator");
    expect(markdownExport.body.markdown).not.toMatch(/Archived|autoApprove|alwaysAllow|modelSelection|threadId/);
    expect((await api("GET", "/api/bots")).body.groups).toHaveLength(roomsBefore);
    expect((await api("POST", "/api/teams/export", {})).body.crew.name).toBe("My Helmryth Team");

    const stream = await openSse(`${BASE}/api/events`);
    try {
      await stream.until((frame) => frame.kind === "hello");
      const imported = await importCrew("/api/teams/import", exported.body);
      expect(imported.status).toBe(201);
      // the originals still exist, so every member arrives visibly numbered
      // rather than wearing a name that already resolves to another bot. The
      // starter name is intentionally random, so it can duplicate a member
      // name and advance that member to the next available suffix.
      const importedNames = imported.body.bots.map((bot: { name: string }) => bot.name);
      const namesBefore = new Set(stateBefore.bots.map((bot: { name: string }) => bot.name.toLowerCase()));
      expect(importedNames).toHaveLength(visibleNames.length);
      expect(new Set(importedNames.map((name: string) => name.toLowerCase())).size).toBe(importedNames.length);
      for (const [index, name] of importedNames.entries()) {
        const base = visibleNames[index]!;
        expect(name.startsWith(`${base} `)).toBe(true);
        expect(Number(name.slice(base.length + 1))).toBeGreaterThanOrEqual(2);
        expect(namesBefore.has(name.toLowerCase())).toBe(false);
      }
      expect(imported.body.bots.every((bot: { id: string }) => ![first.id, second.id].includes(bot.id))).toBe(true);
      expect(imported.body.bots[0]).not.toHaveProperty("alwaysAllow");
      // imported bots arrive quiet and without reach: no seeded greeting
      // in their name, and no access to the workspace's connected apps
      // until the user grants it per bot
      expect(imported.body.bots.every((bot: { messages: unknown[] }) => bot.messages.length === 0)).toBe(true);
      expect(imported.body.bots.every((bot: { composio?: boolean }) => bot.composio === false)).toBe(true);
      expect(imported.body).not.toHaveProperty("group");

      const lastImported = imported.body.bots.at(-1)!;
      await stream.until((frame) => frame.kind === "bot" && frame.bot?.id === lastImported.id);
      const importedBotIds = new Set(imported.body.bots.map((bot: { id: string }) => bot.id));
      const importFrames = stream.frames.filter(
        (frame) => frame.kind === "bot" && importedBotIds.has(frame.bot?.id),
      );
      // every imported bot is announced to other windows. The store emits
      // on every write now, so a bot may produce more than one frame —
      // the invariant is coverage, not an exact count.
      for (const id of importedBotIds) expect(importFrames.some((frame) => frame.bot?.id === id)).toBe(true);
      expect(importFrames.every((frame) => frame.kind === "bot")).toBe(true);
      expect((await api("GET", "/api/bots")).body.groups).toHaveLength(roomsBefore);

      const invalid = await importCrew("/api/teams/import", { ...exported.body, version: 3 });
      expect(invalid.status).toBe(400);
      expect((await importCrew("/api/teams/import?mode=erase", exported.body)).status).toBe(400);

      const beforeReplace = (await api("GET", "/api/bots")).body.bots.filter(
        (bot: { hidden?: boolean }) => !bot.hidden,
      );
      const replaced = await importCrew("/api/teams/import?mode=replace", exported.body);
      expect(replaced.status).toBe(201);
      expect(replaced.body.archived.map((bot: { id: string }) => bot.id).sort()).toEqual(
        beforeReplace.map((bot: { id: string }) => bot.id).sort(),
      );
      expect(replaced.body.archivedBots.every((bot: { hidden?: boolean }) => bot.hidden)).toBe(true);
      const afterReplace = (await api("GET", "/api/bots")).body.bots;
      expect(afterReplace.filter((bot: { hidden?: boolean }) => !bot.hidden).map((bot: { id: string }) => bot.id).sort()).toEqual(
        replaced.body.bots.map((bot: { id: string }) => bot.id).sort(),
      );
      expect((await api("GET", "/api/bots")).body.groups).toHaveLength(roomsBefore);

      // Undo is one durable server transaction, not a short-lived sequence of
      // client mutations. Repeating the request is idempotent.
      const undoPath = `/api/teams/imports/${replaced.body.transaction.transactionId}/undo`;
      const undone = await api("POST", undoPath, {});
      expect(undone.status).toBe(200);
      expect((await api("POST", undoPath, {})).status).toBe(200);
      const afterUndo = (await api("GET", "/api/bots")).body.bots;
      expect(afterUndo.filter((bot: { hidden?: boolean }) => !bot.hidden).map((bot: { id: string }) => bot.id).sort()).toEqual(
        beforeReplace.map((bot: { id: string }) => bot.id).sort(),
      );
      expect(afterUndo.some((bot: { id: string }) => replaced.body.bots.some((created: { id: string }) => created.id === bot.id))).toBe(false);

      for (const bot of [first, second, hidden, ...imported.body.bots]) {
        expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
      }
    } finally {
      stream.close();
    }
  });

  it("imports a team as a project: one room, on a folder", async () => {
    // The manifest still describes only people. Room name and folder come
    // from the CALLER, so a manifest fetched from the library cannot create
    // structure in someone's workspace — the property v2 established by
    // dropping its `room` block.
    const seed = await api("POST", "/api/bots", { name: "Planner", title: "Lead", description: "Plans", color: "purple" });
    const exported = await api("POST", "/api/teams/export", { name: "Client XY" });
    expect(exported.body.crew).not.toHaveProperty("room");

    const roomsBefore = (await api("GET", "/api/bots")).body.groups.length;
    const folder = mkdtempSync(join(tmpdir(), "hry-project-"));

    const stream = await openSse(`${BASE}/api/events`);
    try {
      await stream.until((frame) => frame.kind === "hello");

      // A folder that does not exist must not leave half a project behind.
      const bogus = await importCrew(`/api/teams/import?mode=project&cwd=${encodeURIComponent(join(folder, "nope"))}`, exported.body);
      expect(bogus.status).toBe(400);
      expect((await api("GET", "/api/bots")).body.groups).toHaveLength(roomsBefore);

      const created = await importCrew(`/api/teams/import?mode=project&cwd=${encodeURIComponent(folder)}`, exported.body);
      expect(created.status).toBe(201);
      expect(created.body.group).toMatchObject({ name: "Client XY", cwd: folder });
      // the room is made of exactly the bots this import created
      expect(created.body.group.memberIds.sort()).toEqual(created.body.bots.map((bot: { id: string }) => bot.id).sort());
      // the folder is the room's WISH; the store pins it on the first turn
      expect(created.body.group).not.toHaveProperty("pinnedCwd");
      expect((await api("GET", "/api/bots")).body.groups).toHaveLength(roomsBefore + 1);
      await stream.until((frame) => frame.kind === "group" && frame.group?.id === created.body.group.id);

      // an explicit name wins over the team name, and the folder is optional
      const named = await importCrew("/api/teams/import?mode=project&room=Client%20XY%20-%20Ads", exported.body);
      expect(named.body.group).toMatchObject({ name: "Client XY - Ads" });
      expect(named.body.group.cwd).toBeUndefined();

      for (const room of [created.body.group, named.body.group]) {
        expect((await api("DELETE", `/api/groups/${room.id}`)).status).toBe(200);
      }
      for (const bot of [seed.body, ...created.body.bots, ...named.body.bots]) {
        await api("DELETE", `/api/bots/${bot.id}`);
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
      stream.close();
    }
  });

  it("undo removes only imported artifacts and leaves unrelated later work intact", async () => {
    const packageFile = {
      format: "helmryth.package",
      version: 1,
      package: {
        id: "undo-scope",
        release: "1.0.0",
        name: "Undo Scope",
        tagline: "Scope only imported artifacts.",
        summary: "Tests undo boundaries.",
        category: "Research",
        author: { name: "Helmryth" },
        license: "MIT",
        outcomes: ["Verify undo scope."],
        setupMinutes: 1,
        requirements: { apps: [], capabilities: [] },
        agents: [
          { key: "lead", name: "Lead", title: "Lead", description: "Lead", appearance: { color: "cyan" } },
          { key: "scribe", name: "Scribe", title: "Scribe", description: "Scribe", appearance: { color: "green" } },
        ],
        rooms: [{
          key: "scope-room",
          name: "Scope Room",
          members: ["lead", "scribe"],
          bulletin: "",
          defaultResponder: { kind: "agent", agent: "lead" },
        }],
        routines: [{
          key: "scope-routine",
          name: "Scope Routine",
          agent: "lead",
          prompt: "Check scope.",
          runOn: "local",
          schedule: { type: "daily", time: "09:00", weekdays: [1] },
          durationMinutes: 30,
          enabledAfterInstall: false,
        }],
      },
    };

    const imported = await importCrew("/api/teams/import", packageFile);
    expect(imported.status).toBe(201);

    const unrelatedBot = await api("POST", "/api/bots", { name: "Later Bot", title: "Later", description: "Independent" });
    expect(unrelatedBot.status).toBe(201);
    const unrelatedGroup = await api("POST", "/api/groups", { memberIds: [unrelatedBot.body.bot.id], name: "Later Crew" });
    expect(unrelatedGroup.status).toBe(201);
    const unrelatedRoutine = await api("POST", "/api/routines", {
      name: "Later Routine",
      prompt: "Stay put.",
      botId: unrelatedBot.body.bot.id,
      runOn: "local",
      enabled: false,
      schedule: { type: "daily", time: "10:00", weekdays: [1] },
      durationMinutes: 30,
    });
    expect(unrelatedRoutine.status).toBe(201);

    const undone = await api("POST", `/api/teams/imports/${imported.body.transaction.transactionId}/undo`, {});
    expect(undone.status).toBe(200);
    expect(undone.body.bots.some((bot: { id: string }) => bot.id === unrelatedBot.body.bot.id)).toBe(true);
    expect(undone.body.bots.some((bot: { id: string }) => imported.body.bots.some((created: { id: string }) => created.id === bot.id))).toBe(false);
    const [botState, routineState] = await Promise.all([
      api("GET", "/api/bots"),
      api("GET", "/api/routines"),
    ]);
    expect(botState.body.groups.map((group: { id: string }) => group.id)).toContain(unrelatedGroup.body.group.id);
    expect(routineState.body.routines.map((routine: { id: string }) => routine.id)).toContain(unrelatedRoutine.body.routine.id);
    expect(botState.body.groups.map((group: { id: string }) => group.id)).not.toContain(imported.body.groups[0].id);
    expect(routineState.body.routines.map((routine: { id: string }) => routine.id)).not.toContain(imported.body.routines[0].id);
  });

  it("blocks undo when an unrelated crew or cadence still depends on an imported operator", async () => {
    const packageFile = {
      format: "helmryth.package",
      version: 1,
      package: {
        id: "undo-deps",
        release: "1.0.0",
        name: "Undo Deps",
        tagline: "Check dependencies.",
        summary: "Tests dependent artifacts.",
        category: "Research",
        author: { name: "Helmryth" },
        license: "MIT",
        outcomes: ["Verify dependency guard."],
        setupMinutes: 1,
        requirements: { apps: [], capabilities: [] },
        agents: [{ key: "lead", name: "Lead", title: "Lead", description: "Lead", appearance: { color: "cyan" } }],
      },
    };

    const imported = await importCrew("/api/teams/import", packageFile);
    const importedBotId = imported.body.bots[0].id;
    const unrelatedGroup = await api("POST", "/api/groups", { memberIds: [importedBotId], name: "Dependent Crew" });
    expect(unrelatedGroup.status).toBe(201);

    const blockedGroup = await api("POST", `/api/teams/imports/${imported.body.transaction.transactionId}/undo`, {});
    expect(blockedGroup.status).toBe(409);
    expect(blockedGroup.body.code).toBe("IMPORT_IN_USE");
    expect(blockedGroup.body.error).toContain("Dependent Crew");

    await api("DELETE", `/api/groups/${unrelatedGroup.body.group.id}`);
    const dependentRoutine = await api("POST", "/api/routines", {
      name: "Dependent Routine",
      prompt: "Keep imported bot.",
      botId: importedBotId,
      runOn: "local",
      enabled: false,
      schedule: { type: "daily", time: "11:00", weekdays: [1] },
      durationMinutes: 30,
    });
    expect(dependentRoutine.status).toBe(201);

    const blockedRoutine = await api("POST", `/api/teams/imports/${imported.body.transaction.transactionId}/undo`, {});
    expect(blockedRoutine.status).toBe(409);
    expect(blockedRoutine.body.code).toBe("IMPORT_IN_USE");
    expect(blockedRoutine.body.error).toContain("Dependent Routine");
  });

  it("rejects reserved or retired import idempotency keys and limits latest-import lookup", async () => {
    const exported = await api("POST", "/api/teams/export", { name: "Header Guard" });

    const reserved = await api("POST", "/api/teams/import", exported.body, { "idempotency-key": "__proto__" });
    expect(reserved.status).toBe(400);
    expect(reserved.body.code).toBe("INVALID_IDEMPOTENCY_KEY");

    const imported = await importCrew("/api/teams/import", exported.body);
    expect(imported.status).toBe(201);
    const latest = await api("GET", "/api/teams/imports?limit=1");
    expect(latest.status).toBe(200);
    expect(latest.body.imports).toHaveLength(1);
    expect(latest.body.imports[0].transactionId).toBe(imported.body.transaction.transactionId);
    expect(latest.body.imports[0]).toMatchObject({
      name: expect.any(String),
      members: imported.body.bots.length,
      botIds: imported.body.bots.map((bot: { id: string }) => bot.id),
      groupIds: expect.any(Array),
      routineIds: expect.any(Array),
      archived: expect.any(Array),
    });
    expect(latest.body.imports[0]).not.toHaveProperty("result");
    expect(JSON.stringify(latest.body.imports[0])).not.toContain('"messages"');

    expect((await api("POST", `/api/teams/imports/${imported.body.transaction.transactionId}/undo`, {})).status).toBe(200);
    const retired = await api("POST", "/api/teams/import", exported.body, {
      "idempotency-key": imported.body.transaction.idempotencyKey,
    });
    expect(retired.status).toBe(409);
    expect(retired.body.code).toBe("IDEMPOTENCY_KEY_RETIRED");
  });

  it("installs a complete bot package with a Chief, room, playbook, connector intent, and paused routine", async () => {
    const packageFile = {
      format: "helmryth.package",
      version: 1,
      package: {
        id: "signal-desk",
        release: "1.0.0",
        name: "Signal Desk",
        tagline: "Find and explain the signal.",
        summary: "A complete two-bot signal workflow.",
        category: "Research",
        author: { name: "Helmryth" },
        license: "MIT",
        outcomes: ["Produce a concise signal brief."],
        setupMinutes: 4,
        requirements: {
          apps: [{ slug: "reddit", label: "Reddit", reason: "Read approved communities." }],
          capabilities: ["computer"],
        },
        agents: [
          {
            key: "scout",
            name: "Package Scout",
            title: "Researcher",
            description: "Find evidence.",
            appearance: { color: "cyan" },
            playbooks: ["signal-check"],
            autoApprove: true,
          },
          {
            key: "editor",
            name: "Package Editor",
            title: "Editor",
            description: "Explain the result.",
            appearance: { color: "green" },
          },
        ],
        chiefOfStaff: "scout",
        rooms: [{
          key: "signals",
          name: "Signal Room",
          members: ["scout", "editor"],
          bulletin: "Separate direct evidence from inference.",
          defaultResponder: { kind: "agent", agent: "scout" },
        }],
        routines: [{
          key: "morning-signals",
          name: "Morning signals",
          agent: "scout",
          prompt: "Prepare the approved morning signal brief.",
          runOn: "local",
          schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
          durationMinutes: 30,
          enabledAfterInstall: false,
        }],
        playbooks: [{
          key: "signal-check",
          name: "Signal Check",
          summary: "Verify a public signal.",
          triggers: ["signal brief"],
          instructions: "Keep the source URL and confidence.",
        }],
      },
    };

    const installed = await importCrew("/api/teams/import", packageFile);
    expect(installed.status).toBe(201);
    expect(installed.body.bots).toHaveLength(2);
    expect(installed.body.groups).toHaveLength(1);
    expect(installed.body.routines).toHaveLength(1);

    const scout = installed.body.bots.find((bot: { name: string }) => bot.name.startsWith("Package Scout"));
    const editor = installed.body.bots.find((bot: { name: string }) => bot.name.startsWith("Package Editor"));
    expect(scout).toMatchObject({
      chiefOfStaff: true,
      composio: false,
      playbooks: [{ key: "signal-check", instructions: "Keep the source URL and confidence." }],
      installedPackage: {
        id: "signal-desk",
        release: "1.0.0",
        requiredApps: [{ slug: "reddit", label: "Reddit" }],
      },
    });
    expect(scout).not.toHaveProperty("autoApprove");
    expect(editor.playbooks).toBeUndefined();
    expect(scout.section).toBe(editor.section);
    expect(installed.body.groups[0]).toMatchObject({
      name: "Signal Room",
      memberIds: expect.arrayContaining([scout.id, editor.id]),
      defaultResponder: { kind: "member", botId: scout.id },
      bulletin: "Separate direct evidence from inference.",
      setupCompletedAt: expect.any(Number),
    });
    expect(installed.body.routines[0]).toMatchObject({
      name: "Morning signals",
      botId: scout.id,
      enabled: false,
      nextRunAt: null,
    });

    await api("DELETE", `/api/routines/${installed.body.routines[0].id}`);
    await api("DELETE", `/api/groups/${installed.body.groups[0].id}`);
    for (const bot of installed.body.bots) await api("DELETE", `/api/bots/${bot.id}`);
  });

  it("the scout reads a folder, proposes an importable team, and creates nothing until the human imports", async () => {
    const folder = mkdtempSync(join(tmpdir(), "hry-scout-"));
    writeFileSync(join(folder, "README.md"), "# Demo Shop\n\nA storefront demo.\n");
    writeFileSync(
      join(folder, "package.json"),
      JSON.stringify({ dependencies: { react: "^19" }, devDependencies: { vitest: "^3" } }),
    );

    const before = (await api("GET", "/api/bots")).body;

    expect((await api("GET", "/api/teams/scout")).status).toBe(400);
    expect((await api("GET", `/api/teams/scout?cwd=${encodeURIComponent(join(folder, "nope"))}`)).status).toBe(400);

    const scouted = await api("GET", `/api/teams/scout?cwd=${encodeURIComponent(folder)}`);
    expect(scouted.status).toBe(200);
    expect(scouted.body.profile).toMatchObject({ name: "Demo Shop", summary: "A storefront demo." });
    expect(scouted.body.profile.stacks).toContain("React");
    expect(scouted.body.suggestion.roomName).toBe("Demo Shop");
    const keys = scouted.body.suggestion.manifest.crew.operators.map((member: { key: string }) => member.key);
    expect(keys).toEqual(["lead", "frontend", "testing"]);
    expect(Object.keys(scouted.body.suggestion.reasons).sort()).toEqual(keys.slice().sort());

    // scouting is read-only: no bot and no room exists until the import
    const after = (await api("GET", "/api/bots")).body;
    expect(after.bots).toHaveLength(before.bots.length);
    expect(after.groups).toHaveLength(before.groups.length);

    // and the suggestion goes through the real importer verbatim
    const imported = await importCrew(
      `/api/teams/import?mode=project&cwd=${encodeURIComponent(folder)}&room=${encodeURIComponent(scouted.body.suggestion.roomName)}`,
      scouted.body.suggestion.manifest,
    );
    expect(imported.status).toBe(201);
    expect(imported.body.group).toMatchObject({ name: "Demo Shop", cwd: folder });
    expect(imported.body.bots).toHaveLength(3);

    expect((await api("DELETE", `/api/groups/${imported.body.group.id}`)).status).toBe(200);
    for (const bot of imported.body.bots) await api("DELETE", `/api/bots/${bot.id}`);
    rmSync(folder, { recursive: true, force: true });
  });

  it("team import is additive-only: smuggled grants, claimed ids, and re-imports never touch existing records", async () => {
    // an armed bot: every privilege a malicious manifest could try to
    // capture is switched ON here, so any write-through shows up as a diff
    const trusted = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${trusted.id}`, {
      name: "Mira",
      title: "Project Lead",
      autoApprove: true,
      autoReview: "enforce",
      alwaysAllow: ["Bash:git"],
      approvePeerComms: true,
      chiefOfStaff: true,
      composio: true,
      computer: "off",
    });
    const groupsBefore = (await api("GET", "/api/bots")).body.groups.length;
    const room = (await api("POST", "/api/groups", { memberIds: [trusted.id], name: "War Room" })).body.group;

    const smuggled = {
      format: LEGACY_HELMRYTH_TEAM_FORMAT,
      version: 2,
      team: {
        name: "Trap Team",
        members: [
          {
            key: "mira",
            name: "Mira",
            title: "Impostor",
            description: "claims to be the lead",
            appearance: { color: "red" },
            // none of these exist in the manifest format, but a hand-edited
            // file can still claim them — and they must go nowhere
            id: trusted.id,
            threadId: trusted.threadId,
            autoApprove: true,
            autoReview: "enforce",
            alwaysAllow: ["Bash"],
            chiefOfStaff: true,
            approvePeerComms: false,
            composio: true,
            computer: "local",
            cloudBackend: "vps",
            cwd: "/",
            hidden: false,
          },
        ],
      },
    };
    const first = await importCrew("/api/teams/import", smuggled);
    expect(first.status).toBe(201);
    expect(first.body.bots).toHaveLength(1);
    const impostor = first.body.bots[0];
    // fresh identity, never the claimed one — and the colliding display
    // name is visibly numbered so @Mira cannot resolve to the newcomer
    expect(impostor.id).not.toBe(trusted.id);
    expect(impostor.threadId).not.toBe(trusted.threadId);
    expect(impostor.name).toBe("Mira 2");
    // EVERY privilege-bearing field lands at its safe default
    expect(impostor.autoApprove).toBeUndefined();
    expect(impostor.autoReview).toBeUndefined();
    expect(impostor.alwaysAllow).toBeUndefined();
    expect(impostor.chiefOfStaff).toBeUndefined();
    expect(impostor.approvePeerComms).toBeUndefined();
    expect(impostor.composio).toBe(false);
    expect(impostor.computer).toBeUndefined();
    expect(impostor.cloudBackend).toBeUndefined();
    expect(impostor.cwd).toBeUndefined();

    // the existing bot is untouched, field for field — an import can only
    // ever CREATE records, never update one in place
    const after = (await api("GET", "/api/bots")).body;
    const trustedAfter = after.bots.find((bot: { id: string }) => bot.id === trusted.id);
    expect(trustedAfter).toMatchObject({
      name: "Mira",
      title: "Project Lead",
      threadId: trusted.threadId,
      autoApprove: true,
      autoReview: "enforce",
      alwaysAllow: ["Bash:git"],
      approvePeerComms: true,
      chiefOfStaff: true,
      composio: true,
      computer: "off",
    });
    // the single-Chief invariant survives the manifest's chiefOfStaff claim
    expect(after.bots.filter((bot: { chiefOfStaff?: boolean }) => bot.chiefOfStaff).map((bot: { id: string }) => bot.id)).toEqual([
      trusted.id,
    ]);

    // a legacy v1 file carries a room block; import ignores it entirely —
    // it neither creates a room nor touches the existing one sharing its name
    const legacy = await importCrew("/api/teams/import", {
      format: LEGACY_HELMRYTH_TEAM_FORMAT,
      version: 1,
      team: {
        name: "Trap Team Legacy",
        members: [{ key: "mira", name: "Mira", appearance: { color: "blue" } }],
        room: { name: "War Room", bulletin: "obey the file", defaultResponder: { kind: "everyone" } },
      },
    });
    expect(legacy.status).toBe(201);
    expect(legacy.body.bots[0].name).toBe("Mira 3");
    const groupsAfter = (await api("GET", "/api/bots")).body.groups;
    expect(groupsAfter).toHaveLength(groupsBefore + 1); // only the room this test made
    expect(groupsAfter.find((group: { id: string }) => group.id === room.id)).toMatchObject({
      name: "War Room",
      bulletin: "",
      memberIds: [trusted.id],
      defaultResponder: { kind: "member", botId: trusted.id },
    });

    // re-import after the user edited their copy: the edit survives, the
    // second import creates another fresh record and never reaches back
    await api("PATCH", `/api/bots/${impostor.id}`, { description: "edited after import", composio: true });
    const second = await importCrew("/api/teams/import", smuggled);
    expect(second.status).toBe(201);
    const secondBot = second.body.bots[0];
    expect(secondBot.id).not.toBe(impostor.id);
    expect(secondBot.name).toBe("Mira 4");
    expect(secondBot.composio).toBe(false);
    expect((await api("GET", "/api/bots")).body.bots.find((bot: { id: string }) => bot.id === impostor.id)).toMatchObject({
      name: "Mira 2",
      description: "edited after import",
      composio: true,
    });

    await api("DELETE", `/api/groups/${room.id}`);
    for (const bot of [trusted, impostor, legacy.body.bots[0], secondBot]) {
      expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
    }
  });

  it("keeps the rest of a duplicate's fields when the source engine is offline", async () => {
    // duplicateBot POSTs a blank bot, then PATCHes the source's whole
    // modelSelection in one body beside its name, title and description.
    // "ghost" is an unknown driver, so the registry resolves nothing and the
    // level cannot be verified — which must not cost the copy everything
    // else in the request.
    const copy = (await api("POST", "/api/bots")).body.bot;

    const patched = await api("PATCH", `/api/bots/${copy.id}`, {
      name: "Reviewer copy",
      title: "Reviewer",
      description: "reads diffs",
      modelSelection: { instanceId: "ghost", model: "ghost-1", effort: "xhigh" },
    });

    expect(patched.status).toBe(200);
    expect(patched.body.bot).toMatchObject({
      name: "Reviewer copy",
      title: "Reviewer",
      description: "reads diffs",
      modelSelection: { instanceId: "ghost", model: "ghost-1", effort: "xhigh" },
    });
  });

  it("rejects an unknown effort value even while the engine is offline", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const patched = await api("PATCH", `/api/bots/${bot.id}`, {
      modelSelection: { instanceId: "ghost", model: "ghost-1", effort: "turbo" },
    });

    expect(patched.status).toBe(400);
    expect(patched.body.error).toContain("not recognized");
  });

  it("creates a fully configured bot in one request and greets with its final name", async () => {
    const created = await api("POST", "/api/bots", {
      name: "  Pathfinder  ",
      title: "Researcher",
      description: "Maps the problem before acting.",
      section: "  Work  ",
      modelSelection: { instanceId: "  ghost  ", model: "  ghost-1  ", effort: "high" },
    });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    try {
      expect(bot).toMatchObject({
        name: "Pathfinder",
        title: "Researcher",
        description: "Maps the problem before acting.",
        section: "Work",
        modelSelection: { instanceId: "ghost", model: "ghost-1", effort: "high" },
      });
      expect(bot.messages[0].text).toContain("Pathfinder");
      expect(bot.messages[0].text).not.toContain("Sigil");
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("opts MCP-style model writes into the current live catalog without narrowing general writes", async () => {
    const instances = (await api("GET", "/api/instances")).body.instances;
    const claude = instances.find((instance: { instanceId: string }) => instance.instanceId === "claude");
    expect(claude.snapshot.state).toBe("available");
    const customModel = `${claude.models.default}-custom`;
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const general = await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: customModel },
      });
      expect(general.status).toBe(200);
      expect(general.body.bot.modelSelection.model).toBe(customModel);

      const strictPatch = await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: customModel },
        requireAvailableModel: true,
      });
      expect(strictPatch.status).toBe(400);
      expect(strictPatch.body.error).toMatch(/not offered/i);

      const beforeIds = (await api("GET", "/api/bots?messages=0")).body.bots.map(
        (candidate: { id: string }) => candidate.id,
      );
      const strictCreate = await api("POST", "/api/bots", {
        name: "Should not exist",
        modelSelection: { instanceId: "claude", model: customModel },
        requireAvailableModel: true,
      });
      expect(strictCreate.status).toBe(400);
      const afterIds = (await api("GET", "/api/bots?messages=0")).body.bots.map(
        (candidate: { id: string }) => candidate.id,
      );
      expect(afterIds).toEqual(beforeIds);

      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        requireAvailableModel: "yes",
      })).status).toBe(400);
      expect((await api("POST", "/api/bots", {
        name: "Missing selection",
        requireAvailableModel: true,
      })).status).toBe(400);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("rejects incomplete model selections instead of persisting a broken bot", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const missingModel = await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "ghost" },
      });
      expect(missingModel.status).toBe(400);
      expect(missingModel.body.error).toContain("modelSelection.model");

      const missingInstance = await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { model: "ghost-1" },
      });
      expect(missingInstance.status).toBe(400);
      expect(missingInstance.body.error).toContain("modelSelection.instanceId");

      const reread = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(reread.modelSelection).toEqual(bot.modelSelection);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("refuses to switch a bot's active task while its turn is running", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const instances = (await api("GET", "/api/instances")).body.instances;
      const claude = instances.find((instance: { instanceId: string }) => instance.instanceId === "claude");
      expect(claude.snapshot.state).toBe("available");
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: claude.models.default },
      })).status).toBe(200);

      const originalTask = bot.threadId;
      const created = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Running task" });
      expect(created.status).toBe(201);
      const runningTask = created.body.task.threadId;
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "keep running" })).status).toBe(202);

      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        return state?.busy;
      }).toBe(true);

      const blocked = await api("POST", `/api/bots/${bot.id}/tasks/${originalTask}`);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toMatch(/stop it before switching runs/i);
      const current = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(current.threadId).toBe(runningTask);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("refuses to interrupt a conversation after its active task changed", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Exact stop", memberIds: [bot.id] })).body.group;
    try {
      const wrongBot = await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: "old-task" });
      expect(wrongBot.status).toBe(409);
      const wrongRoom = await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: "old-task" });
      expect(wrongRoom.status).toBe(409);
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
      expect((await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);
      for (const route of [`/api/bots/${bot.id}/interrupt`, `/api/groups/${room.id}/interrupt`]) {
        const compatibleNull = await fetch(`${BASE}${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "null",
        });
        expect(compatibleNull.status).toBe(200);
        const rejectedArray = await fetch(`${BASE}${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "[]",
        });
        expect(rejectedArray.status).toBe(400);
      }
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("answers a JSON null body with 400, never a 500 carrying a V8 TypeError", async () => {
    // `null` parses to JS null, and a handler reading a field off it threw
    // "Cannot read properties of null (reading 'x')" — surfaced as a 500, so a
    // malformed request looked like a server crash and leaked engine internals.
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Null bodies", memberIds: [bot.id] })).body.group;
    try {
      const routes = [
        `/api/bots/${bot.id}/respond`,
        `/api/bots/${bot.id}/tasks`,
        `/api/bots/${bot.id}/active-branch`,
        `/api/tts/prepare`,
        `/api/team-library/github`,
        `/api/teams/import`,
      ];
      for (const route of routes) {
        const response = await fetch(`${BASE}${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "null",
        });
        expect(response.status, `${route} must not 500 on a null body`).toBe(400);
        // SAFETY: every error path on this boundary answers { error: string }.
        const failure = (await response.json()) as { error?: string };
        expect(String(failure.error), route).not.toMatch(/Cannot read properties|TypeError|undefined/);
      }
      // PATCH surfaces answer the same way.
      for (const route of [`/api/groups/${room.id}/setup`, `/api/bots/${bot.id}`]) {
        const response = await fetch(`${BASE}${route}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: "null",
        });
        expect(response.status, route).toBe(400);
        // SAFETY: as above — the 400 contract is { error: string }.
        const patchBody = (await response.json()) as { error?: string };
        expect(String(patchBody.error), route).not.toMatch(/Cannot read properties/);
      }
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("clamps a fractional search limit instead of leaking the SQLite bind error", async () => {
    // Math.min/Math.max preserved the fraction and SQLite refused to bind 1.9 to
    // an INTEGER parameter, so the driver's "datatype mismatch" went out as a 500.
    for (const limit of ["1.9", "2.5", "0.5", "99.99"]) {
      const response = await fetch(`${BASE}/api/search?q=a&limit=${limit}`);
      expect(response.status, `limit=${limit}`).toBe(200);
      // SAFETY: search answers { hits } on success and { error } on failure;
      // this assertion only reads the optional error field.
      const body = (await response.json()) as { error?: string };
      expect(String(body.error ?? ""), `limit=${limit}`).not.toMatch(/datatype mismatch/);
    }
  });

  it("pins sends to the expected task and offers compact switch responses", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Pinned sends", memberIds: [bot.id] })).body.group;
    try {
      const wrongBot = await api("POST", `/api/bots/${bot.id}/messages`, {
        text: "Do not reroute me",
        threadId: "old-task",
      });
      expect(wrongBot.status).toBe(409);
      expect(wrongBot.body.error).toMatch(/switched runs/i);

      const wrongRoom = await api("POST", `/api/groups/${room.id}/messages`, {
        text: "Do not reroute me",
        threadId: "old-task",
      });
      expect(wrongRoom.status).toBe(409);
      expect(wrongRoom.body.error).toMatch(/switched runs/i);

      const botOriginal = bot.threadId;
      const botTask = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Second" });
      expect(botTask.status).toBe(201);
      const compactBot = await api("POST", `/api/bots/${bot.id}/tasks/${botOriginal}?messages=0`, {});
      expect(compactBot.status).toBe(200);
      expect(compactBot.body.bot.threadId).toBe(botOriginal);
      expect(compactBot.body.bot.tasks).toHaveLength(2);
      expect(compactBot.body.bot).not.toHaveProperty("messages");
      expect(compactBot.body.bot).not.toHaveProperty("activeLeafId");

      const roomOriginal = room.threadId;
      const roomTask = await api("POST", `/api/groups/${room.id}/tasks`, { title: "Second" });
      expect(roomTask.status).toBe(201);
      const compactRoom = await api("POST", `/api/groups/${room.id}/tasks/${roomOriginal}?messages=0`, {});
      expect(compactRoom.status).toBe(200);
      expect(compactRoom.body.group.threadId).toBe(roomOriginal);
      expect(compactRoom.body.group.tasks).toHaveLength(2);
      expect(compactRoom.body.group).not.toHaveProperty("messages");
      expect(compactRoom.body.group).not.toHaveProperty("activeLeafId");
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, {});
      await api("DELETE", `/api/groups/${room.id}`);
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("leaves a bot with no effort level untouched", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    expect(bot.modelSelection.effort).toBeUndefined();

    const renamed = await api("PATCH", `/api/bots/${bot.id}`, { name: "Plain" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.bot.modelSelection.effort).toBeUndefined();
  });

  // This fixture pins a single unknown driver, so no instance here ever
  // resolves: these cover the gate's pass-through and the store's replace
  // semantics, NOT the comparison against a live engine's declared list.
  // That branch has no coverage at this layer, and manufacturing a live
  // instance in this fixture would cost it its no-probe determinism.
  it("round-trips an effort level and clears it when the key is dropped", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const selection = { instanceId: "ghost", model: "ghost-1" };

    const set = await api("PATCH", `/api/bots/${bot.id}`, {
      modelSelection: { ...selection, effort: "high" },
    });
    expect(set.status).toBe(200);
    expect(set.body.bot.modelSelection.effort).toBe("high");

    const reread = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === bot.id);
    expect(reread.modelSelection.effort).toBe("high");

    // The panel's "Default" button spreads the selection with effort:
    // undefined, and JSON.stringify drops the key — so clearing reaches the
    // server as a modelSelection carrying no effort at all.
    const cleared = await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: selection });
    expect(cleared.status).toBe(200);

    const after = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === bot.id);
    expect(after.modelSelection).toEqual(selection);
    expect(after.modelSelection.effort).toBeUndefined();
  });

  it("grants Auto on this computer only through the warning acknowledgement", async () => {
    const created = await api("POST", "/api/bots");
    const bot = created.body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true })).body.bot.autoApprove).toBe(
      true,
    );

    // The important half: a blind PATCH — exactly what a bot curling the
    // loopback API from a tool call would send — must be refused. The
    // renderer's warning dialog is not a boundary; this 400 is.
    const blind = await api("PATCH", `/api/bots/${bot.id}`, { computer: "local" });
    expect(blind.status).toBe(400);
    const oneShot = await api("PATCH", `/api/bots/${bot.id}`, { computer: "local", autoApprove: true });
    expect(oneShot.status).toBe(400);
    const after = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === bot.id);
    expect(after.computer).not.toBe("local");

    // The dialog's acknowledgement grants it, and the flag is not persisted.
    const local = await api("PATCH", `/api/bots/${bot.id}`, { computer: "local", acknowledgeLocalAuto: true });
    expect(local.status).toBe(200);
    expect(local.body.bot).toMatchObject({ computer: "local", autoApprove: true });
    expect(local.body.bot.acknowledgeLocalAuto).toBeUndefined();

    // Once granted, re-asserting auto and unrelated PATCHes need no re-ack.
    const enabled = await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body.bot.autoApprove).toBe(true);

    // The other direction needs the warning too: local first, then auto.
    await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: false });
    const autoBlind = await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true });
    expect(autoBlind.status).toBe(400);
    const autoAcked = await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, acknowledgeLocalAuto: true });
    expect(autoAcked.status).toBe(200);

    // Leaving local ends the grant; coming back needs the warning again.
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off" });
    const back = await api("PATCH", `/api/bots/${bot.id}`, { computer: "local" });
    expect(back.status).toBe(400);
    await api("DELETE", `/api/bots/${bot.id}`);
  });

  it("stores only known approval-review modes", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    for (const autoReview of ["off", "shadow", "enforce"]) {
      const response = await api("PATCH", `/api/bots/${bot.id}`, { autoReview });
      expect(response.status).toBe(200);
      expect(response.body.bot.autoReview).toBe(autoReview);
    }
    expect((await api("PATCH", `/api/bots/${bot.id}`, { autoReview: "always" })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { autoReview: true })).status).toBe(400);
    await api("DELETE", `/api/bots/${bot.id}`);
  });

  it("offers an idempotent stop boundary for active local turns", async () => {
    const unsupportedResponse = await fetch(`${BASE}/api/local-computer/interrupt`, { method: "POST" });
    expect(unsupportedResponse.status).toBe(415);
    expect(await unsupportedResponse.json()).toEqual({ error: "content-type must be application/json" });
    const stopped = await api("POST", "/api/local-computer/interrupt");
    expect(stopped).toEqual({ status: 200, body: { ok: true } });
  });

  it("persists an answered onboarding card", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const card = bot.messages.find((m: { kind: string }) => m.kind === "options");
    const res = await api("PATCH", `/api/bots/${bot.id}/cards/${card.id}`, { answered: card.card.options[0] });
    expect(res.status).toBe(200);
    expect(res.body.message.card.answered).toBe(card.card.options[0]);
  });

  it("validates approval decisions and reports a request that is no longer open", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];

    const invalid = await api("POST", `/api/bots/${bot.id}/respond`, {
      requestId: "gone",
      behavior: "approve-everything",
    });
    expect(invalid.status).toBe(400);

    const unavailable = await api("POST", `/api/bots/${bot.id}/respond`, {
      requestId: "gone",
      behavior: "allow",
    });
    expect(unavailable.status).toBe(200);
    expect(unavailable.body).toEqual({ ok: true, outcome: "unavailable" });

    const reread = (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
    expect(reread.messages.at(-1).tool).toMatchObject({ ok: false });
    expect(reread.messages.at(-1).tool.name).toContain("request is no longer open");
  });

  it("answers a room approval whose turn is already over instead of stranding the room", async () => {
    // busyBotId lives in memory only, so a card that outlives its turn (or the
    // process) has no speaker. The room must still be answerable: a pending
    // approval takes over the composer, so a dead end locks the room for good.
    const answered = await api("POST", "/api/threads/test-stranded-room-thread/respond", {
      requestId: "stranded-request",
      behavior: "allow",
    });
    expect(answered.status).toBe(200);
    expect(answered.body).toEqual({ ok: true, outcome: "unavailable" });

    const room = (await api("GET", "/api/bots")).body.groups.find(
      (group: { id: string }) => group.id === "test-stranded-room",
    );
    const card = room.messages.find((message: { id: string }) => message.id === "stranded-card").card;
    expect(card.dismissed).toBe(true);
    expect(card.answered).toBe("unavailable");

    // a room with nothing pending still reports that plainly
    const nothing = await api("POST", "/api/threads/test-pinned-room-thread/respond", {
      requestId: "never-existed",
      behavior: "allow",
    });
    expect(nothing.status).toBe(404);
  });

  it("closes the approvals a cancelled turn can no longer answer", async () => {
    // "Cancel turn" is a button ON the approval card, and a pending approval
    // owns the composer. Stopping the turn without closing its card leaves the
    // room blocked by a question whose asker is already gone.
    const stopped = await api("POST", "/api/groups/test-cancel-room/interrupt");
    expect(stopped.status).toBe(200);

    const room = (await api("GET", "/api/bots")).body.groups.find(
      (group: { id: string }) => group.id === "test-cancel-room",
    );
    const card = room.messages.find((message: { id: string }) => message.id === "cancel-card").card;
    expect(card.dismissed).toBe(true);
    expect(card.answered).toBe("unavailable");
  });

  it("rejects an empty message and explains an unavailable provider", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    try {
      expect((await api("PATCH", `/api/bots/${created.id}`, {
        modelSelection: { instanceId: "ghost", model: "ghost-1" },
      })).status).toBe(200);

      const empty = await api("POST", `/api/bots/${created.id}/messages`, { text: "   " });
      expect(empty.status).toBe(400);

      const before = (await api("GET", "/api/bots")).body.bots.find(
        (candidate: { id: string }) => candidate.id === created.id,
      );
      const send = await api("POST", `/api/bots/${created.id}/messages`, { text: "hello?" });
      expect(send.status).toBe(409);
      expect(send.body.error).toContain("unavailable");

      const afterFail = (await api("GET", "/api/bots")).body.bots.find(
        (candidate: { id: string }) => candidate.id === created.id,
      );
      expect(afterFail.messages).toHaveLength(before.messages.length);
      expect(afterFail.messages.find((m: { kind: string }) => m.kind === "options")?.card.dismissed).toBeFalsy();
      expect(afterFail.messages.some((m: { role: string; text?: string }) => m.role === "user" && m.text === "hello?")).toBe(false);
    } finally {
      await api("DELETE", `/api/bots/${created.id}`);
    }
  });

  it("refuses to fork a message when the provider is unavailable, without mutating", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    try {
      const instances = (await api("GET", "/api/instances")).body.instances;
      const claude = instances.find((instance: { instanceId: string }) => instance.instanceId === "claude");
      expect(claude.snapshot.state).toBe("available");
      expect((await api("PATCH", `/api/bots/${created.id}`, {
        modelSelection: { instanceId: "claude", model: claude.models.default },
      })).status).toBe(200);
      expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "editable source" })).status).toBe(202);

      expect((await api("POST", `/api/bots/${created.id}/interrupt`)).status).toBe(200);
      await expect.poll(async () => {
        const current = (await api("GET", "/api/bots?messages=20")).body.bots.find(
          (candidate: { id: string }) => candidate.id === created.id,
        );
        return current?.busy;
      }, { timeout: 5_000 }).toBe(false);

      const settled = (await api("GET", "/api/bots?messages=20")).body.bots.find(
        (candidate: { id: string }) => candidate.id === created.id,
      );
      const before = settled.messages.length;
      const source = settled.messages.find(
        (message: { role: string; kind: string; text?: string }) =>
          message.role === "user" && message.kind === "text" && message.text === "editable source",
      );
      expect(source).toBeTruthy();

      expect((await api("PATCH", `/api/bots/${created.id}`, {
        modelSelection: { instanceId: "ghost", model: "ghost-1" },
      })).status).toBe(200);

      const edit = await api("POST", `/api/bots/${created.id}/messages/${source.id}/edit`, { text: "edited source" });
      expect(edit.status).toBe(409);
      expect(edit.body.error).toContain("unavailable");

      const after = (await api("GET", "/api/bots?messages=20")).body.bots.find(
        (candidate: { id: string }) => candidate.id === created.id,
      );
      expect(after.messages.length).toBe(before);
      expect(after.messages.some((message: { text?: string }) => message.text === "edited source")).toBe(false);
    } finally {
      await api("POST", `/api/bots/${created.id}/interrupt`, {}).catch(() => undefined);
      await api("DELETE", `/api/bots/${created.id}`);
    }
  });

  it("switches the active branch and reports the new leaf", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    try {
      expect((await api("PATCH", `/api/bots/${created.id}`, {
        modelSelection: { instanceId: "ghost", model: "ghost-1" },
      })).status).toBe(200);

      const bot = (await api("GET", "/api/bots?messages=20")).body.bots.find(
        (candidate: { id: string }) => candidate.id === created.id,
      );
      expect(bot.activeLeafId).toBe(bot.messages.at(-1).id);

      // pointing at the first message descends back to the newest leaf on
      // that (only) branch — a no-op switch, but it exercises the descent
      const res = await api("POST", `/api/bots/${created.id}/active-branch`, { messageId: bot.messages[0].id });
      expect(res.status).toBe(200);
      expect(res.body.activeLeafId).toBe(bot.messages.at(-1).id);

      const missing = await api("POST", `/api/bots/${created.id}/active-branch`, { messageId: "nope" });
      expect(missing.status).toBe(404);
    } finally {
      await api("POST", `/api/bots/${created.id}/interrupt`, {}).catch(() => undefined);
      await api("DELETE", `/api/bots/${created.id}`);
    }
  });

  it("refuses a box token the provider rejects, at the point of pasting", async () => {
    // the stub answers 401 for anything but the good token
    const bad = await api("PUT", "/api/config", { box: { token: "box_wrong" } });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/rejected/i);
    const after = await api("GET", "/api/config");
    expect(after.body.box).toEqual({ configured: false });
  });

  it("saves config keys write-only and reports booleans", async () => {
    const before = await api("GET", "/api/config");
    expect(before.body.box).toEqual({ configured: false });

    const put = await api("PUT", "/api/config", { box: { token: "box_good" } });
    expect(put.status).toBe(200);
    expect(put.body.box).toEqual({ configured: true });
    expect(JSON.stringify(put.body)).not.toContain("box_good");

    const after = await api("GET", "/api/config");
    expect(after.body.box).toEqual({ configured: true });
    expect(JSON.stringify(after.body)).not.toContain("box_good");

    const nothing = await api("PUT", "/api/config", {});
    expect(nothing.status).toBe(400);
  });

  it("validates and persists the global room turn timeout", async () => {
    const before = await api("GET", "/api/config");
    expect(before.status).toBe(200);
    expect(before.body.rooms).toEqual({ turnTimeoutMinutes: 5 });

    for (const turnTimeoutMinutes of [0, 1.5, 1441, "20", null]) {
      const invalid = await api("PUT", "/api/config", { rooms: { turnTimeoutMinutes } });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toContain("rooms.turnTimeoutMinutes");
    }

    const saved = await api("PUT", "/api/config", { rooms: { turnTimeoutMinutes: 20 } });
    expect(saved.status).toBe(200);
    expect(saved.body.rooms).toEqual({ turnTimeoutMinutes: 20 });

    const after = await api("GET", "/api/config");
    expect(after.body.rooms).toEqual({ turnTimeoutMinutes: 20 });

    const disk = JSON.parse(readFileSync(join(home, ".helmryth", "config.json"), "utf8"));
    expect(disk.rooms).toEqual({ turnTimeoutMinutes: 20 });

    await api("PUT", "/api/config", { rooms: { turnTimeoutMinutes: 5 } });
  });

  it("keeps Teach a skill off by default and persists an explicit opt-in", async () => {
    const before = await api("GET", "/api/config");
    expect(before.status).toBe(200);
    expect(before.body.features).toEqual({ browser: true, skillRecorder: false, showToolCalls: false });

    const saved = await api("PATCH", "/api/config", {
      features: { skillRecorder: true },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.features).toEqual({ browser: true, skillRecorder: true, showToolCalls: false });

    const disk = JSON.parse(readFileSync(join(home, ".helmryth", "config.json"), "utf8"));
    expect(disk.features).toEqual({ skillRecorder: true });

    const tools = await api("PATCH", "/api/config", { features: { showToolCalls: true } });
    expect(tools.status).toBe(200);
    expect(tools.body.features).toEqual({ browser: true, skillRecorder: true, showToolCalls: true });

    await api("PATCH", "/api/config", { features: { skillRecorder: false, showToolCalls: false } });
  });

  it("keeps shared Local VM mode by default and resolves isolated targets per bot when enabled", async () => {
    const first = (await api("POST", "/api/bots")).body.bot;
    const second = (await api("POST", "/api/bots")).body.bot;
    const before = await api("GET", "/api/config");
    expect(before.body.localVm).toEqual({ mode: "shared", maxInstances: 2 });

    const shared = await api("GET", `/api/bots/${first.id}/local-computer`);
    expect(shared.status).toBe(200);
    expect(shared.body).toMatchObject({ mode: "shared", target_key: "shared" });

    const saved = await api("PATCH", "/api/config", {
      localVm: { mode: "per-bot", maxInstances: 3 },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.localVm).toEqual({ mode: "per-bot", maxInstances: 3 });

    const [firstStatus, secondStatus] = await Promise.all([
      api("GET", `/api/bots/${first.id}/local-computer`),
      api("GET", `/api/bots/${second.id}/local-computer`),
    ]);
    expect(firstStatus.body).toMatchObject({ mode: "per-bot", max_instances: 3 });
    expect(secondStatus.body).toMatchObject({ mode: "per-bot", max_instances: 3 });
    expect(firstStatus.body.target_key).not.toBe(secondStatus.body.target_key);
    expect(firstStatus.body.container_name).not.toBe(secondStatus.body.container_name);
    expect(firstStatus.body.workspace_path).not.toBe(secondStatus.body.workspace_path);

    const invalid = await api("PATCH", "/api/config", { localVm: { maxInstances: 5 } });
    expect(invalid.status).toBe(400);
    // Zod's own words ("localVm.maxInstances Too big: expected number to be
    // <=4") used to reach the caller here, next to hand-written siblings like
    // "stop Local VM turns and setup actions before changing the Local VM
    // isolation mode".
    expect(invalid.body.error).toBe("localVm.maxInstances must be a whole number of dedicated VMs from 1 to 4");
    expect(invalid.body.error).not.toMatch(/Too big|expected number/);
    const namelessProfile = await api("PATCH", "/api/config", { browserProfiles: [{ id: "work" }] });
    expect(namelessProfile.status).toBe(400);
    expect(namelessProfile.body.error).toBe("each browser profile needs a name of 1 to 40 characters");
    expect(namelessProfile.body.error).not.toMatch(/Invalid input|expected string/);

    const disk = JSON.parse(readFileSync(join(home, ".helmryth", "config.json"), "utf8"));
    expect(disk.localVm).toEqual({ mode: "per-bot", maxInstances: 3 });
    await api("PATCH", "/api/config", { localVm: { mode: "shared", maxInstances: 2 } });
  });

  it("refuses a standing permission at the cap instead of silently evicting one", async () => {
    // Both grant paths appended and then sliced to 200: the roster PATCH the
    // approval dialog uses dropped the key the user had just been told was
    // granted, and the gate route dropped the OLDEST rule, so a gate already
    // answered forever quietly started asking again. Neither said anything.
    const instances = (await api("GET", "/api/instances")).body.instances;
    const gateInstance = z.object({
      instanceId: z.literal("cadenceGate"),
      models: z.object({ default: z.string() }),
    }).passthrough().parse(instances.find((instance: { instanceId: string }) => instance.instanceId === "cadenceGate"));
    const bot = (await api("POST", "/api/bots", {
      modelSelection: { instanceId: gateInstance.instanceId, model: gateInstance.models.default },
    })).body.bot;
    const full = Array.from({ length: 200 }, (_unused, index) => `Bash:rule-${index}`);
    try {
      expect((await api("PATCH", `/api/bots/${bot.id}`, { alwaysAllow: full })).status).toBe(200);
      const overflowed = await api("PATCH", `/api/bots/${bot.id}`, { alwaysAllow: [...full, "Bash:one-too-many"] });
      expect(overflowed.status).toBe(400);
      expect(overflowed.body.error).toContain("at most 200 standing permissions");

      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "run the gated fixture" })).status).toBe(202);
      let pendingAllowKey = "";
      await expect.poll(async () => {
        const fresh = (await api("GET", "/api/bots")).body.bots
          .find((candidate: { id: string }) => candidate.id === bot.id);
        const card = (fresh?.messages ?? [])
          .map((message: { card?: { allowKey?: string; answered?: boolean } }) => message.card)
          .find((candidate: { allowKey?: string; answered?: boolean } | undefined) =>
            Boolean(candidate?.allowKey) && candidate?.answered !== true);
        pendingAllowKey = card?.allowKey ?? "";
        return pendingAllowKey;
      }, { timeout: 15_000 }).not.toBe("");

      const granted = await api("POST", `/api/bots/${bot.id}/always-allow`, { allowKey: pendingAllowKey });
      expect(granted.status).toBe(409);
      expect(granted.body.error).toContain("already keeps 200 standing permissions");
      const stored = (await api("GET", "/api/bots?messages=0")).body.bots
        .find((candidate: { id: string }) => candidate.id === bot.id);
      // Nothing was evicted to make room, and the refused grant did not land.
      expect(stored.alwaysAllow).toEqual(full);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`).catch(() => undefined);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  }, 30_000);

  it("keeps an active turn alive when only the room timeout changes", async () => {
    const created = await api("POST", "/api/bots", {});
    const botId = created.body.bot.id;
    const room = (await api("POST", "/api/groups", {
      name: "Room timeout capture",
      memberIds: [botId],
    })).body.group;
    const ready = await api("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" });
    expect(ready.status).toBe(200);
    try {
      const selected = await api("PATCH", `/api/bots/${botId}`, {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      });
      expect(selected.status).toBe(200);

      rmSync(fakeClaudeDump, { force: true });
      const sent = await api("POST", `/api/groups/${room.id}/messages`, { text: "stay active" });
      expect(sent.status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);

      const before = (await api("GET", "/api/bots")).body;
      expect(before.bots.find((bot: { id: string }) => bot.id === botId)?.busy).toBe(true);
      expect(before.groups.find((group: { id: string }) => group.id === room.id)?.busyBotId).toBe(botId);

      const saved = await api("PUT", "/api/config", { rooms: { turnTimeoutMinutes: 20 } });
      expect(saved.status).toBe(200);

      const after = (await api("GET", "/api/bots")).body;
      expect(after.bots.find((bot: { id: string }) => bot.id === botId)?.busy).toBe(true);
      const activeRoom = after.groups.find((group: { id: string }) => group.id === room.id);
      expect(activeRoom?.busyBotId).toBe(botId);
      expect(activeRoom.messages.some((message: { tool?: { name?: string } }) =>
        message.tool?.name?.includes("provider settings changed"),
      )).toBe(false);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots")).body;
        return {
          botBusy: state.bots.find((bot: { id: string }) => bot.id === botId)?.busy,
          roomBusyBotId: state.groups.find((group: { id: string }) => group.id === room.id)?.busyBotId,
        };
      }, { timeout: 5_000 }).toEqual({ botBusy: false, roomBusyBotId: null });
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${botId}`);
      await api("PUT", "/api/config", { rooms: { turnTimeoutMinutes: 5 } });
    }
  });

  it("tracks and interrupts the whole queued channel turn", async () => {
    const first = (await api("POST", "/api/bots", {})).body.bot;
    const second = (await api("POST", "/api/bots", {})).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Queued channel turn",
      memberIds: [first.id, second.id],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    })).body.group;
    try {
      for (const bot of [first, second]) {
        const selected = await api("PATCH", `/api/bots/${bot.id}`, {
          modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
        });
        expect(selected.status).toBe(200);
      }

      const sent = await api("POST", `/api/groups/${room.id}/messages`, {
        text: "both bots should answer",
        threadId: room.threadId,
      });
      expect(sent.status).toBe(202);

      // The operation is registered before any awaited provider setup. Polling
      // and structural guards therefore cannot see a false idle window.
      const immediate = (await api("GET", "/api/bots?messages=0")).body;
      expect(immediate.groups.find((group: { id: string }) => group.id === room.id)?.working).toBe(true);
      expect((await api("POST", `/api/groups/${room.id}/tasks`, { title: "Too soon" })).status).toBe(409);
      expect((await api("PATCH", `/api/groups/${room.id}`, { memberIds: [first.id] })).status).toBe(409);

      const interrupted = await api("POST", `/api/groups/${room.id}/interrupt`, {
        threadId: room.threadId,
      });
      expect(interrupted.status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        const currentRoom = state.groups.find((group: { id: string }) => group.id === room.id);
        return {
          working: currentRoom?.working,
          busyBotId: currentRoom?.busyBotId,
          busyBots: state.bots
            .filter((bot: { id: string; busy: boolean }) =>
              (bot.id === first.id || bot.id === second.id) && bot.busy,
            )
            .map((bot: { id: string }) => bot.id),
        };
      }, { timeout: 5_000 }).toEqual({ working: false, busyBotId: null, busyBots: [] });

      // Cancellation must be durable for the queued remainder, not merely
      // interrupt whichever responder happened to own the process.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const settled = (await api("GET", "/api/bots?messages=0")).body;
      expect(settled.groups.find((group: { id: string }) => group.id === room.id)?.working).toBe(false);
      expect(settled.bots.filter((bot: { id: string; busy: boolean }) =>
        (bot.id === first.id || bot.id === second.id) && bot.busy,
      )).toHaveLength(0);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId });
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${first.id}`);
      await api("DELETE", `/api/bots/${second.id}`);
    }
  });

  it("tracks and cancels a queued channel credential continuation before provider dispatch", async () => {
    const first = (await api("POST", "/api/bots", {})).body.bot;
    const second = (await api("POST", "/api/bots", {})).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Credential continuation",
      memberIds: [first.id, second.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: first.id } },
    })).body.group;
    try {
      for (const bot of [first, second]) {
        const selected = await api("PATCH", `/api/bots/${bot.id}`, {
          modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
        });
        expect(selected.status).toBe(200);
      }

      rmSync(fakeClaudeDump, { force: true });
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "start the lead" })).status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);
      const firstDump = z.object({
        pid: z.number(),
        mcpConfig: z.object({
          mcpServers: z.object({
            agents: z.object({ env: z.object({ HELMRYTH_COMMS_TOKEN: z.string() }) }),
          }),
        }),
      }).parse(JSON.parse(readFileSync(fakeClaudeDump, "utf8")));
      const token = firstDump.mcpConfig.mcpServers.agents.env.HELMRYTH_COMMS_TOKEN;
      expect(token).toMatch(/^[a-f0-9]{48}$/);

      const requested = await fetch(`${BASE}/api/internal/request-credential`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          fromBotId: second.id,
          fromThreadId: room.threadId,
          credentialId: "openaiImageApiKey",
          reason: "needed for the queued task",
        }),
      });
      expect(requested.status).toBe(201);
      const { messageId } = z.object({ messageId: z.string() }).parse(await requested.json());

      const resumed = await api("POST", `/api/bots/${second.id}/secret-cards/${messageId}/dismiss`, {
        threadId: room.threadId,
      });
      expect(resumed).toEqual({ status: 200, body: { dismissed: true, resumed: true } });

      const queued = (await api("GET", "/api/bots?messages=0")).body;
      expect(queued.groups.find((group: { id: string }) => group.id === room.id)?.working).toBe(true);
      const deletion = await api("DELETE", `/api/groups/${room.id}`);
      expect(deletion.status).toBe(409);
      expect(deletion.body.error).toMatch(/working/i);

      expect((await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return {
          working: state.groups.find((group: { id: string }) => group.id === room.id)?.working,
          secondBusy: Boolean(state.bots.find((bot: { id: string }) => bot.id === second.id)?.busy),
        };
      }, { timeout: 5_000 }).toEqual({ working: false, secondBusy: false });

      // The continuation sat behind the lead's hanging provider. Interrupting
      // the room must cancel it before a second provider process is spawned.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(JSON.parse(readFileSync(fakeClaudeDump, "utf8")).pid).toBe(firstDump.pid);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId });
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.groups.find((group: { id: string }) => group.id === room.id)?.working;
      }, { timeout: 5_000 }).toBe(false);
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${first.id}`);
      await api("DELETE", `/api/bots/${second.id}`);
    }
  });

  it("settles declined connector requests exactly once without stranding grouped capabilities", async () => {
    const bot = (await api("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
    })).body.bot;
    const outsider = (await api("POST", "/api/bots", {})).body.bot;
    try {
      rmSync(fakeClaudeDump, { force: true });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "prepare connected apps" })).status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);
      const bootstrapDump = z.object({
        mcpConfig: z.object({
          mcpServers: z.object({
            agents: z.object({ env: z.object({ HELMRYTH_COMMS_TOKEN: z.string() }) }),
          }),
        }),
      }).parse(JSON.parse(readFileSync(fakeClaudeDump, "utf8")));
      const token = bootstrapDump.mcpConfig.mcpServers.agents.env.HELMRYTH_COMMS_TOKEN;
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy;
      }, { timeout: 5_000 }).toBe(false);

      expect((await api("PUT", "/api/config?secretStorage=external", {
        composio: { apiKey: "ak_good" },
      })).status).toBe(200);

      const requestCards = async (
        slugs: string[],
        resumeKey: string,
        requestBotId = bot.id,
        requestThreadId = bot.threadId,
      ) => {
        const response = await fetch(`${BASE}/api/internal/connectors/request`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ botId: requestBotId, threadId: requestThreadId, slugs, resumeKey }),
        });
        expect(response.status).toBe(200);
        return z.object({ messageIds: z.array(z.string()) }).parse(await response.json()).messageIds;
      };
      const connectorMessage = async (messageId: string) => {
        const thread = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`)).body;
        return thread.messages.find((message: { id: string }) => message.id === messageId);
      };

      const sharedRoom = (await api("POST", "/api/groups", {
        name: "Connector identity boundary",
        memberIds: [bot.id, outsider.id],
        setup: { bulletin: "", defaultResponder: { kind: "mentions" } },
      })).body.group;
      try {
        const [roomCardId] = await requestCards(
          ["linear", "trello"],
          "connector_room_identity_123456",
          bot.id,
          sharedRoom.threadId,
        );
        expect((await api("POST", `/api/bots/${outsider.id}/connector-cards/${roomCardId}/dismiss`, {
          threadId: sharedRoom.threadId,
        })).status).toBe(404);
        expect((await api("POST", `/api/bots/${bot.id}/connector-cards/${roomCardId}/dismiss`, {
          threadId: sharedRoom.threadId,
        })).body).toMatchObject({ dismissed: true, outcome: "declined", resumed: false, pending: 1 });
      } finally {
        await api("DELETE", `/api/groups/${sharedRoom.id}`);
      }

      const groupedKey = "connector_group_decline_123456";
      const [githubId, slackId] = await requestCards(["github", "slack"], groupedKey);
      const firstDismiss = await api("POST", `/api/bots/${bot.id}/connector-cards/${githubId}/dismiss`, {
        threadId: bot.threadId,
      });
      expect(firstDismiss.status).toBe(200);
      expect(firstDismiss.body).toMatchObject({
        dismissed: true,
        outcome: "declined",
        resumed: false,
        pending: 1,
        message: { id: githubId, connector: { dismissed: true, resumed: false } },
      });
      expect(await connectorMessage(githubId)).toMatchObject({
        connector: { dismissed: true, resumed: false },
      });
      expect(await connectorMessage(slackId)).toMatchObject({
        connector: { dismissed: false, resumed: false },
      });

      // Duplicate dismissals are stable, and every identity dimension is
      // enforced before connector state can be observed or changed.
      const duplicate = await api("POST", `/api/bots/${bot.id}/connector-cards/${githubId}/dismiss`, {
        threadId: bot.threadId,
      });
      expect(duplicate.body).toMatchObject({ dismissed: true, outcome: "declined", resumed: false, pending: 1 });
      expect((await api("POST", `/api/bots/${outsider.id}/connector-cards/${githubId}/dismiss`, {
        threadId: bot.threadId,
      })).status).toBe(404);
      expect((await api("POST", `/api/bots/${bot.id}/connector-cards/not-a-message/dismiss`, {
        threadId: bot.threadId,
      })).status).toBe(404);
      expect((await api("POST", `/api/bots/${bot.id}/connector-cards/${githubId}/dismiss`, {
        threadId: "not-the-connector-thread",
      })).status).toBe(404);

      rmSync(fakeClaudeDump, { force: true });
      const finalDismiss = await api("POST", `/api/bots/${bot.id}/connector-cards/${slackId}/dismiss`, {
        threadId: bot.threadId,
      });
      expect(finalDismiss.body).toMatchObject({
        dismissed: true,
        outcome: "declined",
        resumed: true,
        pending: 0,
        message: { id: slackId, connector: { dismissed: true, resumed: true } },
      });
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);
      const continuation = JSON.stringify(JSON.parse(readFileSync(fakeClaudeDump, "utf8")).prompt);
      expect(continuation).toContain("declined to connect");
      expect(continuation).toContain("GitHub");
      expect(continuation).toContain("Slack");
      expect(await connectorMessage(githubId)).toMatchObject({ connector: { dismissed: true, resumed: true } });

      const late = await api("POST", `/api/bots/${bot.id}/connector-cards/${githubId}/dismiss`, {
        threadId: bot.threadId,
      });
      expect(late.body).toMatchObject({ dismissed: true, outcome: "declined", resumed: true, pending: 0 });

      expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy;
      }, { timeout: 5_000 }).toBe(false);

      const [singleId] = await requestCards(["notion"], "connector_single_decline_123456");
      rmSync(fakeClaudeDump, { force: true });
      const single = await api("POST", `/api/bots/${bot.id}/connector-cards/${singleId}/dismiss`, {
        threadId: bot.threadId,
      });
      expect(single.body).toMatchObject({
        dismissed: true,
        outcome: "declined",
        resumed: true,
        pending: 0,
      });
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);
      expect(JSON.stringify(JSON.parse(readFileSync(fakeClaudeDump, "utf8")).prompt)).toContain("Notion");

      expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy;
      }, { timeout: 5_000 }).toBe(false);

      const [connectedId] = await requestCards(["gmail"], "connector_connected_late_123456");
      connectedComposioToolkits.add("gmail");
      rmSync(fakeClaudeDump, { force: true });
      const status = await api(
        "GET",
        `/api/bots/${bot.id}/connector-cards/${connectedId}/status?threadId=${encodeURIComponent(bot.threadId)}`,
      );
      expect(status.body.connected).toBe(true);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);
      const lateConnected = await api("POST", `/api/bots/${bot.id}/connector-cards/${connectedId}/dismiss`, {
        threadId: bot.threadId,
      });
      expect(lateConnected.body).toMatchObject({
        dismissed: false,
        outcome: "connected",
        resumed: true,
        pending: 0,
        message: { id: connectedId, connector: { status: "connected", dismissed: false, resumed: true } },
      });
    } finally {
      connectedComposioToolkits.clear();
      await api("POST", `/api/bots/${bot.id}/interrupt`).catch(() => undefined);
      await api("DELETE", `/api/bots/${bot.id}`);
      await api("DELETE", `/api/bots/${outsider.id}`);
    }
  });

  it("blocks checkpoint restore while another operator owns the same project folder", async () => {
    const project = join(home, "shared-checkpoint-project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "brief.txt"), "original\n");
    const first = (await api("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
    })).body.bot;
    const second = (await api("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
    })).body.bot;
    try {
      expect((await api("PATCH", `/api/bots/${first.id}`, { cwd: project })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${second.id}`, { cwd: project })).status).toBe(200);

      rmSync(fakeClaudeDump, { force: true });
      expect((await api("POST", `/api/bots/${first.id}/messages`, { text: "create the safety point" })).status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 10_000 }).toBe(true);
      expect((await api("POST", `/api/bots/${first.id}/interrupt`)).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.bots.find((bot: { id: string }) => bot.id === first.id)?.busy;
      }, { timeout: 5_000 }).toBe(false);

      const checkpoints = await api("GET", `/api/bots/${first.id}/checkpoints?cwd=${encodeURIComponent(project)}`);
      expect(checkpoints.status).toBe(200);
      const hash = z.object({
        checkpoints: z.array(z.object({ hash: z.string().regex(/^[0-9a-f]{40}$/) })).min(1),
      }).parse(checkpoints.body).checkpoints[0].hash;

      rmSync(fakeClaudeDump, { force: true });
      expect((await api("POST", `/api/bots/${second.id}/messages`, { text: "hold the shared project" })).status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 10_000 }).toBe(true);

      const blocked = await api("POST", `/api/bots/${first.id}/checkpoints/restore`, { cwd: project, hash });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toMatch(/active operator|in use/i);

      expect((await api("POST", `/api/bots/${second.id}/interrupt`)).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.bots.find((bot: { id: string }) => bot.id === second.id)?.busy;
      }, { timeout: 5_000 }).toBe(false);
      expect((await api("POST", `/api/bots/${first.id}/checkpoints/restore`, { cwd: project, hash })).status).toBe(200);
    } finally {
      await api("POST", `/api/bots/${first.id}/interrupt`).catch(() => undefined);
      await api("POST", `/api/bots/${second.id}/interrupt`).catch(() => undefined);
      await api("DELETE", `/api/bots/${first.id}`);
      await api("DELETE", `/api/bots/${second.id}`);
    }
  });

  it("returns controlled cadence input errors without partially applying create or update", async () => {
    const anchor = (await api("POST", "/api/bots")).body.bot;
    const target = (await api("POST", "/api/bots")).body.bot;
    let routineId = "";
    try {
      const missingCreate = await api("POST", "/api/routines", {
        name: "Missing target",
        prompt: "Do not persist this cadence",
        botId: "operator-that-does-not-exist",
        schedule: { type: "daily", time: "09:00", weekdays: [1] },
      });
      expect(missingCreate).toMatchObject({
        status: 400,
        body: { error: "That operator no longer exists" },
      });

      const malformedCreate = await api("POST", "/api/routines", {
        name: "Malformed target",
        prompt: "Do not persist this either",
        botId: " ",
        schedule: { type: "daily", time: "09:00", weekdays: [1] },
      });
      expect(malformedCreate).toMatchObject({
        status: 400,
        body: { error: "Choose an operator" },
      });

      const malformedSchedule = await api("POST", "/api/routines", {
        name: "Malformed schedule",
        prompt: "Do not persist this either",
        botId: target.id,
        schedule: { type: "daily", time: "25:61", weekdays: [1] },
      });
      expect(malformedSchedule).toMatchObject({
        status: 400,
        body: { error: "Time must use HH:MM" },
      });

      const created = await api("POST", "/api/routines", {
        name: "Stable cadence",
        prompt: "Keep this instruction",
        botId: target.id,
        enabled: false,
        schedule: { type: "daily", time: "09:00", weekdays: [1] },
      });
      expect(created.status).toBe(201);
      routineId = created.body.routine.id;
      const original = created.body.routine;

      const missingUpdate = await api("PATCH", `/api/routines/${routineId}`, {
        name: "Must not persist",
        botId: "operator-that-does-not-exist",
      });
      expect(missingUpdate).toMatchObject({
        status: 400,
        body: { error: "That operator no longer exists" },
      });

      const archived = await api("PATCH", `/api/bots/${target.id}`, {
        hidden: true,
        chiefOfStaff: false,
      });
      expect(archived.status).toBe(200);

      const archivedCreate = await api("POST", "/api/routines", {
        name: "Archived target",
        prompt: "Do not revive archived work",
        botId: target.id,
        schedule: { type: "daily", time: "09:00", weekdays: [1] },
      });
      expect(archivedCreate).toMatchObject({
        status: 400,
        body: { error: "That operator no longer exists" },
      });

      const archivedUpdate = await api("PATCH", `/api/routines/${routineId}`, {
        prompt: "Must not change while archived",
      });
      expect(archivedUpdate).toMatchObject({
        status: 400,
        body: { error: "That operator no longer exists" },
      });

      const state = await api("GET", "/api/routines");
      const relevant = state.body.routines.filter((routine: { id: string }) => routine.id === routineId);
      expect(relevant).toEqual([original]);
      expect(state.body.routines.some((routine: { name: string }) =>
        ["Missing target", "Malformed target", "Malformed schedule", "Archived target", "Must not persist"].includes(routine.name)
      )).toBe(false);
    } finally {
      if (routineId) await api("DELETE", `/api/routines/${routineId}`);
      await api("DELETE", `/api/bots/${target.id}`);
      await api("DELETE", `/api/bots/${anchor.id}`);
    }
  });

  it("opens only the exact waiting cadence task while preserving its active execution", async () => {
    const instances = (await api("GET", "/api/instances")).body.instances;
    const gateInstance = z.object({
      instanceId: z.literal("cadenceGate"),
      models: z.object({ default: z.string() }),
    }).passthrough().parse(instances.find((instance: { instanceId: string }) => instance.instanceId === "cadenceGate"));
    const bot = (await api("POST", "/api/bots", {
      modelSelection: { instanceId: gateInstance.instanceId, model: gateInstance.models.default },
    })).body.bot;
    let routineId = "";
    try {
      const originalThreadId = bot.threadId;
      const unrelated = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Unrelated run" })).body.task;
      expect((await api("POST", `/api/bots/${bot.id}/tasks/${originalThreadId}`)).status).toBe(200);

      const routine = await api("POST", "/api/routines", {
        name: "Waiting gate navigation",
        prompt: "Run the gated fixture.",
        botId: bot.id,
        runOn: "local",
        enabled: false,
        schedule: { type: "once", at: Date.now() + 60_000 },
      });
      expect(routine.status).toBe(201);
      routineId = routine.body.routine.id;
      const queued = await api("POST", `/api/routines/${routineId}/run`);
      expect(queued.status).toBe(201);
      const runId = queued.body.run.id;

      let waitingRun: { threadId: string; status: string } | undefined;
      await expect.poll(async () => {
        const runs = (await api("GET", "/api/routines")).body.runs;
        waitingRun = runs.find((run: { id: string }) => run.id === runId);
        return waitingRun?.status;
      }, { timeout: 10_000 }).toBe("waiting");
      expect(waitingRun?.threadId).toMatch(/^[\w-]+$/);
      const executionThreadId = z.string().parse(waitingRun?.threadId);

      const before = (await api("GET", "/api/bots?messages=0")).body.bots
        .find((candidate: { id: string }) => candidate.id === bot.id);
      expect(before).toMatchObject({ busy: true, threadId: originalThreadId });

      // Busy navigation is never a general task switch: only the detached
      // task named by the currently waiting cadence is permitted.
      const arbitrary = await api("POST", `/api/bots/${bot.id}/tasks/${unrelated.threadId}`);
      expect(arbitrary.status).toBe(409);
      const opened = await api("POST", `/api/bots/${bot.id}/tasks/${executionThreadId}`);
      expect(opened.status).toBe(200);
      expect(opened.body.bot).toMatchObject({ busy: true, threadId: executionThreadId });
      const gate = opened.body.bot.messages.find(
        (message: { card?: { requestId?: string } }) => Boolean(message.card?.requestId),
      );
      expect(gate?.card).toMatchObject({ requestId: expect.any(String), tool: expect.any(String) });

      const stillWaiting = (await api("GET", "/api/routines")).body.runs
        .find((run: { id: string }) => run.id === runId);
      expect(stillWaiting).toMatchObject({ status: "waiting", threadId: executionThreadId });

      const decided = await api("POST", `/api/threads/${executionThreadId}/respond`, {
        requestId: gate.card.requestId,
        behavior: "deny",
      });
      expect(decided.status).toBe(200);
      await expect.poll(async () => {
        const runs = (await api("GET", "/api/routines")).body.runs;
        return runs.find((run: { id: string }) => run.id === runId)?.status;
      }, { timeout: 10_000 }).toBe("completed");
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`).catch(() => undefined);
      if (routineId) await api("DELETE", `/api/routines/${routineId}`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("keeps chat-created routines inert until their durable card is confirmed", async () => {
    const bot = (await api("POST", "/api/bots", {})).body.bot;
    let routineId = "";
    let orphanRoutineId = "";
    let legacyRoutineId = "";
    try {
      const selected = await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      });
      expect(selected.status).toBe(200);

      rmSync(fakeClaudeDump, { force: true });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "prepare a routine" })).status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);
      const dump = JSON.parse(readFileSync(fakeClaudeDump, "utf8"));
      const token = dump.mcpConfig.mcpServers.agents.env.HELMRYTH_COMMS_TOKEN;
      expect(token).toMatch(/^[a-f0-9]{48}$/);
      const internalHeaders = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };

      const before = await fetch(
        `${BASE}/api/internal/routines?fromBotId=${encodeURIComponent(bot.id)}&fromThreadId=${encodeURIComponent(bot.threadId)}`,
        { headers: internalHeaders },
      );
      expect(before.status).toBe(200);
      expect(z.object({ routines: z.array(z.unknown()) }).parse(await before.json()).routines).toEqual([]);

      const unavailableCloud = await fetch(`${BASE}/api/internal/routine-requests`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          fromBotId: bot.id,
          fromThreadId: bot.threadId,
          action: "create",
          routine: {
            name: "Cloud brief",
            instructions: "Summarize today's priorities in the Cloud VM.",
            schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] },
            runOn: "cloud",
          },
        }),
      });
      expect(unavailableCloud.status).toBe(409);
      expect(await unavailableCloud.json()).toMatchObject({
        error: expect.stringMatching(/Box API key|Cloud VM runner/i),
      });

      const proposed = await fetch(`${BASE}/api/internal/routine-requests`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          fromBotId: bot.id,
          fromThreadId: bot.threadId,
          action: "create",
          routine: {
            name: "Weekday brief",
            instructions: "Summarize the priorities for today.",
            schedule: {
              type: "weekly",
              time: "09:00",
              weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
            },
            runOn: "local",
            durationMinutes: 30,
          },
        }),
      });
      expect(proposed.status).toBe(201);
      const proposal = z.object({ requestId: z.string() }).passthrough().parse(await proposed.json());

      const stillInert = await api("GET", "/api/routines");
      expect(stillInert.body.routines.filter((routine: { botId: string }) => routine.botId === bot.id)).toEqual([]);
      const state = (await api("GET", "/api/bots")).body;
      const card = state.bots
        .find((candidate: { id: string }) => candidate.id === bot.id)
        ?.messages.find((message: { card?: { requestId?: string } }) => message.card?.requestId === proposal.requestId);
      expect(card?.card).toMatchObject({
        tool: "schedule_routine",
        routineRequest: { botId: bot.id, threadId: bot.threadId },
      });
      expect(card?.card.answered).toBeUndefined();

      const confirmed = await api("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: proposal.requestId,
        behavior: "allow",
      });
      expect(confirmed).toMatchObject({ status: 200, body: { outcome: "allowed-once", routineAction: "create" } });
      routineId = confirmed.body.resultId;
      await expect.poll(async () => {
        const decisions = (await api("GET", "/api/decisions")).body.decisions;
        return decisions
          .filter((decision: { requestId?: string }) => decision.requestId === proposal.requestId)
          .map((decision: { decision: string; source: string }) => `${decision.decision}:${decision.source}`)
          .sort();
      }).toEqual(["card-shown:routine", "user-approved:user"]);

      const after = await api("GET", "/api/routines");
      const confirmedRoutine = after.body.routines.find((routine: { id: string }) => routine.id === routineId);
      expect(confirmedRoutine).toMatchObject({
        botId: bot.id,
        sourceThreadId: bot.threadId,
      });
      const duplicate = await api("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: proposal.requestId,
        behavior: "allow",
      });
      expect(duplicate.body.alreadySettled).toBe(true);
      expect((await api("GET", "/api/routines")).body.routines
        .filter((routine: { botId: string }) => routine.botId === bot.id)).toHaveLength(1);

      // The initial fixture turn is deliberately hung. Once it is stopped,
      // force a deterministic dispatch failure by choosing the configured
      // but unavailable ghost provider. The execution stays detached, while one source card is
      // appended then patched through queued → running → failed.
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
      await expect.poll(async () => {
        const current = (await api("GET", "/api/bots?messages=0")).body.bots
          .find((candidate: { id: string }) => candidate.id === bot.id);
        return Boolean(current?.busy);
      }, { timeout: 5_000 }).toBe(false);
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "ghost", model: "unavailable-fixture" },
      })).status).toBe(200);

      const routineEvents = await openSse(`${BASE}/api/events`);
      try {
        const queued = await api("POST", `/api/routines/${routineId}/run`);
        expect(queued.status).toBe(201);
        const failedNotice = await routineEvents.until(
          (frame) =>
            frame.kind === "notify" &&
            frame.notification?.kind === "routine-failed" &&
            frame.notification?.botId === bot.id,
          5_000,
        );
        const failedNotification = z.object({
          notification: z.object({ threadId: z.string() }),
        }).parse(failedNotice);
        expect(failedNotification.notification.threadId).toBe(bot.threadId);

        await expect.poll(async () => {
          const current = (await api("GET", "/api/bots")).body.bots
            .find((candidate: { id: string }) => candidate.id === bot.id);
          return current?.messages.filter(
            (message: { kind?: string; routineRun?: { runId?: string } }) =>
              message.kind === "routine.run" && message.routineRun?.runId === queued.body.run.id,
          ) ?? [];
        }, { timeout: 5_000 }).toHaveLength(1);
        const current = (await api("GET", "/api/bots")).body.bots
          .find((candidate: { id: string }) => candidate.id === bot.id);
        const runCards = current.messages.filter(
          (message: { kind?: string; routineRun?: { runId?: string } }) =>
            message.kind === "routine.run" && message.routineRun?.runId === queued.body.run.id,
        );
        expect(runCards).toHaveLength(1);
        expect(runCards[0].routineRun).toMatchObject({
          runId: queued.body.run.id,
          routineId,
          routineName: "Weekday brief",
          status: "failed",
        });
        expect(runCards[0].routineRun.executionThreadId).not.toBe(bot.threadId);

        // Reading the source and then marking the failure seen in Routines
        // must not make the original conversation unread again. markSeen
        // re-emits the receipt without changing its lifecycle status.
        expect((await api("POST", `/api/bots/${bot.id}/read`)).status).toBe(200);
        expect((await api("POST", `/api/routine-runs/${queued.body.run.id}/seen`)).status).toBe(200);
        const afterSeen = (await api("GET", "/api/bots?messages=0")).body.bots
          .find((candidate: { id: string }) => candidate.id === bot.id);
        expect(afterSeen.unread).toBe(false);

        const grounded = await fetch(
          `${BASE}/api/internal/routines?fromBotId=${encodeURIComponent(bot.id)}&fromThreadId=${encodeURIComponent(bot.threadId)}`,
          { headers: internalHeaders },
        );
        const groundedBody = z.object({
          routines: z.array(z.object({
            id: z.string(),
            latestRun: z.object({
              status: z.string(),
              scheduledFor: z.string().nullable(),
              startedAt: z.string().nullable(),
              finishedAt: z.string().nullable(),
              output: z.string().nullable(),
              error: z.string().nullable(),
              executionThreadId: z.string().nullable(),
            }).nullable(),
          }).passthrough()),
        }).parse(await grounded.json());
        expect(groundedBody.routines.find((routine) => routine.id === routineId)?.latestRun).toMatchObject({
          status: "failed",
          startedAt: expect.any(String),
          finishedAt: expect.any(String),
          error: expect.stringMatching(/provider instance "ghost" is unavailable/i),
          executionThreadId: runCards[0].routineRun.executionThreadId,
        });
      } finally {
        routineEvents.close();
      }

      // A deleted source conversation is a safe fallback, not an instruction
      // to recreate its transcript. The run still gets its detached receipt
      // and failure, but no lifecycle message is written to the orphan id.
      const orphanSource = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Temporary routine source" });
      expect(orphanSource.status).toBe(201);
      const orphanThreadId = z.object({
        task: z.object({ threadId: z.string() }),
      }).parse(orphanSource.body).task.threadId;
      const orphanProposalResponse = await fetch(`${BASE}/api/internal/routine-requests`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          fromBotId: bot.id,
          fromThreadId: orphanThreadId,
          action: "create",
          routine: {
            name: "Orphan-safe brief",
            instructions: "Summarize without recreating the deleted source.",
            schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] },
            runOn: "local",
          },
        }),
      });
      expect(orphanProposalResponse.status).toBe(201);
      const orphanProposal = z.object({ requestId: z.string() }).parse(await orphanProposalResponse.json());
      const orphanConfirmed = await api("POST", `/api/threads/${orphanThreadId}/respond`, {
        requestId: orphanProposal.requestId,
        behavior: "allow",
      });
      expect(orphanConfirmed.status).toBe(200);
      orphanRoutineId = orphanConfirmed.body.resultId;
      expect((await api("DELETE", `/api/bots/${bot.id}/tasks/${orphanThreadId}`)).status).toBe(200);
      expect(storedMessageCount(orphanThreadId)).toBe(0);

      const orphanRun = await api("POST", `/api/routines/${orphanRoutineId}/run`);
      expect(orphanRun.status).toBe(201);
      await expect.poll(async () => {
        const runs = (await api("GET", "/api/routines")).body.runs;
        return runs.find((run: { id: string }) => run.id === orphanRun.body.run.id)?.status;
      }, { timeout: 5_000 }).toBe("failed");
      expect(storedMessageCount(orphanThreadId)).toBe(0);

      // Calendar-created routines may predate chat-card redaction. Listing
      // them to a model must redact the whole prompt before returning its
      // bounded preview, and tell the model when that preview is incomplete.
      const fakeSecret = `Bearer ${"a".repeat(24)}`;
      const fakeNameSecret = `sk-proj-${"b".repeat(24)}`;
      const legacy = await api("POST", "/api/routines", {
        name: `Legacy ${fakeNameSecret}`,
        prompt: `${fakeSecret}\n${"Review the archive. ".repeat(180)}`,
        botId: bot.id,
        runOn: "local",
        enabled: false,
        schedule: { type: "daily", time: "10:00", weekdays: [1] },
      });
      legacyRoutineId = legacy.body.routine.id;
      const listed = await fetch(
        `${BASE}/api/internal/routines?fromBotId=${encodeURIComponent(bot.id)}&fromThreadId=${encodeURIComponent(bot.threadId)}`,
        { headers: internalHeaders },
      );
      expect(listed.status).toBe(200);
      const listedBody = z.object({
        routines: z.array(z.object({
          id: z.string(),
          instructions: z.string(),
          instructionsTruncated: z.boolean(),
        }).passthrough()),
      }).parse(await listed.json());
      const legacyResult = listedBody.routines.find((routine) => routine.id === legacyRoutineId)!;
      expect(legacyResult.instructions).not.toContain(fakeSecret);
      expect(legacyResult.name).not.toContain(fakeNameSecret);
      expect(legacyResult.instructions).toContain("redacted");
      expect(legacyResult.instructionsTruncated).toBe(true);

      const wrongThread = await fetch(`${BASE}/api/internal/routine-requests`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          fromBotId: bot.id,
          fromThreadId: "not-this-bots-thread",
          action: "pause",
          routineId,
        }),
      });
      expect(wrongThread.status).toBe(403);
    } finally {
      if (legacyRoutineId) await api("DELETE", `/api/routines/${legacyRoutineId}`);
      if (orphanRoutineId) await api("DELETE", `/api/routines/${orphanRoutineId}`);
      if (routineId) await api("DELETE", `/api/routines/${routineId}`);
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("validates the non-secret VPS alias and keeps old bots on Box by default", async () => {
    const before = await api("GET", "/api/bots");
    const bot = before.body.bots[0];
    expect(bot.cloudBackend).toBeUndefined();

    const bad = await api("PUT", "/api/config", { vps: { sshAlias: "prod; reboot" } });
    expect(bad.status).toBe(400);

    const saved = await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } });
    expect(saved.status).toBe(200);
    expect(saved.body.vps).toEqual({ configured: true, sshAlias: "production-vps" });
    expect(JSON.stringify(saved.body)).not.toContain("privateKey");

    const patched = await api("PATCH", `/api/bots/${bot.id}`, { cloudBackend: "vps" });
    expect(patched.status).toBe(200);
    expect(patched.body.bot.cloudBackend).toBe("vps");
    const autoStart = await api("PATCH", `/api/bots/${bot.id}`, { autoStartVps: true });
    expect(autoStart.status).toBe(200);
    expect(autoStart.body.bot.autoStartVps).toBe(true);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { autoStartVps: "yes" })).status).toBe(400);
    const invalid = await api("PATCH", `/api/bots/${bot.id}`, { cloudBackend: "daytona" });
    expect(invalid.status).toBe(400);
  });

  it("validates a Composio project key, creates a Session, and keeps externally stored secrets off disk", async () => {
    const oldKey = await api("PUT", "/api/config", { composio: { apiKey: "old_key" } });
    expect(oldKey.status).toBe(400);
    expect(oldKey.body.error).toMatch(/start with ak_/i);

    const rejected = await api("PUT", "/api/config", { composio: { apiKey: "ak_wrong" } });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/invalid project key/i);

    const saved = await api("PUT", "/api/config?secretStorage=external", {
      composio: { apiKey: "ak_good" },
      openaiCompat: {
        key: "compat-external",
        url: "https://models.example.test/v1",
        model: "vendor/model",
        provider: "vendor",
      },
      opencodeGo: { apiKey: "opencode-external" },
      profile: { name: "External Store" },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.composio).toEqual({ configured: true, mode: "self-hosted" });
    expect(saved.body.opencodeGo).toEqual({ configured: true });
    expect(saved.body.openaiCompat).toEqual({
      configured: true,
      url: "https://models.example.test/v1",
      model: "vendor/model",
      provider: "vendor",
    });
    expect(saved.body.managedServices).toEqual({
      source: "packaged",
      state: "ready",
      registry: { configured: true, origin: "https://registry.example.test" },
      conduit: { configured: true, origin: "https://conduit.example.test" },
    });
    expect(saved.body.profile).toEqual({ name: "External Store", email: "" });
    expect(JSON.stringify(saved.body)).not.toContain("ak_good");
    expect(JSON.stringify(saved.body)).not.toContain("compat-external");

    const disk = JSON.parse(readFileSync(join(home, ".helmryth", "config.json"), "utf8"));
    expect(disk.composio).toMatchObject({ apiKey: "", sessionId: "trs_config_test" });
    expect(disk.opencodeGo).toEqual({ apiKey: "" });
    expect(disk.openaiCompat).toEqual({
      key: "",
      url: "https://models.example.test/v1",
      model: "vendor/model",
      provider: "vendor",
    });
    expect(disk.profile).toEqual({ name: "External Store" });
    expect(JSON.stringify(disk)).not.toContain("ak_good");
    expect(JSON.stringify(disk)).not.toContain("opencode-external");
    expect(JSON.stringify(disk)).not.toContain("compat-external");

    // A later ordinary setting save reloads config; the in-process secure-env
    // override must keep Composio configured until the next app launch.
    expect((await api("PUT", "/api/config", { profile: { name: "Grace" } })).status).toBe(200);
    expect((await api("GET", "/api/config")).body.composio).toEqual({ configured: true, mode: "self-hosted" });
  });

  it.skipIf(process.platform === "win32")("stores the credentials file with owner-only permissions", () => {
    expect(statSync(join(home, ".helmryth", "config.json")).mode & 0o777).toBe(0o600);
  });

  it("stores and echoes the user profile (not write-only, unlike keys)", async () => {
    const put = await api("PUT", "/api/config", { profile: { name: "Ada Lovelace", email: "Ada@Example.com" } });
    expect(put.status).toBe(200);
    expect(put.body.profile).toEqual({ name: "Ada Lovelace", email: "Ada@Example.com" });

    const after = await api("GET", "/api/config");
    expect(after.body.profile).toEqual({ name: "Ada Lovelace", email: "Ada@Example.com" });
  });

  it("creates an independent webhook, accepts a delivery, deduplicates it, and rotates its secret", async () => {
    const bots = await api("GET", "/api/bots");
    const created = await api("POST", "/api/webhooks", {
      name: "Incoming build",
      prompt: "Review the incoming build event",
      botId: bots.body.bots[0].id,
      runOn: "local",
    });
    expect(created.status).toBe(201);
    expect(created.body.ingress).toMatchObject({ available: true, baseUrl: WEBHOOK_BASE });
    expect(created.body.credential).toMatchObject({
      endpointUrl: expect.stringMatching(new RegExp(`^${WEBHOOK_BASE}/hooks/wh_`)),
      secret: expect.stringMatching(/^whsec_/),
      idempotencyKey: expect.stringMatching(/^hry_evt_[0-9a-f-]{36}$/),
    });
    expect(created.body.credential.endpointUrl).not.toContain(created.body.credential.secret);
    expect(created.body.credential).not.toHaveProperty("url");

    const listed = await api("GET", "/api/webhooks");
    expect(listed.body.webhooks).toHaveLength(1);
    expect(listed.body.attempts).toEqual([]);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.credential.secret);

    const deliver = () => fetch(created.body.credential.endpointUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.body.credential.secret}`,
        "content-type": "application/json",
        "idempotency-key": "build-42",
      },
      body: JSON.stringify({ status: "failed", build: 42 }),
    });
    const first = await deliver();
    expect(first.status).toBe(202);
    const accepted = z.object({
      runId: z.string(),
      accepted: z.boolean(),
      duplicate: z.boolean(),
    }).parse(await first.json());
    expect(accepted).toMatchObject({ accepted: true, duplicate: false });
    const retry = await deliver();
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ accepted: true, duplicate: true, runId: accepted.runId });

    const afterDelivery = await api("GET", "/api/webhooks");
    expect(afterDelivery.body.attempts.map((attempt: { outcome: string }) => attempt.outcome)).toEqual(["accepted", "duplicate"]);

    const receipts = await api("GET", "/api/routines");
    expect(receipts.body.runs.find((run: { id: string }) => run.id === accepted.runId)).toMatchObject({
      triggerSource: "webhook",
      deliveryId: "build-42",
      routineName: "Incoming build",
    });

    const rotated = await api("POST", `/api/webhooks/${created.body.webhook.id}/rotate`);
    expect(rotated.status).toBe(200);
    expect(rotated.body.credential.endpointUrl).toBe(created.body.credential.endpointUrl);
    expect(rotated.body.credential.secret).not.toBe(created.body.credential.secret);
    expect(rotated.body.credential.idempotencyKey).not.toBe(created.body.credential.idempotencyKey);
    expect(rotated.body.credential).not.toHaveProperty("url");
    expect((await deliver()).status).toBe(401);

    expect((await api("DELETE", `/api/webhooks/${created.body.webhook.id}`)).status).toBe(200);
    expect((await api("GET", "/api/webhooks")).body.webhooks).toHaveLength(0);
    if (process.platform !== "win32") {
      expect(statSync(join(home, ".helmryth", "webhooks.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("stores OpenCode Go credentials as a configured-only status", async () => {
    const put = await api("PUT", "/api/config", { opencodeGo: { apiKey: "opencode-secret" } });
    expect(put.status).toBe(200);
    expect(put.body.opencodeGo).toEqual({ configured: true });
    expect(JSON.stringify(put.body)).not.toContain("opencode-secret");

    const after = await api("GET", "/api/config");
    expect(after.body.opencodeGo).toEqual({ configured: true });
    expect(JSON.stringify(after.body)).not.toContain("opencode-secret");
  });

  it("stores the avatar image key as configured-only status", async () => {
    try {
      const put = await api("PUT", "/api/config", { imageGen: { key: "sk-image-secret" } });
      expect(put.status).toBe(200);
      expect(put.body.imageGen).toEqual({ configured: true });
      expect(JSON.stringify(put.body)).not.toContain("sk-image-secret");

      const after = await api("GET", "/api/config");
      expect(after.body.imageGen).toEqual({ configured: true });
      expect(JSON.stringify(after.body)).not.toContain("sk-image-secret");
    } finally {
      await api("PUT", "/api/config", { imageGen: { key: "" } });
    }
  });

  it("rejects a non-string OpenCode Go API key", async () => {
    const bad = await api("PUT", "/api/config", { opencodeGo: { apiKey: 123 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("opencodeGo.apiKey");

    const array = await api("PUT", "/api/config", { opencodeGo: [] });
    expect(array.status).toBe(400);
    expect(array.body.error).toContain("opencodeGo");
  });

  it("never hands a client the provider session cursors", async () => {
    // resumeCursors is the harness's own bookkeeping. It reached clients for
    // a long time as harmless noise; once a phone is a client it is provider
    // session state leaving the machine, so nothing carrying a bot may have it.
    const listed = await api("GET", "/api/bots");
    for (const bot of listed.body.bots) {
      expect(bot).not.toHaveProperty("resumeCursors");
      for (const task of bot.tasks ?? []) expect(task).not.toHaveProperty("resumeCursors");
    }

    const created = await api("POST", "/api/bots");
    const botId = created.body.bot.id;
    try {
      expect(created.body.bot).not.toHaveProperty("resumeCursors");
      const patched = await api("PATCH", `/api/bots/${botId}`, { name: "Cursorless" });
      expect(patched.body.bot).not.toHaveProperty("resumeCursors");

      const task = await api("POST", `/api/bots/${botId}/tasks`, {});
      expect(task.body.bot).not.toHaveProperty("resumeCursors");
      for (const t of task.body.bot.tasks ?? []) expect(t).not.toHaveProperty("resumeCursors");
      // the task alone, not just the bot it came attached to
      expect(task.body.task).not.toHaveProperty("resumeCursors");
      const renamed = await api("PATCH", `/api/bots/${botId}/tasks/${task.body.task.threadId}`, {
        title: "Cursorless task",
      });
      expect(renamed.body.task).not.toHaveProperty("resumeCursors");

      // and the same on the wire, not just in the HTTP responses
      const stream = await openSse(`${BASE}/api/events`);
      try {
        await api("PATCH", `/api/bots/${botId}`, { unread: true });
        const frame = await stream.until((f) => f.kind === "bot");
        expect(frame.bot).not.toHaveProperty("resumeCursors");
        expect(JSON.stringify(frame)).not.toContain("resumeCursors");
      } finally {
        stream.close();
      }
    } finally {
      await api("DELETE", `/api/bots/${botId}`);
    }
  });

  it("validates the event inspector limit at the HTTP boundary", async () => {
    const bot = (await api("GET", "/api/bots")).body.bots[0];
    for (const value of ["nope", "0", "-1", "1.5", "Infinity"]) {
      const response = await api("GET", `/api/threads/${bot.threadId}/events?limit=${value}`);
      expect(response.status).toBe(400);
      expect(response.body.error).toContain("positive whole number");
    }
    const ok = await api("GET", `/api/threads/${bot.threadId}/events?limit=1`);
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.entries)).toBe(true);
    expect(ok.body.total).toEqual({ runtime: expect.any(Number), native: expect.any(Number) });
  });

  it("404s unknown routes with the route in the error", async () => {
    const res = await api("GET", "/api/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("/api/definitely-not-a-route");
  });
});

describe("section context API", () => {
  it("keeps user-managed briefs isolated by live section and clears them explicitly", async () => {
    const work = (await api("POST", "/api/bots")).body.bot;
    const personal = (await api("POST", "/api/bots")).body.bot;
    try {
      await api("PATCH", `/api/bots/${work.id}`, { section: "Work" });
      await api("PATCH", `/api/bots/${personal.id}`, { section: "Personal" });

      const saved = await api("PUT", "/api/section-context?section=Work", { text: "# Goals\n- Ship Friday" });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ section: "Work", label: "Work", text: "# Goals\n- Ship Friday" });
      expect(saved.body.updatedAt).toEqual(expect.any(Number));

      const read = await api("GET", "/api/section-context?section=%20Work%20");
      expect(read.body.text).toBe("# Goals\n- Ship Friday");
      expect((await api("GET", "/api/section-context?section=Personal")).body.text).toBe("");
      expect((await api("GET", "/api/section-context?section=")).body.label).toBe("General");

      const cleared = await api("PUT", "/api/section-context?section=Work", { text: "  " });
      expect(cleared.body).toMatchObject({ text: "", updatedAt: null });
      expect((await api("GET", "/api/section-context?section=Work")).body.text).toBe("");
    } finally {
      await api("DELETE", `/api/bots/${work.id}`);
      await api("DELETE", `/api/bots/${personal.id}`);
    }
  });

  it("rejects missing, unknown, invalid, and oversized section context writes", async () => {
    expect((await api("GET", "/api/section-context")).status).toBe(400);
    expect((await api("PUT", "/api/section-context?section=Missing", { text: "x" })).status).toBe(404);
    expect((await api("PUT", "/api/section-context?section=", { text: 7 })).status).toBe(400);
    const oversized = await api("PUT", "/api/section-context?section=", { text: "x".repeat(24_001) });
    expect(oversized.status).toBe(400);
    expect(oversized.body.error).toContain("24KB");
  });
});

// The memory routes expose plain files in the bot's workspace. The
// traversal cases matter more than the happy path here: a topic name in a
// URL is hostile-adjacent input, and the only defensible answer to "../"
// in any coat of encoding is a rejection before the filesystem is touched.
describe("bot memory API", () => {
  /** raw-path GET: fetch() normalizes "../" segments away client-side, and
   * the traversal tests need the wire to carry exactly the bytes shown */
  const rawGet = (rawPath: string): Promise<{ status: number; text: string }> =>
    new Promise((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: PORT, path: rawPath }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on("error", reject);
      req.end();
    });

  const workspaceOf = (botId: string) => join(home, ".helmryth", "workspaces", botId);

  it("reads empty memory for a fresh bot and 404s a bot that does not exist", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const fresh = await api("GET", `/api/bots/${bot.id}/memory`);
      expect(fresh.status).toBe(200);
      expect(fresh.body).toEqual({ text: "", truncated: false, topics: [] });
      expect((await api("GET", "/api/bots/does-not-exist/memory")).status).toBe(404);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("round-trips a MEMORY.md edit and rejects non-string or oversized text", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const saved = await api("PUT", `/api/bots/${bot.id}/memory`, { text: "# Memory\n- prefers pnpm\n" });
      expect(saved.status).toBe(200);
      expect(saved.body.truncated).toBe(false);
      const read = await api("GET", `/api/bots/${bot.id}/memory`);
      expect(read.body.text).toBe("# Memory\n- prefers pnpm\n");
      // the write lands in the same file the bot's own tools read
      expect(readFileSync(join(workspaceOf(bot.id), "MEMORY.md"), "utf8")).toContain("prefers pnpm");

      expect((await api("PUT", `/api/bots/${bot.id}/memory`, { text: 7 })).status).toBe(400);
      expect((await api("PUT", `/api/bots/${bot.id}/memory`, {})).status).toBe(400);
      const big = await api("PUT", `/api/bots/${bot.id}/memory`, { text: "x".repeat(256 * 1024 + 1) });
      expect(big.status).toBe(400);
      expect(big.body.error).toContain("256KB");
      // a rejected write must leave the file exactly as it was
      expect((await api("GET", `/api/bots/${bot.id}/memory`)).body.text).toBe("# Memory\n- prefers pnpm\n");
      expect((await api("PUT", "/api/bots/does-not-exist/memory", { text: "x" })).status).toBe(404);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("lists memory/ topic files and serves one by (possibly encoded) name", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const memDir = join(workspaceOf(bot.id), "memory");
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, "deploys.md"), "- deploy = pnpm ship\n");
      writeFileSync(join(memDir, "my notes.md"), "spaced");
      writeFileSync(join(memDir, "notes.txt"), "not a topic");
      const listed = await api("GET", `/api/bots/${bot.id}/memory`);
      expect(listed.body.topics).toEqual([
        { name: "deploys.md", bytes: 21 },
        { name: "my notes.md", bytes: 6 },
      ]);

      const topic = await api("GET", `/api/bots/${bot.id}/memory/topics/deploys.md`);
      expect(topic.status).toBe(200);
      expect(topic.body).toEqual({ name: "deploys.md", text: "- deploy = pnpm ship\n" });
      // a UI-sent name arrives percent-encoded and must resolve to the same file
      expect((await api("GET", `/api/bots/${bot.id}/memory/topics/my%20notes.md`)).body.text).toBe("spaced");
      expect((await api("GET", `/api/bots/${bot.id}/memory/topics/missing.md`)).status).toBe(404);
      expect((await api("GET", "/api/bots/does-not-exist/memory/topics/deploys.md")).status).toBe(404);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("refuses every coat of path traversal without reading the target", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      // plant real files where a traversal would land, so a hole would show
      // as leaked content and not depend on what happens to exist
      mkdirSync(workspaceOf(bot.id), { recursive: true });
      writeFileSync(join(workspaceOf(bot.id), "MEMORY.md"), "TOP-SECRET-MARKER memory");
      writeFileSync(join(home, ".helmryth", "secret.md"), "TOP-SECRET-MARKER sibling");

      for (const name of [
        "..%2F..%2Fsecret.md", // encoded slashes
        "%2e%2e%2fsecret.md", // dots encoded too
        "..%2FMEMORY.md", // one level up, inside the workspace
        "..%5C..%5Csecret.md", // encoded backslashes (Windows separators)
        "secret%00.md", // null byte
      ]) {
        const res = await rawGet(`/api/bots/${bot.id}/memory/topics/${name}`);
        expect(res.status, name).toBe(400);
        expect(res.text, name).not.toContain("TOP-SECRET");
      }
      // a raw ../ segment is normalized away by URL parsing before routing —
      // it can only miss the route, never reach a file
      const raw = await rawGet(`/api/bots/${bot.id}/memory/topics/../../secret.md`);
      expect(raw.status).toBe(404);
      expect(raw.text).not.toContain("TOP-SECRET");
      // malformed percent-encoding is a clean 400, not a crash
      expect((await rawGet(`/api/bots/${bot.id}/memory/topics/%zz.md`)).status).toBe(400);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });
});

// Hydration is one call that returns every bot's entire transcript. Over
// loopback that is right; over a phone network it is the whole problem.
describe("message pages", () => {
  /** A room whose default responder is mentions-only, posted to without any
   * mention: the user message lands and nothing answers it. That makes the
   * transcript exactly as long as we asked for — no bot turn racing the
   * assertions. */
  const seedRoom = async (count: number) => {
    const { body } = await api("GET", "/api/bots");
    const created = await api("POST", "/api/groups", { name: "Paging", memberIds: [body.bots[0].id] });
    expect(created.status).toBe(201);
    const groupId = created.body.group.id;
    // finish room setup with a mentions-only responder so no bot answers the probes
    const quiet = await api("PATCH", `/api/groups/${groupId}/setup`, {
      action: "complete",
      defaultResponder: { kind: "mentions" },
      bulletin: "",
    });
    expect(quiet.status).toBe(200);

    for (let i = 0; i < count; i++) {
      const posted = await api("POST", `/api/groups/${groupId}/messages`, { text: `page probe ${i}` });
      expect(posted.status).toBe(202);
    }
    const after = await api("GET", "/api/bots");
    return after.body.groups.find((g: { id: string }) => g.id === groupId);
  };

  it("returns the whole transcript when nothing is asked for", async () => {
    const room = await seedRoom(6);
    expect(room.messages).toHaveLength(6);
    // the original shape carries no pagination fields at all
    expect(room).not.toHaveProperty("hasMore");
  });

  it("returns only the newest n when asked", async () => {
    const full = await seedRoom(6);
    const { status, body } = await api("GET", "/api/bots?messages=2");
    expect(status).toBe(200);
    const slim = body.groups.find((g: { id: string }) => g.id === full.id);
    expect(slim.messages).toHaveLength(2);
    expect(slim.hasMore).toBe(true);
    // the newest two, not the oldest two
    expect(slim.messages.map((msg: { id: string }) => msg.id)).toEqual(
      full.messages.slice(-2).map((msg: { id: string }) => msg.id),
    );
    // and every 1:1 thread is capped by the same parameter
    expect(body.bots.every((b: { messages: unknown[] }) => b.messages.length <= 2)).toBe(true);
  });

  it("pages backwards from a message the client already holds", async () => {
    const full = await seedRoom(6);
    const fourth = full.messages[3];

    const { status, body } = await api("GET", `/api/threads/${full.threadId}/messages?before=${fourth.id}&limit=2`);
    expect(status).toBe(200);
    expect(body.messages.map((msg: { id: string }) => msg.id)).toEqual(
      full.messages.slice(1, 3).map((msg: { id: string }) => msg.id),
    );
    expect(body.hasMore).toBe(true);

    // walking back far enough reaches the top and says so
    const top = await api("GET", `/api/threads/${full.threadId}/messages?limit=200`);
    expect(top.body.hasMore).toBe(false);
    expect(top.body.messages).toHaveLength(6);
  });

  it("returns a bounded transcript window around a search result", async () => {
    const full = await seedRoom(9);
    const target = full.messages[4];
    const result = await api("GET", `/api/threads/${full.threadId}/messages?around=${target.id}&limit=5`);
    expect(result.status).toBe(200);
    expect(result.body.messages.map((message: { id: string }) => message.id)).toEqual(
      full.messages.slice(2, 7).map((message: { id: string }) => message.id),
    );
    expect(result.body.hasMore).toBe(true);
    expect((await api("GET", `/api/threads/${full.threadId}/messages?around=nope`)).status).toBe(404);
    expect((await api("GET", `/api/threads/${full.threadId}/messages?around=${target.id}&before=${target.id}`)).status).toBe(400);
  });

  it("refuses a cursor or size it cannot page from", async () => {
    const full = await seedRoom(1);
    // silently answering with the newest page would paginate in a circle
    expect((await api("GET", `/api/threads/${full.threadId}/messages?before=nope`)).status).toBe(404);
    expect((await api("GET", "/api/threads/not-a-thread/messages")).status).toBe(404);
    expect((await api("GET", "/api/bots?messages=-1")).status).toBe(400);
    expect((await api("GET", "/api/bots?messages=lots")).status).toBe(400);
    expect((await api("GET", `/api/threads/${full.threadId}/messages?limit=1.5`)).status).toBe(400);
  });

  it("404s an image on a message that has none", async () => {
    const full = await seedRoom(1);
    const res = await fetch(`${BASE}/api/threads/${full.threadId}/messages/${full.messages[0].id}/image`);
    expect(res.status).toBe(404);
  });

  it("404s an image on a conversation that does not exist, without inventing one", async () => {
    // `messagesFor` materialises and caches a ThreadState for any id it is
    // given, so an unguarded route lets a client grow that map by asking
    // for threads that were never real. The 404 is the visible half; not
    // creating the thread is the half worth having.
    const before = (await api("GET", "/api/bots")).body.bots.length;
    const res = await fetch(`${BASE}/api/threads/not-a-thread/messages/not-a-message/image`);
    expect(res.status).toBe(404);
    expect(z.object({ error: z.string() }).parse(await res.json()).error).toBe("no such conversation");
    // and the phantom thread is not now answerable as an empty conversation
    expect((await api("GET", "/api/threads/not-a-thread/messages")).status).toBe(404);
    expect((await api("GET", "/api/bots")).body.bots.length).toBe(before);
  });
});

// A phone reconnects every time it unlocks, so "what did I miss?" has to
// be answerable without re-downloading every transcript.
describe("resumable event stream", () => {
  /** any request that makes the server broadcast exactly one frame */
  const nudge = async (botId: string) => {
    const res = await api("PATCH", `/api/bots/${botId}`, { unread: true });
    expect(res.status).toBe(200);
  };

  it("hands out a cursor and numbers every frame", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;

    const stream = await openSse(`${BASE}/api/events`);
    try {
      const hello = await stream.until((f) => f.kind === "hello");
      expect(hello.cursor).toMatch(/^[0-9a-f]{8}:\d+$/);
      // a cold connection offered no cursor, so there is nothing to resume
      expect(hello.resumed).toBe(false);

      await nudge(botId);
      await nudge(botId);
      // the PATCH response and the SSE frame travel on different sockets —
      // wait for the frames themselves rather than assuming they landed
      await stream.until(() => stream.frames.filter((f) => f.kind === "bot").length >= 2);
      const bots = z.array(z.object({ seq: z.number() }).passthrough()).parse(
        stream.frames.filter((frame) => frame.kind === "bot"),
      );
      expect(bots[1].seq).toBeGreaterThan(bots[0].seq);
    } finally {
      stream.close();
    }
  });

  it("sends browser-visible heartbeats without moving the replay cursor", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;
    const first = await openSse(`${BASE}/api/events`);
    const hello = z.object({ cursor: z.string() }).passthrough().parse(
      await first.until((frame) => frame.kind === "hello"),
    );
    try {
      expect(await first.until((frame) => frame.kind === "ping")).toEqual({ kind: "ping" });
      await nudge(botId);
      const next = await first.until((frame) => frame.kind === "bot" && frame.bot?.id === botId);
      expect(next.seq).toBe(Number(hello.cursor.split(":")[1]) + 1);
    } finally {
      first.close();
    }

    // Heartbeats describe connection health, not application state. A
    // reconnect from the numbered application frame remains fully resumable.
    const cursor = `${hello.cursor.split(":")[0]}:${Number(hello.cursor.split(":")[1]) + 1}`;
    const resumed = await openSse(`${BASE}/api/events?since=${encodeURIComponent(cursor)}`);
    try {
      expect((await resumed.until((frame) => frame.kind === "hello")).resumed).toBe(true);
    } finally {
      resumed.close();
    }
  });

  it("replays exactly what a disconnected client missed", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;

    const first = await openSse(`${BASE}/api/events`);
    const hello = z.object({ cursor: z.string() }).passthrough().parse(
      await first.until((frame) => frame.kind === "hello"),
    );
    await nudge(botId);
    const seen = z.object({ seq: z.number() }).passthrough().parse(
      await first.until((frame) => frame.kind === "bot"),
    );
    first.close();
    // a real client advances its cursor as frames arrive — resume from the
    // last frame it actually saw, not from where it connected
    const cursor = `${hello.cursor.split(":")[0]}:${seen.seq}`;

    // ...three things happen while the phone is asleep...
    await nudge(botId);
    await nudge(botId);
    await nudge(botId);

    const resumed = await openSse(`${BASE}/api/events?since=${encodeURIComponent(cursor)}`);
    try {
      // ...and an old cursor still replays them, in order, without a hydrate
      const back = await resumed.until((f) => f.kind === "hello");
      expect(back.resumed).toBe(true);
      await resumed.until((f) => f.kind === "bot" && f.seq === seen.seq + 3);
      const replayed = resumed.frames.filter((f) => f.kind === "bot").map((f) => f.seq);
      expect(replayed).toEqual([seen.seq + 1, seen.seq + 2, seen.seq + 3]);
    } finally {
      resumed.close();
    }
  });

  it("resumes a browser EventSource through Last-Event-ID alone", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;

    const first = await openSse(`${BASE}/api/events`);
    const hello = z.object({ cursor: z.string() }).passthrough().parse(
      await first.until((frame) => frame.kind === "hello"),
    );
    first.close();
    await nudge(botId);

    // the id: field is what a browser echoes back on its own reconnect
    const resumed = await openSse(`${BASE}/api/events`, { "last-event-id": hello.cursor });
    try {
      expect((await resumed.until((f) => f.kind === "hello")).resumed).toBe(true);
      await resumed.until((f) => f.kind === "bot");
    } finally {
      resumed.close();
    }
  });

  it("prefers a newer Last-Event-ID over the EventSource URL's stale cursor", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;

    const first = await openSse(`${BASE}/api/events`);
    const hello = z.object({ cursor: z.string() }).passthrough().parse(
      await first.until((frame) => frame.kind === "hello"),
    );
    await nudge(botId);
    const seen = z.object({ seq: z.number() }).passthrough().parse(
      await first.until((frame) => frame.kind === "bot" && frame.bot?.id === botId),
    );
    first.close();
    await nudge(botId);

    // Native EventSource reconnects reuse their original URL, including its
    // old query, but add Last-Event-ID for the newest numbered frame seen.
    const resumed = await openSse(
      `${BASE}/api/events?since=${encodeURIComponent(hello.cursor)}`,
      { "last-event-id": `${hello.cursor.split(":")[0]}:${seen.seq}` },
    );
    try {
      expect((await resumed.until((frame) => frame.kind === "hello")).resumed).toBe(true);
      await resumed.until((frame) => frame.kind === "bot" && frame.bot?.id === botId);
      const replayed = resumed.frames.filter((frame) => frame.kind === "bot" && frame.bot?.id === botId);
      expect(replayed.map((frame) => frame.seq)).toEqual([seen.seq + 1]);
    } finally {
      resumed.close();
    }
  });

  it("keeps delivering everything else when a client declines screen frames", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;

    // a phone on cellular opts out of the live desktop captures; nothing
    // else about its stream changes
    const stream = await openSse(`${BASE}/api/events?screens=off`);
    try {
      expect((await stream.until((f) => f.kind === "hello")).resumed).toBe(false);
      await nudge(botId);
      await stream.until((f) => f.kind === "bot");
      expect(stream.frames.some((f) => f.kind === "screen")).toBe(false);
    } finally {
      stream.close();
    }
  });

  it("refuses a cursor it cannot honour instead of replaying the wrong run", async () => {
    for (const cursor of ["deadbeef:1", "not-a-cursor", "12345678:999999"]) {
      const stream = await openSse(`${BASE}/api/events?since=${encodeURIComponent(cursor)}`);
      try {
        const hello = await stream.until((f) => f.kind === "hello");
        // false is the signal to hydrate — a partial replay would leave a
        // permanent hole in the client's state
        expect(hello.resumed).toBe(false);
      } finally {
        stream.close();
      }
    }
  });
});

describe("instance CLI override API", () => {
  it("round-trips a set, clear, and rejects bad input", async () => {
    // ghost is the fixture's one shadow instance (unknown driver)
    const set = await api("PATCH", "/api/instances/ghost", { cli: "/opt/ghost/wrapper sub" });
    expect(set.status).toBe(200);
    const setRow = set.body.instances.find((instance: { instanceId: string; cli?: string }) => instance.instanceId === "ghost");
    expect(setRow.cli).toBe("/opt/ghost/wrapper sub");

    // persisted for real: the next fleet rebuild reads it back
    const cleared = await api("PATCH", "/api/instances/ghost", { cli: "" });
    expect(cleared.status).toBe(200);
    const clearedRow = cleared.body.instances.find((instance: { instanceId: string; cli?: string }) => instance.instanceId === "ghost");
    expect(clearedRow.cli).toBeUndefined();

    expect((await api("PATCH", "/api/instances/nope", { cli: "/x" })).status).toBe(404);
    expect((await api("PATCH", "/api/instances/ghost", { cli: 42 })).status).toBe(400);
    expect((await api("PATCH", "/api/instances/ghost", { cli: "/x\ny" })).status).toBe(400);
  });

  it("echoes a path-ish name back as the only cli candidate", async () => {
    const res = await api("GET", "/api/cli-candidates?name=/opt/definitely/not/here");
    expect(res.status).toBe(200);
    expect(res.body.candidates).toEqual(["/opt/definitely/not/here"]);
    expect((await api("GET", "/api/cli-candidates?name=")).body.candidates).toEqual([]);
  });

  it("reports a missing binary as a failed probe with install info", async () => {
    const res = await api("POST", "/api/cli-test", { cli: "/no/such/binary-anywhere", driver: "claudeAgent" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toContain("isn't installed");
    expect(res.body.install?.docsUrl).toBe("https://claude.com/claude-code");
  });

  it("probes the complete wrapper with fixed arguments and no inherited credentials", async () => {
    const script = join(home, "cli-wrapper-probe.mjs");
    writeFileSync(
      script,
      `if (process.argv.slice(2).join(" ") !== "fixed --version") process.exit(9);\nif (process.env.COMPOSIO_API_KEY) process.exit(8);\nconsole.log("wrapper-ok");\n`,
    );
    const cli = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} fixed`;
    const res = await api("POST", "/api/cli-test", { cli });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, version: "wrapper-ok" });
  });

  it("reports excessive probe output without presenting install guidance", async () => {
    const script = join(home, "cli-noisy-probe.mjs");
    writeFileSync(script, `process.stdout.write("x".repeat(70 * 1024));\n`);
    const cli = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
    const res = await api("POST", "/api/cli-test", { cli, driver: "claudeAgent" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toContain("more than 64 KiB");
    expect(res.body.install).toBeUndefined();
  });

  it("rejects overlapping provider configuration writes", async () => {
    const slowConfigWrite = api("PUT", "/api/config", { box: { token: "box_slow" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const overlapping = await api("PATCH", "/api/instances/ghost", { cli: "/tmp/ghost-overlap" });
    expect(overlapping.status).toBe(409);
    expect((await slowConfigWrite).status).toBe(200);
  });
});

describe("computer control API (who is driving)", () => {
  let botId = "";

  beforeAll(async () => {
    const created = await api("POST", "/api/bots", {});
    botId = created.body.bot.id;
  });

  it("starts disengaged", async () => {
    const res = await api("GET", `/api/bots/${botId}/computer/control`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ held: false, helpReason: null, heldSinceMs: null });
  });

  it("take → held, broadcast on the wire, release → disengaged", async () => {
    const sse = await openSse(`${BASE}/api/events`);
    try {
      const took = await api("POST", `/api/bots/${botId}/computer/control`, { action: "take" });
      expect(took.status).toBe(200);
      expect(took.body.held).toBe(true);
      const frame = await sse.until(
        (f) => f.kind === "computer-control" && f.botId === botId && f.held === true,
      );
      expect(frame.helpReason).toBeNull();
      const hydrated = await api("GET", "/api/bots");
      expect(hydrated.body.computerControl[botId]).toEqual({ held: true, helpReason: null });
      const released = await api("POST", `/api/bots/${botId}/computer/control`, { action: "release" });
      expect(released.body.held).toBe(false);
    } finally {
      sse.close();
    }
  });

  it("atomically owns and conditionally releases a workspace lease without returning its id", async () => {
    const owner = "lease_5b6bbbd2-b88b-4c50-a748-ec87f332662f";
    const other = "lease_ed602995-306f-480a-8817-e8d8c8fe7d90";
    const took = await api("POST", `/api/bots/${botId}/computer/control`, {
      action: "take",
      controlLeaseId: owner,
    });
    expect(took.body).toMatchObject({ held: true, owned: true, acquired: true });
    expect(JSON.stringify(took.body)).not.toContain(owner);

    const blocked = await api("POST", `/api/bots/${botId}/computer/control`, {
      action: "take",
      controlLeaseId: other,
    });
    expect(blocked.body).toMatchObject({ held: true, owned: false, acquired: false });

    const wrongRelease = await api("POST", `/api/bots/${botId}/computer/control`, {
      action: "release",
      controlLeaseId: other,
    });
    expect(wrongRelease.body).toMatchObject({ held: true, released: false });

    const released = await api("POST", `/api/bots/${botId}/computer/control`, {
      action: "release",
      controlLeaseId: owner,
    });
    expect(released.body).toMatchObject({ held: false, released: true });
    expect(JSON.stringify(released.body)).not.toContain(owner);
  });

  it("rejects malformed workspace leases without echoing them", async () => {
    const invalid = "bad lease value";
    const res = await api("POST", `/api/bots/${botId}/computer/control`, {
      action: "take",
      controlLeaseId: invalid,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(invalid);
  });

  it("refuses an unknown action and an unknown bot", async () => {
    const bad = await api("POST", `/api/bots/${botId}/computer/control`, { action: "hijack" });
    expect(bad.status).toBe(400);
    const ghost = await api("GET", "/api/bots/nope/computer/control");
    expect(ghost.status).toBe(404);
  });

  it("refuses a form-shaped POST — control mutations are JSON-only", async () => {
    const res = await fetch(`${BASE}/api/bots/${botId}/computer/control`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=take",
    });
    expect(res.status).toBe(415);
  });

  it("keeps the internal who-is-driving endpoint behind the boot token", async () => {
    const res = await fetch(`${BASE}/api/internal/computer-control?botId=${botId}`);
    expect(res.status).toBe(401);
  });
});

describe("hostile and dangling input at the HTTP boundary", () => {
  it("keeps a character whose bytes straddle a socket chunk boundary intact", async () => {
    // Node's HTTP parser hands the body over in chunks — roughly 64 KB each,
    // well inside the 1 MB cap — and a chunk boundary can land in the middle of
    // a multi-byte character. `readBody` accumulated with `data += chunk` over
    // raw Buffers, so each chunk was decoded on its own and both halves of a
    // split character became U+FFFD. That is legal inside a JSON string, so the
    // request answered 201 and the mangled text was persisted with no error
    // anywhere. This drives the boundary deliberately rather than waiting for a
    // large enough body to hit it by chance.
    const name = "Ship 🚀 日本語 now";
    const payload = Buffer.from(JSON.stringify({ name }), "utf8");
    const cut = payload.indexOf(Buffer.from("🚀", "utf8")) + 2;
    expect(cut).toBeGreaterThan(2);

    const created = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const post = request(
        {
          host: "127.0.0.1",
          port: PORT,
          path: "/api/bots",
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE },
        },
        (res) => {
          res.setEncoding("utf8");
          let text = "";
          res.on("data", (chunk) => { text += chunk; });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
        },
      );
      post.on("error", reject);
      // Two writes with a gap: the request is chunked, so the server sees two
      // `data` events with the character split between them.
      post.write(payload.subarray(0, cut));
      setTimeout(() => post.end(payload.subarray(cut)), 25);
    });

    expect(created.status).toBe(201);
    expect(created.body.bot.name).toBe(name);
    expect(created.body.bot.name).not.toContain("\uFFFD");

    // And the same bytes survive the round trip through storage, not just the
    // echo in the create response.
    const listed = await api("GET", "/api/bots");
    expect(listed.body.bots.find((bot: any) => bot.id === created.body.bot.id)?.name).toBe(name);
    await api("DELETE", `/api/bots/${created.body.bot.id}`);
  });

  it("answers a deeply nested body with 400 instead of overflowing the stack", async () => {
    // Every mutation route validates its body through z.json(), which
    // descends once per level of nesting, and safeParse does not catch a
    // RangeError. A few kilobytes of `{"a":{"a":…}}` — well inside the size
    // cap — therefore answered with 500 "Maximum call stack size exceeded".
    type NestedProbe = { end: true } | { a: NestedProbe };
    const nested = (depth: number): NestedProbe => {
      let node: NestedProbe = { end: true };
      for (let level = 0; level < depth; level++) node = { a: node };
      return node;
    };
    // The hostile body is assembled as text rather than built as an object and
    // handed to JSON.stringify. stringify recurses once per level too, so the
    // 6,000-deep probe overflowed inside the test helper on runners with a
    // smaller default stack than a developer laptop — the request was never
    // sent and the boundary this test exists to cover was never exercised.
    const deep = (depth: number) => `{"a":`.repeat(depth) + `{"end":true}` + `}`.repeat(depth);
    // Same return shape the file's `api` helper declares, so the assertions
    // below read the parsed body the same way.
    const postRaw = async (path: string, rawBody: string): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: rawBody,
      });
      return { status: res.status, body: await res.json() };
    };
    const created = await postRaw("/api/bots", `{"name":"Nested","deep":${deep(6_000)}}`);
    expect(created.status).toBe(400);
    expect(created.body.error).not.toContain("call stack");
    expect((await postRaw("/api/groups", `{"name":"Nested","memberIds":[],"deep":${deep(6_000)}}`)).status).toBe(400);
    // A body that is merely nested, not absurdly so, still goes through.
    const ordinary = await api("POST", "/api/bots", { name: "Shallow nest", deep: nested(20) });
    expect(ordinary.status).toBe(201);
    await api("DELETE", `/api/bots/${ordinary.body.bot.id}`);
  });

  it("rejects control characters in an imported persona, exactly as the direct route does", async () => {
    // name, title and description are composed into the engine's system
    // prompt and handed to the CLI as a spawn argument, where one NUL kills
    // every future run for that operator. The import door has to enforce the
    // refinement the create door already does.
    const manifest = (field: "name" | "title" | "description", value: string) => ({
      format: "helmryth.crew",
      version: 1,
      crew: {
        name: "Control characters",
        operators: [{
          key: "smuggler",
          name: "Smuggler",
          title: "Operator",
          description: "Ordinary description",
          appearance: { color: "green" },
          [field]: value,
        }],
      },
    });
    const before = (await api("GET", "/api/bots?messages=0")).body.bots.length;
    for (const [field, value] of [
      ["name", `Nu${String.fromCharCode(0)}l`],
      ["title", `Ti${String.fromCharCode(7)}tle`],
      ["description", `De${String.fromCharCode(27)}sc${String.fromCharCode(127)}`],
    ] as const) {
      const rejected = await importCrew("/api/teams/import", manifest(field, value));
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toBe(`${field} must not contain control characters`);
    }
    expect((await api("GET", "/api/bots?messages=0")).body.bots).toHaveLength(before);
    const clean = await importCrew("/api/teams/import", manifest("title", "Operator"));
    expect(clean.status).toBe(201);
    for (const bot of clean.body.bots) await api("DELETE", `/api/bots/${bot.id}`);
  });

  it("bounds a once cadence to an instant a Date can represent", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Cadence bounds" })).body.bot;
    try {
      // Number.isFinite accepted all of these, and they were persisted: every
      // later render of that row is `new Date(at)` on an Invalid Date.
      for (const at of [Number.MAX_SAFE_INTEGER + 1, 1e30, -1e15, 8_640_000_000_000_001]) {
        const rejected = await api("POST", "/api/routines", {
          name: "Out of range", prompt: "run", botId: bot.id, schedule: { type: "once", at },
        });
        expect(rejected.status).toBe(400);
        expect(rejected.body.error).toBe("Choose a valid date and time");
      }
      const cadencesForBot = async () =>
        (await api("GET", "/api/routines")).body.routines
          .filter((routine: { botId: string }) => routine.botId === bot.id);
      expect(await cadencesForBot()).toHaveLength(0);
      const accepted = await api("POST", "/api/routines", {
        name: "In range", prompt: "run", botId: bot.id, schedule: { type: "once", at: Date.now() + 600_000 },
      });
      expect(accepted.status).toBe(201);
      const patched = await api("PATCH", `/api/routines/${accepted.body.routine.id}`, {
        schedule: { type: "once", at: Number.MAX_SAFE_INTEGER + 1 },
      });
      expect(patched.status).toBe(400);
      expect((await cadencesForBot())[0].schedule.at).toBe(accepted.body.routine.schedule.at);
      await api("DELETE", `/api/routines/${accepted.body.routine.id}`);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("tells an unknown operator and an unknown run apart from the last-run rule", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Run identity" })).body.bot;
    try {
      const second = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "second" });
      expect(second.status).toBe(201);
      // The operator holds two runs here, so the last-run rule provably is
      // not what these answers are about.
      expect(await api("DELETE", `/api/bots/${bot.id}/tasks/no-such-thread`)).toMatchObject({
        status: 404, body: { error: "No such run" },
      });
      expect(await api("DELETE", "/api/bots/no-such-operator/tasks/no-such-thread")).toMatchObject({
        status: 404, body: { error: "No such operator" },
      });
      // The real last-run rule still answers 400.
      expect((await api("DELETE", `/api/bots/${bot.id}/tasks/${second.body.task.threadId}`)).status).toBe(200);
      expect(await api("DELETE", `/api/bots/${bot.id}/tasks/${bot.threadId}`)).toMatchObject({
        status: 400, body: { error: "An operator keeps at least one run" },
      });
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("clears a deleted operator out of every crew it belonged to", async () => {
    const ghost = { instanceId: "ghost", model: "ghost-1" };
    const lead = (await api("POST", "/api/bots", { name: "Departing lead", modelSelection: ghost })).body.bot;
    const survivor = (await api("POST", "/api/bots", { name: "Remaining", modelSelection: ghost })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Crew that outlives its lead",
      memberIds: [lead.id, survivor.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    })).body.group;
    try {
      expect((await api("DELETE", `/api/bots/${lead.id}`)).status).toBe(200);
      const state = (await api("GET", "/api/bots?messages=0")).body;
      const after = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
      // The roster kept the dead id, and the room kept pointing its lead at it.
      expect(after.memberIds).toEqual([survivor.id]);
      expect(after.defaultResponder).toEqual({ kind: "member", botId: survivor.id });
      // A dangling id used to pass the "is this a member?" check and be
      // re-armed as lead with a 200, while a never-issued id was refused.
      expect((await api("PATCH", `/api/groups/${room.id}`, {
        defaultResponder: { kind: "member", botId: lead.id },
      })).status).toBe(400);

      // And the message that used to be accepted and then silently dropped
      // now reaches the surviving member.
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "who is on this?" })).status).toBe(202);
      await expect.poll(async () => {
        const latest = (await api("GET", "/api/bots?messages=20")).body;
        const messages = latest.groups.find((candidate: { id: string }) => candidate.id === room.id).messages;
        return messages.some((message: { tool?: { name?: string } }) =>
          message.tool?.name === "error: Remaining's model is unavailable"
        );
      }, { timeout: 5_000 }).toBe(true);
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${survivor.id}`);
    }
  });
});
