import { z } from "zod";

const NODE_CREDENTIAL =
  /^hry_node_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const NODE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const stringBoundarySchema = z.string();

const stringValue = (value) => {
  const parsed = stringBoundarySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const isPlainRecord = (value) => {
  if (value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return (
      prototype === null ||
      (Object.getPrototypeOf(prototype) === null &&
        Object.prototype.hasOwnProperty.call(prototype, "isPrototypeOf"))
    );
  } catch {
    return false;
  }
};

const plainObject = (value) => {
  if (!isPlainRecord(value)) return null;
  const record = {};
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) continue;
      const decodedKey = stringValue(key);
      if (decodedKey === null) return null;
      if (decodedKey === "__proto__") continue;
      record[decodedKey] = value[decodedKey];
    }
  } catch {
    return null;
  }
  return record;
};

const validClientInstance = (value) => {
  const input = stringValue(value);
  return input !== null && CLIENT_INSTANCE.test(input);
};

const boundedSecret = (value, maximum = 8_192) => {
  const input = stringValue(value);
  return input !== null &&
    input.length >= 20 &&
    input.length <= maximum &&
    /^\S+$/.test(input)
    ? input
    : null;
};

export class RegistryError extends Error {
  constructor(code, status = 0, requestId = "") {
    super(code);
    this.name = "RegistryError";
    this.code = code;
    this.status = status;
    const decodedRequestId = stringValue(requestId);
    this.requestId = decodedRequestId !== null && REQUEST_ID.test(decodedRequestId)
      ? decodedRequestId
      : "";
  }
}

function statusErrorCode(status) {
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 405) return "method_not_allowed";
  if (status === 409) return "conflict";
  if (status === 413) return "request_too_large";
  if (status === 415) return "unsupported_media_type";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "registry_unavailable";
  return "request_failed";
}

/** Production accepts HTTPS only. A loopback HTTP origin remains available
 * for an explicitly configured development Worker. Paths, credentials, and
 * query strings are rejected so every request stays under the audited API. */
export function normalizeRegistryOrigin(value) {
  const input = stringValue(value)?.trim() ?? "";
  if (!input) return "";
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return "";
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    return "";
  }
  return parsed.origin;
}

export function normalizeAccountEmail(value) {
  const input = stringValue(value);
  const email = input !== null && input.length <= 254 ? input.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

function validatedUser(value) {
  const user = plainObject(value);
  const email = normalizeAccountEmail(user?.email);
  const idInput = stringValue(user?.id);
  const id = idInput !== null && idInput.length >= 1 && idInput.length <= 256
    ? idInput
    : null;
  if (!email || !id) return null;
  return { id, email };
}

function validatedNode(value) {
  const node = plainObject(value);
  const id = stringValue(node?.id);
  const clientInstanceId = stringValue(node?.clientInstanceId);
  if (
    id === null ||
    !NODE_ID.test(id) ||
    clientInstanceId === null ||
    !validClientInstance(clientInstanceId)
  ) {
    return null;
  }
  return {
    id,
    clientInstanceId,
    name: stringValue(node.name) ?? "This computer",
    platform: node.platform,
    appVersion: stringValue(node.appVersion),
  };
}

function validatedReach(value) {
  const reach = plainObject(value);
  const reachURL = stringValue(reach?.url);
  if (reachURL === null) return null;
  let url;
  try {
    url = new URL(reachURL);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return { url: url.origin };
}

export function createRegistryClient({
  registryOrigin,
  fetchImpl = globalThis.fetch,
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  timeoutMs = 15_000,
  healthTimeoutMs = 3_000,
}) {
  const origin = normalizeRegistryOrigin(registryOrigin);
  if (!origin) throw new RegistryError("registry_unavailable");

  const request = async (
    path,
    { method = "GET", token, body, allowEmpty = false, deadlineMs = timeoutMs } = {},
  ) => {
    const headers = new Headers({ accept: "application/json" });
    if (token) headers.set("authorization", `Bearer ${token}`);
    // Node's fetch sends `Sec-Fetch-Mode: cors` even though Electron is a
    // native client. Better Auth 1.7 treats that Fetch Metadata as a
    // browser-shaped request and requires a trusted Origin. Our exact,
    // validated registry origin is already trusted by the Worker; send
    // it only to Better Auth routes instead of weakening server CSRF checks.
    if (path.startsWith("/api/auth/")) headers.set("origin", origin);
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }
    let response;
    try {
      const init = {
        method,
        headers,
        redirect: "error",
        signal: timeoutSignal(deadlineMs),
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      response = await fetchImpl(`${origin}${path}`, init);
    } catch {
      throw new RegistryError("network_unavailable");
    }

    let payload = null;
    if (response.status !== 204) {
      payload = await response.json().catch(() => null);
    }
    if (!response.ok) {
      const rawCode = stringValue(plainObject(payload)?.error);
      const code = rawCode !== null && /^[a-z0-9_]{1,64}$/.test(rawCode)
        ? rawCode
        : null;
      throw new RegistryError(
        code ?? statusErrorCode(response.status),
        response.status,
        response.headers.get("x-request-id") ?? "",
      );
    }
    if (!allowEmpty && !plainObject(payload)) {
      throw new RegistryError("invalid_response", response.status);
    }
    return { response, payload };
  };

  const accountNodes = async (accountToken) => {
    if (!boundedSecret(accountToken)) throw new RegistryError("signed_out", 401);
    const { payload } = await request("/v1/nodes", { token: accountToken });
    if (!Array.isArray(payload.nodes)) {
      throw new RegistryError("invalid_response");
    }
    const nodes = payload.nodes.map(validatedNode);
    if (nodes.some((node) => !node)) {
      throw new RegistryError("invalid_response");
    }
    return nodes;
  };

  return {
    origin,

    async health() {
      const { payload } = await request("/healthz", {
        deadlineMs: Math.min(timeoutMs, healthTimeoutMs),
      });
      if (
        payload.ok !== true ||
        payload.service !== "helmryth-registry"
      ) {
        throw new RegistryError("registry_unavailable");
      }
      return true;
    },

    async requestOTP(rawEmail) {
      const email = normalizeAccountEmail(rawEmail);
      if (!email) throw new RegistryError("invalid_email");
      await request("/api/auth/email-otp/send-verification-otp", {
        method: "POST",
        body: { email, type: "sign-in" },
      });
      // The server deliberately gives the same result for known and unknown
      // addresses. Preserve that enumeration-safe contract in the UI.
      return { email };
    },

    async verifyOTP(rawEmail, rawOTP) {
      const email = normalizeAccountEmail(rawEmail);
      const otpInput = stringValue(rawOTP);
      const otp = otpInput !== null && otpInput.length <= 32
        ? otpInput.replaceAll(/\s|-/g, "")
        : "";
      if (!email) throw new RegistryError("invalid_email");
      if (!/^\d{8}$/.test(otp)) throw new RegistryError("invalid_otp");
      const { response, payload } = await request("/api/auth/sign-in/email-otp", {
        method: "POST",
        body: { email, otp, name: email.split("@", 1)[0] },
      });
      // Better Auth's response JSON includes its raw database token. The
      // signed bearer plugin intentionally publishes a different credential
      // in this header; only that signed value may cross our API boundary.
      const accountToken = boundedSecret(response.headers.get("set-auth-token"));
      const user = validatedUser(payload.user);
      if (!accountToken || !user || user.email !== email) {
        throw new RegistryError("invalid_response", response.status);
      }
      return { accountToken, user };
    },

    async me(accountToken) {
      if (!boundedSecret(accountToken)) throw new RegistryError("signed_out", 401);
      const { payload } = await request("/v1/account", { token: accountToken });
      const user = validatedUser(payload.account);
      if (!user) throw new RegistryError("invalid_response");
      return user;
    },

    async listInstallations(accountToken) {
      return accountNodes(accountToken);
    },

    async ensureInstallation({ accountToken, currentCredential, clientInstanceId, name, platform, appVersion }) {
      if (
        !validClientInstance(clientInstanceId)
      ) {
        throw new RegistryError("invalid_client_identity");
      }

      const decodedCurrentCredential = stringValue(currentCredential);
      if (decodedCurrentCredential !== null && NODE_CREDENTIAL.test(decodedCurrentCredential)) {
        try {
          const { payload } = await request("/v1/nodes/self", { token: decodedCurrentCredential });
          const node = validatedNode(payload.node);
          if (node?.clientInstanceId === clientInstanceId) {
            return {
              installation: node,
              credential: decodedCurrentCredential,
              credentialExpiresAt:
                Number.isSafeInteger(payload.credentialExpiresAt) ? payload.credentialExpiresAt : null,
            };
          }
        } catch (error) {
          // A transient outage must not rotate a perfectly usable identity.
          // Only a definitive 401 falls through to account recovery.
          if (!(error instanceof RegistryError) || error.status !== 401) throw error;
        }
      }

      if (!boundedSecret(accountToken)) throw new RegistryError("signed_out", 401);
      const nodes = await accountNodes(accountToken);
      const existing = nodes.find((item) => item.clientInstanceId === clientInstanceId);
      const result = existing
        ? await request(`/v1/nodes/${encodeURIComponent(existing.id)}/credentials/rotate`, {
            method: "POST",
            token: accountToken,
          })
        : await request("/v1/nodes", {
            method: "POST",
            token: accountToken,
            body: { clientInstanceId, name, platform, appVersion },
          });
      const node = existing ?? validatedNode(result.payload.node);
      const credential = stringValue(result.payload.credential);
      if (!node || credential === null || !NODE_CREDENTIAL.test(credential)) {
        throw new RegistryError("invalid_response");
      }
      return {
        installation: node,
        credential,
        credentialExpiresAt:
          Number.isSafeInteger(result.payload.credentialExpiresAt)
            ? result.payload.credentialExpiresAt
            : null,
      };
    },

    async ensureEndpoint(nodeCredential) {
      const credential = stringValue(nodeCredential);
      if (credential === null || !NODE_CREDENTIAL.test(credential)) {
        throw new RegistryError("signed_out", 401);
      }
      const { payload } = await request("/v1/nodes/self/reach", {
        method: "POST",
        token: credential,
      });
      const endpoint = validatedReach(payload.reach);
      const connectorToken = boundedSecret(payload.connectorToken, 16_384);
      if (!endpoint || !connectorToken) throw new RegistryError("invalid_response");
      return { endpoint, connectorToken };
    },

    async deleteEndpoint(nodeCredential) {
      const credential = stringValue(nodeCredential);
      if (credential === null || !NODE_CREDENTIAL.test(credential)) {
        throw new RegistryError("signed_out", 401);
      }
      await request("/v1/nodes/self/reach", {
        method: "DELETE",
        token: credential,
        allowEmpty: true,
      });
    },

    async revokeInstallation(accountToken, nodeId) {
      const decodedNodeId = stringValue(nodeId);
      if (
        !boundedSecret(accountToken) ||
        decodedNodeId === null ||
        !NODE_ID.test(decodedNodeId)
      ) {
        throw new RegistryError("signed_out", 401);
      }
      await request(`/v1/nodes/${encodeURIComponent(decodedNodeId)}`, {
        method: "DELETE",
        token: accountToken,
        allowEmpty: true,
      });
    },

    async signOut(accountToken) {
      if (!boundedSecret(accountToken)) return;
      await request("/api/auth/sign-out", {
        method: "POST",
        token: accountToken,
      });
    },
  };
}
