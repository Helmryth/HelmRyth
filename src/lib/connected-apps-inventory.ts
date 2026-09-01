import { api, type Action } from "@/state/store";
import {
  patchCachedInventoryService,
  readCachedInventory,
  writeCachedInventory,
} from "@/lib/connected-apps-cache";

export interface ConnectorStatus {
  connected: boolean;
  pending?: boolean;
  status?: string;
  accounts?: Array<{
    id: string;
    alias?: string;
    status: string;
  }>;
}

export interface ConnectorInventory {
  services: Record<string, ConnectorStatus>;
  authoritative: boolean;
}

export type ConnectorInventoryPhase = "loading" | "ready" | "error";

let cachedConnectorStatus: Record<string, ConnectorStatus> | null = null;
let cachedConnectorStatusAt = 0;
let cachedConnectorStatusAuthoritative = true;
/** True only when the server actually reported an unopenable credential store.
 * A non-authoritative result can also come from an optimistic local patch, and
 * those two causes need different advice on screen. */
let cachedCredentialStoreUnavailable = false;
let connectorStatusRequest: Promise<ConnectorInventory> | null = null;
let connectedInventoryGeneration = 0;
const CONNECTOR_STATUS_CACHE_MS = 30_000;
const pendingAuthorizationUrls = new Map<string, string>();
let connectionsSetupFocusRequested = false;

export function readRememberedConnectorInventory() {
  return cachedConnectorStatus === null
    ? readCachedInventory()
    : { at: cachedConnectorStatusAt, services: cachedConnectorStatus };
}

export function rememberedConnectorInventoryStale(): boolean {
  return cachedConnectorStatus === null || !cachedConnectorStatusAuthoritative;
}

export function writeRememberedConnectorInventory(
  status: Record<string, ConnectorStatus>,
  stale: boolean,
  now = Date.now(),
): void {
  cachedConnectorStatus = status;
  cachedConnectorStatusAt = now;
  cachedConnectorStatusAuthoritative = !stale;
}

export function connectionsSettingsAction(): Action {
  return { type: "toggleAppSettings", open: true, section: "connections" };
}

export function requestConnectionsSetupFocus(): void {
  connectionsSetupFocusRequested = true;
}

export function consumeConnectionsSetupFocusIntent(): boolean {
  const requested = connectionsSetupFocusRequested;
  connectionsSetupFocusRequested = false;
  return requested;
}

export function rememberPendingAuthorizationUrl(slug: string, url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("The connection service returned an unsafe authorization address.");
  const safeUrl = parsed.toString();
  pendingAuthorizationUrls.set(slug, safeUrl);
  return safeUrl;
}

export function pendingAuthorizationUrl(slug: string): string | undefined {
  return pendingAuthorizationUrls.get(slug);
}

export function pendingAuthorizationEntries(): Array<[string, string]> {
  return Array.from(pendingAuthorizationUrls.entries());
}

export function clearPendingAuthorizationUrl(slug: string): void {
  pendingAuthorizationUrls.delete(slug);
}

export function pendingAuthorizationSettled(status: ConnectorStatus): boolean {
  return (status.connected && !status.pending) || /^(expired|failed)$/i.test(status.status ?? "");
}

export function connectorMutationsDisabled(input: {
  configured: boolean;
  phase: ConnectorInventoryPhase;
  stale: boolean;
  busy: boolean;
}): boolean {
  return !input.configured || input.phase !== "ready" || input.stale || input.busy;
}

export function patchConnectedAppsInventory(slug: string, status: ConnectorStatus, now = Date.now()): void {
  connectedInventoryGeneration += 1;
  connectorStatusRequest = null;
  const patched = patchCachedInventoryService(slug, status, now);
  cachedConnectorStatus = patched.services;
  cachedConnectorStatusAt = now;
  cachedConnectorStatusAuthoritative = false;
}

export function credentialStoreUnavailable(): boolean {
  return cachedCredentialStoreUnavailable;
}

export function preloadConnectedApps(force = false): Promise<ConnectorInventory> {
  if (connectorStatusRequest) return connectorStatusRequest;
  if (!force && cachedConnectorStatus !== null && Date.now() - cachedConnectorStatusAt < CONNECTOR_STATUS_CACHE_MS) {
    return Promise.resolve({
      services: cachedConnectorStatus,
      authoritative: cachedConnectorStatusAuthoritative,
    });
  }
  const requestGeneration = connectedInventoryGeneration;
  const request = api("/api/connectors/connected")
    .then((response) => {
      if (requestGeneration !== connectedInventoryGeneration) return preloadConnectedApps(true);
      const services: Record<string, ConnectorStatus> = response.services ?? {};
      if (response.credentialStore === "unavailable") {
        const remembered = readCachedInventory()?.services ?? {};
        cachedConnectorStatus = remembered;
        cachedConnectorStatusAt = Date.now();
        cachedConnectorStatusAuthoritative = false;
        cachedCredentialStoreUnavailable = true;
        return { services: remembered, authoritative: false };
      }
      cachedConnectorStatus = services;
      cachedConnectorStatusAt = Date.now();
      cachedConnectorStatusAuthoritative = true;
      cachedCredentialStoreUnavailable = false;
      writeCachedInventory(services, Date.now());
      return { services, authoritative: true };
    });
  connectorStatusRequest = request;
  const clearRequest = () => {
    if (connectorStatusRequest === request) connectorStatusRequest = null;
  };
  void request.then(clearRequest, clearRequest);
  return request;
}

export function disconnectAccountConfirmation(
  service: string,
  account: { id: string; alias?: string },
) {
  const identity = account.alias ? `“${account.alias}” (${account.id})` : `“${account.id}”`;
  return `Disconnect ${identity} from ${service}? Only this ${service} account will be revoked. Your other ${service} accounts will stay connected.`;
}

export function requiresAccountAlias(message: string) {
  return /account alias.*existing connection.*not replaced/i.test(message);
}

export function connectorActionLabel(
  phase: ConnectorInventoryPhase,
  state: { busy: boolean; included: boolean; canContinue: boolean; hasAccounts: boolean; failed: boolean },
) {
  if (state.busy) return null;
  if (state.included) return "Included";
  if (phase === "loading") return "Checking…";
  if (phase === "error") return "Unavailable";
  if (state.canContinue) return "Continue";
  if (state.hasAccounts) return "Add account";
  if (state.failed) return "Retry";
  return "Connect";
}

export function connectedInventoryCopy(phase: ConnectorInventoryPhase) {
  if (phase === "loading") return {
    title: "Checking active capabilities…",
    description: "Your connected accounts will appear when the secure check finishes.",
  };
  if (phase === "error") return {
    title: "Couldn’t load active capabilities",
    description: "Retry the secure check before adding another account.",
  };
  return {
    title: "No active capabilities",
    description: "Connect a service from the catalog and it will appear here with its accounts.",
  };
}

export const STALE_CAPABILITY_INVENTORY_COPY =
  "Showing the last confirmed inventory. This Mac’s credential store could not be opened, so Helmryth cannot verify the current connection state. Restart Helmryth, then refresh before changing an account.";

/** Shown when the inventory request itself failed. Restarting cannot help a
 * revoked key, a rate limit, or a service outage, so this must not reuse the
 * credential-store wording above. */
export const UNVERIFIED_CAPABILITY_INVENTORY_COPY =
  "Showing the last confirmed inventory. Helmryth could not reach the connection service, so the current state of your accounts is unconfirmed. Retry, and check the Composio project key in Settings if this persists.";

export function mergeCurrentConnectorStatus(
  current: Record<string, ConnectorStatus>,
  incoming: Record<string, ConnectorStatus>,
  latestGenerations: ReadonlyMap<string, number>,
  requestGenerations: ReadonlyMap<string, number>,
) {
  const next = { ...current };
  for (const [slug, state] of Object.entries(incoming)) {
    if ((latestGenerations.get(slug) ?? 0) !== (requestGenerations.get(slug) ?? 0)) continue;
    next[slug] = state;
  }
  return next;
}

export function mergeCompleteConnectorStatus(
  current: Record<string, ConnectorStatus>,
  incoming: Record<string, ConnectorStatus>,
  latestGenerations: ReadonlyMap<string, number>,
  requestGenerations: ReadonlyMap<string, number>,
  authoritative = true,
) {
  const next = { ...current };
  if (!authoritative) return mergeCurrentConnectorStatus(next, incoming, latestGenerations, requestGenerations);
  for (const [slug, state] of Object.entries(current)) {
    if (incoming[slug]) continue;
    if (!state.connected && !state.accounts?.length) continue;
    if ((latestGenerations.get(slug) ?? 0) !== (requestGenerations.get(slug) ?? 0)) continue;
    next[slug] = { connected: false, pending: false, status: "not_connected", accounts: [] };
  }
  return mergeCurrentConnectorStatus(next, incoming, latestGenerations, requestGenerations);
}

export function onlyLatestConnectorResponses(
  incoming: Record<string, ConnectorStatus>,
  latestRequests: ReadonlyMap<string, number>,
  requestIds: ReadonlyMap<string, number>,
) {
  return Object.fromEntries(
    Object.entries(incoming).filter(
      ([slug]) => (latestRequests.get(slug) ?? 0) === (requestIds.get(slug) ?? 0),
    ),
  );
}
