import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import type { AppConfig } from "./config.ts";
import {
  applyManagedConduitMessage,
  authorizeService,
  connectedServices,
  connectionMode,
  connectionStatus,
  mcpIntegration,
  normalizeAccountAlias,
  prepareProjectSession,
  removeAccount,
  removeService,
  setManagedConduitAccess,
} from "./composio.ts";

let api: Server;
let base = "";
interface StubRequestBody {
  auth_configs?: Record<string, string>;
  user_id?: string;
  multi_account?: { enable?: boolean; max_accounts_per_toolkit?: number; require_explicit_selection?: boolean };
  toolkit?: string;
}
interface AuthConfigFixture {
  id: string;
  toolkit: { slug: string };
  is_composio_managed: boolean;
  status?: string;
  last_updated_at?: string;
  is_enabled_for_tool_router?: boolean;
}
const calls: Array<{ method: string; path: string; query: string; body: StubRequestBody }> = [];
let malformedConnectedAccounts = false;
let connectedAccountsUnavailable = false;
type ConnectedAccountsFixtureMode =
  | "default"
  | "github-five-identical"
  | "github-five-unique"
  | "linear-duplicate-status"
  | "duplicate-pagination";
let connectedAccountsFixtureMode: ConnectedAccountsFixtureMode = "default";
// The project's own auth configs, and the ones the stub Session was created
// with — a Session only knows the configs named at its creation, which is
// the whole reason #509 happened.
let customAuthConfigs: AuthConfigFixture[] = [];
let sessionAuthConfigs: Record<string, string> = {};

beforeAll(async () => {
  api = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body: StubRequestBody = raw ? JSON.parse(raw) : {};
    calls.push({ method: req.method ?? "GET", path: url.pathname, query: url.search, body });

    if (req.headers["x-api-key"] !== "ak_test") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "invalid project key" } }));
    }

    if (req.method === "POST" && url.pathname === "/api/v3.1/tool_router/session") {
      sessionAuthConfigs = body.auth_configs ?? {};
      res.writeHead(201, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        session_id: "trs_test",
        mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/trs_test/mcp" },
        config: { user_id: body.user_id, multi_account: body.multi_account, auth_configs: sessionAuthConfigs },
      }));
    }
    if (req.method === "GET" && url.pathname === "/api/v3.1/tool_router/session/trs_test") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        session_id: "trs_test",
        mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/trs_test/mcp" },
        config: {
          user_id: "helmryth_existing",
          multi_account: {
            enable: true,
            max_accounts_per_toolkit: 5,
            require_explicit_selection: true,
          },
          auth_configs: sessionAuthConfigs,
        },
      }));
    }
    if (req.method === "GET" && url.pathname === "/api/v3.1/auth_configs") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ items: customAuthConfigs }));
    }
    if (req.method === "GET" && url.pathname === "/api/v3.1/tool_router/session/trs_legacy") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        session_id: "trs_legacy",
        mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/trs_legacy/mcp" },
        config: { user_id: "helmryth_legacy" },
      }));
    }
    if (req.method === "GET" && url.pathname.endsWith("/toolkits")) {
      res.writeHead(200, { "content-type": "application/json" });
      if (url.searchParams.get("cursor") === "toolkits-page-2") {
        return res.end(JSON.stringify({
          items: [
            { slug: "publicsearch", is_no_auth: true },
            { slug: "selectedonly", connected_account: { id: "ca_session_only", status: "ACTIVE" } },
          ],
        }));
      }
      const page = {
        items: [
          { slug: "github", connected_account: { id: "ca_github", status: "ACTIVE" } },
          { slug: "gmail", is_no_auth: true },
          { slug: "slack" },
          { slug: "unconnected", connected_account: null },
        ],
        next_cursor: url.searchParams.has("toolkits") ? undefined : "toolkits-page-2",
      };
      return res.end(JSON.stringify(page));
    }
    if (req.method === "GET" && url.pathname === "/api/v3.1/connected_accounts") {
      if (connectedAccountsUnavailable) {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "connected-account read not granted" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (malformedConnectedAccounts) return res.end(JSON.stringify({ items: {} }));
      if (connectedAccountsFixtureMode === "github-five-identical") {
        return res.end(JSON.stringify({
          items: Array.from({ length: 5 }, () => ({
            id: "ca_github_work",
            alias: "work",
            toolkit: { slug: "github" },
            status: "ACTIVE",
            updated_at: "2026-08-17T09:00:00Z",
          })),
        }));
      }
      if (connectedAccountsFixtureMode === "github-five-unique") {
        return res.end(JSON.stringify({
          items: Array.from({ length: 5 }, (_, index) => ({
            id: `ca_github_${index + 1}`,
            alias: `slot-${index + 1}`,
            toolkit: { slug: "github" },
            status: "ACTIVE",
            updated_at: `2026-08-17T0${index}:00:00Z`,
          })),
        }));
      }
      if (connectedAccountsFixtureMode === "linear-duplicate-status") {
        return res.end(JSON.stringify({
          items: [
            { id: "ca_linear_dup", toolkit: { slug: "linear" }, status: "FAILED", updated_at: "2026-08-17T09:00:00Z" },
            { id: "ca_linear_dup", alias: "ops", toolkit: { slug: "linear" }, status: "ACTIVE", updated_at: "2026-08-17T08:00:00Z" },
            { id: "ca_linear_real", alias: "prod", toolkit: { slug: "linear" }, status: "ACTIVE", updated_at: "2026-08-17T07:00:00Z" },
          ],
        }));
      }
      if (connectedAccountsFixtureMode === "duplicate-pagination") {
        if (url.searchParams.get("cursor") === "accounts-page-2") {
          return res.end(JSON.stringify({
            items: [
              { id: "ca_github_work", alias: "work", toolkit: { slug: "github" }, status: "ACTIVE", updated_at: "2026-08-17T09:00:00Z" },
              { id: "ca_toolkit_41", alias: "overflow", toolkit: { slug: "toolkit_41" }, status: "ACTIVE", updated_at: "2026-08-17T10:00:00Z" },
            ],
          }));
        }
        return res.end(JSON.stringify({
          items: [
            { id: "ca_github_work", alias: "work", toolkit: { slug: "github" }, status: "ACTIVE", updated_at: "2026-08-17T09:00:00Z" },
            { id: "ca_notion", alias: "team", toolkit: { slug: "notion" }, status: "INITIATED", updated_at: "2026-08-17T08:01:00Z" },
          ],
          next_cursor: "accounts-page-2",
        }));
      }
      if (url.searchParams.get("cursor") === "accounts-page-2") {
        return res.end(JSON.stringify({
          items: [
            { id: "ca_toolkit_41", alias: "overflow", toolkit: { slug: "toolkit_41" }, status: "ACTIVE", updated_at: "2026-08-17T10:00:00Z" },
          ],
        }));
      }
      return res.end(JSON.stringify({
        items: [
          { id: "ca_github_work", alias: "work", toolkit: { slug: "github" }, status: "ACTIVE", updated_at: "2026-08-17T08:00:00Z" },
          { id: "ca_github_personal", alias: "personal", toolkit: { slug: "github" }, status: "ACTIVE", updated_at: "2026-08-17T09:00:00Z" },
          { id: "ca_notion", alias: "team", toolkit: { slug: "notion" }, status: "INITIATED", updated_at: "2026-08-17T08:01:00Z" },
          { id: "ca_linear", toolkit: { slug: "linear" }, status: "EXPIRED", updated_at: "2026-08-17T08:02:00Z" },
        ],
        next_cursor: "accounts-page-2",
      }));
    }
    if (req.method === "POST" && url.pathname.endsWith("/link")) {
      // twitter has no Composio-managed auth: the link only works when the
      // Session was created with the project's own config for it
      if (body.toolkit === "twitter" && !sessionAuthConfigs.twitter) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          error: {
            message:
              "Composio does not manage auth for toolkit twitter and no auth config without required fields is available. "
              + "Please create an auth config manually or specify one in auth_config_override.",
          },
        }));
      }
      res.writeHead(201, { "content-type": "application/json" });
      return res.end(JSON.stringify({ redirect_url: `https://connect.composio.dev/link/${body.toolkit}` }));
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/v3.1/connected_accounts/ca_")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ success: true }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  if (!address) throw new Error("Composio stub did not bind a TCP port");
  // SAFETY: this server was explicitly bound to an IPv4 address above.
  base = `http://127.0.0.1:${(address as AddressInfo).port}/api/v3.1`;
  process.env.HELMRYTH_COMPOSIO_API = base;
});

afterAll(async () => {
  setManagedConduitAccess(null);
  delete process.env.HELMRYTH_COMPOSIO_API;
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

afterEach(() => {
  malformedConnectedAccounts = false;
  connectedAccountsUnavailable = false;
  connectedAccountsFixtureMode = "default";
  customAuthConfigs = [];
  sessionAuthConfigs = {};
});

describe.sequential("Composio Sessions", () => {
  it("rejects Conduit URL components and invalid tokens from the environment", () => {
    process.env.HELMRYTH_CONDUIT_TOKEN = `hry_${"a".repeat(64)}`;
    try {
      for (const url of [
        "https://user:secret@conduit.example/root",
        "https://conduit.example/root?redirect=evil",
        "https://conduit.example/root#fragment",
      ]) {
        process.env.HELMRYTH_CONDUIT_URL = url;
        expect(() => connectionMode({})).toThrow(/must not include/);
      }
      process.env.HELMRYTH_CONDUIT_URL = "http://[::1]:3210/root/";
      expect(connectionMode({})).toBe("managed");
      process.env.HELMRYTH_CONDUIT_TOKEN = "short";
      expect(() => connectionMode({})).toThrow(/token is invalid/);
    } finally {
      delete process.env.HELMRYTH_CONDUIT_URL;
      delete process.env.HELMRYTH_CONDUIT_TOKEN;
    }
  });
  it("accepts a private desktop credential update and rejects unsafe Conduit URLs", () => {
    setManagedConduitAccess({ url: "http://127.0.0.1:3210/", token: `hry_${"a".repeat(64)}` });
    expect(connectionMode({})).toBe("managed");
    setManagedConduitAccess({ url: "http://[::1]:3210/", token: `hry_${"a".repeat(64)}` });
    expect(connectionMode({})).toBe("managed");
    expect(() =>
      setManagedConduitAccess({ url: "http://conduit.example", token: `hry_${"a".repeat(64)}` }),
    ).toThrow(/HTTPS/);
    for (const url of [
      "https://user:secret@conduit.example/root",
      "https://conduit.example/root?redirect=evil",
      "https://conduit.example/root#fragment",
    ]) {
      expect(() => setManagedConduitAccess({ url, token: `hry_${"a".repeat(64)}` })).toThrow(/must not include/);
    }
    expect(() => setManagedConduitAccess({ url: "https://conduit.example", token: "short" })).toThrow();
    setManagedConduitAccess(null);
  });
  it("ignores credential sync without access and clears only on explicit null", () => {
    const messageType = "helmryth:conduit-access";
    setManagedConduitAccess({ url: "http://127.0.0.1:3210/", token: `hry_${"a".repeat(64)}` });

    expect(applyManagedConduitMessage({ type: messageType })).toBe(false);
    expect(connectionMode({})).toBe("managed");

    expect(applyManagedConduitMessage({ type: messageType, access: null })).toBe(true);
    expect(connectionMode({})).toBe("unavailable");
  });
  it("accepts only project API keys", async () => {
    await expect(prepareProjectSession("old_key")).rejects.toThrow(/start with ak_/i);
    await expect(prepareProjectSession("ak_wrong")).rejects.toThrow(/invalid project key/i);
  });

  it("falls back to the broader managed capabilities endpoint when /active is unavailable", async () => {
    const token = `hry_${"b".repeat(64)}`;
    const seen: string[] = [];
    const conduit = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://stub");
      seen.push(url.pathname + url.search);
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unauthorized" }));
      }
      if (req.method === "GET" && url.pathname === "/v1/capabilities/active") {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unknown fake Conduit route" }));
      }
      if (req.method === "GET" && url.pathname === "/v1/capabilities") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          capabilities: {
            github: {
              connected: true,
              pending: false,
              status: "ACTIVE",
              accounts: [{ id: "ca_github", alias: "work", status: "ACTIVE" }],
            },
          },
        }));
      }
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "missing route" }));
    });
    await new Promise<void>((resolve) => conduit.listen(0, "127.0.0.1", resolve));
    const port = z.object({ port: z.number() }).parse(conduit.address()).port;
    setManagedConduitAccess({ url: `http://127.0.0.1:${port}/`, token });
    try {
      await expect(connectedServices({})).resolves.toEqual({
        github: {
          connected: true,
          pending: false,
          status: "ACTIVE",
          accounts: [{ id: "ca_github", alias: "work", status: "ACTIVE" }],
        },
      });
      expect(seen).toEqual(["/v1/capabilities/active", "/v1/capabilities"]);
    } finally {
      setManagedConduitAccess(null);
      await new Promise<void>((resolve, reject) => conduit.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("creates one stable per-installation session and reuses it", async () => {
    const created = await prepareProjectSession("ak_test", { userId: "helmryth_existing" });
    expect(created).toEqual({
      apiKey: "ak_test",
      userId: "helmryth_existing",
      sessionId: "trs_test",
    });
    expect(calls.filter((call) => call.method === "POST" && call.path.endsWith("/session")).at(-1)?.body).toEqual({
      user_id: "helmryth_existing",
      manage_connections: {
        enable: true,
        enable_wait_for_connections: true,
        enable_connection_removal: true,
      },
      multi_account: {
        enable: true,
        max_accounts_per_toolkit: 5,
        require_explicit_selection: true,
      },
    });

    const reused = await prepareProjectSession("ak_test", created);
    expect(reused).toEqual({
      apiKey: "ak_test",
      userId: "helmryth_existing",
      sessionId: "trs_test",
    });
  });

  it("recreates a legacy Session with the same Composio user ID", async () => {
    const upgraded = await prepareProjectSession("ak_test", {
      apiKey: "ak_test",
      userId: "stale-local-user-id",
      sessionId: "trs_legacy",
    });
    expect(upgraded).toEqual({
      apiKey: "ak_test",
      userId: "helmryth_legacy",
      sessionId: "trs_test",
    });
    expect(calls.filter((call) => call.method === "POST" && call.path.endsWith("/session")).at(-1)?.body).toMatchObject({
      user_id: "helmryth_legacy",
      multi_account: {
        enable: true,
        max_accounts_per_toolkit: 5,
        require_explicit_selection: true,
      },
    });
  });

  it("names the project's own auth configs at creation and rebuilds a Session that predates them", async () => {
    customAuthConfigs = [
      { id: "ac_twitter_old", toolkit: { slug: "twitter" }, is_composio_managed: false, status: "ENABLED", last_updated_at: "2026-08-20T00:00:00Z" },
      // newest wins, and the slug is matched case-insensitively
      { id: "ac_twitter", toolkit: { slug: "TWITTER" }, is_composio_managed: false, status: "ENABLED", last_updated_at: "2026-08-25T00:00:00Z" },
      // Composio-managed, disabled, and switched-off-for-Sessions configs are not the user's choice
      { id: "ac_github_managed", toolkit: { slug: "github" }, is_composio_managed: true, status: "ENABLED" },
      { id: "ac_slack_disabled", toolkit: { slug: "slack" }, is_composio_managed: false, status: "DISABLED" },
      { id: "ac_notion_off", toolkit: { slug: "notion" }, is_composio_managed: false, is_enabled_for_tool_router: false },
    ];
    sessionAuthConfigs = {};
    try {
      const current = { apiKey: "ak_test", userId: "helmryth_existing", sessionId: "trs_test" };
      const before = calls.length;
      await expect(prepareProjectSession("ak_test", current)).resolves.toEqual({ ...current });
      const creates = calls.slice(before).filter((call) => call.method === "POST" && call.path.endsWith("/session"));
      expect(creates).toHaveLength(1);
      expect(creates[0].body).toMatchObject({ user_id: "helmryth_existing", auth_configs: { twitter: "ac_twitter" } });
      // the rebuilt Session now covers the configs, so the next check reuses it
      const after = calls.length;
      await prepareProjectSession("ak_test", current);
      expect(calls.slice(after).some((call) => call.method === "POST" && call.path.endsWith("/session"))).toBe(false);
    } finally {
      customAuthConfigs = [];
      sessionAuthConfigs = {};
    }
  });

  it("rebuilds the Session and retries when a toolkit needs the project's own auth config", async () => {
    customAuthConfigs = [{ id: "ac_twitter", toolkit: { slug: "twitter" }, is_composio_managed: false, status: "ENABLED" }];
    sessionAuthConfigs = {};
    const cfg: AppConfig = {
      // The live Session is authoritative. A stale local user ID must never
      // move the rebuilt Session away from the existing connected accounts.
      composio: { apiKey: "ak_test", userId: "stale-local-user", sessionId: "trs_test" },
    };
    try {
      const before = calls.length;
      await expect(authorizeService(cfg, "twitter")).resolves.toEqual({ url: "https://connect.composio.dev/link/twitter" });
      const since = calls.slice(before);
      // once against the stale Session, once against the rebuilt one
      expect(since.filter((call) => call.method === "POST" && call.path.endsWith("/link"))).toHaveLength(2);
      expect(since.filter((call) => call.method === "POST" && call.path.endsWith("/session")).at(-1)?.body).toMatchObject({
        user_id: "helmryth_existing",
        auth_configs: { twitter: "ac_twitter" },
      });
      // the same Composio user keeps every existing connection
      expect(cfg.composio).toMatchObject({ userId: "helmryth_existing", sessionId: "trs_test" });
    } finally {
      customAuthConfigs = [];
      sessionAuthConfigs = {};
    }
  });

  it("says what to create when the project has no auth config for the toolkit", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "helmryth_existing", sessionId: "trs_test" },
    };
    const before = calls.length;
    await expect(authorizeService(cfg, "twitter")).rejects.toThrow(/create an auth config for "twitter"/i);
    expect(calls.slice(before).some((call) => call.method === "POST" && call.path.endsWith("/session"))).toBe(false);
    expect(cfg.composio).toMatchObject({ userId: "helmryth_existing", sessionId: "trs_test" });
    // and a failure that is not about auth configs is passed through untouched
    await expect(authorizeService(cfg, "github", "personal-three")).resolves.toEqual({
      url: "https://connect.composio.dev/link/github",
    });
  });

  it("validates account aliases before sending them upstream", () => {
    expect(normalizeAccountAlias("  personal gmail  ")).toBe("personal gmail");
    expect(() => normalizeAccountAlias("bad\nalias")).toThrow(/printable/i);
    expect(() => normalizeAccountAlias("x".repeat(65))).toThrow(/1-64/i);
  });

  it("mounts the Session MCP endpoint with the project key header", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "helmryth_existing", sessionId: "trs_test" },
    };
    const integration = await mcpIntegration(cfg, {
      harnessUrl: "http://127.0.0.1:8799",
      commsToken: "secret",
      botId: "bot-1",
      threadId: "thread-1",
    });
    expect(integration).toMatchObject({
      command: process.execPath,
      args: [expect.stringContaining("connector-proxy")],
      env: {
        HELMRYTH_CONNECTOR_UPSTREAM_URL: "http://127.0.0.1:8799/api/internal/connectors/mcp",
        HELMRYTH_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: "Bearer secret" }),
        HELMRYTH_HARNESS_URL: "http://127.0.0.1:8799",
        HELMRYTH_COMMS_TOKEN: "secret",
        HELMRYTH_BOT_ID: "bot-1",
        HELMRYTH_THREAD_ID: "thread-1",
      },
    });
  });

  it("reports connection state, creates auth links and revokes disconnects", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "helmryth_existing", sessionId: "trs_test" },
    };
    const statusCallCount = calls.length;
    await expect(connectionStatus(cfg, ["github", "gmail", "slack", "notion", "linear"])).resolves.toEqual({
      github: {
        connected: true,
        pending: false,
        status: "ACTIVE",
        accounts: [
          { id: "ca_github_personal", alias: "personal", status: "ACTIVE" },
          { id: "ca_github_work", alias: "work", status: "ACTIVE" },
          // the Session-selected account is synthesized when the raw list
          // omits it — same rule as the inventory path
          { id: "ca_github", status: "ACTIVE" },
        ],
      },
      gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [] },
      slack: { connected: false, pending: false, status: "not_connected", accounts: [] },
      notion: {
        connected: false,
        pending: true,
        status: "INITIATED",
        accounts: [{ id: "ca_notion", alias: "team", status: "INITIATED" }],
      },
      linear: {
        connected: false,
        pending: false,
        status: "EXPIRED",
        accounts: [{ id: "ca_linear", status: "EXPIRED" }],
      },
    });
    const scopedInventoryCalls = calls.slice(statusCallCount).filter((call) => call.path.endsWith("/connected_accounts"));
    expect(scopedInventoryCalls).toHaveLength(2);
    expect(scopedInventoryCalls[0]?.query).toContain("toolkit_slugs=github%2Cgmail%2Cslack%2Cnotion%2Clinear");
    expect(scopedInventoryCalls[1]?.query).toContain("cursor=accounts-page-2");
    await expect(authorizeService(cfg, "github")).rejects.toThrow(/alias.*not replaced/i);
    await expect(authorizeService(cfg, "github", "work")).rejects.toThrow(/already in use/i);
    await expect(authorizeService(cfg, "github", "personal-two")).resolves.toEqual({
      url: "https://connect.composio.dev/link/github",
    });
    expect(calls.filter((call) => call.method === "POST" && call.path.endsWith("/link")).at(-1)?.body).toEqual({
      toolkit: "github",
      alias: "personal-two",
    });
    await expect(removeAccount(cfg, "github", "ca_github_personal")).resolves.toEqual({ removed: 1 });
    await expect(removeAccount(cfg, "github", "ca_other_user")).resolves.toEqual({ removed: 0 });
    await expect(removeAccount(cfg, "github", "../other")).rejects.toThrow(/invalid connected-account ID/i);
    await expect(removeService(cfg, "github")).resolves.toEqual({ removed: 1 });
    expect(calls.some(
      (call) => call.method === "DELETE"
        && call.path.endsWith("/connected_accounts/ca_github")
        && call.query === "?revoke_on_delete=true",
    )).toBe(true);
  });

  it("enumerates connected services independently of catalog position", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "helmryth_existing", sessionId: "trs_test" },
    };
    const callCount = calls.length;

    await expect(connectedServices(cfg)).resolves.toMatchObject({
      toolkit_41: {
        connected: true,
        pending: false,
        status: "ACTIVE",
        accounts: [{ id: "ca_toolkit_41", alias: "overflow", status: "ACTIVE" }],
      },
      github: {
        accounts: [
          { id: "ca_github_personal", alias: "personal", status: "ACTIVE" },
          { id: "ca_github_work", alias: "work", status: "ACTIVE" },
          { id: "ca_github", status: "ACTIVE" },
        ],
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
    });

    const inventoryCalls = calls.slice(callCount).filter((call) => call.path.endsWith("/connected_accounts"));
    expect(inventoryCalls).toHaveLength(2);
    expect(inventoryCalls[0]?.query).not.toContain("toolkit_slugs=");
    expect(inventoryCalls[1]?.query).toContain("cursor=accounts-page-2");
    const toolkitCalls = calls.slice(callCount).filter((call) => call.path.endsWith("/toolkits"));
    expect(toolkitCalls).toHaveLength(2);
    expect(toolkitCalls[0]?.query).toContain("is_connected=true");
    expect(toolkitCalls[1]?.query).toContain("cursor=toolkits-page-2");
  });

  it("falls back to complete Session toolkit state without connected-account read permission", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "helmryth_existing", sessionId: "trs_test" },
    };
    connectedAccountsUnavailable = true;
    try {
      await expect(connectedServices(cfg)).resolves.toMatchObject({
        github: {
          connected: true,
          status: "ACTIVE",
          accounts: [{ id: "ca_github", status: "ACTIVE" }],
        },
        gmail: { connected: true, status: "ACTIVE", accounts: [] },
        publicsearch: { connected: true, status: "ACTIVE", accounts: [] },
        selectedonly: {
          connected: true,
          status: "ACTIVE",
          accounts: [{ id: "ca_session_only", status: "ACTIVE" }],
        },
      });
    } finally {
      connectedAccountsUnavailable = false;
    }
  });

  it("preserves the Session-selected account in scoped status without account inventory permission", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "helmryth_existing", sessionId: "trs_test" },
    };
    connectedAccountsUnavailable = true;
    try {
      await expect(connectionStatus(cfg, ["github", "slack"])).resolves.toEqual({
        github: {
          connected: true,
          pending: false,
          status: "ACTIVE",
          accounts: [{ id: "ca_github", status: "ACTIVE" }],
        },
        slack: { connected: false, pending: false, status: "not_connected", accounts: [] },
      });
    } finally {
      connectedAccountsUnavailable = false;
    }
  });

  it("falls back to session toolkit state when connected-account items is malformed", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "helmryth_existing", sessionId: "trs_test" },
    };
    malformedConnectedAccounts = true;
    try {
      await expect(connectionStatus(cfg, ["github", "slack"])).resolves.toEqual({
        // the malformed list degrades to [], but the Session still names its
        // selected account — synthesized so a poll never wipes the row
        github: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "ca_github", status: "ACTIVE" }] },
        slack: { connected: false, pending: false, status: "not_connected", accounts: [] },
      });
    } finally {
      malformedConnectedAccounts = false;
    }
  });

  it("deduplicates identical provider rows so one account cannot exhaust the five-account cap", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "helmryth_existing", sessionId: "trs_test" },
    };
    connectedAccountsFixtureMode = "github-five-identical";

    await expect(connectedServices(cfg)).resolves.toMatchObject({
      github: {
        accounts: [{ id: "ca_github_work", alias: "work", status: "ACTIVE" }, { id: "ca_github", status: "ACTIVE" }],
      },
    });
    await expect(authorizeService(cfg, "github", "personal-two")).resolves.toEqual({
      url: "https://connect.composio.dev/link/github",
    });
  });

  it("keeps the newest duplicate status while backfilling a missing alias and preserving later unique accounts", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "helmryth_existing", sessionId: "trs_test" },
    };
    connectedAccountsFixtureMode = "linear-duplicate-status";

    await expect(connectionStatus(cfg, ["linear"])).resolves.toEqual({
      linear: {
        connected: true,
        pending: false,
        status: "ACTIVE",
        accounts: [
          { id: "ca_linear_dup", alias: "ops", status: "FAILED" },
          { id: "ca_linear_real", alias: "prod", status: "ACTIVE" },
        ],
      },
    });
  });

  it("still enforces the five-account cap when there are five distinct active accounts", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "helmryth_existing", sessionId: "trs_test" },
    };
    connectedAccountsFixtureMode = "github-five-unique";

    await expect(authorizeService(cfg, "github", "personal-six")).rejects.toThrow(
      /github already has the maximum of 5 accounts/i,
    );
  });

  it("deduplicates repeated accounts across pages without dropping a later unique account", async () => {
    const cfg: AppConfig = {
      composio: { apiKey: "ak_test", userId: "helmryth_existing", sessionId: "trs_test" },
    };
    connectedAccountsFixtureMode = "duplicate-pagination";

    await expect(connectedServices(cfg)).resolves.toMatchObject({
      github: {
        accounts: [{ id: "ca_github_work", alias: "work", status: "ACTIVE" }, { id: "ca_github", status: "ACTIVE" }],
      },
      toolkit_41: {
        connected: true,
        pending: false,
        status: "ACTIVE",
        accounts: [{ id: "ca_toolkit_41", alias: "overflow", status: "ACTIVE" }],
      },
      notion: {
        connected: false,
        pending: true,
        status: "INITIATED",
        accounts: [{ id: "ca_notion", alias: "team", status: "INITIATED" }],
      },
    });
  });
});
