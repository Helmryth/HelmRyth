import { afterEach, describe, expect, it, vi } from "vitest";

import conduit, {
  authorize,
  upstreamError,
  connectedCapabilities,
  capabilityStatus,
  createSession,
  disconnectAccount,
  ensureSession,
  normalizeAccountAlias,
  parseSession,
  randomToken,
  requestAlias,
  sha256,
} from "./index";

const multiAccount = {
  enable: true,
  max_accounts_per_toolkit: 5,
  require_explicit_selection: true,
};

interface SessionTestConfig {
  multi_account?: typeof multiAccount;
  user_id: string;
}

function session(id: string, userId: string, configured = true) {
  const config: SessionTestConfig = { user_id: userId };
  if (configured) config.multi_account = multiAccount;
  return {
    session_id: id,
    mcp: { url: `https://mcp.composio.dev/${id}` },
    config,
  };
}

function testEnv(fetchCalls: Array<{ url: string; init?: RequestInit }>) {
  const dbRuns: Array<{ sql: string; values: unknown[] }> = [];
  const env = {
    COMPOSIO_API_BASE: "https://backend.composio.dev/api/v3.1",
    COMPOSIO_API_KEY: "ak_test",
    COMPOSIO_TOOLKIT_BASE: "https://backend.composio.dev/api/v3",
    HELMRYTH_CONDUIT_ENROLLMENT_MODE: "open",
    NODE_ENROLLMENT_LIMITER: { limit: async () => ({ success: true }) },
    CONDUIT_SESSION_LIMITER: { limit: async () => ({ success: true }) },
    CONDUIT_DB: {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              run: async () => {
                dbRuns.push({ sql, values });
              },
            };
          },
        };
      },
    },
  };
  const ctx = { waitUntil(promise: Promise<unknown>) { void promise; } };
  return { env, ctx, dbRuns, fetchCalls };
}

function asEnv(value: ReturnType<typeof testEnv>["env"]): Env {
  // SAFETY: The focused fake implements every Env binding used by the functions under test.
  return value as never;
}

function asExecutionContext(value: ReturnType<typeof testEnv>["ctx"]): ExecutionContext {
  // SAFETY: These tests exercise waitUntil only; the fake records that promise contract.
  return value as never;
}

afterEach(() => vi.unstubAllGlobals());

describe("Conduit boundaries", () => {
  it("publishes the Helmryth Conduit health identity", async () => {
    const { env, ctx } = testEnv([]);
    const response = await conduit.fetch(
      new Request("https://conduit.test/healthz"),
      asEnv(env),
      asExecutionContext(ctx),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ service: "helmryth-conduit", ready: true });
  });

  it("enrolls a Node with a prefixed opaque credential", async () => {
    const { env, ctx, dbRuns } = testEnv([]);
    const response = await conduit.fetch(
      new Request("https://conduit.test/v1/nodes", { method: "POST" }),
      asEnv(env),
      asExecutionContext(ctx),
    );
    expect(response.status).toBe(201);
    const body = await response.json<{ nodeId: string; token: string }>();
    expect(body.nodeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.token).toMatch(/^hry_[0-9a-f]{64}$/);
    expect(dbRuns).toHaveLength(1);
    expect(dbRuns[0]?.sql).toContain("INSERT INTO nodes");
    expect(dbRuns[0]?.values[2]).toMatch(/^hry_node_[0-9a-f]{32}$/);
  });

  it("accepts an empty authorize body as a first-account request", async () => {
    await expect(requestAlias(new Request("https://conduit.test/v1/capabilities/gmail/authorize", {
      method: "POST",
      body: "",
    }))).resolves.toBeUndefined();
    await expect(requestAlias(new Request("https://conduit.test/v1/capabilities/gmail/authorize", {
      method: "POST",
      body: "  \n",
    }))).resolves.toBeUndefined();
  });

  it("accepts only HTTPS Composio MCP endpoints", () => {
    expect(parseSession({
      session_id: "session-1",
      mcp: { url: "https://mcp.composio.dev/session", headers: { "x-session": "one", host: "bad" } },
    })).toEqual({
      sessionId: "session-1",
      url: "https://mcp.composio.dev/session",
      headers: { "x-session": "one" },
      userId: undefined,
      multiAccountConfigured: false,
    });
    expect(() => parseSession({ session_id: "session-1", mcp: { url: "https://attacker.example/mcp" } })).toThrow(/untrusted/i);
    expect(() => parseSession({ session_id: "session-1", mcp: { url: "http://mcp.composio.dev/session" } })).toThrow(/untrusted/i);
  });

  it("hashes node tokens before storage", async () => {
    await expect(sha256("helmryth")).resolves.toBe("3df69006280957bdb12b691127c2a0400834993bc7f16dd04f9513dcc4a931b5");
  });

  it("issues only Helmryth-prefixed Conduit tokens", () => {
    expect(randomToken()).toMatch(/^hry_[0-9a-f]{64}$/);
  });

  it("creates Sessions with explicit multi-account selection", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env } = testEnv(fetchCalls);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return Response.json(session("trs_new", "hry_user"), { status: 201 });
    });

    await expect(createSession(asEnv(env), "hry_user")).resolves.toMatchObject({
      sessionId: "trs_new",
      multiAccountConfigured: true,
    });
    expect(JSON.parse(String(fetchCalls[0].init?.body))).toMatchObject({
      user_id: "hry_user",
      multi_account: multiAccount,
    });
  });

  it("upgrades a legacy Session without changing the node's Composio user", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx, dbRuns } = testEnv(fetchCalls);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (init?.method === "POST") return Response.json(session("trs_new", "hry_stable"), { status: 201 });
      return Response.json(session("trs_legacy", "hry_stable", false));
    });

    await expect(ensureSession({
      id: "node-1",
      composio_user_id: "hry_stable",
      session_id: "trs_legacy",
      disabled_at: null,
    }, asEnv(env), asExecutionContext(ctx))).resolves.toMatchObject({ sessionId: "trs_new", multiAccountConfigured: true });
    const creation = fetchCalls.find((call) => call.init?.method === "POST");
    expect(JSON.parse(String(creation?.init?.body))).toMatchObject({ user_id: "hry_stable", multi_account: multiAccount });
    expect(dbRuns.some((run) => run.values[0] === "trs_new" && run.values[2] === "node-1")).toBe(true);
  });

  it("returns every account and deletes only an owned account ID", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx } = testEnv(fetchCalls);
    const accounts = {
      items: [
        { id: "ca_work", alias: "work", toolkit: { slug: "gmail" }, status: "ACTIVE", updated_at: "2026-08-21T10:00:00Z" },
        { id: "ca_personal", alias: "personal", toolkit: { slug: "gmail" }, status: "INITIALIZING", updated_at: "2026-08-21T11:00:00Z" },
      ],
      next_cursor: "accounts-page-2",
    };
    let connectedAccountsUnavailable = false;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.includes("/tool_router/session/trs_multi/toolkits")) {
        const query = new URL(url).searchParams;
        if (query.get("cursor") === "toolkits-page-2") {
          return Response.json({
            items: [
              { slug: "publicsearch", is_no_auth: true },
              { slug: "selectedonly", connected_account: { id: "ca_session_only", status: "ACTIVE" } },
            ],
          });
        }
        const body = {
          items: [
            { slug: "gmail", connected_account: { id: "ca_work", status: "ACTIVE" } },
            { slug: "unconnected", connected_account: null },
          ],
          next_cursor: query.has("toolkits") ? undefined : "toolkits-page-2",
        };
        return Response.json(body);
      }
      if (url.endsWith("/tool_router/session/trs_multi/link") && init?.method === "POST") {
        return Response.json({ redirect_url: "https://connect.composio.dev/link/gmail" }, { status: 201 });
      }
      if (url.includes("/tool_router/session/trs_multi")) return Response.json(session("trs_multi", "hry_stable"));
      if (url.includes("/connected_accounts?") && !init?.method) {
        if (connectedAccountsUnavailable) {
          return Response.json({ error: "connected-account read not granted" }, { status: 403 });
        }
        if (url.includes("cursor=accounts-page-2")) {
          return Response.json({
            items: [
              { id: "ca_toolkit_41", alias: "overflow", toolkit: { slug: "toolkit_41" }, status: "ACTIVE", updated_at: "2026-08-21T12:00:00Z" },
            ],
          });
        }
        return Response.json(accounts);
      }
      if (url.includes("/connected_accounts/ca_work") && init?.method === "DELETE") return Response.json({ success: true });
      return Response.json({ error: "not found" }, { status: 404 });
    });
    const node = {
      id: "node-1",
      composio_user_id: "hry_stable",
      session_id: "trs_multi",
      disabled_at: null,
    };

    const statusResponse = await capabilityStatus(
      new URL("https://conduit.example/v1/capabilities?capabilities=gmail"),
      node,
      asEnv(env),
      asExecutionContext(ctx),
    );
    await expect(statusResponse.json()).resolves.toEqual({
      capabilities: {
        gmail: {
          connected: true,
          pending: true,
          status: "ACTIVE",
          accounts: [
            { id: "ca_personal", alias: "personal", status: "INITIALIZING" },
            { id: "ca_work", alias: "work", status: "ACTIVE" },
          ],
        },
      },
    });
    expect(fetchCalls.some((call) =>
      call.url.includes("/connected_accounts?")
        && call.url.includes("toolkit_slugs=gmail")
        && call.url.includes("cursor=accounts-page-2")
    )).toBe(true);
    const connectedResponse = await connectedCapabilities(node, asEnv(env), asExecutionContext(ctx));
    await expect(connectedResponse.json()).resolves.toMatchObject({
      configured: true,
      capabilities: {
        toolkit_41: {
          connected: true,
          pending: false,
          status: "ACTIVE",
          accounts: [{ id: "ca_toolkit_41", alias: "overflow", status: "ACTIVE" }],
        },
        publicsearch: {
          connected: true,
          pending: false,
          status: "ACTIVE",
          accounts: [],
        },
        selectedonly: {
          connected: true,
          pending: false,
          status: "ACTIVE",
          accounts: [{ id: "ca_session_only", status: "ACTIVE" }],
        },
      },
    });
    const inventoryCall = fetchCalls.find((call) =>
      call.url.includes("/connected_accounts?") && !call.url.includes("toolkit_slugs=")
    );
    expect(inventoryCall).toBeDefined();
    expect(fetchCalls.some((call) =>
      call.url.includes("/connected_accounts?")
        && !call.url.includes("toolkit_slugs=")
        && call.url.includes("cursor=accounts-page-2")
    )).toBe(true);
    expect(fetchCalls.some((call) =>
      call.url.includes("/tool_router/session/trs_multi/toolkits?")
        && !call.url.includes("toolkits=")
        && call.url.includes("is_connected=true")
        && call.url.includes("cursor=toolkits-page-2")
    )).toBe(true);

    connectedAccountsUnavailable = true;
    const scopedFallbackResponse = await capabilityStatus(
      new URL("https://conduit.example/v1/capabilities?capabilities=gmail"),
      node,
      asEnv(env),
      asExecutionContext(ctx),
    );
    await expect(scopedFallbackResponse.json()).resolves.toEqual({
      capabilities: {
        gmail: {
          connected: true,
          pending: false,
          status: "ACTIVE",
          accounts: [{ id: "ca_work", status: "ACTIVE" }],
        },
      },
    });
    const fallbackResponse = await connectedCapabilities(node, asEnv(env), asExecutionContext(ctx));
    await expect(fallbackResponse.json()).resolves.toMatchObject({
      configured: true,
      capabilities: {
        gmail: {
          connected: true,
          status: "ACTIVE",
          accounts: [{ id: "ca_work", status: "ACTIVE" }],
        },
        publicsearch: { connected: true, status: "ACTIVE", accounts: [] },
        selectedonly: {
          connected: true,
          status: "ACTIVE",
          accounts: [{ id: "ca_session_only", status: "ACTIVE" }],
        },
      },
    });
    connectedAccountsUnavailable = false;
    await expect((await disconnectAccount("gmail", "ca_work", node, asEnv(env), asExecutionContext(ctx))).json())
      .resolves.toEqual({ removed: 1 });
    await expect((await disconnectAccount("gmail", "ca_not_owned", node, asEnv(env), asExecutionContext(ctx))).json())
      .resolves.toEqual({ removed: 0 });
    expect(fetchCalls.filter((call) => call.init?.method === "DELETE")).toHaveLength(1);

    const missingAlias = await authorize("gmail", undefined, node, asEnv(env), asExecutionContext(ctx));
    expect(missingAlias.status).toBe(400);
    await expect(missingAlias.json()).resolves.toEqual({
      error: "Add an account alias so the existing connection is not replaced",
    });
    const authorized = await authorize("gmail", "second", node, asEnv(env), asExecutionContext(ctx));
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toEqual({ url: "https://connect.composio.dev/link/gmail" });
    const linkCall = fetchCalls.find((call) => call.url.endsWith("/tool_router/session/trs_multi/link"));
    expect(JSON.parse(String(linkCall?.init?.body))).toEqual({ toolkit: "gmail", alias: "second" });
  });

  it("validates aliases at the conduit boundary", () => {
    expect(normalizeAccountAlias("  work gmail  ")).toBe("work gmail");
    expect(() => normalizeAccountAlias("bad\nalias")).toThrow(/printable/i);
  });
});

// This Worker authenticates to Composio with its OWN api key, and Composio's
// auth failures quote the key they were sent — middle-masked, but still leaking
// the leading and trailing characters of a server-side secret to whoever
// provoked the error. The unparsed branch was worse: it forwarded the upstream
// body verbatim.
describe("upstream errors never carry this Worker's credentials", () => {
  const reply = (status: number, body: string) =>
    new Response(body, { status, headers: { "content-type": "application/json" } });

  it("never forwards an upstream auth body", async () => {
    const leaky = JSON.stringify({ message: "Invalid API key ak_spw...xX3bP for this project" });
    for (const status of [401, 403]) {
      const message = await upstreamError(reply(status, leaky), "Catalog unavailable");
      expect(message).toBe("Catalog unavailable");
      expect(message).not.toMatch(/ak_|notarealkey/);
    }
  });

  it("redacts credential shapes from a non-auth upstream message", async () => {
    const message = await upstreamError(
      reply(502, JSON.stringify({ message: "upstream rejected key ak_TESTFIXTUREnotarealkey" })),
      "Catalog unavailable",
    );
    expect(message).not.toMatch(/ak_TESTFIXTUREnotarealkey/);
    expect(message).toContain("«redacted»");
  });

  it("redacts a middle-masked echo, a bearer token and a long hex secret", async () => {
    for (const secret of ["ak_T...lkey", "Bearer abcdef0123456789", "a".repeat(40), "abc***xyz"]) {
      const message = await upstreamError(
        reply(502, JSON.stringify({ message: `upstream said ${secret}` })),
        "fallback",
      );
      expect(message, secret).not.toContain(secret);
    }
  });

  it("falls back instead of echoing an unparsable upstream body", async () => {
    const message = await upstreamError(
      new Response("ak_TESTFIXTUREnotarealkey is not authorized", { status: 502 }),
      "Catalog unavailable",
    );
    expect(message).toBe("Catalog unavailable");
  });

  it("still surfaces a genuinely useful upstream message", async () => {
    const message = await upstreamError(
      reply(404, JSON.stringify({ message: "Toolkit gmail not found" })),
      "Catalog unavailable",
    );
    expect(message).toBe("Toolkit gmail not found");
  });
});
