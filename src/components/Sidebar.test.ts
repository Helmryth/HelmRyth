import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", {
    value: {
      helmryth: {},
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    configurable: true,
    writable: true,
  });
});

import {
  contextMenuFocusIndex,
  executeRosterDeletion,
  focusSkipTarget,
  MOBILE_ROSTER_CLOSE_CLASS,
  rosterDeletionPresentation,
  rosterFocusAfterRemoval,
  SidebarShell,
  sidebarLayoutModeForWidth,
  skipDestination,
} from "./Sidebar";

describe("Sidebar responsive shell", () => {
  it("uses the overlay layout below the mobile breakpoint", () => {
    expect(sidebarLayoutModeForWidth(390)).toBe("overlay");
    expect(sidebarLayoutModeForWidth(767)).toBe("overlay");
    expect(sidebarLayoutModeForWidth(768)).toBe("dock");
  });

  it("removes the closed mobile drawer from the tree", () => {
    const markup = renderToStaticMarkup(
      createElement(
        SidebarShell,
        {
          mode: "overlay",
          open: false,
          panelRef: createRef<HTMLElement>(),
          onClose: vi.fn(),
        },
        createElement("div", null, "Roster"),
      ),
    );

    expect(markup).toBe("");
  });

  it("renders the open mobile drawer as a modal overlay", () => {
    const markup = renderToStaticMarkup(
      createElement(
        SidebarShell,
        {
          mode: "overlay",
          open: true,
          panelRef: createRef<HTMLElement>(),
          onClose: vi.fn(),
        },
        createElement("div", null, "Roster"),
      ),
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("fixed inset-0");
    expect(MOBILE_ROSTER_CLOSE_CLASS.split(" ")).toEqual(expect.arrayContaining(["size-11", "items-center", "justify-center"]));
  });

  it("keeps the docked desktop sidebar mounted even when mobile open is false", () => {
    const markup = renderToStaticMarkup(
      createElement(
        SidebarShell,
        {
          mode: "dock",
          open: false,
          panelRef: createRef<HTMLElement>(),
          onClose: vi.fn(),
        },
        createElement("div", null, "Roster"),
      ),
    );

    expect(markup).toContain("Operator roster and navigation");
    expect(markup).not.toContain('role="dialog"');
  });
});

describe("roster destructive-action gate", () => {
  it("names the exact operator scope and retained neighboring data", () => {
    const copy = rosterDeletionPresentation({
      kind: "operator",
      id: "op-1",
      name: "Rivet",
      taskCount: 2,
    });

    expect(copy.title).toBe("Permanently delete operator “Rivet”?");
    expect(copy.consequence).toContain("Rivet's operator record, main workstream, 2 task workstreams, and operator workspace");
    expect(copy.consequence).toContain("Other operators and crew workstreams stay");
    expect(copy.confirmLabel).toBe("Delete Rivet permanently");
    expect(copy.path).toBe("/api/bots/op-1");
  });

  it("names the exact crew scope and retained member workstreams", () => {
    const copy = rosterDeletionPresentation({
      kind: "crew",
      id: "crew-1",
      name: "Release desk",
      taskCount: 1,
    });

    expect(copy.title).toBe("Permanently delete crew “Release desk”?");
    expect(copy.consequence).toContain("its shared workstream, and 1 task workstream");
    expect(copy.consequence).toContain("Member operators and their individual workstreams stay");
    expect(copy.path).toBe("/api/groups/crew-1");
  });

  it("permits exactly one delete request while an activation is in flight", async () => {
    let release!: () => void;
    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = vi.fn(() => response);
    const lock = { current: false };
    const subject = { kind: "crew", id: "crew-1", name: "Release desk", taskCount: 0 } as const;

    const first = executeRosterDeletion(subject, request, lock);
    await expect(executeRosterDeletion(subject, request, lock)).resolves.toEqual({ status: "duplicate" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/api/groups/crew-1", { method: "DELETE" });

    release();
    await expect(first).resolves.toEqual({ status: "deleted" });
    expect(lock.current).toBe(true);
  });

  it("keeps the target retryable and exposes the API error when deletion fails", async () => {
    const request = vi.fn().mockRejectedValue(new Error("Stop the active turn first"));
    const lock = { current: false };

    await expect(executeRosterDeletion(
      { kind: "operator", id: "op-1", name: "Rivet", taskCount: 0 },
      request,
      lock,
    )).resolves.toEqual({ status: "error", message: "Stop the active turn first" });
    expect(lock.current).toBe(false);
  });
});

// The roster footer and the operator context menu only render inside a live
// StoreProvider with a seeded roster, which this suite has no DOM for. Their
// markup contracts are asserted against the source instead — a silent revert of
// either one is exactly the regression that shipped.
const sidebarSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "./Sidebar.tsx"),
  "utf8",
);

describe("roster focus after a destructive action", () => {
  it("moves to the nearest surviving row instead of dropping to <body>", () => {
    const archived = { dataset: { rosterId: "op-1" } };
    const survivor = { dataset: { rosterId: "op-2" } };
    const fallback = { dataset: {} };

    expect(rosterFocusAfterRemoval([archived, survivor], "op-1", [fallback])).toBe(survivor);
  });

  it("falls back to the roster chrome when the archived row was the last one", () => {
    const archived = { dataset: { rosterId: "op-1" } };
    const closeButton = { dataset: {} };
    const panel = { dataset: {} };

    expect(rosterFocusAfterRemoval([archived], "op-1", [null, closeButton, panel])).toBe(closeButton);
    expect(rosterFocusAfterRemoval([archived], "op-1", [null, undefined])).toBeNull();
  });

  it("keeps one status region mounted so the archive message is a change, not an insertion", () => {
    // A role="status" node added to the DOM together with its first message is
    // not announced: the roster count changed in silence.
    expect(sidebarSource).toContain('<div role="status" aria-live="polite" className="sr-only">');
    expect(sidebarSource).toContain("{teamFeedback?.text ?? \"\"}");
  });
});

describe("roster skip control", () => {
  const stubTarget = (focusable = true) => ({
    focus: vi.fn(),
    hasAttribute: vi.fn(() => focusable),
    setAttribute: vi.fn(),
  });

  it("prefers the live composer over the surrounding main region", () => {
    const composer = stubTarget();
    const main = stubTarget();
    const querySelector = vi.fn((selector: string) =>
      selector === "[data-helmryth-composer-input]" ? composer : main,
    );

    expect(skipDestination(querySelector)).toBe(composer);
    expect(focusSkipTarget(querySelector)).toBe(true);
    expect(composer.focus).toHaveBeenCalledOnce();
    expect(main.focus).not.toHaveBeenCalled();
  });

  it("makes a bare <main> a programmatic focus stop so the next Tab continues from the content", () => {
    const main = stubTarget(false);
    const querySelector = vi.fn((selector: string) =>
      selector === "[data-helmryth-composer-input]" ? null : main,
    );

    expect(focusSkipTarget(querySelector)).toBe(true);
    expect(main.setAttribute).toHaveBeenCalledWith("tabindex", "-1");
    expect(main.focus).toHaveBeenCalledOnce();
  });

  it("reports failure instead of pretending it jumped", () => {
    expect(focusSkipTarget(() => null)).toBe(false);
  });

  it("puts the skip control ahead of the roster's own controls", () => {
    expect(sidebarSource).toContain("Skip to the workstream");
    expect(sidebarSource.indexOf("Skip to the workstream")).toBeLessThan(
      sidebarSource.indexOf('aria-label="Close roster"'),
    );
  });
});

describe("operator context menu keyboard contract", () => {
  it("wraps arrow navigation and honours Home/End", () => {
    expect(contextMenuFocusIndex(4, -1, "ArrowDown")).toBe(0);
    expect(contextMenuFocusIndex(4, 3, "ArrowDown")).toBe(0);
    expect(contextMenuFocusIndex(4, -1, "ArrowUp")).toBe(3);
    expect(contextMenuFocusIndex(4, 0, "ArrowUp")).toBe(3);
    expect(contextMenuFocusIndex(4, 2, "Home")).toBe(0);
    expect(contextMenuFocusIndex(4, 0, "End")).toBe(3);
  });

  it("leaves every other key to the menu items", () => {
    expect(contextMenuFocusIndex(4, 0, "Enter")).toBeNull();
    expect(contextMenuFocusIndex(4, 0, "a")).toBeNull();
    expect(contextMenuFocusIndex(0, -1, "ArrowDown")).toBeNull();
  });

  it("is announced as a menu and takes focus when Shift+F10 opens it", () => {
    expect(sidebarSource).toContain('role="menu"');
    expect(sidebarSource).toContain('role="menuitem"');
    expect(sidebarSource).toContain('\'[role="menuitem"]:not([disabled])\'');
    expect(sidebarSource).not.toContain('role="group"\n      aria-label={`${bot.name} operator actions`}');
  });
});

describe("System launcher naming", () => {
  it("carries a literal accessible name, not just a tooltip", () => {
    // `title` is not a dependable accessible name: touch and several screen
    // readers never surface it, which left the default-density launcher unnamed.
    expect(sidebarSource).toContain('aria-label="System"');
  });
});
