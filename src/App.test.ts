import { describe, expect, it, vi } from "vitest";

import {
  focusWorkbenchLauncher,
  mobileRosterCloseSignal,
  MOBILE_ROSTER_TRIGGER_CLASS,
  WORKBENCH_LAUNCHER_SELECTOR,
} from "./App";
import { syncModalBoundary } from "@/lib/modal-boundary";

describe("syncModalBoundary", () => {
  it("applies inert only while a modal gate is active", () => {
    const node = {
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
    };

    syncModalBoundary(node, true);
    expect(node.setAttribute).toHaveBeenCalledWith("inert", "");
    expect(node.removeAttribute).not.toHaveBeenCalled();

    syncModalBoundary(node, false);
    expect(node.removeAttribute).toHaveBeenCalledWith("inert");
  });
});

describe("Workbench panel focus lifecycle", () => {
  it("returns focus to the stable Workbench launcher after an explicit panel close", () => {
    const launcher = { focus: vi.fn() };
    const querySelector = vi.fn(() => launcher);

    expect(focusWorkbenchLauncher(querySelector)).toBe(true);
    expect(querySelector).toHaveBeenCalledWith(WORKBENCH_LAUNCHER_SELECTOR);
    expect(launcher.focus).toHaveBeenCalledOnce();
  });

  it("fails safely when the current surface has no Workbench launcher", () => {
    const querySelector = vi.fn(() => null);

    expect(focusWorkbenchLauncher(querySelector)).toBe(false);
  });
});

describe("mobile roster access", () => {
  it("keeps the mobile roster trigger at a complete 44px touch target", () => {
    const classes = MOBILE_ROSTER_TRIGGER_CLASS.split(" ");

    expect(classes).toEqual(expect.arrayContaining(["size-11", "md:hidden"]));
    expect(classes).not.toContain("p-1.5");
  });

  it("closes for every shell transition that can cover the mobile roster", () => {
    const baseline = {
      selectedId: "operator-a",
      activeView: "chat" as const,
      pluginsOpen: false,
      settingsOpen: false,
      appSettingsOpen: false,
      inspectorOpen: false,
      computerOpen: false,
    };
    const initial = mobileRosterCloseSignal(baseline);

    for (const overlay of [
      "pluginsOpen",
      "settingsOpen",
      "appSettingsOpen",
      "inspectorOpen",
      "computerOpen",
    ] as const) {
      expect(mobileRosterCloseSignal({ ...baseline, [overlay]: true })).not.toBe(initial);
    }
    expect(mobileRosterCloseSignal({ ...baseline, selectedId: "operator-b" })).not.toBe(initial);
    expect(mobileRosterCloseSignal({ ...baseline, activeView: "routines" })).not.toBe(initial);
  });
});
