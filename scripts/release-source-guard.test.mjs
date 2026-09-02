import { describe, expect, it, vi } from "vitest";

import { verifyReleaseSourcePolicy } from "./release-source-guard.mjs";

describe("release source guard", () => {
  it("allows any exact ref whose commit is reachable from protected main", () => {
    expect(
      verifyReleaseSourcePolicy({
        requestedRef: "4c9b47d",
        defaultRef: "refs/heads/main",
        resolveCommit: () => "abc123",
        isAncestorOfMain: () => true,
        verifySignedTag: vi.fn(),
      }),
    ).toEqual({
      mode: "protected-main",
      ref: "4c9b47d",
      sha: "abc123",
    });
  });

  it("rejects free-form refs that are outside protected main and not approved tags", () => {
    expect(() =>
      verifyReleaseSourcePolicy({
        requestedRef: "refs/heads/feature/release-me",
        defaultRef: "refs/heads/main",
        resolveCommit: () => "abc123",
        isAncestorOfMain: () => false,
        verifySignedTag: vi.fn(),
      }),
    ).toThrow(/protected main/);
  });

  it("allows approved signed release tags outside protected main", () => {
    const verifySignedTag = vi.fn(() => "abc123");
    expect(
      verifyReleaseSourcePolicy({
        requestedRef: "refs/tags/v1.2.3",
        defaultRef: "refs/heads/main",
        resolveCommit: () => "abc123",
        isAncestorOfMain: () => false,
        verifySignedTag,
      }),
    ).toEqual({
      mode: "signed-tag",
      ref: "refs/tags/v1.2.3",
      sha: "abc123",
      tag: "v1.2.3",
    });
    expect(verifySignedTag).toHaveBeenCalledWith("v1.2.3");
  });

  it("rejects signed tags that do not match the requested commit", () => {
    expect(() =>
      verifyReleaseSourcePolicy({
        requestedRef: "v1.2.3",
        defaultRef: "refs/heads/main",
        resolveCommit: () => "abc123",
        isAncestorOfMain: () => false,
        verifySignedTag: () => "def456",
      }),
    ).toThrow(/does not resolve/);
  });
});
