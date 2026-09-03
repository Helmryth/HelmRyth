/**
 * Public connector HTTP contract coverage.
 *
 * This suite deliberately boots the real main server and points it at a
 * loopback-only Composio fixture. It never reads a developer credential or
 * reaches the network. The fixture key exists only inside the throwaway
 * profile and child process used by this file.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";
import { parseJson, type JsonObject, type JsonValue } from "./schema.ts";
import { HAS_POSIX_FILE_MODES } from "./testing/platform.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FIXTURE_KEY = "ak_connector_route_fixture";
const AUTH_INTENT_MARKER = "fixture-auth-intent";
const PORT = 31_000 + Math.floor(Math.random() * 5_000);
const WEBHOOK_PORT = 36_000 + Math.floor(Math.random() * 5_000);
const BASE = `http://127.0.0.1:${PORT}`;

interface FixtureAccount {
  id: string;
  alias?: string;
  status: string;
  updated_at: string;
  toolkit: { slug: string };
}

interface FixtureCall {
  method: string;
  path: string;
  query: string;
  body: JsonValue;
}

type LinkMode = "trusted" | "provider-error" | "untrusted";

let profileDir = "";
let upstream: Server | undefined;
let child: ChildProcess | undefined;
let childOutput = "";
let upstreamBase = "";
let linkMode: LinkMode = "trusted";
let accounts: FixtureAccount[] = [];
const selectedAccounts = new Map<string, { id: string; status: string }>();
const failingDeletes = new Set<string>();
const calls: FixtureCall[] = [];

const session = (userId = "fixture-user") => ({
  session_id: "trs_fresh",
  mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/trs_fresh/mcp" },
  config: {
    user_id: userId,
    multi_account: {
      enable: true,
      max_accounts_per_toolkit: 5,
      require_explicit_selection: true,
    },
    auth_configs: {},
  },
});

function json(response: ServerResponse, status: number, body: JsonValue): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function requestBody(request: IncomingMessage): Promise<JsonValue> {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  if (!raw) return {};
  return parseJson(raw);
}

function callCount(
  method: string,
  predicate: (call: FixtureCall) => boolean,
  after = 0,
): number {
  return calls.slice(after).filter((call) => call.method === method && predicate(call)).length;
}

function setAccount(slug: string, id: string, status = "ACTIVE", alias?: string): void {
  const account: FixtureAccount = {
    id,
    status,
    updated_at: "2026-08-30T00:00:00.000Z",
    toolkit: { slug },
  };
  if (alias) account.alias = alias;
  accounts = [account];
  selectedAccounts.clear();
  selectedAccounts.set(slug, { id, status });
}

function resetFixtureState(): void {
  linkMode = "trusted";
  accounts = [];
  selectedAccounts.clear();
  failingDeletes.clear();
}

async function composioFixture(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://fixture.invalid");
  const body = await requestBody(request);
  const method = request.method ?? "GET";
  calls.push({ method, path: url.pathname, query: url.search, body });

  if (request.headers["x-api-key"] !== FIXTURE_KEY) {
    return json(response, 401, { error: { message: "fixture rejected the project key" } });
  }

  if (method === "GET" && url.pathname === "/api/v3.1/auth_configs") {
    return json(response, 200, { items: [] });
  }
  if (method === "GET" && url.pathname === "/api/v3.1/tool_router/session/trs_stale") {
    return json(response, 404, { error: "fixture session expired" });
  }
  if (method === "POST" && url.pathname === "/api/v3.1/tool_router/session") {
    const parsed = z.object({ user_id: z.string() }).passthrough().parse(body);
    return json(response, 201, session(parsed.user_id));
  }
  if (method === "GET" && url.pathname === "/api/v3.1/tool_router/session/trs_fresh") {
    return json(response, 200, session());
  }
  if (method === "GET" && url.pathname === "/api/v3.1/connected_accounts") {
    const scoped = (url.searchParams.get("toolkit_slugs") ?? "")
      .split(",")
      .map((slug) => slug.toLowerCase())
      .filter(Boolean);
    const visibleAccounts = scoped.length
      ? accounts.filter((account) => scoped.includes(account.toolkit.slug.toLowerCase()))
      : accounts;
    const items: JsonObject[] = visibleAccounts.map((account) => {
      const item: JsonObject = {
        id: account.id,
        status: account.status,
        updated_at: account.updated_at,
        toolkit: { slug: account.toolkit.slug },
      };
      if (account.alias) item.alias = account.alias;
      return item;
    });
    return json(response, 200, { items });
  }
  if (method === "GET" && /^\/api\/v3\.1\/tool_router\/session\/trs_fresh\/toolkits$/.test(url.pathname)) {
    const scoped = (url.searchParams.get("toolkits") ?? "")
      .split(",")
      .map((slug) => slug.toLowerCase())
      .filter(Boolean);
    const items = [...selectedAccounts.entries()]
      .filter(([slug]) => scoped.length === 0 || scoped.includes(slug.toLowerCase()))
      .map(([slug, selected]) => ({ slug, connected_account: selected }));
    return json(response, 200, { items });
  }
  if (method === "POST" && url.pathname === "/api/v3.1/tool_router/session/trs_fresh/link") {
    const parsed = z.object({ toolkit: z.string(), alias: z.string().optional() }).parse(body);
    if (linkMode === "provider-error") {
      return json(response, 503, {
        error: {
          message: `authorization provider temporarily unavailable ${AUTH_INTENT_MARKER} ${"x".repeat(400)}`,
        },
      });
    }
    if (linkMode === "untrusted") {
      return json(response, 201, {
        redirect_url: `https://untrusted.example/authorize?intent=${AUTH_INTENT_MARKER}`,
      });
    }
    const pendingId = `ca_pending_${parsed.toolkit}`;
    setAccount(parsed.toolkit, pendingId, "INITIATED", parsed.alias);
    return json(response, 201, {
      redirect_url: `https://connect.composio.dev/link/${encodeURIComponent(parsed.toolkit)}?intent=${AUTH_INTENT_MARKER}`,
    });
  }
  const accountDelete = /^\/api\/v3\.1\/connected_accounts\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (method === "DELETE" && accountDelete) {
    const id = accountDelete[1];
    if (failingDeletes.has(id)) {
      return json(response, 503, {
        error: {
          message: `disconnect provider temporarily unavailable ${AUTH_INTENT_MARKER} ${"x".repeat(400)}`,
        },
      });
    }
    accounts = accounts.filter((account) => account.id !== id);
    for (const [slug, selected] of selectedAccounts) {
      if (selected.id === id) selectedAccounts.delete(slug);
    }
    return json(response, 200, { success: true });
  }
  return json(response, 404, { error: "fixture route not found" });
}

const api = async (
  method: string,
  path: string,
  body?: JsonValue,
): Promise<{ status: number; body: JsonValue; text: string }> => {
  const mutation = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: mutation ? { "content-type": "application/json" } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? parseJson(text) : null,
    text,
  };
};

beforeAll(async () => {
  profileDir = mkdtempSync(join(tmpdir(), "hry-connector-routes-"));
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  chmodSync(profileDir, 0o700);
  writeFileSync(join(profileDir, "config.json"), JSON.stringify({
    composio: {
      apiKey: FIXTURE_KEY,
      userId: "fixture-user",
      sessionId: "trs_stale",
    },
    instances: {
      ghost: { driver: "not-a-real-driver", displayName: "Connector fixture" },
    },
  }), { mode: 0o600 });

  upstream = createServer(async (request, response) => {
    try {
      await composioFixture(request, response);
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address) throw new Error("connector fixture did not bind");
  const upstreamPort = z.object({ port: z.number() }).parse(address).port;
  upstreamBase = `http://127.0.0.1:${upstreamPort}/api/v3.1`;

  // Use an allowlist instead of spreading process.env: the credentialed live
  // run may coexist with this suite, and none of its workspace secrets may
  // cross into this deterministic child.
  const environment: NodeJS.ProcessEnv = {
    HOME: profileDir,
    USERPROFILE: profileDir,
    HELMRYTH_DATA_DIR: profileDir,
    HELMRYTH_PORT: String(PORT),
    HELMRYTH_WEBHOOK_PORT: String(WEBHOOK_PORT),
    HELMRYTH_COMPOSIO_API: upstreamBase,
    HELMRYTH_CREDENTIAL_STORE: "ready",
    HELMRYTH_SSE_HEARTBEAT_MS: "50",
  };
  if (process.env.PATH) environment.PATH = process.env.PATH;
  if (process.env.SystemRoot) environment.SystemRoot = process.env.SystemRoot;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => { childOutput += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { childOutput += chunk.toString("utf8"); });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) break;
    } catch {
      // The real server has not bound yet.
    }
    if (child.exitCode !== null) throw new Error(`connector contract server exited early: ${childOutput}`);
    if (Date.now() > deadline) throw new Error(`connector contract server did not start: ${childOutput}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await new Promise<void>((resolve) => upstream?.close(() => resolve()) ?? resolve());
  await removeTempDir(profileDir);
});

describe.sequential("public connector HTTP contract", () => {
  it("repairs a stale stored Session and returns exactly one trusted authorization intent", async () => {
    resetFixtureState();
    const before = calls.length;
    const result = await api("POST", "/api/connectors/github/authorize", { alias: "work" });

    expect(result.status).toBe(200);
    const response = z.object({ url: z.string() }).strict().parse(result.body);
    const authorization = new URL(response.url);
    expect(authorization.protocol).toBe("https:");
    expect(authorization.hostname).toBe("connect.composio.dev");
    expect(authorization.pathname).toBe("/link/github");
    expect(callCount("POST", (call) => call.path.endsWith("/link"), before)).toBe(1);
    const linkCall = calls.slice(before).find((call) => call.method === "POST" && call.path.endsWith("/link"));
    expect(linkCall?.body).toEqual({ toolkit: "github", alias: "work" });

    const stored = z.object({
      composio: z.object({ apiKey: z.string(), userId: z.string(), sessionId: z.string() }),
    }).passthrough().parse(parseJson(readFileSync(join(profileDir, "config.json"), "utf8")));
    expect(stored.composio).toEqual({
      apiKey: FIXTURE_KEY,
      userId: "fixture-user",
      sessionId: "trs_fresh",
    });
    // Only where the platform has POSIX modes — see testing/platform.ts. The
    // rest of this case (the repaired session, the stored credential shape, the
    // single authorization intent) is platform-independent and still runs.
    if (HAS_POSIX_FILE_MODES) {
      expect(statSync(join(profileDir, "config.json")).mode & 0o777).toBe(0o600);
    }

    const refreshed = await api("GET", "/api/connectors?services=github");
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toMatchObject({
      configured: true,
      services: {
        github: {
          connected: false,
          pending: true,
          status: "INITIATED",
          accounts: [{ id: "ca_pending_github", alias: "work", status: "INITIATED" }],
        },
      },
    });
    expect(refreshed.text).not.toContain(FIXTURE_KEY);
    expect(childOutput).not.toContain(FIXTURE_KEY);
    expect(childOutput).not.toContain(AUTH_INTENT_MARKER);
  });

  it("disconnects exactly one owned account, makes refresh authoritative, and replays as a no-op", async () => {
    resetFixtureState();
    setAccount("github", "ca_owned", "ACTIVE", "personal");
    const before = calls.length;

    const removed = await api("DELETE", "/api/connectors/github/accounts/ca_owned");
    expect(removed).toMatchObject({ status: 200, body: { removed: 1 } });
    expect(callCount(
      "DELETE",
      (call) => call.path === "/api/v3.1/connected_accounts/ca_owned",
      before,
    )).toBe(1);

    const refreshed = await api("GET", "/api/connectors?services=github");
    expect(refreshed.body).toMatchObject({
      configured: true,
      services: {
        github: { connected: false, pending: false, status: "not_connected", accounts: [] },
      },
    });

    const replay = await api("DELETE", "/api/connectors/github/accounts/ca_owned");
    expect(replay).toMatchObject({ status: 200, body: { removed: 0 } });
    expect(callCount(
      "DELETE",
      (call) => call.path === "/api/v3.1/connected_accounts/ca_owned",
      before,
    )).toBe(1);
  });

  it("disconnects the selected service once and leaves unknown services as provider-free no-ops", async () => {
    resetFixtureState();
    setAccount("notion", "ca_notion", "ACTIVE");
    const before = calls.length;

    const removed = await api("DELETE", "/api/connectors/notion");
    expect(removed).toMatchObject({ status: 200, body: { removed: 1 } });
    expect(callCount(
      "DELETE",
      (call) => call.path === "/api/v3.1/connected_accounts/ca_notion",
      before,
    )).toBe(1);

    const beforeUnknown = calls.length;
    const unknown = await api("DELETE", "/api/connectors/not-a-real-toolkit");
    expect(unknown).toMatchObject({ status: 200, body: { removed: 0 } });
    expect(callCount("DELETE", () => true, beforeUnknown)).toBe(0);
    const refreshed = await api("GET", "/api/connectors?services=notion,not-a-real-toolkit");
    expect(refreshed.body).toMatchObject({
      services: {
        notion: { connected: false, status: "not_connected" },
        "not-a-real-toolkit": { connected: false, status: "not_connected" },
      },
    });
  });

  it("rejects encoded separators, Unicode, malformed, and oversized path identifiers before Composio", async () => {
    resetFixtureState();
    const before = calls.length;
    const invalidRequests: Array<[string, string, JsonValue?]> = [
      ["POST", "/api/connectors/github%2Fgmail/authorize", {}],
      ["POST", "/api/connectors/%E2%98%83/authorize", {}],
      ["DELETE", "/api/connectors/github/accounts/%2e%2e%2foutside"],
      ["DELETE", "/api/connectors/github/accounts/%252Foutside"],
      ["DELETE", `/api/connectors/github/accounts/${"a".repeat(129)}`],
      ["DELETE", "/api/connectors/github%5Cgmail"],
    ];

    for (const [method, path, body] of invalidRequests) {
      const result = await api(method, path, body);
      expect(result.status, `${method} ${path}`).toBe(404);
    }
    expect(calls).toHaveLength(before);
  });

  it("normalizes provider failures and refuses untrusted authorization origins without leaking intent data", async () => {
    resetFixtureState();
    linkMode = "provider-error";
    const providerBefore = calls.length;
    const providerFailure = await api("POST", "/api/connectors/slack/authorize", {});
    expect(providerFailure).toEqual({
      status: 502,
      body: { error: "Composio authorization: HTTP 503" },
      text: JSON.stringify({ error: "Composio authorization: HTTP 503" }),
    });
    expect(providerFailure.text).not.toContain(AUTH_INTENT_MARKER);
    expect(callCount("POST", (call) => call.path.endsWith("/link"), providerBefore)).toBe(1);

    linkMode = "untrusted";
    const untrustedBefore = calls.length;
    const untrusted = await api("POST", "/api/connectors/slack/authorize", {});
    expect(untrusted.status).toBe(500);
    expect(untrusted.body).toEqual({ error: "Connected-apps service returned an untrusted authorization link" });
    expect(untrusted.text).not.toContain(AUTH_INTENT_MARKER);
    expect(untrusted.text).not.toContain("untrusted.example");
    expect(callCount("POST", (call) => call.path.endsWith("/link"), untrustedBefore)).toBe(1);

    resetFixtureState();
    setAccount("faulty", "ca_faulty");
    failingDeletes.add("ca_faulty");
    const accountDeleteBefore = calls.length;
    const accountDeleteFailure = await api("DELETE", "/api/connectors/faulty/accounts/ca_faulty");
    expect(accountDeleteFailure).toMatchObject({
      status: 502,
      body: { error: "Composio disconnect: HTTP 503" },
    });
    expect(accountDeleteFailure.text).not.toContain(AUTH_INTENT_MARKER);
    expect(callCount(
      "DELETE",
      (call) => call.path === "/api/v3.1/connected_accounts/ca_faulty",
      accountDeleteBefore,
    )).toBe(1);

    const serviceDeleteBefore = calls.length;
    const serviceDeleteFailure = await api("DELETE", "/api/connectors/faulty");
    expect(serviceDeleteFailure).toMatchObject({
      status: 502,
      body: { error: "Composio disconnect: HTTP 503" },
    });
    expect(serviceDeleteFailure.text).not.toContain(AUTH_INTENT_MARKER);
    expect(callCount(
      "DELETE",
      (call) => call.path === "/api/v3.1/connected_accounts/ca_faulty",
      serviceDeleteBefore,
    )).toBe(1);
    expect(childOutput).not.toContain(AUTH_INTENT_MARKER);
    expect(childOutput).not.toContain(FIXTURE_KEY);
  });

  it("reports configured-state transitions over SSE while unconfigured mutations fail closed without provider calls", async () => {
    resetFixtureState();
    const events = await openSse(`${BASE}/api/events`);
    try {
      const clear = await api("PUT", "/api/config", { composio: { apiKey: "" } });
      expect(clear.status).toBe(200);
      expect(clear.body).toMatchObject({ composio: { configured: false, mode: "unavailable" } });
      const clearedFrame = await events.until((frame) => {
        const parsed = z.object({
          kind: z.literal("config"),
          composio: z.object({ configured: z.literal(false) }),
        }).passthrough().safeParse(frame);
        return parsed.success;
      });
      expect(JSON.stringify(clearedFrame)).not.toContain(FIXTURE_KEY);
      expect(JSON.stringify(clearedFrame)).not.toContain(AUTH_INTENT_MARKER);

      const before = calls.length;
      for (const [method, path, body] of [
        ["POST", "/api/connectors/github/authorize", {}],
        ["DELETE", "/api/connectors/github/accounts/ca_owned", undefined],
        ["DELETE", "/api/connectors/github", undefined],
      ] as const) {
        const result = await api(method, path, body);
        expect(result.status, `${method} ${path}`).toBe(409);
        expect(result.body).toMatchObject({ error: expect.stringMatching(/not configured.*project key/i) });
      }
      expect(calls).toHaveLength(before);

      const restore = await api("PUT", "/api/config", { composio: { apiKey: FIXTURE_KEY } });
      expect(restore.status).toBe(200);
      expect(restore.body).toMatchObject({ composio: { configured: true, mode: "self-hosted" } });
      const restoredFrame = await events.until((frame) => {
        const parsed = z.object({
          kind: z.literal("config"),
          composio: z.object({ configured: z.literal(true) }),
        }).passthrough().safeParse(frame);
        return parsed.success;
      });
      expect(JSON.stringify(restoredFrame)).not.toContain(FIXTURE_KEY);
      expect(JSON.stringify(restoredFrame)).not.toContain(AUTH_INTENT_MARKER);

      const status = await api("GET", "/api/config");
      expect(status.body).toMatchObject({ composio: { configured: true, mode: "self-hosted" } });
      expect(status.text).not.toContain(FIXTURE_KEY);
      expect(status.text).not.toContain(AUTH_INTENT_MARKER);
    } finally {
      events.close();
    }
  });
});
