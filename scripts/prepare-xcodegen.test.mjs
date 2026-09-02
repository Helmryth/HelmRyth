import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("./prepare-xcodegen.sh", import.meta.url), "utf8");
const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const releaseWorkflow = readFileSync(new URL("../.github/workflows/release-ios.yml", import.meta.url), "utf8");
const iosReadme = readFileSync(new URL("../ios/README.md", import.meta.url), "utf8");
const iosTesting = readFileSync(new URL("../ios/TESTING.md", import.meta.url), "utf8");
const iosProject = readFileSync(new URL("../ios/project.yml", import.meta.url), "utf8");
const iosRelease = readFileSync(new URL("../ios/AppStore/RELEASE.md", import.meta.url), "utf8");
const iosCompanion = readFileSync(new URL("../docs/ios-companion.md", import.meta.url), "utf8");

function captured(name) {
  const match = script.match(new RegExp(`^${name}="([^"]+)"$`, "m"));
  if (!match) throw new Error(`could not find ${name} in prepare-xcodegen.sh`);
  return match[1];
}

describe("pinned xcodegen bootstrap", () => {
  it("pins the official release version, URL, and both digests", () => {
    expect(captured("XCODEGEN_VERSION")).toBe("2.46.0");
    expect(captured("XCODEGEN_ARCHIVE")).toBe("xcodegen.zip");
    expect(captured("XCODEGEN_ARCHIVE_SHA256")).toBe(
      "4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806",
    );
    expect(captured("XCODEGEN_BINARY_SHA256")).toBe(
      "8774da746668bc18fe74e54cbaf10f2631a1fb05947cd374179aa912f14f99db",
    );
    expect(captured("XCODEGEN_URL")).toBe(
      "https://github.com/yonaskolb/XcodeGen/releases/download/${XCODEGEN_VERSION}/${XCODEGEN_ARCHIVE}",
    );
  });

  it("accepts only the documented CLI modes", () => {
    expect(script).toContain("Usage: scripts/prepare-xcodegen.sh [--print-bin | --run <xcodegen args...>]");
    expect(script).toContain("--print-bin)");
    expect(script).toContain("--run)");
  });

  it("removes mutable brew installs from the macOS CI and release lanes", () => {
    expect(ciWorkflow).not.toContain("brew install xcodegen");
    expect(releaseWorkflow).not.toContain("brew install xcodegen");
    expect(ciWorkflow).toContain("../scripts/prepare-xcodegen.sh --run generate");
    expect(releaseWorkflow).toContain("../scripts/prepare-xcodegen.sh --run generate");
  });

  it("keeps every iOS setup document on the pinned bootstrap path", () => {
    for (const doc of [iosReadme, iosTesting, iosProject, iosRelease, iosCompanion]) {
      expect(doc).toContain("../scripts/prepare-xcodegen.sh --run generate");
      expect(doc).not.toContain("brew install xcodegen");
    }
  });
});
