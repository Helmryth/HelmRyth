// Focused real-server contract coverage for four small mutation routes that
// previously had service/client tests but no direct method/path assertions.
// The provider boundary is the existing fake ACP CLI; no live provider or
// credential is involved.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { openSse, type SseFrame } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_ACP_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18_800 + Math.floor(Math.random() * 10_000);
const WEBHOOK_PORT = 39_000 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const SENSITIVE_MARKER = "synthetic-sensitive-marker-9d82f1";
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let home: string;
let stderr = "";

const errorSchema = z.object({ error: z.string() });
const messageSchema = z.object({
  id: z.string(),
  reactions: z.array(z.object({ emoji: z.string(), by: z.string() })).optional(),
}).passthrough();
const botSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  alwaysAllow: z.array(z.string()).optional(),
  busy: z.boolean().optional(),
  messages: z.array(z.object({
    id: z.string(),
    kind: z.string(),
    reactions: z.array(z.object({ emoji: z.string(), by: z.string() })).optional(),
    card: z.object({
      requestId: z.string().optional(),
      allowKey: z.string().optional(),
      answered: z.string().optional(),
      dismissed: z.boolean().optional(),
    }).passthrough().optional(),
  }).passthrough()).optional(),
}).passthrough();
const groupSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  unread: z.boolean(),
}).passthrough();
const stateSchema = z.object({
  bots: z.array(botSchema),
  groups: z.array(groupSchema),
});
const botResponseSchema = z.object({ bot: botSchema });
const groupResponseSchema = z.object({ group: groupSchema });
const reactionResponseSchema = z.object({ message: messageSchema });
const webhookCreateSchema = z.object({
  webhook: z.object({ id: z.string(), deliveryCount: z.number().int().nonnegative() }).passthrough(),
}).passthrough();
const webhookTestSchema = z.object({
  runId: z.string(),
  deliveryId: z.string(),
  duplicate: z.literal(false),
});
const webhookListSchema = z.object({
  webhooks: z.array(z.object({
    id: z.string(),
    deliveryCount: z.number().int().nonnegative(),
    lastRunId: z.string().optional(),
  }).passthrough()),
  attempts: z.array(z.object({
    webhookId: z.string(),
    outcome: z.string(),
    runId: z.string().optional(),
  }).passthrough()),
}).passthrough();
const requestBodySchema = z.json();
type RequestBody = z.input<typeof requestBodySchema>;
const mutationSseFrameSchema = z.object({
  kind: z.string().optional(),
  message: messageSchema.optional(),
  bot: botSchema.optional(),
  group: groupSchema.optional(),
  webhook: z.object({
    id: z.string(),
    deliveryCount: z.number().int().nonnegative(),
    lastRunId: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

interface HttpResult {
  status: number;
  body: unknown;
  contentType: string;
}

async function rawRequest(method: string, path: string, body?: string, contentType?: string): Promise<HttpResult> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: contentType ? { "content-type": contentType } : undefined,
    body,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    contentType: response.headers.get("content-type") ?? "",
  };
}

async function api(method: string, path: string, body?: RequestBody): Promise<HttpResult> {
  const mutation = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  return rawRequest(
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body),
    mutation ? "application/json" : undefined,
  );
}

function expectJson(result: HttpResult, status: number): void {
  expect(result.status).toBe(status);
  expect(result.contentType).toContain("application/json");
}

function expectSecretSafeError(result: HttpResult, status: number): void {
  expectJson(result, status);
  const parsed = errorSchema.parse(result.body);
  expect(parsed.error).toBeTruthy();
  expect(JSON.stringify(result.body)).not.toContain(SENSITIVE_MARKER);
}

function mutationFrame(frame: SseFrame) {
  return mutationSseFrameSchema.parse(frame);
}

async function waitForPermissionCard(botId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await api("GET", "/api/bots");
    const bot = stateSchema.parse(response.body).bots.find((candidate) => candidate.id === botId);
    const card = bot?.messages?.find((message) =>
      message.kind === "options" &&
      message.card?.requestId &&
      message.card.allowKey &&
      !message.card.answered &&
      message.card.dismissed !== true
    );
    if (card?.card?.requestId && card.card.allowKey) {
      return { requestId: card.card.requestId, allowKey: card.card.allowKey };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`approval card did not appear for ${botId}`);
}

async function createBot(body?: RequestBody) {
  const created = await api("POST", "/api/bots", body ?? {});
  expectJson(created, 201);
  return botResponseSchema.parse(created.body).bot;
}

posixOnly("miscellaneous HTTP mutation contracts", () => {
  beforeAll(async () => {
    chmodSync(FAKE_ACP_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "hry-http-misc-"));
    const dataDir = join(home, ".helmryth");
    const fakeBin = join(home, "bin");
    const fakePi = join(fakeBin, "pi");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(fakePi, "#!/bin/sh\nprintf 'pi 0.0-test\\n'\n");
    chmodSync(fakePi, 0o755);
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({
        instances: {
          ghost: { driver: "not-a-real-driver", displayName: "Offline fixture" },
          fixture: {
            driver: "grokAgent",
            displayName: "Permission fixture",
            environment: { FAKE_ACP_MODE: "permission" },
            config: { cli: FAKE_ACP_CLI, fullAuto: false },
          },
        },
      }),
    );

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      HELMRYTH_PORT: String(PORT),
      HELMRYTH_WEBHOOK_PORT: String(WEBHOOK_PORT),
    };
    env.PATH = process.env.PATH ? `${fakeBin}${delimiter}${process.env.PATH}` : fakeBin;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (chunk) => (stderr += chunk));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        // The child has not bound the loopback port yet.
      }
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("POST /api/webhooks/:webhookId/test validates the route and creates a fresh durable run per activation", async () => {
    const starter = stateSchema.parse((await api("GET", "/api/bots")).body).bots[0];
    expect(starter).toBeDefined();
    if (!starter) throw new Error("starter operator missing");
    const createdResponse = await api("POST", "/api/webhooks", {
      name: "Contract probe",
      prompt: "Process the synthetic event",
      botId: starter.id,
      runOn: "local",
    });
    expectJson(createdResponse, 201);
    const hook = webhookCreateSchema.parse(createdResponse.body).webhook;
    const stream = await openSse(`${BASE}/api/events`);
    try {
      await stream.until((frame) => frame.kind === "hello");

      expectSecretSafeError(
        await rawRequest(
          "POST",
          `/api/webhooks/${hook.id}/test`,
          `{"payload":"${SENSITIVE_MARKER}"`,
          "application/json",
        ),
        400,
      );
      expectSecretSafeError(await api("POST", "/api/webhooks/no-such-webhook/test", { event: "probe" }), 404);
      expectSecretSafeError(await api("GET", `/api/webhooks/${hook.id}/test`), 404);

      // Management mutations use the same JSON-only contract as the rest of
      // the renderer API. This does not alter the separate path-secret ingress.
      const simpleResponse = await rawRequest(
        "POST",
        `/api/webhooks/${hook.id}/test`,
        JSON.stringify({ event: "first", build: 1 }),
        "text/plain",
      );
      expectJson(simpleResponse, 415);
      const firstResponse = await api("POST", `/api/webhooks/${hook.id}/test`, { event: "first", build: 1 });
      expectJson(firstResponse, 202);
      const first = webhookTestSchema.parse(firstResponse.body);
      const firstEvent = await stream.until((frame) => {
        const webhook = mutationFrame(frame).webhook;
        return frame.kind === "webhook" && webhook?.id === hook.id && webhook.deliveryCount === 1;
      });
      expect(mutationFrame(firstEvent).webhook?.lastRunId).toBe(first.runId);

      const secondResponse = await api("POST", `/api/webhooks/${hook.id}/test`, { event: "second", build: 2 });
      expectJson(secondResponse, 202);
      const second = webhookTestSchema.parse(secondResponse.body);
      expect(second.runId).not.toBe(first.runId);
      expect(second.deliveryId).not.toBe(first.deliveryId);

      const listedResponse = await api("GET", "/api/webhooks");
      expectJson(listedResponse, 200);
      const listed = webhookListSchema.parse(listedResponse.body);
      expect(listed.webhooks.find((candidate) => candidate.id === hook.id)).toMatchObject({
        deliveryCount: 2,
        lastRunId: second.runId,
      });
      expect(listed.attempts.filter((attempt) => attempt.webhookId === hook.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ outcome: "accepted", runId: first.runId }),
          expect.objectContaining({ outcome: "accepted", runId: second.runId }),
        ]),
      );
      expect(JSON.stringify(listedResponse.body)).not.toMatch(/whsec_|secretHash|"credential"\s*:/i);
    } finally {
      stream.close();
      expectJson(await api("DELETE", `/api/webhooks/${hook.id}`), 200);
    }
  }, 60_000);

  it("POST /api/threads/:threadId/messages/:messageId/reactions toggles once, persists, and emits patches", async () => {
    const bot = await createBot();
    const message = bot.messages?.[0];
    expect(message).toBeDefined();
    if (!message) throw new Error("created operator had no seeded message");
    const route = `/api/threads/${bot.threadId}/messages/${message.id}/reactions`;
    const stream = await openSse(`${BASE}/api/events`);
    try {
      await stream.until((frame) => frame.kind === "hello");
      expectSecretSafeError(
        await rawRequest("POST", route, `{"emoji":"${SENSITIVE_MARKER}"`, "application/json"),
        400,
      );
      expectSecretSafeError(await api("POST", route, null), 400);
      expectSecretSafeError(await api("POST", route, []), 400);
      expectSecretSafeError(await api("POST", route, {}), 400);
      expectSecretSafeError(await api("POST", `/api/threads/no-such-thread/messages/${message.id}/reactions`, { emoji: "👍" }), 404);
      expectSecretSafeError(await api("POST", `/api/threads/${bot.threadId}/messages/no-such-message/reactions`, { emoji: "👍" }), 404);
      expectSecretSafeError(await api("PUT", route, { emoji: "👍" }), 404);

      const activatedResponse = await rawRequest(
        "POST",
        route,
        JSON.stringify({ emoji: "👍", by: "contract-user" }),
        "text/plain",
      );
      expectJson(activatedResponse, 415);
      const acceptedResponse = await api("POST", route, { emoji: "👍", by: "contract-user" });
      expectJson(acceptedResponse, 200);
      const activated = reactionResponseSchema.parse(acceptedResponse.body).message;
      expect(activated.reactions).toEqual([{ emoji: "👍", by: "contract-user" }]);
      await stream.until((frame) => {
        const patched = mutationFrame(frame).message;
        return frame.kind === "message.patch" && patched?.id === message.id && Array.isArray(patched.reactions);
      });

      const toggledOffResponse = await api("POST", route, { emoji: "👍", by: "contract-user" });
      expectJson(toggledOffResponse, 200);
      expect(reactionResponseSchema.parse(toggledOffResponse.body).message.reactions).toBeUndefined();

      const persisted = stateSchema.parse((await api("GET", "/api/bots")).body).bots.find((candidate) => candidate.id === bot.id);
      expect(persisted?.messages?.find((candidate) => candidate.id === message.id)?.reactions).toBeUndefined();
    } finally {
      stream.close();
      expectJson(await api("DELETE", `/api/bots/${bot.id}`), 200);
    }
  }, 30_000);

  it("POST /api/bots/:botId/always-allow only accepts a pending gate and deduplicates repeat grants", async () => {
    const bot = await createBot({
      name: "Permission contract",
      modelSelection: { instanceId: "fixture", model: "fake-model" },
    });
    expectJson(await api("POST", `/api/bots/${bot.id}/messages`, { text: "request the fixture tool" }), 202);
    const pending = await waitForPermissionCard(bot.id);
    const route = `/api/bots/${bot.id}/always-allow`;
    const stream = await openSse(`${BASE}/api/events`);
    try {
      await stream.until((frame) => frame.kind === "hello");
      expectSecretSafeError(
        await rawRequest("POST", route, `{"allowKey":"${SENSITIVE_MARKER}"`, "application/json"),
        400,
      );
      expectSecretSafeError(await api("POST", route, null), 400);
      expectSecretSafeError(await api("POST", route, []), 400);
      expectSecretSafeError(await api("POST", route, {}), 400);
      expectSecretSafeError(await api("POST", "/api/bots/no-such-bot/always-allow", { allowKey: pending.allowKey }), 404);
      expectSecretSafeError(await api("POST", route, { allowKey: SENSITIVE_MARKER }), 409);
      expectSecretSafeError(await api("GET", route), 404);

      const firstResponse = await rawRequest(
        "POST",
        route,
        JSON.stringify({ allowKey: pending.allowKey }),
        "text/plain",
      );
      expectJson(firstResponse, 415);
      const acceptedResponse = await api("POST", route, { allowKey: pending.allowKey });
      expectJson(acceptedResponse, 200);
      expect(botResponseSchema.parse(acceptedResponse.body).bot.alwaysAllow).toEqual([pending.allowKey]);
      await stream.until((frame) => {
        const updated = mutationFrame(frame).bot;
        return frame.kind === "bot" && updated?.id === bot.id &&
          Array.isArray(updated.alwaysAllow) && updated.alwaysAllow.includes(pending.allowKey);
      });

      const repeatedResponse = await api("POST", route, { allowKey: pending.allowKey });
      expectJson(repeatedResponse, 200);
      expect(botResponseSchema.parse(repeatedResponse.body).bot.alwaysAllow).toEqual([pending.allowKey]);
      const persisted = stateSchema.parse((await api("GET", "/api/bots")).body).bots.find((candidate) => candidate.id === bot.id);
      expect(persisted?.alwaysAllow).toEqual([pending.allowKey]);
    } finally {
      stream.close();
      await api("POST", `/api/bots/${bot.id}/respond`, { requestId: pending.requestId, behavior: "deny" });
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      expectJson(await api("DELETE", `/api/bots/${bot.id}`), 200);
    }
  }, 60_000);

  it("POST /api/groups/:groupId/read is bodyless, repeat-safe, persistent, and observable", async () => {
    const starter = stateSchema.parse((await api("GET", "/api/bots")).body).bots[0];
    expect(starter).toBeDefined();
    if (!starter) throw new Error("starter operator missing");
    const createdResponse = await api("POST", "/api/groups", {
      name: "Read contract",
      memberIds: [starter.id],
      setup: { bulletin: "", defaultResponder: { kind: "mentions" } },
    });
    expectJson(createdResponse, 201);
    const group = groupResponseSchema.parse(createdResponse.body).group;
    expectJson(await api("PATCH", `/api/groups/${group.id}`, { unread: true }), 200);
    const route = `/api/groups/${group.id}/read`;
    const stream = await openSse(`${BASE}/api/events`);
    try {
      await stream.until((frame) => frame.kind === "hello");
      expectSecretSafeError(await api("POST", "/api/groups/no-such-group/read"), 404);
      expectSecretSafeError(await api("GET", route), 404);

      // Even a bodyless semantic action uses the public JSON media contract.
      const firstResponse = await rawRequest("POST", route, `{${SENSITIVE_MARKER}`, "text/plain");
      expectJson(firstResponse, 415);
      const acceptedResponse = await api("POST", route);
      expectJson(acceptedResponse, 200);
      expect(groupResponseSchema.parse(acceptedResponse.body).group.unread).toBe(false);
      await stream.until((frame) => {
        const updated = mutationFrame(frame).group;
        return frame.kind === "group" && updated?.id === group.id && updated.unread === false;
      });

      const repeatedResponse = await api("POST", route);
      expectJson(repeatedResponse, 200);
      expect(groupResponseSchema.parse(repeatedResponse.body).group.unread).toBe(false);
      const persisted = stateSchema.parse((await api("GET", "/api/bots")).body).groups.find((candidate) => candidate.id === group.id);
      expect(persisted?.unread).toBe(false);
      expect(JSON.stringify(repeatedResponse.body)).not.toContain(SENSITIVE_MARKER);
    } finally {
      stream.close();
      expectJson(await api("DELETE", `/api/groups/${group.id}`), 200);
    }
  }, 30_000);
});
