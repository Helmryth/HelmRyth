// The registry and the stylesheet are two halves of one contract: a skin listed
// here without a matching CSS block renders as whatever was active before, with
// no error anywhere. That failure is silent, so it gets a test.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SKIN, LEGACY_SKIN_IDS, SKINS, SKIN_IDS, readSkin } from "./skins";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../styles.css"),
  "utf8",
);

const blocks = new Set(
  [...css.matchAll(/\[data-skin="([a-z-]+)"\]/g)].map(([, id]) => id),
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("skins", () => {
  it("gives every registered skin a stylesheet block", () => {
    for (const id of SKIN_IDS) expect(blocks).toContain(id);
  });

  it("registers only the public stylesheet block", () => {
    for (const id of blocks) expect(SKIN_IDS.some((candidate) => candidate === id)).toBe(true);
  });

  it("defines the same tokens in every skin", () => {
    const tokensOf = (id: string) => {
      const selector = `[data-skin="${id}"]`;
      const start = css.indexOf(selector);
      if (start < 0) return new Set<string>();
      const open = css.indexOf("{", start);
      const close = css.indexOf("}", open);
      const body = open >= 0 && close >= 0 ? css.slice(open + 1, close) : "";
      return new Set([...body.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name));
    };
    const reference = tokensOf(DEFAULT_SKIN);
    expect(reference.size).toBeGreaterThan(15);
    for (const id of SKIN_IDS) {
      expect([...reference].filter((t) => !tokensOf(id).has(t))).toEqual([]);
    }
  });

  it("describes each skin exactly once", () => {
    expect(SKINS.map((s) => s.id)).toEqual([DEFAULT_SKIN]);
    for (const skin of SKINS) {
      expect(skin.name.length).toBeGreaterThan(0);
      expect(skin.tagline.length).toBeGreaterThan(0);
    }
  });

  it("migrates every legacy stored skin from either persistence key", () => {
    for (const sourceKey of ["helmryth-skin", "omb-skin"]) {
      for (const legacy of LEGACY_SKIN_IDS) {
        const store = {
          getItem: (key: string) => (key === sourceKey ? legacy : null),
          setItem: vi.fn(),
          removeItem: vi.fn(),
        };
        vi.stubGlobal("localStorage", store);
        expect(readSkin()).toBe(DEFAULT_SKIN);
      }
    }
  });
});
