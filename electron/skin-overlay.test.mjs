import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { SKIN_CHROME, DEFAULT_SKIN, skinChrome, isKnownSkin } = require("./skin-overlay.cjs");

describe("native Helmryth chrome", () => {
  it("markets exactly one light-first identity", () => {
    expect(DEFAULT_SKIN).toBe("helmryth");
    expect(SKIN_CHROME).toEqual({
      helmryth: { color: "#f6f1e7", symbolColor: "#526071" },
    });
  });

  it("uses opaque colours accepted by the Windows overlay", () => {
    expect(SKIN_CHROME.helmryth.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(SKIN_CHROME.helmryth.symbolColor).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("decodes inherited ids without re-exposing their themes", () => {
    for (const legacy of ["midnight", "atelier", "foundry", "lagoon"]) {
      expect(isKnownSkin(legacy)).toBe(true);
      expect(skinChrome(legacy)).toEqual(SKIN_CHROME.helmryth);
    }
  });

  it("falls back to Helmryth for unknown input without accepting it", () => {
    expect(isKnownSkin("helmryth")).toBe(true);
    expect(isKnownSkin("does-not-exist")).toBe(false);
    expect(isKnownSkin(undefined)).toBe(false);
    expect(isKnownSkin(42)).toBe(false);
    expect(skinChrome("does-not-exist")).toEqual(SKIN_CHROME.helmryth);
    expect(skinChrome(null)).toEqual(SKIN_CHROME.helmryth);
  });
});
