import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowserWorkbenchUnavailable } from "./BrowserPanel";
import {
  browserWorkbenchAvailability,
  readStoredWorkbenchPanelWidth,
  workbenchPanelLayout,
  workbenchPanelWidthAfterDrag,
  workbenchPanelWidthAfterKey,
} from "./ComputerPanel";

describe("Browser Workbench availability", () => {
  it("keeps the Browser tab reachable as a truthful unavailable state outside Desktop", () => {
    expect(browserWorkbenchAvailability(undefined, undefined, false)).toBe("unavailable");

    const markup = renderToStaticMarkup(createElement(BrowserWorkbenchUnavailable));
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Open Helmryth Desktop to use the Browser Workbench");
  });

  it("hides the Browser tab when the system or operator setting disables it", () => {
    expect(browserWorkbenchAvailability({ features: { browser: false } }, true, true)).toBe("hidden");
    expect(browserWorkbenchAvailability({ features: { browser: true } }, false, true)).toBe("hidden");
  });

  it("marks an enabled native bridge as available", () => {
    expect(browserWorkbenchAvailability({ features: { browser: true } }, true, true)).toBe("available");
  });
});

describe("Workbench panel responsive width contract", () => {
  it("uses a full-width, non-resizable overlay at 390px without horizontal overflow", () => {
    expect(workbenchPanelLayout(390, 960)).toEqual({
      mode: "full",
      width: 390,
      minWidth: 390,
      maxWidth: 390,
      resizable: false,
    });
  });

  it("uses an overlay at 768px so the workstream does not collapse", () => {
    expect(workbenchPanelLayout(768, 400)).toEqual({
      mode: "overlay",
      width: 400,
      minWidth: 360,
      maxWidth: 720,
      resizable: true,
    });
  });

  it("reserves a readable workstream at 1440px and permits 960px on large displays", () => {
    expect(workbenchPanelLayout(1440, 960)).toEqual({
      mode: "dock",
      width: 600,
      minWidth: 360,
      maxWidth: 600,
      resizable: true,
    });
    expect(workbenchPanelLayout(1920, 960)).toEqual({
      mode: "dock",
      width: 960,
      minWidth: 360,
      maxWidth: 960,
      resizable: true,
    });
  });

  it("clamps oversized and undersized persisted preferences before applying the viewport limit", () => {
    const oversized = { getItem: () => "2000" };
    const undersized = { getItem: () => "20" };
    expect(readStoredWorkbenchPanelWidth(oversized)).toBe(960);
    expect(readStoredWorkbenchPanelWidth(undersized)).toBe(360);
    expect(workbenchPanelLayout(1440, readStoredWorkbenchPanelWidth(oversized)).width).toBe(600);
  });

  it("clamps pointer resizing to the current layout bounds", () => {
    expect(workbenchPanelWidthAfterDrag(400, 500, 0, 1440)).toBe(600);
    expect(workbenchPanelWidthAfterDrag(400, 500, 1000, 1440)).toBe(360);
    expect(workbenchPanelWidthAfterDrag(400, 500, 0, 768)).toBe(720);
    expect(workbenchPanelWidthAfterDrag(400, 500, 0, 390)).toBe(390);
  });

  it("clamps keyboard resizing and reports unhandled keys", () => {
    expect(workbenchPanelWidthAfterKey(590, "ArrowLeft", 1440)).toBe(600);
    expect(workbenchPanelWidthAfterKey(370, "ArrowRight", 1440)).toBe(360);
    expect(workbenchPanelWidthAfterKey(500, "Home", 1440)).toBe(360);
    expect(workbenchPanelWidthAfterKey(500, "End", 1440)).toBe(600);
    expect(workbenchPanelWidthAfterKey(500, "Enter", 1440)).toBeNull();
  });
});
