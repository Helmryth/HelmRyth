import { describe, expect, it, vi } from "vitest";

import {
  captureFocusRestoreTarget,
  consumeTopmostEscape,
  type FocusTargetLike,
  isTopmostModal,
  type ModalElement,
  type ModalRoot,
  restoreOverlayFocus,
} from "./overlay-focus";

function modal(connected = true) {
  return { isConnected: connected };
}

function root(...modals: ModalElement[]): ModalRoot {
  return {
    querySelectorAll: vi.fn(() => modals),
  };
}

type FocusOwner = {
  activeElement: FocusTargetLike | null;
  body: FocusTargetLike | null;
};

function focusTarget(options: {
  activeOwner?: FocusOwner;
  connected?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  inert?: boolean;
  label?: string;
  rects?: number;
}) {
  const ownerDocument = options.activeOwner ?? { activeElement: null, body: null };
  const target = {
    isConnected: options.connected ?? true,
    ownerDocument,
    parentElement: null,
    hidden: options.hidden ?? false,
    inert: options.inert ?? false,
    disabled: options.disabled ?? false,
    focus: vi.fn((focusOptions?: FocusOptions) => {
      ownerDocument.activeElement = target;
      return focusOptions;
    }),
    contains: (value: FocusTargetLike | null) => value === target,
    getAttribute: vi.fn(() => null),
    getClientRects: vi.fn(() => Array.from({ length: options.rects ?? 1 }, () => ({ width: 1 }))),
    hasAttribute: vi.fn((name: string) =>
      name === "hidden" ? Boolean(options.hidden)
        : name === "inert" ? Boolean(options.inert)
          : name === "disabled" ? Boolean(options.disabled)
            : false),
    label: options.label ?? "target",
  };
  if (!ownerDocument.body) {
    ownerDocument.body = {
      isConnected: true,
      ownerDocument,
      focus: vi.fn(),
      getAttribute: vi.fn(() => null),
      getClientRects: vi.fn(() => [{ width: 1 }]),
      hasAttribute: vi.fn(() => false),
    };
  }
  return target;
}

describe("overlay focus and Escape ownership", () => {
  it("assigns Escape to only the last connected modal", () => {
    const outer = modal();
    const nested = modal();
    const documentRef = root(outer, nested);
    const outerClose = vi.fn();
    const nestedClose = vi.fn();
    const nestedEvent = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };

    expect(consumeTopmostEscape(nestedEvent, outer, outerClose, documentRef)).toBe(false);
    expect(consumeTopmostEscape(nestedEvent, nested, nestedClose, documentRef)).toBe(true);
    expect(outerClose).not.toHaveBeenCalled();
    expect(nestedClose).toHaveBeenCalledOnce();
    expect(nestedEvent.preventDefault).toHaveBeenCalledOnce();
    expect(nestedEvent.stopPropagation).toHaveBeenCalledOnce();
    expect(nestedEvent.stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it("ignores disconnected modals when resolving the topmost owner", () => {
    const outer = modal();
    const removedNested = modal(false);
    expect(isTopmostModal(outer, root(outer, removedNested))).toBe(true);
  });

  it("restores a connected opener only after the scheduled unmount boundary", () => {
    const callbacks: Array<() => void> = [];
    const activeOwner: FocusOwner = { activeElement: null, body: null };
    const target = focusTarget({ activeOwner });
    restoreOverlayFocus(target, { schedule: (callback) => callbacks.push(callback) });

    expect(target.focus).not.toHaveBeenCalled();
    callbacks[0]?.();
    expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });

    const removed = focusTarget({ activeOwner, connected: false });
    restoreOverlayFocus(removed, { schedule: (callback) => callback() });
    expect(removed.focus).not.toHaveBeenCalled();
  });

  it("captures only a stable opener that lives outside the overlay", () => {
    const ownerDocument: FocusOwner = { activeElement: null, body: null };
    const opener = focusTarget({ activeOwner: ownerDocument });
    ownerDocument.activeElement = opener;
    const overlay = { contains: vi.fn((value: FocusTargetLike | null) => value === ownerDocument.body) };

    expect(captureFocusRestoreTarget(opener, overlay)).toBe(opener);
    expect(captureFocusRestoreTarget(ownerDocument.body, overlay)).toBeNull();
    expect(captureFocusRestoreTarget(opener, { contains: () => true })).toBeNull();
  });

  it("retries until the launcher is focusable again and never falls back to body", () => {
    const callbacks: Array<() => void> = [];
    const ownerDocument: FocusOwner = { activeElement: null, body: null };
    const opener = focusTarget({ activeOwner: ownerDocument, connected: false });
    const launcher = focusTarget({ activeOwner: ownerDocument, hidden: true, rects: 0, label: "launcher" });

    restoreOverlayFocus(opener, {
      fallback: () => launcher,
      schedule: (callback) => callbacks.push(callback),
      maxAttempts: 6,
    });

    expect(callbacks).toHaveLength(1);
    callbacks.shift()?.();
    expect(opener.focus).not.toHaveBeenCalled();
    expect(launcher.focus).not.toHaveBeenCalled();

    launcher.hidden = false;
    vi.mocked(launcher.getClientRects).mockReturnValue([{ width: 1 }]);
    vi.mocked(launcher.hasAttribute).mockImplementation(() => false);
    callbacks.shift()?.();
    expect(launcher.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(ownerDocument.activeElement).toBe(launcher);
    expect(ownerDocument.activeElement).not.toBe(ownerDocument.body);
  });

  it("waits for a temporarily suppressed connected opener before using a different fallback", () => {
    const callbacks: Array<() => void> = [];
    const ownerDocument: FocusOwner = { activeElement: null, body: null };
    const opener = focusTarget({ activeOwner: ownerDocument, inert: true, label: "exact opener" });
    const fallback = focusTarget({ activeOwner: ownerDocument, label: "other launcher" });

    restoreOverlayFocus(opener, {
      fallback: () => fallback,
      schedule: (callback) => callbacks.push(callback),
      maxAttempts: 4,
    });

    callbacks.shift()?.();
    expect(opener.focus).not.toHaveBeenCalled();
    expect(fallback.focus).not.toHaveBeenCalled();

    opener.inert = false;
    vi.mocked(opener.hasAttribute).mockImplementation(() => false);
    callbacks.shift()?.();
    expect(opener.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(fallback.focus).not.toHaveBeenCalled();
    expect(ownerDocument.activeElement).toBe(opener);
  });

  it("retries when the first focus attempt does not stick", () => {
    const callbacks: Array<() => void> = [];
    const ownerDocument: FocusOwner = { activeElement: null, body: null };
    const launcher = focusTarget({ activeOwner: ownerDocument, label: "launcher" });
    let calls = 0;
    vi.mocked(launcher.focus).mockImplementation(() => {
      calls += 1;
      ownerDocument.activeElement = calls === 1 ? ownerDocument.body : launcher;
    });

    restoreOverlayFocus(launcher, {
      schedule: (callback) => callbacks.push(callback),
      maxAttempts: 4,
    });

    callbacks.shift()?.();
    expect(launcher.focus).toHaveBeenCalledTimes(1);
    expect(ownerDocument.activeElement).toBe(ownerDocument.body);

    callbacks.shift()?.();
    expect(launcher.focus).toHaveBeenCalledTimes(2);
    expect(ownerDocument.activeElement).toBe(launcher);
  });

  it("survives 10 repeated restore cycles with the same stable launcher", () => {
    const ownerDocument: FocusOwner = { activeElement: null, body: null };
    const launcher = focusTarget({ activeOwner: ownerDocument, label: "launcher" });

    for (let cycle = 0; cycle < 10; cycle += 1) {
      ownerDocument.activeElement = ownerDocument.body;
      restoreOverlayFocus(launcher, { schedule: (callback) => callback() });
      expect(ownerDocument.activeElement).toBe(launcher);
    }
    expect(launcher.focus).toHaveBeenCalledTimes(10);
  });
});
