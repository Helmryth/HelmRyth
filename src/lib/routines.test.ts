import { describe, expect, it } from "vitest";

import { routineRunLocationLabel, type RoutineRunOn } from "./routines";

describe("cadence run location vocabulary", () => {
  it.each([
    ["local", "Local workbench"],
    ["cloud", "Hosted workbench"],
  ] satisfies Array<[RoutineRunOn, string]>)("labels %s without exposing infrastructure terms", (runOn, label) => {
    expect(routineRunLocationLabel(runOn)).toBe(label);
    expect(label).not.toMatch(/\b(?:VM|Box|computer)\b/i);
  });
});
