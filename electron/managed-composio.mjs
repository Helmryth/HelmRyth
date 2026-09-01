import { z } from "zod";

const TOKEN = /^hry_[0-9a-f]{64}$/;
const NODE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const stringBoundarySchema = z.string();

export function normalizeConduitUrl(value) {
  const decoded = stringBoundarySchema.safeParse(value);
  if (!decoded.success || !decoded.data.trim()) return "";
  const input = decoded.data.trim();
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return "";
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return "";
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return "";
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export function managedConduitAccess(conduitUrl, credentials) {
  const url = normalizeConduitUrl(conduitUrl);
  const token = credentials?.conduitToken;
  if (!url || !TOKEN.test(token ?? "")) return null;
  return { url, token };
}

export function managedConduitChildEnvironment(conduitUrl, credentials, environment) {
  const next = { ...environment };
  delete next.HELMRYTH_CONDUIT_URL;
  delete next.HELMRYTH_CONDUIT_TOKEN;
  const access = managedConduitAccess(conduitUrl, credentials);
  if (access) {
    next.HELMRYTH_CONDUIT_URL = access.url;
    next.HELMRYTH_CONDUIT_TOKEN = access.token;
  }
  return next;
}

export async function ensureConduitCredentials({
  conduitUrl,
  credentials,
  fetchImpl = globalThis.fetch,
  saveCredentials,
  log = () => {},
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  existingCredentialTimeoutMs = 8_000,
  registrationTimeoutMs = 15_000,
}) {
  const url = normalizeConduitUrl(conduitUrl);
  if (!url) {
    if (conduitUrl) log("Connected Apps conduit URL rejected: HTTPS or a loopback HTTP URL is required");
    return credentials;
  }
  if (TOKEN.test(credentials.conduitToken ?? "")) {
    try {
      const check = await fetchImpl(`${url}/v1/self`, {
        headers: { authorization: `Bearer ${credentials.conduitToken}` },
        redirect: "error",
        signal: timeoutSignal(existingCredentialTimeoutMs),
      });
      if (check.ok) {
        const body = await check.json().catch(() => null);
        if (!NODE_ID.test(body?.nodeId ?? "")) return credentials;
        if (
          credentials.conduitNodeId !== body.nodeId ||
          Object.hasOwn(credentials, "conduitInstallationId")
        ) {
          credentials.conduitNodeId = body.nodeId;
          delete credentials.conduitInstallationId;
          await saveCredentials(credentials);
        }
        return credentials;
      }
      // Only a definitive auth failure rotates the credential. A transient
      // outage keeps the existing identity so reconnecting cannot strand the
      // user's already-authorized accounts under a new installation.
      if (check.status !== 401) return credentials;
      delete credentials.conduitToken;
      delete credentials.conduitNodeId;
      delete credentials.conduitInstallationId;
    } catch {
      return credentials;
    }
  }
  try {
    const response = await fetchImpl(`${url}/v1/nodes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      redirect: "error",
      signal: timeoutSignal(registrationTimeoutMs),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    if (!TOKEN.test(body?.token ?? "") || !NODE_ID.test(body?.nodeId ?? "")) {
      throw new Error("the connected-apps service returned invalid credentials");
    }
    credentials.conduitToken = body.token;
    credentials.conduitNodeId = body.nodeId;
    delete credentials.conduitInstallationId;
    await saveCredentials(credentials);
    log("connected-apps Node enrolled");
  } catch (error) {
    // This operation always settles locally. The caller runs it after first
    // paint, so an optional hosted integration cannot delay desktop readiness.
    log(`connected-apps enrollment failed: ${error?.message ?? error}`);
  }
  return credentials;
}
