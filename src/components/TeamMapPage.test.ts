import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { operationsMapCounts, operationsMapTiles } from "./TeamMapPage";

describe("Operations map status counts", () => {
  it("classifies contradictory busy activity through the same precedence as operator status", () => {
    const counts = operationsMapCounts([
      { id: "gate", name: "Gate", busy: true, activity: "waiting-on-you" },
      { id: "lost", name: "Lost", busy: true, activity: "no-signal" },
      { id: "dead", name: "Dead", busy: true, activity: "dead" },
      { id: "active", name: "Active", activity: "working" },
      { id: "busy", name: "Busy", busy: true, activity: "idle" },
      { id: "ready", name: "Ready", activity: "idle" },
    ]);

    expect(counts).toEqual({
      operators: 6,
      working: 2,
      atGates: 1,
      noSignal: 2,
      ready: 1,
    });
    expect(counts.working + counts.atGates + counts.noSignal + counts.ready).toBe(counts.operators);
  });

  it("moves an active operator into exactly one gate count while approval is open", () => {
    const operator = { id: "asker", name: "Asker", busy: true, activity: "working" as const };
    expect(operationsMapCounts([operator])).toMatchObject({ working: 1, atGates: 0 });

    const waiting = { ...operator, activity: "waiting-on-you" as const };
    const counts = operationsMapCounts([waiting]);
    expect(counts).toEqual({ operators: 1, working: 0, atGates: 1, noSignal: 0, ready: 0 });
  });
});

describe("Operations map header tiles", () => {
  it("renders every classification the counter produces", () => {
    const counts = operationsMapCounts([
      { id: "a", name: "A", busy: true, activity: "working" },
      { id: "b", name: "B", busy: true, activity: "waiting-on-you" },
      { id: "c", name: "C", activity: "no-signal" },
      { id: "d", name: "D", activity: "idle" },
    ]);
    const tiles = operationsMapTiles(counts);

    expect(tiles.map(([, label]) => label)).toEqual([
      "Operators",
      "Working",
      "At gates",
      "No signal",
      "Ready",
    ]);
    // The row has to add up: a tally that shows a total and only part of its
    // parts reads as if the missing operators were never there.
    const [[total], ...parts] = tiles;
    expect(parts.reduce((sum, [value]) => sum + value, 0)).toBe(total);
  });
});

describe("Reduced-motion busy state", () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../styles.css"),
    "utf8",
  );
  const reducedMotionBlocks = css.split("@media (prefers-reduced-motion: reduce) {");

  it("replaces the frozen spinner arc with a static ring instead of nothing", () => {
    // `animation: none` alone leaves every loading icon as a three-quarter arc
    // stopped at an arbitrary angle — a meaningless glyph where the only
    // progress feedback used to be.
    const spinnerBlock = reducedMotionBlocks.find((block) => block.includes("svg.animate-spin"));

    expect(spinnerBlock).toBeDefined();
    expect(spinnerBlock).toMatch(/svg\.animate-spin\s*\{[^}]*border:[^}]*currentColor/);
    expect(spinnerBlock).toMatch(/svg\.animate-spin\s*>\s*\*\s*\{[^}]*display:\s*none/);
  });
});
