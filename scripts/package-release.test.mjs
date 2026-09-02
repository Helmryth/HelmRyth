import { describe, expect, it } from "vitest";

import { releaseBuildSteps } from "./package-release.mjs";

describe("release packaging plan", () => {
  it("stages the signed macOS helpers and native control runtime", () => {
    expect(releaseBuildSteps({ target: "mac", offline: false })).toEqual([
      ["package:prepare"],
      ["build:speech"],
      ["build:recorder"],
      ["build:cua"],
    ]);
  });

  it("keeps Windows preparation dependency-only", () => {
    expect(releaseBuildSteps({ target: "win", offline: false })).toEqual([
      ["package:prepare"],
    ]);
  });

  it("selects the exact requested Linux CUA stage", () => {
    expect(releaseBuildSteps({ target: "linux", offline: false })).toEqual([
      ["package:prepare"],
      ["build:cua:linux"],
    ]);
    expect(releaseBuildSteps({ target: "linux", offline: true })).toEqual([
      ["package:prepare"],
      ["build:cua:linux:offline"],
    ]);
  });
});
