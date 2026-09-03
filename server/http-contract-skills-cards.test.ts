import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { openSse, type SseFrame } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 21_000 + Math.floor(Math.random() * 8_000);
const WEBHOOK_PORT = 39_000 + Math.floor(Math.random() * 8_000);
const BASE = `http://127.0.0.1:${PORT}`;
const CONDUIT_TOKEN = `hry_${"c".repeat(64)}`;
const IMAGE_KEY_CANARY = "sk-contract-private-never-reflect";
const SKILL_SOURCE = "https://raw.githubusercontent.com/helmryth-fixtures/methods/main/SKILL.md";
const SKILL_TEXT = `---
name: route-review
description: Review an HTTP route against its declared contract.
license: Apache-2.0
---

# Route review

Check the request boundary, response schema, persistence, and emitted events.
`;

const errorResponseSchema = z.object({ error: z.string() });
const botSchema = z.object({ id: z.string(), threadId: z.string() }).passthrough();
const skillSchema = z.object({
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  source: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  reviewRevision: z.string().regex(/^[a-f0-9]{64}$/),
  warnings: z.array(z.string()),
  skippedFiles: z.array(z.string()),
  reviewedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).passthrough();
const cardMessageSchema = z.object({
  id: z.string(),
  kind: z.string(),
  secret: z.object({
    provided: z.boolean().optional(),
    dismissed: z.boolean().optional(),
    resumed: z.boolean().optional(),
  }).passthrough().optional(),
  connector: z.object({
    slug: z.string(),
    status: z.string(),
    resumeKey: z.string(),
    dismissed: z.boolean(),
    resumed: z.boolean(),
  }).passthrough().optional(),
}).passthrough();
const messagePageSchema = z.object({ messages: z.array(cardMessageSchema) }).passthrough();
const sqliteMessageRowSchema = z.object({ json: z.string() });
const conduitRequestBodySchema = z.object({}).strict();

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type ApiResult = { status: number; body: JsonValue; contentType: string };

let child: ChildProcess;
let conduit: Server;
let scratch = "";
let dataDir = "";
let fakeClaudeDump = "";
let bot: z.infer<typeof botSchema>;
let commsToken = "";
let stderr = "";
let stdout = "";
let connectorConnected = false;
let connectorAuthorizeCalls = 0;
const conduitRequests: Array<{ method: string; path: string }> = [];
const observedBodies: JsonValue[] = [];
const observedFrames: SseFrame[] = [];

async function api(
  method: string,
  path: string,
  body?: JsonValue,
  headers: Record<string, string> = {},
): Promise<ApiResult> {
  const mutation = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  const requestHeaders = { ...headers };
  if (mutation && requestHeaders["content-type"] === undefined) requestHeaders["content-type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const parsed = z.json().parse(await response.json());
  observedBodies.push(parsed);
  return { status: response.status, body: parsed, contentType };
}

async function rawApi(
  method: string,
  path: string,
  body: string,
  contentType: string,
): Promise<ApiResult> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": contentType },
    body,
  });
  const parsed = z.json().parse(await response.json());
  observedBodies.push(parsed);
  return {
    status: response.status,
    body: parsed,
    contentType: response.headers.get("content-type") ?? "",
  };
}

async function poll<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error("condition did not settle before the HTTP-contract timeout");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

function storedMessage(threadId: string, messageId: string): z.infer<typeof cardMessageSchema> {
  const database = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
  try {
    const row = sqliteMessageRowSchema.parse(database
      .prepare("SELECT json FROM messages WHERE thread_id = ? AND id = ?")
      .get(threadId, messageId));
    return cardMessageSchema.parse(JSON.parse(row.json));
  } finally {
    database.close();
  }
}

async function transcriptMessage(messageId: string): Promise<z.infer<typeof cardMessageSchema>> {
  const response = await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`);
  expect(response.status).toBe(200);
  const page = messagePageSchema.parse(response.body);
  const found = page.messages.find((message) => message.id === messageId);
  if (!found) throw new Error(`message ${messageId} was absent from the HTTP transcript`);
  return found;
}

function expectJson(result: ApiResult, status: number): void {
  expect(result.status).toBe(status);
  expect(result.contentType).toMatch(/^application\/json\b/);
}

function parseConduitBody(raw: string): z.infer<typeof conduitRequestBodySchema> {
  if (!raw) return {};
  return conduitRequestBodySchema.parse(JSON.parse(raw));
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "hry-http-skills-cards-"));
  dataDir = join(scratch, "profile");
  fakeClaudeDump = join(scratch, "fake-claude-dump.json");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dataDir, "config.json"),
    JSON.stringify({
      instances: {
        claude: {
          driver: "claudeAgent",
          displayName: "Contract fixture",
          config: { cli: FAKE_CLAUDE_CLI },
        },
      },
    }),
    { mode: 0o600 },
  );

  // The production skill route still performs its ordinary fetch. This
  // process-local preload replaces only one exact raw-GitHub fixture URL;
  // every other request keeps the native fetch implementation.
  const preload = join(scratch, "fixture-fetch.mjs");
  writeFileSync(
    preload,
    `const nativeFetch = globalThis.fetch;
const source = ${JSON.stringify(SKILL_SOURCE)};
const method = ${JSON.stringify(SKILL_TEXT)};
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === source) return Promise.resolve(new Response(method, { status: 200, headers: { "content-type": "text/markdown" } }));
  return nativeFetch(input, init);
};
`,
    { mode: 0o600 },
  );

  conduit = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    conduitRequests.push({ method: request.method ?? "GET", path: url.pathname });
    if (request.headers.authorization !== `Bearer ${CONDUIT_TOKEN}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = parseConduitBody(raw);
    if (request.method === "GET" && url.pathname === "/v1/capabilities/catalog") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ items: [{ slug: "github", name: "GitHub", description: "Repository work" }] }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/capabilities") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        capabilities: {
          github: connectorConnected
            ? { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "account_github", status: "ACTIVE" }] }
            : { connected: false, pending: false, status: "not_connected", accounts: [] },
        },
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/capabilities/github/authorize") {
      expect(body).toEqual({});
      connectorAuthorizeCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        url: "https://connect.composio.dev/link/github?intent=contract-fixture",
      }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unknown fake Conduit route" }));
  });
  await new Promise<void>((resolve) => conduit.listen(0, "127.0.0.1", resolve));
  const conduitPort = z.object({ port: z.number() }).parse(conduit.address()).port;

  const environment: NodeJS.ProcessEnv = {
    HOME: scratch,
    USERPROFILE: scratch,
    HELMRYTH_DATA_DIR: dataDir,
    HELMRYTH_PORT: String(PORT),
    HELMRYTH_WEBHOOK_PORT: String(WEBHOOK_PORT),
    HELMRYTH_CONDUIT_URL: `http://127.0.0.1:${conduitPort}`,
    HELMRYTH_CONDUIT_TOKEN: CONDUIT_TOKEN,
    HELMRYTH_SSE_HEARTBEAT_MS: "50",
    FAKE_CLAUDE_MODE: "happy",
    FAKE_CLAUDE_DUMP: fakeClaudeDump,
    NODE_OPTIONS: `--import=${preload}`,
  };
  if (process.env.PATH) environment.PATH = process.env.PATH;
  if (process.env.SystemRoot) environment.SystemRoot = process.env.SystemRoot;

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));

  await poll(
    async () => {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}:\n${stderr}`);
      try {
        return (await fetch(`${BASE}/api/health`)).ok;
      } catch {
        return false;
      }
    },
    Boolean,
    20_000,
  );

  const created = await api("POST", "/api/bots", {
    name: "Contract Operator",
    modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
  });
  expectJson(created, 201);
  bot = botSchema.parse(z.record(z.string(), z.unknown()).parse(created.body).bot);

  const bootstrap = await api("POST", `/api/bots/${bot.id}/messages`, { text: "bootstrap contract token" });
  expectJson(bootstrap, 202);
  await poll(() => existsSync(fakeClaudeDump), Boolean);
  const dump = z.object({
    mcpConfig: z.object({
      mcpServers: z.object({
        agents: z.object({ env: z.object({ HELMRYTH_COMMS_TOKEN: z.string().regex(/^[a-f0-9]{48}$/) }) }),
      }).passthrough(),
    }),
  }).passthrough().parse(JSON.parse(readFileSync(fakeClaudeDump, "utf8")));
  commsToken = dump.mcpConfig.mcpServers.agents.env.HELMRYTH_COMMS_TOKEN;
  await poll(
    async () => {
      const result = await api("GET", "/api/bots?messages=0");
      const root = z.object({ bots: z.array(z.record(z.string(), z.unknown())) }).parse(result.body);
      return root.bots.find((candidate) => candidate.id === bot.id)?.busy;
    },
    (busy) => busy === false,
  );
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await new Promise<void>((resolve) => conduit.close(() => resolve()));
  await removeTempDir(scratch);
});

describe("Methods and interactive-card HTTP contracts", () => {
  it("drives the full Method list/create/get/patch/delete lifecycle and boundary failures", async () => {
    const collection = `/api/bots/${bot.id}/skills`;
    const item = `${collection}/route-review`;

    const initial = await api("GET", collection);
    expectJson(initial, 200);
    expect(z.object({ skills: z.array(skillSchema) }).parse(initial.body).skills).toEqual([]);

    const unknownBot = await api("GET", "/api/bots/no-such-operator/skills");
    expectJson(unknownBot, 404);
    expect(errorResponseSchema.parse(unknownBot.body).error).toMatch(/no such operator/i);

    const invalidSource = await rawApi(
      "POST",
      collection,
      JSON.stringify({ source: "file:///private/method/SKILL.md" }),
      "text/plain",
    );
    expectJson(invalidSource, 415);
    const invalidSourceJson = await api("POST", collection, { source: "file:///private/method/SKILL.md" });
    expectJson(invalidSourceJson, 422);
    expect(errorResponseSchema.parse(invalidSourceJson.body).error).toMatch(/GitHub repository/i);

    const malformed = await rawApi("POST", collection, "{", "application/json");
    expectJson(malformed, 400);
    expect(errorResponseSchema.parse(malformed.body).error).toMatch(/invalid JSON/i);
    expect(z.object({ skills: z.array(skillSchema) }).parse((await api("GET", collection)).body).skills).toEqual([]);

    const imported = await api("POST", collection, { source: SKILL_SOURCE });
    expectJson(imported, 201);
    const importBody = z.object({ installed: z.array(skillSchema), errors: z.array(z.string()) }).parse(imported.body);
    expect(importBody.errors).toEqual([]);
    expect(importBody.installed).toHaveLength(1);
    const installed = importBody.installed[0]!;
    expect(installed).toMatchObject({
      name: "route-review",
      description: "Review an HTTP route against its declared contract.",
      enabled: false,
      source: SKILL_SOURCE,
      warnings: [],
      skippedFiles: [],
    });

    const duplicate = await api("POST", collection, { source: SKILL_SOURCE });
    expectJson(duplicate, 422);
    expect(errorResponseSchema.parse(duplicate.body).error).toMatch(/already imported/i);

    const listed = await api("GET", collection);
    expectJson(listed, 200);
    expect(z.object({ skills: z.array(skillSchema) }).parse(listed.body).skills).toEqual([installed]);

    const read = await api("GET", item);
    expectJson(read, 200);
    expect(z.object({ text: z.string() }).parse(read.body).text).toBe(SKILL_TEXT);

    const missing = await api("GET", `${collection}/missing-method`);
    expectJson(missing, 404);
    expect(errorResponseSchema.parse(missing.body).error).toMatch(/no such method/i);
    const unsafePath = await api("GET", `${collection}/UPPER_CASE`);
    expectJson(unsafePath, 404);
    expect(errorResponseSchema.parse(unsafePath.body).error).toMatch(/no route/i);
    for (const unsafeSlug of ["%2e%2e", "..%2Fprivate", "route-review%2Fchild"]) {
      const unsafe = await api("GET", `${collection}/${unsafeSlug}`);
      expectJson(unsafe, 404);
    }

    const unreviewed = await api("PATCH", item, { enabled: true });
    expectJson(unreviewed, 409);
    expect(errorResponseSchema.parse(unreviewed.body).error).toMatch(/read and acknowledge/i);

    const badReview = await api("PATCH", item, {
      enabled: true,
      review: { revision: "../not-a-review", acknowledged: true },
    });
    expectJson(badReview, 400);
    expect(errorResponseSchema.parse(badReview.body).error).toMatch(/enabled must be true or false/i);

    const enabled = await api("PATCH", item, {
      enabled: true,
      review: { revision: installed.reviewRevision, acknowledged: true },
    });
    expectJson(enabled, 200);
    const enabledSkill = z.object({ skill: skillSchema }).parse(enabled.body).skill;
    expect(enabledSkill.enabled).toBe(true);
    expect(enabledSkill.reviewedRevision).toBe(installed.reviewRevision);

    const methodDir = join(dataDir, "workspaces", bot.id, "skills", "route-review");
    const manifestPath = join(dataDir, "workspaces", bot.id, "skills", "skills.json");
    expect(readFileSync(join(methodDir, "SKILL.md"), "utf8")).toBe(SKILL_TEXT);
    const manifestText = readFileSync(manifestPath, "utf8");
    expect(manifestText).toContain('"route-review"');
    expect(manifestText).toContain('"enabled": true');
    for (const nativeDir of [".claude", ".agents", ".grok"]) {
      const link = join(dataDir, "workspaces", bot.id, nativeDir, "skills", "route-review");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    }

    const removed = await api("DELETE", item);
    expectJson(removed, 200);
    expect(removed.body).toEqual({ ok: true });
    expect(existsSync(methodDir)).toBe(false);
    expect(z.object({ skills: z.array(skillSchema) }).parse((await api("GET", collection)).body).skills).toEqual([]);

    const removedAgain = await api("DELETE", item);
    expectJson(removedAgain, 404);
    expect(errorResponseSchema.parse(removedAgain.body).error).toMatch(/no imported skill/i);
    const malformedPatch = await rawApi("PATCH", item, "{", "application/json");
    expectJson(malformedPatch, 400);
  });

  it("provides and resumes a credential card once, with durable secret-free state and SSE", async () => {
    const auth = { authorization: `Bearer ${commsToken}` };
    const requested = await api("POST", "/api/internal/request-credential", {
      fromBotId: bot.id,
      fromThreadId: bot.threadId,
      credentialId: "openaiImageApiKey",
      reason: "generate the release portrait",
    }, auth);
    expectJson(requested, 201);
    const messageId = z.object({ messageId: z.string(), label: z.string() }).parse(requested.body).messageId;

    const duplicateRequest = await api("POST", "/api/internal/request-credential", {
      fromBotId: bot.id,
      fromThreadId: bot.threadId,
      credentialId: "openaiImageApiKey",
    }, auth);
    expectJson(duplicateRequest, 200);
    expect(z.object({ messageId: z.string() }).parse(duplicateRequest.body).messageId).toBe(messageId);

    const route = `/api/bots/${bot.id}/secret-cards/${messageId}`;
    const tooSoon = await api("POST", `${route}/provided`, { threadId: bot.threadId });
    expectJson(tooSoon, 409);
    expect(errorResponseSchema.parse(tooSoon.body).error).toMatch(/was not saved yet/i);
    const notReady = await rawApi(
      "POST",
      `${route}/resume`,
      JSON.stringify({ threadId: bot.threadId }),
      "application/json",
    );
    expectJson(notReady, 409);
    expect(errorResponseSchema.parse(notReady.body).error).toMatch(/not ready to resume/i);

    for (const result of [
      await api("POST", `/api/bots/no-such-operator/secret-cards/${messageId}/resume`, { threadId: bot.threadId }),
      await api("POST", `/api/bots/${bot.id}/secret-cards/no-such-card/resume`, { threadId: bot.threadId }),
      await api("POST", `${route}/resume`, { threadId: "no-such-thread" }),
      await api("GET", `${route}/resume`),
      await api("POST", `/api/bots/bad%2Foperator/secret-cards/${messageId}/resume`, { threadId: bot.threadId }),
    ]) {
      expectJson(result, 404);
    }
    const malformed = await rawApi("POST", `${route}/provided`, "{", "application/json");
    expectJson(malformed, 400);

    const saved = await api("PUT", "/api/config?secretStorage=external", { imageGen: { key: IMAGE_KEY_CANARY } });
    expectJson(saved, 200);
    expect(JSON.stringify(saved.body)).not.toContain(IMAGE_KEY_CANARY);

    const stream = await openSse(`${BASE}/api/events?screens=off`);
    try {
      await stream.until((frame) => frame.kind === "hello");
      const provided = await api("POST", `${route}/provided`, { threadId: bot.threadId });
      expectJson(provided, 200);
      expect(provided.body).toEqual({ provided: true, resumed: true });
      const event = await stream.until((frame) =>
        frame.kind === "message.patch" &&
        frame.threadId === bot.threadId &&
        z.record(z.string(), z.unknown()).safeParse(frame.message).success &&
        z.record(z.string(), z.unknown()).parse(frame.message).id === messageId
      );
      observedFrames.push(...stream.frames);
      expect(JSON.stringify(event)).not.toContain(IMAGE_KEY_CANARY);
    } finally {
      stream.close();
    }

    const duplicateProvided = await api("POST", `${route}/provided`, { threadId: bot.threadId });
    expectJson(duplicateProvided, 200);
    expect(duplicateProvided.body).toEqual({ provided: true, resumed: true });
    const explicitResume = await api("POST", `${route}/resume`, { threadId: bot.threadId });
    expectJson(explicitResume, 200);
    expect(explicitResume.body).toEqual({ resumed: true });

    const persisted = storedMessage(bot.threadId, messageId);
    const visible = await transcriptMessage(messageId);
    for (const message of [persisted, visible]) {
      expect(message.kind).toBe("secret");
      expect(message.secret).toMatchObject({ provided: true, resumed: true });
      expect(JSON.stringify(message)).not.toContain(IMAGE_KEY_CANARY);
      expect(JSON.stringify(message)).not.toMatch(/sk-contract-private/i);
    }
  });

  it("appends one connector card when two identical requests arrive together", async () => {
    // The dedupe read the transcript, then awaited composio.toolkitCard — a
    // network call — and only then appended. Two concurrent requests both saw
    // an empty transcript before either wrote, so the thread got two identical
    // cards. Not cosmetic: maybeResumeConnectors holds the paused turn until
    // every matching card is resumed, so the run stayed parked until the person
    // answered both. The existing idempotency case below sends its requests one
    // after the other, which passes because the first has already appended.
    const auth = { authorization: `Bearer ${commsToken}` };
    connectorConnected = false;
    const resumeKey = "connector_race_resume_1234567";
    const send = () => api("POST", "/api/internal/connectors/request", {
      botId: bot.id,
      threadId: bot.threadId,
      slugs: ["github"],
      resumeKey,
    }, auth);

    const [first, second] = await Promise.all([send(), send()]);
    expectJson(first, 200);
    expectJson(second, 200);
    const ids = z.object({ messageIds: z.array(z.string()).length(1) });
    expect(ids.parse(first.body).messageIds).toEqual(ids.parse(second.body).messageIds);

    const thread = await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`);
    expect(thread.status).toBe(200);
    const cards = messagePageSchema.parse(thread.body).messages
      .filter((message) => message.kind === "connector");
    expect(cards).toHaveLength(1);
  });

  it("authorizes and resumes a connector card with identity, trust, idempotency, persistence, and SSE proofs", async () => {
    const auth = { authorization: `Bearer ${commsToken}` };
    connectorConnected = false;
    const resumeKey = "connector_contract_resume_123456";
    const requested = await api("POST", "/api/internal/connectors/request", {
      botId: bot.id,
      threadId: bot.threadId,
      slugs: ["github"],
      resumeKey,
    }, auth);
    expectJson(requested, 200);
    const [messageId] = z.object({ messageIds: z.array(z.string()).length(1) }).parse(requested.body).messageIds;
    expect(messageId).toBeTruthy();

    const duplicateRequest = await api("POST", "/api/internal/connectors/request", {
      botId: bot.id,
      threadId: bot.threadId,
      slugs: ["github", "github", "../unsafe"],
      resumeKey,
    }, auth);
    expectJson(duplicateRequest, 200);
    expect(z.object({ messageIds: z.array(z.string()) }).parse(duplicateRequest.body).messageIds).toEqual([messageId]);

    const route = `/api/bots/${bot.id}/connector-cards/${messageId}`;
    for (const result of [
      await api("POST", `/api/bots/no-such-operator/connector-cards/${messageId}/resume`, { threadId: bot.threadId }),
      await api("POST", `/api/bots/${bot.id}/connector-cards/no-such-card/resume`, { threadId: bot.threadId }),
      await api("POST", `${route}/resume`, { threadId: "no-such-thread" }),
      await api("POST", `/api/bots/bad%2Foperator/connector-cards/${messageId}/resume`, { threadId: bot.threadId }),
    ]) {
      expectJson(result, 404);
    }
    const malformed = await rawApi("POST", `${route}/authorize`, "{", "application/json");
    expectJson(malformed, 400);
    const wrongMethod = await api("GET", `${route}/authorize?threadId=${encodeURIComponent(bot.threadId)}`);
    expectJson(wrongMethod, 405);

    const premature = await rawApi(
      "POST",
      `${route}/resume`,
      JSON.stringify({ threadId: bot.threadId }),
      "application/json",
    );
    expectJson(premature, 409);
    expect(errorResponseSchema.parse(premature.body).error).toMatch(/finish connecting/i);

    const authorizeStream = await openSse(`${BASE}/api/events?screens=off`);
    let authHost = "";
    try {
      await authorizeStream.until((frame) => frame.kind === "hello");
      const authorized = await api("POST", `${route}/authorize`, { threadId: bot.threadId });
      expectJson(authorized, 200);
      const intentUrl = z.object({ url: z.string().url() }).parse(authorized.body).url;
      const intent = new URL(intentUrl);
      authHost = intent.hostname;
      expect({ protocol: intent.protocol, hostname: intent.hostname, pathname: intent.pathname }).toEqual({
        protocol: "https:",
        hostname: "connect.composio.dev",
        pathname: "/link/github",
      });
      const event = await authorizeStream.until((frame) =>
        frame.kind === "message.patch" &&
        frame.threadId === bot.threadId &&
        JSON.stringify(frame.message).includes('"status":"authorizing"')
      );
      observedFrames.push(...authorizeStream.frames);
      expect(JSON.stringify(event)).not.toContain(CONDUIT_TOKEN);
    } finally {
      authorizeStream.close();
    }
    expect(authHost).toBe("connect.composio.dev");
    expect(connectorAuthorizeCalls).toBe(1);
    const authorizing = await transcriptMessage(messageId!);
    expect(authorizing.connector).toMatchObject({ status: "authorizing", resumed: false, dismissed: false });
    expect(JSON.stringify(authorizing)).not.toContain("connect.composio.dev");
    expect(JSON.stringify(authorizing)).not.toContain(CONDUIT_TOKEN);

    connectorConnected = true;
    const resumeStream = await openSse(`${BASE}/api/events?screens=off`);
    try {
      await resumeStream.until((frame) => frame.kind === "hello");
      const status = await api(
        "GET",
        `${route}/status?threadId=${encodeURIComponent(bot.threadId)}`,
      );
      expectJson(status, 200);
      expect(status.body).toEqual({ connected: true, pending: false, status: "ACTIVE" });
      const resumedEvent = await resumeStream.until((frame) =>
        frame.kind === "message.patch" &&
        frame.threadId === bot.threadId &&
        JSON.stringify(frame.message).includes('"resumed":true')
      );
      observedFrames.push(...resumeStream.frames);
      expect(JSON.stringify(resumedEvent)).not.toContain(CONDUIT_TOKEN);
    } finally {
      resumeStream.close();
    }

    for (const resumed of [
      await api("POST", `${route}/resume`, { threadId: bot.threadId }),
      await api("POST", `${route}/resume`, { threadId: bot.threadId }),
    ]) {
      expectJson(resumed, 200);
      expect(resumed.body).toEqual({ resumed: true });
    }

    const persisted = storedMessage(bot.threadId, messageId!);
    const visible = await transcriptMessage(messageId!);
    for (const message of [persisted, visible]) {
      expect(message.kind).toBe("connector");
      expect(message.connector).toMatchObject({
        slug: "github",
        status: "connected",
        resumeKey,
        dismissed: false,
        resumed: true,
      });
      const serialized = JSON.stringify(message);
      expect(serialized).not.toContain("connect.composio.dev");
      expect(serialized).not.toContain(CONDUIT_TOKEN);
      expect(serialized).not.toContain(IMAGE_KEY_CANARY);
    }

    expect(conduitRequests).toEqual(expect.arrayContaining([
      { method: "GET", path: "/v1/capabilities" },
      { method: "GET", path: "/v1/capabilities/catalog" },
      { method: "POST", path: "/v1/capabilities/github/authorize" },
    ]));
  });

  it("never reflects fixture credentials through HTTP bodies, SSE, persisted messages, or provider dumps", () => {
    const publicEvidence = JSON.stringify({ observedBodies, observedFrames });
    expect(publicEvidence).not.toContain(IMAGE_KEY_CANARY);
    expect(publicEvidence).not.toContain(CONDUIT_TOKEN);

    const database = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
    try {
      const rows = z.array(sqliteMessageRowSchema).parse(database.prepare("SELECT json FROM messages").all());
      const persisted = rows.map((row) => row.json).join("\n");
      expect(persisted).not.toContain(IMAGE_KEY_CANARY);
      expect(persisted).not.toContain(CONDUIT_TOKEN);
      expect(persisted).not.toContain("connect.composio.dev");
    } finally {
      database.close();
    }

    const providerDump = readFileSync(fakeClaudeDump, "utf8");
    expect(providerDump).not.toContain(IMAGE_KEY_CANARY);
    expect(providerDump).not.toContain(CONDUIT_TOKEN);
    expect(stderr).not.toContain(IMAGE_KEY_CANARY);
    expect(stderr).not.toContain(CONDUIT_TOKEN);
    expect(stdout).not.toContain(IMAGE_KEY_CANARY);
    expect(stdout).not.toContain(CONDUIT_TOKEN);
  });
});
