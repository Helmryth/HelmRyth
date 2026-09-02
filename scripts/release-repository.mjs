import path from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;

export function parseReleaseRepository(value) {
  if (Object.prototype.toString.call(value) !== "[object String]") {
    throw new Error("HELMRYTH_RELEASE_REPO must be an explicit GitHub owner/repo value");
  }
  const input = value.trim();
  if (input !== value || input.includes("://") || input.split("/").length !== 2) {
    throw new Error("HELMRYTH_RELEASE_REPO must use exact owner/repo syntax");
  }
  const [owner, repo] = input.split("/");
  if (!OWNER.test(owner) || !REPOSITORY.test(repo) || repo === "." || repo === ".." || repo.endsWith(".git")) {
    throw new Error("HELMRYTH_RELEASE_REPO contains an invalid GitHub owner or repository name");
  }
  return Object.freeze({ owner, repo, slug: input });
}

function checkEnvironment() {
  const destination = parseReleaseRepository(process.env.HELMRYTH_RELEASE_REPO);
  console.log(`Release repository verified: ${destination.slug}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== "--check") {
    console.error("Usage: HELMRYTH_RELEASE_REPO=owner/repo node scripts/release-repository.mjs --check");
    process.exitCode = 2;
  } else {
    try {
      checkEnvironment();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
