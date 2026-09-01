// A project API key (ak_…) creates/reuses one Composio Session. That
// Session owns connection state, auth links and the MCP endpoint.
import { saveConfig, type AppConfig } from "./config.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";

const DEFAULT_BACKEND_ORIGIN = "https://backend.composio.dev";

function apiBase() {
  return (process.env.HELMRYTH_COMPOSIO_API ?? `${DEFAULT_BACKEND_ORIGIN}/api/v3.1`).replace(/\/$/, "");
}

function toolkitBase() {
  return (process.env.HELMRYTH_COMPOSIO_TOOLKITS_API ?? `${DEFAULT_BACKEND_ORIGIN}/api/v3`).replace(/\/$/, "");
}

const sessionResponseSchema = z.object({
  session_id: z.string().min(1),
  mcp: z.object({ type: z.enum(["http", "sse"]), url: z.string().min(1) }),
  config: z.object({
    user_id: z.string().optional(),
    multi_account: z.object({
      enable: z.boolean().optional(),
      max_accounts_per_toolkit: z.number().optional(),
      require_explicit_selection: z.boolean().optional(),
    }).optional(),
    /** toolkit slug → the project's own auth config the Session uses for it */
    auth_configs: z.record(z.string(), z.string()).optional(),
  }).optional(),
});
type SessionResponse = z.infer<typeof sessionResponseSchema>;

// A project's own auth configs (bring-your-own OAuth app, API-key toolkits
// such as twitter that Composio does not manage). A Session only uses one
// when it was created with the config's id under `auth_configs`.
const authConfigItemSchema = z.object({
  id: z.string().optional(),
  status: z.string().nullable().optional(),
  is_composio_managed: z.boolean().optional(),
  is_enabled_for_tool_router: z.boolean().nullable().optional(),
  last_updated_at: z.string().nullable().optional(),
  toolkit: z.object({ slug: z.string().optional() }).optional(),
});
const authConfigsPageSchema = z.object({
  items: z.array(authConfigItemSchema).optional(),
  next_cursor: z.string().nullable().optional(),
});
/** toolkit slug (lowercase) → auth config id */
type AuthConfigMap = Record<string, string>;
const MAX_AUTH_CONFIG_PAGES = 20;

export interface ConnectedAccountSummary {
  id: string;
  alias?: string;
  status: string;
}

export interface ConnectorServiceState {
  connected: boolean;
  pending: boolean;
  status: string;
  accounts: ConnectedAccountSummary[];
}

interface ConnectedAccountSummaryWithUpdatedAt extends ConnectedAccountSummary {
  updatedAt: string;
}

interface AccountLinkRequest {
  toolkit: string;
  alias?: string;
}

const connectedAccountResponseSchema = z.object({
  id: z.string().optional(),
  alias: z.string().nullable().optional(),
  status: z.string().optional(),
  updated_at: z.string().optional(),
  toolkit: z.object({ slug: z.string().optional() }).optional(),
});
type ConnectedAccountResponse = z.infer<typeof connectedAccountResponseSchema>;

const connectedAccountsPageSchema = z.object({
  items: z.array(connectedAccountResponseSchema),
  next_cursor: z.string().nullable().optional(),
});

const toolkitItemSchema = z.object({
  slug: z.string().optional(),
  is_no_auth: z.boolean().optional(),
  connected_account: z.object({ id: z.string().optional(), status: z.string().optional() }).nullable().optional(),
});
type ToolkitItem = z.infer<typeof toolkitItemSchema>;
const toolkitPageSchema = z.object({
  items: z.array(toolkitItemSchema).optional(),
  next_cursor: z.string().nullable().optional(),
});

const connectorServiceSchema = z.object({
  connected: z.boolean(),
  pending: z.boolean().optional(),
  status: z.string().optional(),
  accounts: z.array(z.object({ id: z.string(), alias: z.string().optional(), status: z.string() })).optional(),
});
const conduitCapabilitiesResponseSchema = z.object({
  capabilities: z.record(z.string(), connectorServiceSchema).optional(),
});
const removalResponseSchema = z.object({ removed: z.number() });
const authUrlResponseSchema = z.object({ url: z.string().optional() });
const linkResponseSchema = z.object({ redirect_url: z.string().optional() });

const MULTI_ACCOUNT_CONFIG = {
  enable: true,
  max_accounts_per_toolkit: 5,
  require_explicit_selection: true,
} as const;

interface SessionCreateRequest {
  user_id: string;
  manage_connections: { enable: boolean; enable_wait_for_connections: boolean; enable_connection_removal: boolean };
  multi_account: typeof MULTI_ACCOUNT_CONFIG;
  /** toolkit slug → the project's own auth config id; named only when the
   * project has its own configs, since a Session cannot be edited afterwards
   * and an empty map would pin "no custom auth" for the Session's lifetime */
  auth_configs?: AuthConfigMap;
}
const MAX_CONNECTED_ACCOUNT_PAGES = 100;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const printableAliasSchema = z.string().min(1).max(64).refine((value) => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127) return false;
  }
  return true;
});

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ComposioMcpIntegration {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface IntegrationContext {
  harnessUrl: string;
  commsToken: string;
  botId: string;
  threadId: string;
}

let managedConduitAccess: { url: string; token: string } | null | undefined;

const managedConduitMessageSchema = z.unknown().pipe(z.record(z.string(), z.unknown()));
type ManagedConduitMessageInput = z.input<typeof managedConduitMessageSchema>;
const managedConduitAccessSchema = z.unknown().pipe(
  z.object({ url: z.string().url(), token: z.string().regex(/^hry_[0-9a-f]{64}$/) }).strict(),
);
type ManagedConduitAccessInput = z.input<typeof managedConduitAccessSchema>;
const managedConduitToken = /^hry_[0-9a-f]{64}$/;

function normalizeManagedConduitUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The connected-apps service URL must not include credentials, a query, or a fragment");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("The connected-apps service must use HTTPS");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function applyManagedConduitMessage(message: ManagedConduitMessageInput): boolean {
  const parsed = managedConduitMessageSchema.safeParse(message);
  if (
    !parsed.success ||
    parsed.data.type !== "helmryth:conduit-access" ||
    !Object.hasOwn(parsed.data, "access")
  ) {
    return false;
  }
  setManagedConduitAccess(parsed.data.access);
  return true;
}

export function setManagedConduitAccess(access: ManagedConduitAccessInput): void {
  if (access === null) {
    managedConduitAccess = null;
    return;
  }
  const parsed = managedConduitAccessSchema.parse(access);
  managedConduitAccess = { url: normalizeManagedConduitUrl(parsed.url), token: parsed.token };
}

function conduitAccess(): { url: string; token: string } | null {
  if (managedConduitAccess !== undefined) return managedConduitAccess;
  const url = process.env.HELMRYTH_CONDUIT_URL?.trim();
  const token = process.env.HELMRYTH_CONDUIT_TOKEN?.trim();
  if (!url || !token) return null;
  if (!managedConduitToken.test(token)) throw new Error("The Conduit token is invalid");
  return { url: normalizeManagedConduitUrl(url), token };
}

export function connectionMode(cfg: AppConfig): "managed" | "self-hosted" | "unavailable" {
  if (conduitAccess()) return "managed";
  return cfg.composio?.apiKey ? "self-hosted" : "unavailable";
}

export function configured(cfg: AppConfig): boolean {
  return connectionMode(cfg) !== "unavailable";
}

/** Three answers, not two. The desktop shell sets HELMRYTH_CREDENTIAL_STORE to
 * "unavailable" when it could not read credentials.bin this launch; without
 * that signal an unreadable store is indistinguishable from a user who never
 * connected anything, and the UI wipes a list it should have kept. */
export type ConnectorAvailability = "configured" | "unconfigured" | "unreadable";

export function connectorAvailability(
  cfg: AppConfig,
  storeState: string | undefined = process.env.HELMRYTH_CREDENTIAL_STORE,
): ConnectorAvailability {
  if (configured(cfg)) return "configured";
  return storeState === "unavailable" ? "unreadable" : "unconfigured";
}

async function conduitRequest(path: string, init?: RequestInit): Promise<Response> {
  const conduit = conduitAccess();
  if (!conduit) throw new Error("Conduit is unavailable");
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${conduit.token}`);
  if (init?.body) headers.set("content-type", "application/json");
  return fetch(`${conduit.url}${path}`, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
}

/** Card blurbs are one line of chrome, so they are capped — but a hard cut
 * lands mid-word and reads like corrupted data. Trim to the last word that
 * fits and mark the elision. */
function catalogBlurb(text: string, limit = 90): string {
  const value = (text ?? "").trim();
  if (value.length <= limit) return value;
  const clipped = value.slice(0, limit - 1);
  const lastSpace = clipped.lastIndexOf(" ");
  const body = lastSpace > limit * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${body.replace(/[\s,;:.-]+$/, "")}…`;
}

function projectHeaders(apiKey: string, json = false) {
  const headers = new Headers({ "x-api-key": apiKey });
  if (json) headers.set("content-type", "application/json");
  return headers;
}

async function responseError(res: Response, fallback: string) {
  const raw = await res.text().catch(() => "");
  try {
    const body = JSON.parse(raw);
    return String(body?.message ?? body?.error?.message ?? body?.error ?? fallback);
  } catch {
    return raw.trim().slice(0, 300) || fallback;
  }
}

const MAX_PUBLIC_PROVIDER_ERROR_CHARS = 240;

/**
 * Preserve actionable provider 4xx responses, but never reflect a remote 5xx
 * body into the local UI. Upstream server failures can contain request dumps,
 * authorization URLs, or credentials; the stable fallback is all a person
 * needs, and 502 truthfully locates the failure beyond Helmryth's boundary.
 */
async function throwProviderError(res: Response, fallback: string): Promise<never> {
  if (res.status >= 400 && res.status < 500) {
    const message = (await responseError(res, fallback)).slice(0, MAX_PUBLIC_PROVIDER_ERROR_CHARS);
    throw Object.assign(new Error(message), { status: res.status });
  }
  await res.body?.cancel().catch(() => undefined);
  throw Object.assign(new Error(fallback.slice(0, MAX_PUBLIC_PROVIDER_ERROR_CHARS)), { status: 502 });
}

async function throwConduitError(res: Response, fallback: string): Promise<never> {
  return throwProviderError(res, fallback);
}

function trustedAuthUrl(value: string | undefined, slug: string): string {
  if (!value) throw new Error(`Connected-apps service returned no authorization link for ${slug}`);
  const url = new URL(value);
  if (url.protocol !== "https:" || (url.hostname !== "composio.dev" && !url.hostname.endsWith(".composio.dev"))) {
    throw new Error("Connected-apps service returned an untrusted authorization link");
  }
  return url.toString();
}

function parseSessionResponse(session: SessionResponse): SessionResponse {
  const mcp = new URL(session.mcp.url);
  if (mcp.protocol !== "https:" || (mcp.hostname !== "composio.dev" && !mcp.hostname.endsWith(".composio.dev"))) {
    throw new Error("Composio returned an untrusted Session MCP URL");
  }
  return { ...session, mcp: { ...session.mcp, url: mcp.toString() } };
}

function supportsMultiAccount(session: SessionResponse): boolean {
  // Only `enable` gates reuse. The cap and selection flags are what we ASK
  // for at creation; if Composio clamps or omits them in the echo, recreating
  // the Session would post the same config and get the same echo back — a
  // strict equality check here can only manufacture a recreate-per-request
  // loop, never fix anything.
  return session.config?.multi_account?.enable === true;
}

/** Session ids this boot already tried to upgrade once. If the fresh Session
 *  STILL doesn't echo multi-account, Composio isn't granting it — run with
 *  what we have (single-account behavior) instead of recreating a Session and
 *  rewriting config.json on every request. */
const multiAccountUpgradeAttempted = new Set<string>();
/** Session id + auth-config map pairs this boot already created a Session
 *  for. Same idea: if Composio does not echo `auth_configs`, recreating the
 *  Session on every check would loop without changing anything. */
const authConfigUpgradeAttempted = new Set<string>();

function inputError(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

function connectorNotConfigured(): Error {
  return inputError("Connected apps are not configured. Add a Composio project key in App Settings.", 409);
}

export function normalizeAccountAlias(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = z.string().safeParse(value);
  if (!parsed.success) throw inputError("Account alias must be text");
  const alias = parsed.data.trim();
  if (!printableAliasSchema.safeParse(alias).success) {
    throw inputError("Account alias must be 1-64 printable characters");
  }
  return alias;
}

function validAccountId(value: string | undefined): value is string {
  return Boolean(value && ACCOUNT_ID.test(value));
}

async function getProjectSession(apiKey: string, sessionId: string): Promise<SessionResponse | null> {
  const res = await fetch(`${apiBase()}/tool_router/session/${encodeURIComponent(sessionId)}`, {
    headers: projectHeaders(apiKey),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await responseError(res, `Composio session: HTTP ${res.status}`));
  return parseSessionResponse(sessionResponseSchema.parse(await res.json()));
}

/** The project's own (non-Composio-managed) auth configs, one per toolkit.
 *  Disabled configs and ones switched off for Sessions are skipped; when a
 *  toolkit has several, the most recently updated wins. Ordinary Session
 *  preparation treats a denied list as "none"; an explicit auth retry surfaces
 *  the denial so it cannot replace a usable Session with an incomplete one. */
export async function listCustomAuthConfigs(apiKey: string): Promise<AuthConfigMap> {
  const chosen = new Map<string, { id: string; updated: string }>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_AUTH_CONFIG_PAGES; page++) {
    const params = new URLSearchParams({ is_composio_managed: "false", limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${apiBase()}/auth_configs?${params}`, {
      headers: projectHeaders(apiKey),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(await responseError(res, `Composio auth configs: HTTP ${res.status}`));
    const body = authConfigsPageSchema.parse(await res.json());
    for (const item of body.items ?? []) {
      const slug = item.toolkit?.slug?.toLowerCase();
      if (!slug || !item.id || item.is_composio_managed === true) continue;
      if (item.is_enabled_for_tool_router === false) continue;
      if (item.status && /^(disabled|inactive|expired|deleted)$/i.test(item.status)) continue;
      const updated = item.last_updated_at ?? "";
      const current = chosen.get(slug);
      if (!current || updated > current.updated) chosen.set(slug, { id: item.id, updated });
    }
    const next = body.next_cursor ?? undefined;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return Object.fromEntries([...chosen].sort(([a], [b]) => a.localeCompare(b)).map(([slug, { id }]) => [slug, id]));
}

/** True when the Session already routes every wanted toolkit through the
 *  project's own auth config. Extra configs on the Session are fine; a
 *  missing or different one means the Session predates the config. */
function sessionCoversAuthConfigs(session: SessionResponse, wanted: AuthConfigMap): boolean {
  const have = session.config?.auth_configs ?? {};
  const haveLower = Object.fromEntries(Object.entries(have).map(([slug, id]) => [slug.toLowerCase(), id]));
  return Object.entries(wanted).every(([slug, id]) => haveLower[slug] === id);
}

function authConfigsKey(sessionId: string, wanted: AuthConfigMap): string {
  return `${sessionId}:${JSON.stringify(wanted)}`;
}

/** Validate a project key and return one reusable Session for this install. */
export async function prepareProjectSession(
  apiKey: string,
  current?: { apiKey?: string; userId?: string; sessionId?: string },
  knownAuthConfigs?: AuthConfigMap,
): Promise<{ apiKey: string; userId: string; sessionId: string }> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("Enter a Composio project API key");
  if (!trimmed.startsWith("ak_")) throw new Error("Composio project API keys start with ak_");

  // The project's own auth configs must be named at creation — a Session
  // cannot be edited later — so they are read before deciding whether the
  // current Session is still the right one (issue #509: a twitter auth
  // config created after the Session existed was never used).
  const authConfigs = knownAuthConfigs
    ?? await listCustomAuthConfigs(trimmed).catch((): AuthConfigMap => ({}));
  let priorUserId = current?.userId;
  if (trimmed === current?.apiKey && current.sessionId) {
    const existing = await getProjectSession(trimmed, current.sessionId);
    if (
      existing
      && supportsMultiAccount(existing)
      && (sessionCoversAuthConfigs(existing, authConfigs)
        || authConfigUpgradeAttempted.has(authConfigsKey(existing.session_id, authConfigs)))
    ) {
      return {
        apiKey: trimmed,
        userId: existing.config?.user_id ?? current.userId ?? `helmryth_${randomUUID()}`,
        sessionId: existing.session_id,
      };
    }
    // Connections belong to the Composio user, not the Session. Recreate old
    // single-account Sessions with the same user ID so every existing grant is
    // retained while the new Session opts into explicit multi-account routing.
    priorUserId = existing?.config?.user_id ?? priorUserId;
  }

  const userId = priorUserId ?? `helmryth_${randomUUID()}`;
  const sessionRequest: SessionCreateRequest = {
    user_id: userId,
    manage_connections: {
      enable: true,
      enable_wait_for_connections: true,
      enable_connection_removal: true,
    },
    multi_account: MULTI_ACCOUNT_CONFIG,
  };
  if (Object.keys(authConfigs).length) sessionRequest.auth_configs = authConfigs;
  const res = await fetch(`${apiBase()}/tool_router/session`, {
    method: "POST",
    headers: projectHeaders(trimmed, true),
    body: JSON.stringify(sessionRequest),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(await responseError(res, `Composio rejected this key (HTTP ${res.status})`));
  const session = parseSessionResponse(sessionResponseSchema.parse(await res.json()));
  // If Composio does not echo the configs back, a later check would ask for
  // the same creation again — remember this attempt so it happens once.
  authConfigUpgradeAttempted.add(authConfigsKey(session.session_id, authConfigs));
  return { apiKey: trimmed, userId, sessionId: session.session_id };
}

async function ensureProjectSession(cfg: AppConfig): Promise<SessionResponse> {
  const composio = cfg.composio;
  if (!composio?.apiKey) throw new Error("No Composio project key configured");
  if (composio.sessionId) {
    const existing = await getProjectSession(composio.apiKey, composio.sessionId);
    if (existing && (supportsMultiAccount(existing) || multiAccountUpgradeAttempted.has(existing.session_id))) {
      return existing;
    }
  }
  // A missing/deleted session is recreated and its non-secret identifiers are
  // persisted so an edited config/env setup does not recreate it every launch.
  const prepared = await prepareProjectSession(composio.apiKey, composio);
  multiAccountUpgradeAttempted.add(prepared.sessionId);
  composio.userId = prepared.userId;
  composio.sessionId = prepared.sessionId;
  saveConfig({ composio: { userId: prepared.userId, sessionId: prepared.sessionId } });
  const created = await getProjectSession(composio.apiKey, prepared.sessionId);
  if (!created) throw new Error("Composio Session disappeared after creation");
  return created;
}

/** Replace the current Session with a freshly created one — the only way to
 *  pick up an auth config the user added after the Session was made. The
 *  Composio user id is kept, so every existing connection survives. */
async function recreateProjectSession(
  cfg: AppConfig,
  userId: string,
  authConfigs: AuthConfigMap,
): Promise<SessionResponse> {
  const composio = cfg.composio;
  if (!composio?.apiKey) throw new Error("No Composio project key configured");
  const prepared = await prepareProjectSession(
    composio.apiKey,
    { apiKey: composio.apiKey, userId },
    authConfigs,
  );
  multiAccountUpgradeAttempted.add(prepared.sessionId);
  composio.userId = prepared.userId;
  composio.sessionId = prepared.sessionId;
  saveConfig({ composio: { userId: prepared.userId, sessionId: prepared.sessionId } });
  const created = await getProjectSession(composio.apiKey, prepared.sessionId);
  if (!created) throw new Error("Composio Session disappeared after creation");
  return created;
}

/** Composio's wording when a toolkit has no managed auth and the Session was
 *  not told which of the project's own auth configs to use. */
const NEEDS_AUTH_CONFIG = /does not manage auth|auth[_ ]?config/i;

export async function mcpIntegration(
  cfg: AppConfig,
  context: IntegrationContext,
): Promise<ComposioMcpIntegration | null> {
  if (!configured(cfg)) return null;
  return {
    command: process.execPath,
    args: [SPAWNED_PROXIES.connectors],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      // The provider-facing bridge receives only this boot's loopback token.
      // Project and Conduit credentials stay in the harness process, so a
      // provider process that prints its environment cannot export a durable secret.
      HELMRYTH_CONNECTOR_UPSTREAM_URL: `${context.harnessUrl}/api/internal/connectors/mcp`,
      HELMRYTH_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: `Bearer ${context.commsToken}` }),
      HELMRYTH_HARNESS_URL: context.harnessUrl,
      HELMRYTH_COMMS_TOKEN: context.commsToken,
      HELMRYTH_BOT_ID: context.botId,
      HELMRYTH_THREAD_ID: context.threadId,
    },
  };
}

export async function relayMcp(
  cfg: AppConfig,
  payload: JsonValue,
  transportSessionId?: string,
): Promise<{ status: number; bytes: Uint8Array; contentType: string; transportSessionId?: string }> {
  const conduit = conduitAccess();
  let url: string;
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  if (transportSessionId) headers.set("mcp-session-id", transportSessionId);
  if (conduit) {
    url = `${conduit.url}/v1/mcp`;
    headers.set("authorization", `Bearer ${conduit.token}`);
  } else {
    if (!cfg.composio?.apiKey) throw new Error("Connected apps are unavailable");
    const session = await ensureProjectSession(cfg);
    url = session.mcp.url;
    headers.set("x-api-key", cfg.composio.apiKey);
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > 20 * 1024 * 1024) throw new Error("Connected-app response exceeded 20 MB");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("Connected-app response exceeded 20 MB");
  return {
    status: response.status,
    bytes,
    contentType: response.headers.get("content-type") ?? "application/json",
    transportSessionId: response.headers.get("mcp-session-id") ?? undefined,
  };
}

async function listConnectedAccounts(
  apiKey: string,
  userId: string,
  slugs: string[],
): Promise<ConnectedAccountResponse[]> {
  const accounts: ConnectedAccountResponse[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  // Five accounts per toolkit can exceed one provider page when a user has
  // many apps. Follow Composio's cursor instead of silently dropping entries.
  for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
    const params = new URLSearchParams({
      limit: "50",
      user_ids: userId,
      order_by: "updated_at",
      order_direction: "desc",
    });
    if (slugs.length) params.set("toolkit_slugs", slugs.join(","));
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`${apiBase()}/connected_accounts?${params}`, {
      headers: projectHeaders(apiKey),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(await responseError(response, `Composio accounts: HTTP ${response.status}`));
    const body = connectedAccountsPageSchema.parse(await response.json());
    accounts.push(...body.items);
    const next = body.next_cursor || undefined;
    if (!next || seenCursors.has(next)) return accounts;
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error("Composio account inventory exceeded the pagination safety limit");
}

async function listSessionToolkits(
  apiKey: string,
  sessionId: string,
): Promise<ToolkitItem[]> {
  const toolkits: ToolkitItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
    // The unfiltered endpoint contains the entire Composio marketplace and is
    // cursor-paginated in 50-item pages. The Connected tab only needs the
    // user's connected toolkits, so avoid scanning hundreds of unrelated apps.
    const params = new URLSearchParams({ limit: "50", is_connected: "true" });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(
      `${apiBase()}/tool_router/session/${encodeURIComponent(sessionId)}/toolkits?${params}`,
      { headers: projectHeaders(apiKey), signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) throw new Error(await responseError(response, `Composio toolkits: HTTP ${response.status}`));
    const body = toolkitPageSchema.parse(await response.json());
    toolkits.push(...(body.items ?? []));
    const next = body.next_cursor || undefined;
    if (!next || seenCursors.has(next)) return toolkits;
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error("Composio toolkit inventory exceeded the pagination safety limit");
}

function dedupeSummarizedAccounts(
  accounts: ConnectedAccountSummaryWithUpdatedAt[],
): ConnectedAccountSummaryWithUpdatedAt[] {
  const unique: ConnectedAccountSummaryWithUpdatedAt[] = [];
  const byId = new Map<string, ConnectedAccountSummaryWithUpdatedAt>();
  for (const account of accounts) {
    const existing = byId.get(account.id);
    if (!existing) {
      byId.set(account.id, account);
      unique.push(account);
      continue;
    }
    // The provider sorts by updated_at desc. Keep the first row's lifecycle
    // state so an older duplicate cannot revive or expire the account, but
    // backfill a missing alias from later duplicates when available.
    if (!existing.alias && account.alias) existing.alias = account.alias;
  }
  return unique;
}

function summarizeAccounts(accounts: ConnectedAccountResponse[], slugs: string[]) {
  const requested = new Set(slugs.map((slug) => slug.toLowerCase()));
  const bySlug = new Map<string, ConnectedAccountSummaryWithUpdatedAt[]>();
  for (const account of accounts) {
    const slug = account.toolkit?.slug?.toLowerCase();
    if (!slug || (requested.size && !requested.has(slug)) || !validAccountId(account.id)) continue;
    const alias = account.alias?.trim() ?? "";
    const summary: ConnectedAccountSummaryWithUpdatedAt = {
      id: account.id,
      status: account.status || "UNKNOWN",
      updatedAt: account.updated_at ?? "",
    };
    if (printableAliasSchema.safeParse(alias).success) summary.alias = alias;
    const list = bySlug.get(slug) ?? [];
    list.push(summary);
    bySlug.set(slug, list);
  }
  for (const [slug, list] of bySlug) {
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    bySlug.set(slug, dedupeSummarizedAccounts(list));
  }
  return bySlug;
}

function publicAccount({ id, alias, status }: ConnectedAccountSummary): ConnectedAccountSummary {
  const account: ConnectedAccountSummary = { id, status };
  if (alias) account.alias = alias;
  return account;
}

function serviceStateFromAccounts(
  accounts: ConnectedAccountSummary[],
): ConnectorServiceState {
  const active = accounts.find((account) => /^active$/i.test(account.status));
  const pending = accounts.find((account) => /^(initiated|initializing|pending)$/i.test(account.status));
  const selected = active ?? pending ?? accounts[0];
  return {
    connected: Boolean(active),
    pending: Boolean(pending),
    status: selected?.status ?? "not_connected",
    accounts: accounts.map(publicAccount),
  };
}

function serviceStateFromToolkit(
  toolkit: ToolkitItem | undefined,
  inventoryAccounts: ConnectedAccountSummary[],
): ConnectorServiceState {
  const selected = toolkit?.connected_account;
  const selectedId = validAccountId(selected?.id) ? selected.id : undefined;
  const accounts = [...inventoryAccounts];
  if (selectedId && !accounts.some((account) => account.id === selectedId)) {
    accounts.push({ id: selectedId, status: selected?.status ?? "ACTIVE" });
  }
  const accountState = serviceStateFromAccounts(accounts);
  const status = toolkit?.is_no_auth ? "ACTIVE" : selected?.status ?? accountState.status;
  return {
    connected: toolkit?.is_no_auth === true || accountState.connected || /^active$/i.test(status),
    pending: accountState.pending || /^(initiated|initializing|pending)$/i.test(status),
    status,
    accounts: accountState.accounts,
  };
}

function allServiceStates(
  accountsBySlug: ReadonlyMap<string, ConnectedAccountSummary[]>,
  toolkits: ToolkitItem[],
): Record<string, ConnectorServiceState> {
  const services = new Map(
    [...accountsBySlug].map(([slug, accounts]) => [slug, serviceStateFromAccounts(accounts)]),
  );
  for (const toolkit of toolkits) {
    const slug = toolkit.slug?.toLowerCase();
    const selected = toolkit.connected_account;
    const selectedId = validAccountId(selected?.id) ? selected.id : undefined;
    if (!slug || (!toolkit.is_no_auth && !selectedId)) continue;
    services.set(slug, serviceStateFromToolkit(toolkit, accountsBySlug.get(slug) ?? []));
  }
  return Object.fromEntries(services);
}

/**
 * Enumerate the user's complete connected-account inventory without depending
 * on marketplace ordering or catalog pagination.
 */
export async function connectedServices(cfg: AppConfig): Promise<Record<string, ConnectorServiceState>> {
  if (conduitAccess()) {
    let response = await conduitRequest("/v1/capabilities/active");
    // Older Conduit surfaces expose only the broader capabilities inventory.
    // Fall back to that compatible shape instead of bubbling a 404 into the
    // app-level warm preload path.
    if (response.status === 404) response = await conduitRequest("/v1/capabilities");
    if (!response.ok) await throwConduitError(response, `Connected apps: HTTP ${response.status}`);
    const body = conduitCapabilitiesResponseSchema.parse(await response.json());
    return Object.fromEntries(
      Object.entries(body.capabilities ?? {}).map(([slug, state]) => [slug, {
        connected: state.connected,
        pending: state.pending ?? false,
        status: state.status ?? (state.connected ? "ACTIVE" : "not_connected"),
        accounts: state.accounts ?? [],
      }]),
    );
  }
  if (!cfg.composio?.apiKey) throw new Error("Connected apps are unavailable");
  const session = await ensureProjectSession(cfg);
  const userId = session.config?.user_id ?? cfg.composio.userId;
  if (!userId) throw new Error("Composio Session returned no user ID");
  const [toolkits, accounts] = await Promise.all([
    listSessionToolkits(cfg.composio.apiKey, session.session_id),
    // Scoped project keys can grant Session reads without granting the raw
    // connected-account list. The Session still proves which selected/no-auth
    // toolkits belong to this installation, so retain that safe fallback.
    listConnectedAccounts(cfg.composio.apiKey, userId, []).catch(() => []),
  ]);
  return allServiceStates(summarizeAccounts(accounts, []), toolkits);
}

export async function connectionStatus(cfg: AppConfig, slugs: string[]) {
  if (conduitAccess()) {
    const response = await conduitRequest(`/v1/capabilities?${new URLSearchParams({ capabilities: slugs.join(",") })}`);
    if (!response.ok) await throwConduitError(response, `Connected apps: HTTP ${response.status}`);
    const body = conduitCapabilitiesResponseSchema.parse(await response.json());
    return body.capabilities ?? {};
  }
  if (!cfg.composio?.apiKey) throw connectorNotConfigured();
  const session = await ensureProjectSession(cfg);
  const params = new URLSearchParams({ limit: "50" });
  if (slugs.length) params.set("toolkits", slugs.join(","));
  const userId = session.config?.user_id ?? cfg.composio.userId;
  const [res, accounts] = await Promise.all([
    fetch(`${apiBase()}/tool_router/session/${encodeURIComponent(session.session_id)}/toolkits?${params}`, {
      headers: projectHeaders(cfg.composio.apiKey),
      signal: AbortSignal.timeout(15_000),
    }),
    // Session toolkits only include an account once it is usable. Read the
    // account lifecycle too so the UI can distinguish an OAuth flow that is
    // still waiting in the browser from one that expired or failed. Scoped
    // keys may omit connected-account read permission, so this is additive:
    // the normal session result remains the fallback.
    userId
      ? listConnectedAccounts(cfg.composio.apiKey, userId, slugs).catch(() => [])
      : Promise.resolve([]),
  ]);
  if (!res.ok) throw new Error(await responseError(res, `Composio toolkits: HTTP ${res.status}`));
  const body = toolkitPageSchema.parse(await res.json());
  const bySlug = new Map((body.items ?? []).map((item) => [item.slug?.toLowerCase(), item]));
  const accountsBySlug = summarizeAccounts(accounts, slugs);
  return Object.fromEntries(
    slugs.map((slug) => {
      const item = bySlug.get(slug.toLowerCase());
      return [slug, serviceStateFromToolkit(item, accountsBySlug.get(slug.toLowerCase()) ?? [])];
    }),
  );
}

/** Backward-compatible service disconnect: removes the Session-selected account. */
export async function removeService(cfg: AppConfig, slug: string) {
  if (conduitAccess()) {
    const response = await conduitRequest(`/v1/capabilities/${encodeURIComponent(slug)}`, { method: "DELETE" });
    if (!response.ok) await throwConduitError(response, `Connected apps: HTTP ${response.status}`);
    return removalResponseSchema.parse(await response.json());
  }
  if (!cfg.composio?.apiKey) throw connectorNotConfigured();
  const session = await ensureProjectSession(cfg);
  const params = new URLSearchParams({ limit: "50", toolkits: slug });
  const list = await fetch(
    `${apiBase()}/tool_router/session/${encodeURIComponent(session.session_id)}/toolkits?${params}`,
    { headers: projectHeaders(cfg.composio.apiKey), signal: AbortSignal.timeout(15_000) },
  );
  if (!list.ok) await throwProviderError(list, `Composio toolkits: HTTP ${list.status}`);
  const body = toolkitPageSchema.parse(await list.json());
  const id = body.items?.find((item) => item.slug?.toLowerCase() === slug.toLowerCase())?.connected_account?.id;
  if (!id) return { removed: 0 };
  const removed = await fetch(
    `${apiBase()}/connected_accounts/${encodeURIComponent(id)}?revoke_on_delete=true`,
    { method: "DELETE", headers: projectHeaders(cfg.composio.apiKey), signal: AbortSignal.timeout(30_000) },
  );
  if (!removed.ok) await throwProviderError(removed, `Composio disconnect: HTTP ${removed.status}`);
  return { removed: 1 };
}

/** Disconnect exactly one account after proving it belongs to this user/toolkit. */
export async function removeAccount(cfg: AppConfig, slug: string, accountId: string) {
  if (!validAccountId(accountId)) throw inputError("Invalid connected-account ID");
  if (conduitAccess()) {
    const response = await conduitRequest(
      `/v1/capabilities/${encodeURIComponent(slug)}/accounts/${encodeURIComponent(accountId)}`,
      { method: "DELETE" },
    );
    if (!response.ok) await throwConduitError(response, `Connected apps: HTTP ${response.status}`);
    return removalResponseSchema.parse(await response.json());
  }
  if (!cfg.composio?.apiKey) throw connectorNotConfigured();
  const session = await ensureProjectSession(cfg);
  const userId = session.config?.user_id ?? cfg.composio.userId;
  if (!userId) throw new Error("Composio Session has no user ID");
  const accounts = await listConnectedAccounts(cfg.composio.apiKey, userId, [slug]);
  const owned = accounts.some((account) =>
    account.id === accountId && account.toolkit?.slug?.toLowerCase() === slug.toLowerCase()
  );
  if (!owned) return { removed: 0 };
  const removed = await fetch(
    `${apiBase()}/connected_accounts/${encodeURIComponent(accountId)}?revoke_on_delete=true`,
    { method: "DELETE", headers: projectHeaders(cfg.composio.apiKey), signal: AbortSignal.timeout(30_000) },
  );
  if (!removed.ok) await throwProviderError(removed, `Composio disconnect: HTTP ${removed.status}`);
  return { removed: 1 };
}

/** Mint a browser auth link for one service. Returns { url } or throws. */
export async function authorizeService(cfg: AppConfig, slug: string, requestedAlias?: string | null) {
  const alias = normalizeAccountAlias(requestedAlias);
  if (conduitAccess()) {
    const request: RequestInit = { method: "POST" };
    if (alias) request.body = JSON.stringify({ alias });
    const response = await conduitRequest(`/v1/capabilities/${encodeURIComponent(slug)}/authorize`, request);
    if (!response.ok) await throwConduitError(response, `Connected apps: HTTP ${response.status}`);
    const body = authUrlResponseSchema.parse(await response.json());
    return { url: trustedAuthUrl(body.url, slug) };
  }
  if (!cfg.composio?.apiKey) throw connectorNotConfigured();
  const session = await ensureProjectSession(cfg);
  const userId = session.config?.user_id ?? cfg.composio.userId;
  if (!userId) throw new Error("Composio Session has no user ID");
  // A scoped key may be denied account listing — authorization must still
  // work (it always did pre-multi-account), so the alias guardrails degrade
  // to first-account behavior, the same fallback every inventory path takes.
  const accounts = await listConnectedAccounts(cfg.composio.apiKey, userId, [slug]).catch(() => []);
  const serviceAccounts = summarizeAccounts(accounts, [slug]).get(slug.toLowerCase()) ?? [];
  const usableAccounts = serviceAccounts.filter((account) => /^(active|initiated|initializing|pending)$/i.test(account.status ?? ""));
  if (usableAccounts.length >= MULTI_ACCOUNT_CONFIG.max_accounts_per_toolkit) {
    throw inputError(`${slug} already has the maximum of ${MULTI_ACCOUNT_CONFIG.max_accounts_per_toolkit} accounts`, 409);
  }
  if (usableAccounts.length > 0 && !alias) {
    throw inputError("Add an account alias so the existing connection is not replaced");
  }
  if (alias && serviceAccounts.some((account) => account.alias?.trim().toLowerCase() === alias.toLowerCase())) {
    throw inputError(`Account alias "${alias}" is already in use for ${slug}`, 409);
  }
  const linkRequest: AccountLinkRequest = { toolkit: slug };
  if (alias) linkRequest.alias = alias;
  const apiKey = cfg.composio.apiKey;
  const link = (sessionId: string) =>
    fetch(`${apiBase()}/tool_router/session/${encodeURIComponent(sessionId)}/link`, {
      method: "POST",
      headers: projectHeaders(apiKey, true),
      body: JSON.stringify(linkRequest),
      signal: AbortSignal.timeout(30_000),
    });
  let res = await link(session.session_id);
  if (!res.ok) {
    const fallback = `Composio authorization: HTTP ${res.status}`;
    if (res.status < 400 || res.status >= 500) await throwProviderError(res, fallback);
    const message = (await responseError(res, fallback)).slice(0, MAX_PUBLIC_PROVIDER_ERROR_CHARS);
    if (!NEEDS_AUTH_CONFIG.test(message)) throw inputError(message, res.status);
    // The toolkit needs one of the project's own auth configs. The Session
    // names those only at creation, so an auth config the user created after
    // the Session existed is invisible to it: rebuild the Session once and
    // retry. If the project has no config for this toolkit, say what to do
    // instead of echoing Composio's "auth_config_override" hint.
    const slugLower = slug.toLowerCase();
    const authConfigs = await listCustomAuthConfigs(apiKey);
    const covered = Object.keys(authConfigs).some((key) => key.toLowerCase() === slugLower);
    if (!covered) {
      throw inputError(
        `${slug} has no Composio-managed sign-in. In your Composio project, create an auth config for "${slug}" `
          + "(Auth Configs → Create) with your own app credentials, then click Connect again.",
      );
    }
    const fresh = await recreateProjectSession(cfg, userId, authConfigs);
    res = await link(fresh.session_id);
    if (!res.ok) await throwProviderError(res, `Composio authorization: HTTP ${res.status}`);
  }
  const body = linkResponseSchema.parse(await res.json());
  return { url: trustedAuthUrl(body.redirect_url, slug) };
}

// ── marketplace catalog ────────────────────────────────────────────────
export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  /** Toolkits such as public search need no user authorization. */
  noAuth?: boolean;
  /** used for the client-side favicon fallback when logo is null/broken */
  domain: string | null;
}

// Curated fallback — the services agentcal's connectors page ships plus the
// long marketplace tail. Logos resolve client-side:
// logo → favicon(domain) → monogram.
const CURATED: ToolkitCard[] = [
  { slug: "slack", label: "Slack", blurb: "Post updates and read channels", domain: "slack.com", logo: null },
  { slug: "github", label: "GitHub", blurb: "Issues, pull requests, and code", domain: "github.com", logo: null },
  { slug: "gmail", label: "Gmail", blurb: "Read and send email", domain: "gmail.com", logo: null },
  { slug: "googlecalendar", label: "Google Calendar", blurb: "Read and create events", domain: "calendar.google.com", logo: null },
  { slug: "googlesheets", label: "Google Sheets", blurb: "Read and update spreadsheets", domain: "sheets.google.com", logo: null },
  { slug: "googledocs", label: "Google Docs", blurb: "Read and write documents", domain: "docs.google.com", logo: null },
  { slug: "googledrive", label: "Google Drive", blurb: "Browse and manage files", domain: "drive.google.com", logo: null },
  { slug: "notion", label: "Notion", blurb: "Pages and databases", domain: "notion.so", logo: null },
  { slug: "linear", label: "Linear", blurb: "Issues and project tracking", domain: "linear.app", logo: null },
  { slug: "sentry", label: "Sentry", blurb: "Errors and alerts", domain: "sentry.io", logo: null },
  { slug: "posthog", label: "PostHog", blurb: "Analytics, feature flags, experiments", domain: "posthog.com", logo: null },
  { slug: "discord", label: "Discord", blurb: "Messages and channels", domain: "discord.com", logo: null },
  { slug: "x", label: "X (Twitter)", blurb: "Post and read on X", domain: "x.com", logo: null },
  { slug: "reddit", label: "Reddit", blurb: "Browse and post", domain: "reddit.com", logo: null },
  { slug: "zapier", label: "Zapier", blurb: "Connect 9,000+ apps", domain: "zapier.com", logo: null },
  { slug: "hubspot", label: "HubSpot", blurb: "CRM search & updates", domain: "hubspot.com", logo: null },
  { slug: "salesforce", label: "Salesforce", blurb: "CRM records and reports", domain: "salesforce.com", logo: null },
  { slug: "jira", label: "Jira", blurb: "Issues and sprints", domain: "atlassian.com", logo: null },
  { slug: "asana", label: "Asana", blurb: "Tasks and projects", domain: "asana.com", logo: null },
  { slug: "trello", label: "Trello", blurb: "Boards and cards", domain: "trello.com", logo: null },
  { slug: "dropbox", label: "Dropbox", blurb: "Files and folders", domain: "dropbox.com", logo: null },
  { slug: "airtable", label: "Airtable", blurb: "Bases and records", domain: "airtable.com", logo: null },
  { slug: "figma", label: "Figma", blurb: "Files and comments", domain: "figma.com", logo: null },
  { slug: "stripe", label: "Stripe", blurb: "Payments and customers", domain: "stripe.com", logo: null },
];

let toolkitCache: { at: number; cards: ToolkitCard[] } | null = null;
const catalogToolkitSchema = z.object({
  slug: z.string().optional(),
  key: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  logo: z.string().nullable().optional(),
  no_auth: z.boolean().optional(),
  meta: z.object({ description: z.string().optional(), logo: z.string().nullable().optional() }).optional(),
});
const toolkitCatalogSchema = z.object({
  items: z.array(catalogToolkitSchema).optional(),
  data: z.array(catalogToolkitSchema).optional(),
});

/**
 * Marketplace catalog. Tries the v3 toolkits API (official names,
 * descriptions, logos — cached 10 min); falls back to the curated list.
 */
export async function listToolkits(cfg: AppConfig): Promise<{ cards: ToolkitCard[]; source: "api" | "curated" }> {
  if (toolkitCache && Date.now() - toolkitCache.at < 10 * 60_000) {
    return { cards: toolkitCache.cards, source: "api" };
  }
  const backendKey = conduitAccess() ? undefined : cfg.composio?.apiKey;
  if (backendKey || conduitAccess()) {
    try {
      const res = backendKey
        ? await fetch(`${toolkitBase()}/toolkits?limit=500&sort_by=usage`, {
            headers: { "x-api-key": backendKey },
            signal: AbortSignal.timeout(15_000),
          })
        : await conduitRequest("/v1/capabilities/catalog", { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const catalog = toolkitCatalogSchema.safeParse(await res.json());
        const items = catalog.success ? (catalog.data.items ?? catalog.data.data ?? []) : [];
        if (items.length) {
          const cards: ToolkitCard[] = items.map((toolkit) => ({
            slug: (toolkit.slug ?? toolkit.key ?? toolkit.name ?? "").toLowerCase(),
            label: toolkit.name ?? toolkit.slug ?? "",
            blurb: catalogBlurb(toolkit.meta?.description ?? toolkit.description ?? ""),
            logo: toolkit.meta?.logo ?? toolkit.logo ?? null,
            noAuth: toolkit.no_auth === true,
            domain: null,
          }));
          toolkitCache = { at: Date.now(), cards };
          return { cards, source: "api" };
        }
      }
    } catch {
      /* fall through to curated */
    }
  }
  return { cards: CURATED, source: "curated" };
}

export async function toolkitCard(cfg: AppConfig, slug: string): Promise<ToolkitCard> {
  const normalized = slug.toLowerCase();
  const { cards } = await listToolkits(cfg);
  return cards.find((card) => card.slug.toLowerCase() === normalized)
    ?? CURATED.find((card) => card.slug === normalized)
    ?? {
      slug: normalized,
      label: normalized.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      blurb: "Connect this app so your operator can continue",
      logo: null,
      domain: null,
    };
}

export const CURATED_SLUGS = CURATED.map((c) => c.slug);
