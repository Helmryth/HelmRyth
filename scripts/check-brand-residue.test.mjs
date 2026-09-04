import { join, sep, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import {
  copyFindings,
  identityFindings,
  migrationContractFindings,
  repoRelative,
  SELF_NAME,
  shouldSkipDirectory,
  toPosixPath,
} from "./check-brand-residue.mjs";

// The strings these cases feed the gate are the very ones it must reject, so
// they are stored encoded rather than written out — this file ships, and a
// plaintext fixture would put the retired identity back into the repository
// through the test that exists to keep it out.
const retired = (encoded) => Buffer.from(encoded, "base64").toString("utf8");


describe("brand residue gate scope", () => {
  it("ignores generated, dependency, and vendored directory names", () => {
    for (const name of [".build", ".next", "dist", "node_modules", "release", "vendor"]) {
      expect(shouldSkipDirectory(name), name).toBe(true);
    }
    expect(shouldSkipDirectory("components")).toBe(false);
  });

  it("reads build/ and tools/, which ship real source, rather than skipping them", () => {
    // `build/` is NOT generated output. It holds the app icons,
    // entitlements.mac.plist, and linux-after-install.sh that electron-builder.yml
    // reads at package time, which is why .gitignore deliberately does not ignore
    // it. Skipping it here left those files — plus the 19-file oxlint plugin under
    // tools/ — with zero brand coverage in a gate that runs on every release.
    expect(shouldSkipDirectory("build")).toBe(false);
    expect(shouldSkipDirectory("tools")).toBe(false);
  });

  it("skips local agent tooling state, which is gitignored and machine-specific", () => {
    // .omc/ session caches embed this machine's absolute project path, which the
    // old-product-name pattern matches. Scanning them fails the gate on files that
    // exist for exactly one developer and never ship.
    expect(shouldSkipDirectory(".omc")).toBe(true);
  });

  it("does not inspect test fixtures as public product identity", () => {
    expect(identityFindings("src/lib/example.test.ts", [retired("Y29uc3QgdG9rZW4gPSAib21iX3BhaXJfb2xkIjs=")])).toEqual([]);
    expect(copyFindings("ios/Tests/FleetTests.swift", ['let role = "bot"', 'let copy = "Create a bot"'])).toEqual([]);
  });

  it("allows only exact internal compatibility vocabulary in QA specs", () => {
    expect(copyFindings("docs/qa/07-api.md", [
      "Exercise bot, bots, botId, /api/bots, and per-bot compatibility.",
      "Expect buffered assistant text after the capability record.",
    ])).toEqual([]);
  });

  it("still rejects banned marketing copy in QA specs", () => {
    const findings = copyFindings("docs/qa/07-api.md", [
      "Unlock the power of the bot assistant.",
      "Our magical AI-powered copilot will supercharge productivity.",
    ]);

    expect(findings.map((finding) => finding.label)).toEqual([
      "visible copy: assistant",
      "visible copy: unlock",
      "visible copy: copilot",
      "visible copy: AI-powered",
      "visible copy: supercharge",
      "visible copy: magic",
    ]);
  });

  it("still scans QA specs for inherited product identity", () => {
    expect(identityFindings("docs/qa/07-api.md", [retired("RG93bmxvYWQgT3Blbk1hdXNCb3Q=")])).toMatchObject([
      { label: "old product name" },
    ]);
    expect(identityFindings("docs/qa/14-execution.md", [
      retired("UmVsZWFzZSBmcm9tIGh0dHBzOi8vZ2l0aHViLmNvbS9taWxpbmQtc29uaS9oZWxtcnl0aC1yZWxlYXNlcw=="),
    ])).toMatchObject([
      { label: "previous-owner runtime destination" },
    ]);
  });

  it("scans our own metadata under third_party/ while retaining legal text verbatim", () => {
    // The exemption used to match the `third_party` path SEGMENT, so the whole
    // tree went unread. A stale SBOM property namespace and a stale
    // env var instruction both survived a rebrand the gate called
    // clean, and the stale namespace broke verify-linux-package.mjs, which
    // looks up `helmryth:cargo:package-id`.
    expect(identityFindings("third_party/cua-driver/SBOM.cdx.json", [
      retired("eyAibmFtZSI6ICJvcGVubWF1c2JvdDpjYXJnbzpwYWNrYWdlLWlkIiwgInZhbHVlIjogInJlZ2lzdHJ5K3giIH0="),
    ])).toMatchObject([{ label: "old product name" }]);
    expect(identityFindings("third_party/cloudflared/README.md", [
      retired("U2V0IGBPTUJfQ0xPVURGTEFSRURfQVJDSElWRV9ESVJgIHRvIGEgZGlyZWN0b3J5IGNvbnRhaW5pbmc="),
    ])).toMatchObject([{ label: "old environment namespace" }]);

    // Retained legal text stays exempt — it is matched by file name, not by
    // any directory it happens to sit in.
    for (const legal of [
      "NOTICE",
      "LICENSE",
      "LEGAL_PROVENANCE.md",
      "third_party/cua-driver/LICENSE.md",
      "third_party/cua-driver/THIRD_PARTY_NOTICES.md",
      "third_party/cua-driver/THIRD_PARTY_LICENSES.html",
      "third_party/cua-driver/Inter-OFL-1.1.txt",
      "third_party/playwright-injected/LICENSE",
    ]) {
      expect(identityFindings(legal, [retired("Q29weXJpZ2h0IDIwMjYgTWlsaW5kIFNvbmkgYW5kIE9wZW5NYXVzQm90IGNvbnRyaWJ1dG9ycw==")]), legal).toEqual([]);
    }

    // Vendored upstream source keeps our identity rules but not our copy rules.
    expect(copyFindings("third_party/playwright-injected/src/roleUtils.ts", ['const role = "bot";'])).toEqual([]);
  });

  it("catches a personal mail-provider address in shipped source", () => {
    // The real instance this rule was written for: scripts/film/drive.mjs held
    // a consumer gmail address as the identity TYPED INTO the onboarding form
    // during a shoot, so it was legible in the published film and in the loop
    // cut from it — not merely present in the source.
    expect(identityFindings("scripts/film/drive.mjs", [
      'export const IDENTITY = { name: "A", email: "someone@gmail.com" };',
    ])).toMatchObject([{ label: "personal contact address" }]);

    // Reserved documentation domains are what the other 85 addresses in this
    // repository use, and a third-party author's address in a vendored licence
    // is attribution rather than a leak. Neither may be flagged.
    for (const allowed of [
      'const a = "ada@example.com";',
      'const b = "noreply@helmryth.test";',
      'const c = "secret@conduit.example";',
      'const d = "you@x.dev";',
    ]) {
      expect(identityFindings("scripts/film/drive.mjs", [allowed]), allowed).toEqual([]);
    }
  });

  it("still catches actual public legacy identity and previous-owner destinations", () => {
    expect(identityFindings("README.md", [retired("RG93bmxvYWQgT3Blbk1hdXNCb3QgdG9kYXk=")])).toMatchObject([
      { label: "old product name" },
    ]);
    expect(identityFindings("docs/releasing.md", [retired("aHR0cHM6Ly9naXRodWIuY29tL21pbGluZC1zb25pL2hlbG1yeXRoLXJlbGVhc2Vz")])).toMatchObject([
      { label: "previous-owner runtime destination" },
    ]);
  });

  it("checks human prose while ignoring fenced and inline internal API examples", () => {
    expect(copyFindings("docs/api.md", ["Use `/api/bots` for compatibility."])).toEqual([]);
    expect(copyFindings("docs/api.md", ["```http", "GET /api/bots", "```"])).toEqual([]);
    expect(copyFindings("docs/api.md", ["Create a bot for each project."])).toMatchObject([
      { label: "visible copy: bot" },
    ]);
  });

  it("ignores stable internal literals but catches a rendered sentence", () => {
    expect(copyFindings("src/components/Panel.tsx", ['const route = "/api/bots";', 'const role = "bot";'])).toEqual([]);
    expect(copyFindings("src/components/Panel.tsx", ['const title = "Create a bot";'])).toMatchObject([
      { label: "visible copy: bot" },
    ]);
  });

  it("removes Swift interpolation identifiers without hiding surrounding copy", () => {
    expect(copyFindings("ios/App/Avatar.swift", ['Text("\\(bot.name) mark")'])).toEqual([]);
    expect(copyFindings("ios/App/Avatar.swift", ['Text("Bot \\(bot.name) is ready")'])).toMatchObject([
      { label: "visible copy: bot" },
    ]);
  });

  it("distinguishes a physical unlock instruction from AI-slop marketing copy", () => {
    expect(copyFindings("src/components/Phone.tsx", ['const help = "Unlock the Android device";'])).toEqual([]);
    expect(copyFindings("README.md", ["Unlock the power of autonomous work."])).toMatchObject([
      { label: "visible copy: unlock" },
    ]);
  });
});

describe("brand residue migration contracts", () => {
  const canonicalSkinMigration = [
    'const KEY = "helmryth-skin";',
    'const LEGACY_KEY = "omb-skin";',
    "store?.setItem(KEY, normalized);",
    "store?.removeItem(LEGACY_KEY);",
  ].join("\n");

  it("allows an exact, named legacy alias when canonical writes and cleanup are proven", () => {
    expect(identityFindings("src/lib/skins.ts", canonicalSkinMigration.split("\n"))).toEqual([]);
    expect(migrationContractFindings(new Map([["src/lib/skins.ts", canonicalSkinMigration]]))).toEqual([]);
  });

  it("fails a named alias when the canonical migration is incomplete", () => {
    const findings = migrationContractFindings(new Map([
      ["src/lib/skins.ts", 'const LEGACY_KEY = "omb-skin";'],
    ]));
    expect(findings.some((finding) => finding.label === "incomplete legacy migration")).toBe(true);
  });

  it("fails when a migration writes the inherited key", () => {
    const findings = migrationContractFindings(new Map([
      ["src/lib/skins.ts", `${canonicalSkinMigration}\nstore?.setItem(LEGACY_KEY, normalized);`],
    ]));
    expect(findings).toMatchObject([{ label: "legacy value is still written" }]);
  });

  it("does not treat an unlisted inherited key as compatibility", () => {
    expect(identityFindings("src/lib/cache.ts", ['const KEY = "omb-cache";'])).toMatchObject([
      { label: "old short prefix" },
    ]);
  });
});

describe("path spelling", () => {
  it("spells a platform path the way every exemption in the gate is written", () => {
    // Built from `sep` so the assertion is about the platform running it, not
    // about a forward slash that POSIX would have produced anyway.
    expect(toPosixPath(["docs", "qa", "01-desktop-shell.md"].join(sep))).toBe("docs/qa/01-desktop-shell.md");
    expect(repoRelative(join(sep, "repo"), join(sep, "repo", "scripts", "gate.mjs"))).toBe("scripts/gate.mjs");

    // The failing case was Windows-only, so assert it explicitly rather than
    // wait for a Windows runner: a backslash path is the one this gate got
    // wrong, and it must normalise on the machine running these tests too.
    expect(toPosixPath("scripts\\check-brand-residue.mjs", win32.sep)).toBe("scripts/check-brand-residue.mjs");
    expect(toPosixPath("docs\\qa\\01-desktop-shell.md", win32.sep)).toBe("docs/qa/01-desktop-shell.md");
  });

  it("exempts its own source under the name the scan produces for it", () => {
    // The regression this pins: the scanned name was normalised and SELF_NAME
    // was not, so on Windows `name === SELF_NAME` never held, the gate read its
    // own detection patterns and reported sixteen findings against itself on
    // every CI run. Both sides go through one helper now.
    expect(SELF_NAME).toBe("scripts/check-brand-residue.mjs");

    // The same bytes under two names: exempt as this file, a finding as any
    // other. Without the second half the first proves only that nothing fires.
    const line = retired("RG93bmxvYWQgT3Blbk1hdXNCb3Q=");
    expect(identityFindings(SELF_NAME, [line])).toEqual([]);
    expect(identityFindings("scripts/some-other-gate.mjs", [line])).toMatchObject([
      { label: "old product name" },
    ]);
  });
});
