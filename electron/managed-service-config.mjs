import fs from "node:fs";
import path from "node:path";

export const MANAGED_SERVICE_CONFIG_FILENAME = "helmryth-service-config.json";

const exactKeys = new Set(["schemaVersion", "registryOrigin", "conduitOrigin"]);

function plainRecord(value) {
  if (Object.prototype.toString.call(value) !== "[object Object]") return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value : null;
}

function exactOrigin(value, { allowLoopbackHttp }) {
  if (Object(value) === value || value?.constructor !== String) return "";
  const input = value.trim();
  if (!input) return "";
  try {
    const parsed = new URL(input);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (
      (parsed.protocol !== "https:" && !(allowLoopbackHttp && parsed.protocol === "http:" && loopback)) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return "";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}

function invalidConfiguration() {
  return new Error("The managed service configuration is invalid");
}

/** Decode the immutable non-secret resource that is covered by the desktop
 * package's code signature. Keeping both origins in one strict document
 * prevents Registry and Conduit from silently drifting onto different
 * operator-controlled configuration paths. */
export function parseManagedServiceConfig(text) {
  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw invalidConfiguration();
  }
  const document = plainRecord(decoded);
  if (
    !document ||
    Object.keys(document).some((key) => !exactKeys.has(key)) ||
    Object.keys(document).length !== exactKeys.size ||
    document.schemaVersion !== 1
  ) {
    throw invalidConfiguration();
  }
  const registryOrigin = exactOrigin(document.registryOrigin, { allowLoopbackHttp: false });
  const conduitOrigin = exactOrigin(document.conduitOrigin, { allowLoopbackHttp: false });
  if (!registryOrigin || !conduitOrigin) throw invalidConfiguration();
  return {
    source: "packaged",
    state: "ready",
    registryOrigin,
    conduitOrigin,
  };
}

/** Packaged builds trust only the signed Resource payload. Launch environment
 * overrides remain available for source development and deterministic tests,
 * where loopback HTTP Workers are useful and cannot expose production
 * credentials to the network. */
export function loadManagedServiceConfig({
  isPackaged,
  resourcesPath,
  environment = process.env,
  readFile = fs.readFileSync,
}) {
  if (isPackaged) {
    try {
      return parseManagedServiceConfig(
        readFile(path.join(resourcesPath, MANAGED_SERVICE_CONFIG_FILENAME), "utf8"),
      );
    } catch (error) {
      return {
        source: "packaged",
        state: error?.code === "ENOENT" ? "missing" : "invalid",
        registryOrigin: "",
        conduitOrigin: "",
      };
    }
  }

  const registryInput = environment.HELMRYTH_REGISTRY_ORIGIN?.trim() ?? "";
  const conduitInput = environment.HELMRYTH_CONDUIT_URL?.trim() ?? "";
  const registryOrigin = exactOrigin(registryInput, { allowLoopbackHttp: true });
  const conduitOrigin = exactOrigin(conduitInput, { allowLoopbackHttp: true });
  const invalid = (registryInput && !registryOrigin) || (conduitInput && !conduitOrigin);
  return {
    source: "development",
    state: invalid ? "invalid" : registryOrigin || conduitOrigin ? "ready" : "missing",
    registryOrigin: invalid ? "" : registryOrigin,
    conduitOrigin: invalid ? "" : conduitOrigin,
  };
}

/** Renderer/server status is deliberately reconstructed from the allowlisted
 * fields. Passing a credential document here cannot accidentally publish a
 * bearer or enrollment token. */
export function managedServiceConfigStatus(config) {
  const registryOrigin = exactOrigin(config?.registryOrigin, { allowLoopbackHttp: true });
  const conduitOrigin = exactOrigin(config?.conduitOrigin, { allowLoopbackHttp: true });
  return {
    source: config?.source === "packaged" ? "packaged" : "development",
    state: ["ready", "missing", "invalid"].includes(config?.state) ? config.state : "invalid",
    registry: { configured: Boolean(registryOrigin), origin: registryOrigin },
    conduit: { configured: Boolean(conduitOrigin), origin: conduitOrigin },
  };
}

export function managedServiceChildEnvironment(config, environment) {
  const next = { ...environment };
  for (const name of [
    "HELMRYTH_REGISTRY_ORIGIN",
    "HELMRYTH_CONDUIT_URL",
    "HELMRYTH_CONDUIT_TOKEN",
    "HELMRYTH_MANAGED_CONFIG_SOURCE",
    "HELMRYTH_MANAGED_CONFIG_STATE",
    "HELMRYTH_MANAGED_REGISTRY_ORIGIN",
    "HELMRYTH_MANAGED_CONDUIT_ORIGIN",
  ]) {
    delete next[name];
  }
  const status = managedServiceConfigStatus(config);
  next.HELMRYTH_MANAGED_CONFIG_SOURCE = status.source;
  next.HELMRYTH_MANAGED_CONFIG_STATE = status.state;
  next.HELMRYTH_MANAGED_REGISTRY_ORIGIN = status.registry.origin;
  next.HELMRYTH_MANAGED_CONDUIT_ORIGIN = status.conduit.origin;
  return next;
}
