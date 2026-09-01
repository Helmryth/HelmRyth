// The decision log is only as good as its wiring: every row is written at
// the request.opened fold or in answerRequest, and both of those keep
// working (cards keep appearing, approvals keep flowing) even when the
// logging silently rots away. So, in the style of unattended.test.ts,
// these run the real server against the fake ACP CLI and assert the ROWS,
// not the behavior the rows describe:
//
//   1. a rule-matched auto-approval writes a row naming the rule
//   2. a card and the human's answer write two rows (allow and deny)
//   3. an unattended block writes its row — the audit row that says "this
//      would have auto-approved, and only the block stood in the way"
//   4. GET /api/decisions pages newest-last with ?limit=
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { decisionRowSchema, type DecisionRow } from "./decision-log.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let home: string;
let stderr = "";

const optionCardSchema = z.object({
  kind: z.string(),
  card: z.object({ requestId: z.string().optional(), answered: z.string().optional() }).optional(),
});
const botSchema = z.object({
  id: z.string(),
  messages: z.array(optionCardSchema).optional(),
});
const botResponseSchema = z.object({ bot: botSchema });
const botsResponseSchema = z.object({ bots: z.array(botSchema).default([]) });
const threadMessagesResponseSchema = z.object({ messages: z.array(optionCardSchema).default([]) });
const routinesResponseSchema = z.object({
  runs: z.array(z.object({ id: z.string(), threadId: z.string().optional() })).default([]),
});
const decisionsResponseSchema = z.object({ decisions: z.array(decisionRowSchema).default([]) });
const webhookResponseSchema = z.object({
  credential: z.object({
    endpointUrl: z.string().url(),
    secret: z.string().min(1),
  }),
});
const deliveryResponseSchema = z.object({ runId: z.string() });
const answerResponseSchema = z.object({ outcome: z.string() });
const jsonResponseSchema = z.json();
const permissionBotPatchSchema = z.object({
  name: z.string(),
  alwaysAllow: z.array(z.string()).optional(),
  autoApprove: z.boolean().optional(),
});
type PermissionBotPatch = z.input<typeof permissionBotPatchSchema>;

interface ApiResponse<Body> {
  status: number;
  body: Body;
}

async function api<Schema extends z.ZodType, Body extends object>(
  method: string,
  path: string,
  schema: Schema,
  body?: Body,
): Promise<ApiResponse<z.output<Schema>>> {
  const init: RequestInit = { method };
  if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
    init.headers = { "content-type": "application/json" };
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, body: schema.parse(await res.json()) };
}

/** Newest matching decision row, or null when none shows up in time. */
async function waitForDecision(pred: (r: DecisionRow) => boolean, ms = 30_000): Promise<DecisionRow | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const { body } = await api("GET", "/api/decisions", decisionsResponseSchema);
    const rows = body.decisions;
    const row = rows.filter(pred).at(-1);
    if (row) return row;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** A live permission card on a bot's transcript (via /api/bots — the same
 * poll unattended.test.ts uses, since a bot's card lives on its thread). */
async function waitForBotCard(botId: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { body } = await api("GET", "/api/bots", botsResponseSchema);
    const bot = body.bots.find((candidate) => candidate.id === botId);
    const card = bot?.messages?.find(
      (message) => message.kind === "options" && message.card?.requestId && !message.card.answered,
    );
    if (card) return card;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** A live permission card on a THREAD — webhook turns run in detached
 * tasks, so their cards never appear on the bot's open conversation. */
async function waitForThreadCard(threadId: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { body } = await api("GET", `/api/threads/${threadId}/messages`, threadMessagesResponseSchema);
    const card = body.messages.find(
      (message) => message.kind === "options" && message.card?.requestId,
    );
    if (card) return card;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** The detached task a webhook delivery created. */
async function waitForRunThread(runId: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { body } = await api("GET", "/api/routines", routinesResponseSchema);
    const run = body.runs.find((candidate) => candidate.id === runId);
    if (run?.threadId) return run.threadId;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** A bot whose fake engine asks permission to run `echo hi` (the ACP core
 * folds that to tool "shell", summary "echo hi" — so the always-allow key
 * is "shell:echo"). */
async function makePermissionBot(patch: PermissionBotPatch) {
  const checkedPatch = permissionBotPatchSchema.parse(patch);
  const created = await api("POST", "/api/bots", botResponseSchema);
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  const patched = await api("PATCH", `/api/bots/${bot.id}`, botResponseSchema, {
    ...checkedPatch,
    modelSelection: { instanceId: "grok", model: "fake-model" },
  });
  expect(patched.status).toBe(200);
  return patched.body.bot;
}

posixOnly("authorization decisions are logged", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "hry-decisions-e2e-"));
    mkdirSync(join(home, ".helmryth"), { recursive: true });
    const fakeBin = join(home, "bin");
    const fakePi = join(fakeBin, "pi");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(fakePi, "#!/bin/sh\nprintf 'pi 0.0-test\\n'\n");
    chmodSync(fakePi, 0o755);
    writeFileSync(
      join(home, ".helmryth", "config.json"),
      JSON.stringify({
        instances: {
          grok: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "permission" },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
        },
      }),
    );
    const serverEnv: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      HELMRYTH_PORT: String(PORT),
    };
    serverEnv.PATH = process.env.PATH ? `${fakeBin}${delimiter}${process.env.PATH}` : fakeBin;
    if (process.env.SystemRoot) serverEnv.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: serverEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.stderr) throw new Error("decision-log test server did not expose stderr");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it(
    "a rule-matched auto-approval writes a row naming the rule",
    async () => {
      const bot = await makePermissionBot({ name: "Granted", alwaysAllow: ["shell:echo"] });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, jsonResponseSchema, { text: "run it" })).status).toBe(202);

      const row = await waitForDecision((r) => r.decision === "auto-approved" && r.botId === bot.id);
      expect(row, "the auto-approval never reached the decision log").not.toBeNull();
      if (!row) throw new Error("the auto-approval never reached the decision log");
      expect(row.source).toBe("always-allow");
      expect(row.rule).toBe("shell:echo");
      expect(row.tool).toBe("shell");
      expect(row.summary).toBe("echo hi");
      expect(row.botName).toBe("Granted");
      expect(row.threadId).toBeTruthy();
      expect(row.requestId).toBeTruthy();
    },
    60_000,
  );

  it(
    "a card and the human's allow write two rows",
    async () => {
      const bot = await makePermissionBot({ name: "Askme" });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, jsonResponseSchema, { text: "run it" })).status).toBe(202);

      const card = await waitForBotCard(bot.id);
      expect(card, "no approval card ever appeared").not.toBeNull();
      if (!card?.card?.requestId) throw new Error("no approval card ever appeared");
      const requestId = card.card.requestId;

      const shown = await waitForDecision((r) => r.decision === "card-shown" && r.requestId === requestId);
      expect(shown, "the card was shown but never logged").not.toBeNull();
      if (!shown) throw new Error("the card was shown but never logged");
      expect(shown.source).toBe("no-grant");
      expect(shown.botId).toBe(bot.id);
      expect(shown.tool).toBe("shell");

      const answered = await api("POST", `/api/bots/${bot.id}/respond`, answerResponseSchema, { requestId, behavior: "allow" });
      expect(answered.status).toBe(200);
      expect(answered.body.outcome).not.toBe("unavailable");

      const user = await waitForDecision((r) => r.decision === "user-approved" && r.requestId === requestId);
      expect(user, "the human's answer never reached the decision log").not.toBeNull();
      if (!user) throw new Error("the human's answer never reached the decision log");
      expect(user.source).toBe("user");
      expect(user.tool).toBe("shell");
      expect(user.summary).toBe("echo hi");
      expect(user.botName).toBe("Askme");
    },
    90_000,
  );

  it(
    "a human deny writes its row too",
    async () => {
      const bot = await makePermissionBot({ name: "Refused" });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, jsonResponseSchema, { text: "run it" })).status).toBe(202);

      const card = await waitForBotCard(bot.id);
      expect(card).not.toBeNull();
      if (!card?.card?.requestId) throw new Error("no approval card ever appeared");
      const requestId = card.card.requestId;
      expect((await api("POST", `/api/bots/${bot.id}/respond`, answerResponseSchema, { requestId, behavior: "deny" })).status).toBe(200);

      const user = await waitForDecision((r) => r.decision === "user-denied" && r.requestId === requestId);
      expect(user, "the denial never reached the decision log").not.toBeNull();
      if (!user) throw new Error("the denial never reached the decision log");
      expect(user.source).toBe("user");
    },
    90_000,
  );

  it(
    "an unattended block writes the row that says a grant was withheld",
    async () => {
      // Auto mode on AND the exact key granted: an attended turn would sail
      // straight through, so the only thing carding this one is the
      // unattended block — which is precisely what the row must say.
      const bot = await makePermissionBot({ name: "Nightshift", autoApprove: true, alwaysAllow: ["shell:echo"] });

      const hook = await api("POST", "/api/webhooks", webhookResponseSchema, {
        name: "Nightly build",
        prompt: "Handle the incoming build event",
        botId: bot.id,
        runOn: "local",
      });
      expect(hook.status).toBe(201);
      const delivered = await fetch(hook.body.credential.endpointUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${hook.body.credential.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "failed" }),
      });
      expect(delivered.status).toBe(202);
      const { runId } = deliveryResponseSchema.parse(await delivered.json());

      const threadId = await waitForRunThread(runId);
      expect(threadId, "the webhook never started a task").toBeTruthy();
      if (!threadId) throw new Error("the webhook never started a task");
      const card = await waitForThreadCard(threadId);
      expect(card, "the webhook turn auto-approved instead of asking").not.toBeNull();

      const row = await waitForDecision((r) => r.threadId === threadId && r.decision === "card-shown");
      expect(row, "the unattended block never reached the decision log").not.toBeNull();
      if (!row) throw new Error("the unattended block never reached the decision log");
      expect(row.source).toBe("unattended-block");
      expect(row.rule).toBe("shell:echo");
      expect(row.unattended).toBe(true);
      expect(row.botId).toBe(bot.id);
    },
    90_000,
  );

  it("GET /api/decisions pages newest-last and validates limit", async () => {
    const all = (await api("GET", "/api/decisions", decisionsResponseSchema)).body.decisions;
    expect(all.length).toBeGreaterThanOrEqual(2);
    const one = (await api("GET", "/api/decisions?limit=1", decisionsResponseSchema)).body.decisions;
    expect(one).toHaveLength(1);
    expect(one[0]).toEqual(all.at(-1));
    expect((await api("GET", "/api/decisions?limit=0", jsonResponseSchema)).status).toBe(400);
    expect((await api("GET", "/api/decisions?limit=nope", jsonResponseSchema)).status).toBe(400);
  });
});
