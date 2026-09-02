import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function exactValue(value, variableName) {
  if (Object.prototype.toString.call(value) !== "[object String]") {
    throw new Error(`${variableName} must be set`);
  }
  const normalized = value.trim();
  if (!normalized) throw new Error(`${variableName} must be set`);
  return normalized;
}

export function verifyManagedServiceConfig(
  configText,
  {
    registryOrigin = process.env.HELMRYTH_RELEASE_REGISTRY_ORIGIN,
    conduitOrigin = process.env.HELMRYTH_RELEASE_CONDUIT_ORIGIN,
  } = {},
) {
  let config;
  try {
    config = JSON.parse(configText);
  } catch {
    throw new Error("managed service config must be valid JSON");
  }
  if (!config || Object.prototype.toString.call(config) !== "[object Object]") {
    throw new Error("managed service config must contain one object");
  }
  const expectedRegistryOrigin = exactValue(registryOrigin, "HELMRYTH_RELEASE_REGISTRY_ORIGIN");
  const expectedConduitOrigin = exactValue(conduitOrigin, "HELMRYTH_RELEASE_CONDUIT_ORIGIN");
  const keys = Object.keys(config).sort();
  const expectedKeys = ["conduitOrigin", "registryOrigin", "schemaVersion"];
  if (keys.length !== expectedKeys.length || keys.some((value, index) => value !== expectedKeys[index])) {
    throw new Error("managed service config must contain exactly schemaVersion, registryOrigin, and conduitOrigin");
  }
  if (config.schemaVersion !== 1) {
    throw new Error("managed service config schemaVersion must be 1");
  }
  if (config.registryOrigin !== expectedRegistryOrigin) {
    throw new Error("managed service config registryOrigin does not match the protected release value");
  }
  if (config.conduitOrigin !== expectedConduitOrigin) {
    throw new Error("managed service config conduitOrigin does not match the protected release value");
  }
  return Object.freeze({
    schemaVersion: 1,
    registryOrigin: expectedRegistryOrigin,
    conduitOrigin: expectedConduitOrigin,
  });
}

function main() {
  const [file] = process.argv.slice(2);
  if (!file) {
    throw new Error("Usage: node scripts/verify-managed-service-config.mjs <helmryth-service-config.json>");
  }
  const verified = verifyManagedServiceConfig(readFileSync(file, "utf8"));
  console.log(
    `Verified managed service config ${verified.registryOrigin} / ${verified.conduitOrigin} in ${file}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
