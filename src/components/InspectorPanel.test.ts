import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  cycleInspectorFocus,
  InspectorShell,
  inspectorLayoutModeForWidth,
} from "./InspectorPanel";

describe("InspectorPanel responsive shell", () => {
  it("switches to the overlay layout below the mobile breakpoint", () => {
    expect(inspectorLayoutModeForWidth(390)).toBe("overlay");
    expect(inspectorLayoutModeForWidth(767)).toBe("overlay");
    expect(inspectorLayoutModeForWidth(768)).toBe("dock");
  });

  it("renders a modal overlay shell on mobile", () => {
    const markup = renderToStaticMarkup(
      createElement(
        InspectorShell,
        {
          mode: "overlay",
          titleId: "trace-title",
          panelRef: createRef<HTMLElement>(),
          onClose: vi.fn(),
        },
        createElement("div", null, "Trace body"),
      ),
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("fixed inset-0");
    expect(markup).toContain("w-full max-w-full");
    expect(markup).not.toContain("w-[460px]");
  });

  it("keeps the docked 460px shell on desktop", () => {
    const markup = renderToStaticMarkup(
      createElement(
        InspectorShell,
        {
          mode: "dock",
          titleId: "trace-title",
          panelRef: createRef<HTMLElement>(),
          onClose: vi.fn(),
        },
        createElement("div", null, "Trace body"),
      ),
    );

    expect(markup).toContain("w-[460px]");
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain("fixed inset-0");
  });
});

describe("InspectorPanel focus cycling", () => {
  it("wraps focus within the mobile overlay controls", () => {
    const controls = ["close", "events", "provider", "reload"];

    expect(cycleInspectorFocus(controls, controls[3], false)).toBe("close");
    expect(cycleInspectorFocus(controls, controls[0], true)).toBe("reload");
    expect(cycleInspectorFocus(controls, null, false)).toBe("close");
    expect(cycleInspectorFocus(controls, null, true)).toBe("reload");
  });
});
