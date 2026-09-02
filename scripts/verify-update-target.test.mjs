import { describe, expect, it } from "vitest";

import { verifyUpdateTarget } from "./verify-update-target.mjs";

const valid = `
provider: github
owner: helmryth-labs
repo: releases
updaterCacheDirName: helmryth-updater
`;

describe("packaged update target verification", () => {
  it("accepts only the exact configured repository", () => {
    expect(verifyUpdateTarget(valid, "helmryth-labs/releases")).toEqual({
      owner: "helmryth-labs",
      repo: "releases",
      slug: "helmryth-labs/releases",
    });
    expect(() => verifyUpdateTarget(valid, "other-owner/releases")).toThrow(/does not target/);
    expect(() => verifyUpdateTarget(valid, "helmryth-labs/other-repo")).toThrow(/does not target/);
  });

  it("rejects non-GitHub and malformed update documents", () => {
    expect(() => verifyUpdateTarget("provider: generic\nurl: https://updates.example", "owner/repo")).toThrow(
      /does not target/,
    );
    expect(() => verifyUpdateTarget("- github", "owner/repo")).toThrow(/configuration object/);
  });

  it("rejects publisher identity on an explicitly unsigned build", () => {
    expect(() => verifyUpdateTarget(`${valid}publisherName: Example Corp\n`, "helmryth-labs/releases", { unsigned: true })).toThrow(
      /publisherName/,
    );
    expect(() => verifyUpdateTarget(valid, "helmryth-labs/releases", { unsigned: true })).not.toThrow();
  });

  it("requires the exact protected Windows publisher identity on signed release manifests", () => {
    expect(() =>
      verifyUpdateTarget(
        `${valid}publisherName:\n  - Helmryth, Inc.\n`,
        "helmryth-labs/releases",
        { signedPublisherNames: ["Helmryth, Inc."] },
      ),
    ).not.toThrow();
    expect(() =>
      verifyUpdateTarget(valid, "helmryth-labs/releases", { signedPublisherNames: ["Helmryth, Inc."] }),
    ).toThrow(/must declare publisherName/);
    expect(() =>
      verifyUpdateTarget(
        `${valid}publisherName: Another Publisher\n`,
        "helmryth-labs/releases",
        { signedPublisherNames: ["Helmryth, Inc."] },
      ),
    ).toThrow(/does not match/);
  });
});
