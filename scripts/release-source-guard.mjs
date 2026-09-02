import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPROVED_RELEASE_TAG = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function exactRef(value, fallback) {
  const candidate = value ?? fallback;
  if (Object.prototype.toString.call(candidate) !== "[object String]") {
    throw new Error("Release source must be an exact branch, tag, or commit reference");
  }
  const exact = candidate.trim();
  if (!exact || exact !== candidate || exact.includes("://") || /\s/u.test(exact)) {
    throw new Error("Release source must be an exact branch, tag, or commit reference");
  }
  return exact;
}

function approvedTagName(ref) {
  if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
  if (APPROVED_RELEASE_TAG.test(ref)) return ref;
  return "";
}

function defaultRunner(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function requireSuccess(result, context) {
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(stderr ? `${context}: ${stderr}` : context);
  }
  return (result.stdout ?? "").trim();
}

function createGpgHome(publicKeysArmored) {
  const exact = Object.prototype.toString.call(publicKeysArmored) === "[object String]"
    ? publicKeysArmored.trim()
    : "";
  if (!exact) {
    throw new Error(
      "HELMRYTH_RELEASE_TAG_PUBLIC_KEYS_ASC is required when releasing from a signed tag outside protected main",
    );
  }
  const directory = mkdtempSync(path.join(tmpdir(), "helmryth-tag-keys-"));
  const keyFile = path.join(directory, "trusted-release-tags.asc");
  writeFileSync(keyFile, `${exact}\n`, { mode: 0o600 });
  return {
    directory,
    keyFile,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function verifyReleaseSourcePolicy({
  requestedRef,
  defaultRef,
  resolveCommit,
  isAncestorOfMain,
  verifySignedTag,
}) {
  const ref = exactRef(requestedRef, defaultRef);
  const sha = resolveCommit(ref);
  if (isAncestorOfMain(sha)) {
    return Object.freeze({ mode: "protected-main", ref, sha });
  }
  const tagName = approvedTagName(ref);
  if (!tagName) {
    throw new Error(
      "Release ref must resolve to a commit reachable from protected main or to an approved signed release tag",
    );
  }
  if (!APPROVED_RELEASE_TAG.test(tagName)) {
    throw new Error(`Release tag ${tagName} does not match the approved release-tag format`);
  }
  const tagCommit = verifySignedTag(tagName);
  if (tagCommit !== sha) {
    throw new Error(`Signed release tag ${tagName} does not resolve to the requested commit`);
  }
  return Object.freeze({ mode: "signed-tag", ref, sha, tag: tagName });
}

export function verifyReleaseSource({
  requestedRef = process.argv[2],
  defaultRef = process.env.GITHUB_REF || "HEAD",
  publicKeysArmored = process.env.HELMRYTH_RELEASE_TAG_PUBLIC_KEYS_ASC,
  runner = defaultRunner,
} = {}) {
  return verifyReleaseSourcePolicy({
    requestedRef,
    defaultRef,
    resolveCommit(ref) {
      return requireSuccess(
        runner("git", ["rev-parse", "--verify", `${ref}^{commit}`]),
        `Unable to resolve release ref ${ref}`,
      );
    },
    isAncestorOfMain(sha) {
      return runner("git", ["merge-base", "--is-ancestor", sha, "origin/main"]).status === 0;
    },
    verifySignedTag(tagName) {
      const home = createGpgHome(publicKeysArmored);
      try {
        requireSuccess(
          runner("gpg", ["--batch", "--homedir", home.directory, "--import", home.keyFile]),
          `Unable to import trusted release tag keys for ${tagName}`,
        );
        requireSuccess(
          runner("git", ["tag", "-v", tagName], {
            env: { ...process.env, GNUPGHOME: home.directory },
          }),
          `Signed release tag verification failed for ${tagName}`,
        );
      } finally {
        home.cleanup();
      }
      return requireSuccess(
        runner("git", ["rev-list", "-n", "1", `refs/tags/${tagName}`]),
        `Unable to resolve commit for signed release tag ${tagName}`,
      );
    },
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const verified = verifyReleaseSource();
    const message =
      verified.mode === "protected-main"
        ? `Verified release source ${verified.sha} is reachable from protected main`
        : `Verified signed release tag ${verified.tag} for commit ${verified.sha}`;
    console.log(message);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
