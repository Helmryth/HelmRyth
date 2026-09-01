import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { packageUrlFromCommandLine, packageUrlFromDeepLink } from "./package-link.mjs";

describe("Helmryth capability deep links", () => {
  it("accepts a public GitHub package URL", () => {
    const target = "https://raw.githubusercontent.com/acme/capabilities/main/reddit-lead-miner.md";
    assert.equal(packageUrlFromDeepLink(`helmryth://install?url=${encodeURIComponent(target)}`), target);
    assert.equal(packageUrlFromCommandLine(["Helmryth", "--flag", `helmryth://install?url=${encodeURIComponent(target)}`]), target);
  });

  it("rejects other commands, hosts, protocols, credentials, and unsupported file types", () => {
    assert.equal(packageUrlFromDeepLink("helmryth://settings"), null);
    assert.equal(packageUrlFromDeepLink("helmryth://install?url=https://evil.example/capability.json"), null);
    assert.equal(packageUrlFromDeepLink("helmryth://install?url=http://raw.githubusercontent.com/a/b/main/capability.json"), null);
    assert.equal(packageUrlFromDeepLink("helmryth://install?url=https://user@example.com/capability.json"), null);
    assert.equal(packageUrlFromDeepLink("helmryth://install?url=https://github.com/acme/capability/run.sh"), null);
  });
});
