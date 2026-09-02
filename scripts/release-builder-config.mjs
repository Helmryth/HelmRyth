import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { parseReleaseRepository } from "./release-repository.mjs";

export { parseReleaseRepository } from "./release-repository.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_CONFIG = path.join(ROOT, "electron-builder.yml");
export const MANAGED_SERVICE_CONFIG_NAME = "helmryth-service-config.json";
const WINDOWS_SIGNING_HASH_ALGORITHMS = Object.freeze(["sha256"]);

function exactHttpsOrigin(value, variableName) {
  const normalized = requiredValue(value, variableName);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${variableName} must be an exact HTTPS origin`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${variableName} must be an exact HTTPS origin`);
  }
  return parsed.origin;
}

function requiredValue(value, variableName) {
  if (Object.prototype.toString.call(value) !== "[object String]") {
    throw new Error(`${variableName} must be set`);
  }
  const normalized = value.trim();
  if (!normalized) throw new Error(`${variableName} must be set`);
  return normalized;
}

function decodeBase64Secret(value, variableName) {
  const normalized = requiredValue(value, variableName);
  const decoded = Buffer.from(normalized, "base64");
  if (!decoded.length || decoded.toString("base64").replace(/=+$/u, "") !== normalized.replace(/=+$/u, "")) {
    throw new Error(`${variableName} must be valid base64`);
  }
  return decoded;
}

export function parsePublisherNames(value, variableName = "HELMRYTH_WINDOWS_PUBLISHER_NAME") {
  const normalized = requiredValue(value, variableName);
  const parsed =
    normalized.startsWith("[")
      ? JSON.parse(normalized)
      : normalized.startsWith("\"")
        ? JSON.parse(normalized)
        : normalized;
  const names = Array.isArray(parsed) ? parsed : [parsed];
  if (!names.length) throw new Error(`${variableName} must list at least one publisher identity`);
  const exact = names.map((entry) => requiredValue(entry, variableName));
  if (new Set(exact).size !== exact.length) {
    throw new Error(`${variableName} must not contain duplicate publisher identities`);
  }
  return Object.freeze(exact);
}

function parseTimestampServer(value, variableName = "HELMRYTH_WINDOWS_TIMESTAMP_SERVER") {
  const normalized = requiredValue(value, variableName);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${variableName} must be an exact HTTP or HTTPS URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${variableName} must be an exact HTTP or HTTPS URL`);
  }
  return `${parsed.origin}${parsed.pathname}`;
}

export function releaseManagedServiceConfig({
  registryOrigin = process.env.HELMRYTH_RELEASE_REGISTRY_ORIGIN,
  conduitOrigin = process.env.HELMRYTH_RELEASE_CONDUIT_ORIGIN,
} = {}) {
  const exactRegistryOrigin = exactHttpsOrigin(registryOrigin, "HELMRYTH_RELEASE_REGISTRY_ORIGIN");
  const exactConduitOrigin = exactHttpsOrigin(conduitOrigin, "HELMRYTH_RELEASE_CONDUIT_ORIGIN");
  return Object.freeze({
    schemaVersion: 1,
    registryOrigin: exactRegistryOrigin,
    conduitOrigin: exactConduitOrigin,
  });
}

function releaseWindowsSigningConfig({
  certificateFile,
  certificatePassword,
  publisherName,
  timeStampServer,
}) {
  return Object.freeze({
    certificateFile,
    certificatePassword: requiredValue(certificatePassword, "HELMRYTH_WINDOWS_CERT_PASSWORD"),
    publisherName: parsePublisherNames(publisherName),
    timeStampServer: parseTimestampServer(timeStampServer),
    signingHashAlgorithms: [...WINDOWS_SIGNING_HASH_ALGORITHMS],
  });
}

export function releaseBuilderConfig(baseConfigText, releaseRepository, options = {}) {
  const {
    target = "",
    managedServiceConfigPath = "",
    windowsSigning = null,
  } = options;
  const destination = parseReleaseRepository(releaseRepository);
  const base = YAML.parse(baseConfigText);
  if (!base || Object.prototype.toString.call(base) !== "[object Object]") {
    throw new Error("electron-builder.yml must contain one configuration object");
  }
  if (Object.hasOwn(base, "publish")) {
    throw new Error("The local Electron Builder config must remain publish-free");
  }
  const config = {
    ...base,
    publish: [{ provider: "github", owner: destination.owner, repo: destination.repo }],
  };
  if (managedServiceConfigPath) {
    config.extraResources = [
      ...(Array.isArray(base.extraResources) ? base.extraResources : []),
      { from: managedServiceConfigPath, to: MANAGED_SERVICE_CONFIG_NAME },
    ];
  }
  if (target === "win") {
    if (!windowsSigning) {
      throw new Error("Windows release builds require Authenticode signing inputs");
    }
    const win = base.win;
    config.win = {
      ...win,
      publisherName: [...windowsSigning.publisherName],
      signtoolOptions: {
        ...win.signtoolOptions,
        certificateFile: windowsSigning.certificateFile,
        certificatePassword: windowsSigning.certificatePassword,
        signingHashAlgorithms: [...windowsSigning.signingHashAlgorithms],
        timeStampServer: windowsSigning.timeStampServer,
      },
    };
  }
  return config;
}

export function createTemporaryReleaseBuilderConfig({
  target = "",
  releaseRepository = process.env.HELMRYTH_RELEASE_REPO,
  releaseRegistryOrigin = process.env.HELMRYTH_RELEASE_REGISTRY_ORIGIN,
  releaseConduitOrigin = process.env.HELMRYTH_RELEASE_CONDUIT_ORIGIN,
  windowsCertPfxBase64 = process.env.HELMRYTH_WINDOWS_CERT_PFX_BASE64,
  windowsCertPassword = process.env.HELMRYTH_WINDOWS_CERT_PASSWORD,
  windowsPublisherName = process.env.HELMRYTH_WINDOWS_PUBLISHER_NAME,
  windowsTimestampServer = process.env.HELMRYTH_WINDOWS_TIMESTAMP_SERVER,
  baseConfigPath = BASE_CONFIG,
} = {}) {
  const baseConfigText = readFileSync(baseConfigPath, "utf8");
  const directory = mkdtempSync(path.join(tmpdir(), "helmryth-release-builder-"));
  const serviceConfig = releaseManagedServiceConfig({
    registryOrigin: releaseRegistryOrigin,
    conduitOrigin: releaseConduitOrigin,
  });
  const serviceConfigPath = path.join(directory, MANAGED_SERVICE_CONFIG_NAME);
  writeFileSync(serviceConfigPath, `${JSON.stringify(serviceConfig, null, 2)}\n`, { mode: 0o600 });
  let windowsSigning = null;
  if (target === "win") {
    const certificatePath = path.join(directory, "helmryth-windows-release.pfx");
    writeFileSync(certificatePath, decodeBase64Secret(windowsCertPfxBase64, "HELMRYTH_WINDOWS_CERT_PFX_BASE64"), {
      mode: 0o600,
    });
    windowsSigning = releaseWindowsSigningConfig({
      certificateFile: certificatePath,
      certificatePassword: windowsCertPassword,
      publisherName: windowsPublisherName,
      timeStampServer: windowsTimestampServer,
    });
  }
  const config = releaseBuilderConfig(baseConfigText, releaseRepository, {
    target,
    managedServiceConfigPath: serviceConfigPath,
    windowsSigning,
  });
  const configPath = path.join(directory, "electron-builder.release.yml");
  writeFileSync(configPath, YAML.stringify(config), { mode: 0o600 });
  let removed = false;
  return Object.freeze({
    configPath,
    destination: Object.freeze({ ...config.publish[0] }),
    serviceConfig,
    serviceConfigPath,
    cleanup() {
      if (removed) return;
      removed = true;
      rmSync(directory, { recursive: true, force: true });
    },
  });
}

function runCheck() {
  const generated = createTemporaryReleaseBuilderConfig();
  try {
    console.log(`Release builder target verified: ${generated.destination.owner}/${generated.destination.repo}`);
  } finally {
    generated.cleanup();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== "--check") {
    console.error("Usage: HELMRYTH_RELEASE_REPO=owner/repo node scripts/release-builder-config.mjs --check");
    process.exitCode = 2;
  } else {
    try {
      runCheck();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
