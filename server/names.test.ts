import { describe, expect, it } from "vitest";

import { pickOperatorName } from "./names.ts";

describe("pickOperatorName", () => {
  it("anchors a new installation with Rivet and advances deterministically", () => {
    expect(pickOperatorName([])).toBe("Rivet");
    expect(pickOperatorName([" Rivet "])).toBe("Cairn");
    expect(pickOperatorName(["rIvEt", "CAIRN"])).toBe("Vesper");
  });

  it("uses stable numeric suffixes after the native roster is exhausted", () => {
    const roster = [
      "Rivet", "Cairn", "Vesper", "Tiller", "Caliper", "Meridian", "Gimbal", "Keel",
      "Plumb", "Sextant", "Trestle", "Pylon", "Fathom", "Spline", "Yoke", "Ferrule",
      "Capstan", "Bezel", "Dovetail", "Ledger", "Waymark", "Kiln", "Lattice", "Verge",
      "Torsion", "Fulcrum", "Quoin", "Datum", "Strake", "Boreal", "Palisade", "Cordage",
    ];
    expect(pickOperatorName(roster)).toBe("Rivet 2");
    expect(pickOperatorName([...roster, "Rivet 2"])).toBe("Cairn 2");
  });

  it("contains none of the inherited pet, food, or generic agent names", () => {
    const inherited = new Set(["scout", "atlas", "nova", "sage", "pixel", "pesto", "miso", "mochi"]);
    const generated: string[] = [];
    for (let index = 0; index < 32; index += 1) generated.push(pickOperatorName(generated));
    expect(generated.some((name) => inherited.has(name.toLowerCase()))).toBe(false);
  });
});
