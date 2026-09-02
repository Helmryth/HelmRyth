import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { parsePublisherNames, parseReleaseRepository } from "./release-builder-config.mjs";

function normalizedPublisherNames(value) {
  if (Object.prototype.toString.call(value) === "[object String]") {
    const exact = value.trim();
    return exact ? [exact] : [];
  }
  if (Array.isArray(value)) {
    return value
      .filter((entry) => Object.prototype.toString.call(entry) === "[object String]")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

export function verifyUpdateTarget(
  configText,
  releaseRepository,
  { unsigned = false, signedPublisherNames = [] } = {},
) {
  const expected = parseReleaseRepository(releaseRepository);
  const config = YAML.parse(configText);
  if (!config || Object.prototype.toString.call(config) !== "[object Object]") {
    throw new Error("app-update.yml must contain one configuration object");
  }
  if (config.provider !== "github" || config.owner !== expected.owner || config.repo !== expected.repo) {
    throw new Error(`app-update.yml does not target ${expected.slug}`);
  }
  if (unsigned && Object.hasOwn(config, "publisherName")) {
    throw new Error("Unsigned app-update.yml must not contain publisherName");
  }
  if (signedPublisherNames.length) {
    const actual = normalizedPublisherNames(config.publisherName);
    if (!actual.length) {
      throw new Error("Signed app-update.yml must declare publisherName");
    }
    if (
      actual.length !== signedPublisherNames.length ||
      actual.some((value, index) => value !== signedPublisherNames[index])
    ) {
      throw new Error("app-update.yml publisherName does not match the protected Windows publisher identity");
    }
  }
  return expected;
}

function main() {
  const args = process.argv.slice(2);
  const unsigned = args.includes("--unsigned");
  const signed = args.includes("--signed");
  if (unsigned && signed) {
    throw new Error("Choose either --unsigned or --signed when verifying app-update.yml");
  }
  const files = args.filter((argument) => argument !== "--unsigned" && argument !== "--signed");
  if (files.length !== 1) {
    throw new Error("Usage: node scripts/verify-update-target.mjs <app-update.yml> [--unsigned|--signed]");
  }
  const expected = verifyUpdateTarget(
    readFileSync(files[0], "utf8"),
    process.env.HELMRYTH_RELEASE_REPO,
    {
      unsigned,
      signedPublisherNames: signed ? parsePublisherNames(process.env.HELMRYTH_WINDOWS_PUBLISHER_NAME) : [],
    },
  );
  console.log(`Verified update target ${expected.slug} in ${files[0]}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
