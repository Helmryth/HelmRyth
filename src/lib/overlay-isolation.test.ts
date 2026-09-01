import { describe, expect, it } from "vitest";

import {
  applyModalIsolation,
  applyOverlayIsolation,
  applyIsolationTargets,
  modalIsolationTargets,
  portaledModalIsolationTargets,
  SHELL_MODAL_MUTATION_ATTRIBUTES,
} from "./overlay-isolation";

class FakeNode {
  inert = false;
  children: FakeNode[] = [];
  parentElement: FakeNode | null = null;
  private attributes = new Map<string, string>();

  constructor(parent?: FakeNode) {
    if (!parent) return;
    this.parentElement = parent;
    parent.children.push(this);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

class FakeParent extends FakeNode {}
class FakeElement extends FakeNode {}

describe("overlay isolation", () => {
  it("observes modal lifecycle attributes without reacting to routine layout mutations", () => {
    expect(SHELL_MODAL_MUTATION_ATTRIBUTES).toEqual(["aria-modal", "hidden", "open"]);
    expect(SHELL_MODAL_MUTATION_ATTRIBUTES).not.toContain("class");
    expect(SHELL_MODAL_MUTATION_ATTRIBUTES).not.toContain("style");
    expect(SHELL_MODAL_MUTATION_ATTRIBUTES).not.toContain("aria-hidden");
    expect(SHELL_MODAL_MUTATION_ATTRIBUTES).not.toContain("inert");
  });

  it("marks sibling content inert and aria-hidden while an overlay is open", () => {
    const parent = new FakeParent();
    const background = new FakeElement(parent);
    const overlay = new FakeElement(parent);
    const restore = applyOverlayIsolation(overlay);

    expect(background.getAttribute("aria-hidden")).toBe("true");
    expect(background.hasAttribute("inert")).toBe(true);
    expect(background.inert).toBe(true);

    restore();

    expect(background.getAttribute("aria-hidden")).toBeNull();
    expect(background.hasAttribute("inert")).toBe(false);
    expect(background.inert).toBe(false);
  });

  it("restores original sibling accessibility state after nested overlays unwind", () => {
    const parent = new FakeParent();
    const background = new FakeElement(parent);
    background.setAttribute("aria-hidden", "false");
    background.setAttribute("inert", "");
    background.inert = true;
    const overlayA = new FakeElement(parent);
    const overlayB = new FakeElement(parent);

    const restoreA = applyOverlayIsolation(overlayA);
    const restoreB = applyOverlayIsolation(overlayB);

    expect(background.getAttribute("aria-hidden")).toBe("true");
    expect(background.inert).toBe(true);

    restoreB();
    expect(background.getAttribute("aria-hidden")).toBe("true");
    expect(background.inert).toBe(true);

    restoreA();
    expect(background.getAttribute("aria-hidden")).toBe("false");
    expect(background.hasAttribute("inert")).toBe(true);
    expect(background.inert).toBe(true);
  });

  it("walks every ancestor to the Shell boundary without isolating beyond it", () => {
    const app = new FakeParent();
    const outsideShell = new FakeElement(app);
    const shell = new FakeParent(app);
    const header = new FakeElement(shell);
    const surface = new FakeParent(shell);
    const conversation = new FakeElement(surface);
    const overlay = new FakeParent(surface);
    const backdrop = new FakeElement(overlay);
    const modal = new FakeElement(overlay);

    const targets = modalIsolationTargets(modal, shell);
    expect(targets).toEqual([backdrop, conversation, header]);
    expect(targets).not.toContain(outsideShell);

    const restore = applyModalIsolation(modal, shell);
    for (const target of [backdrop, conversation, header]) {
      expect(target.getAttribute("aria-hidden")).toBe("true");
      expect(target.inert).toBe(true);
    }
    expect(outsideShell.getAttribute("aria-hidden")).toBeNull();
    expect(outsideShell.inert).toBe(false);
    restore();
  });

  it("keeps ancestor isolation until nested dialogs unwind and restores each original state", () => {
    const shell = new FakeParent();
    const background = new FakeElement(shell);
    background.setAttribute("aria-hidden", "false");
    const layer = new FakeParent(shell);
    const outerDialog = new FakeParent(layer);
    const outerContent = new FakeElement(outerDialog);
    const nestedDialog = new FakeElement(outerDialog);

    const restoreOuter = applyModalIsolation(outerDialog, shell);
    const restoreNested = applyModalIsolation(nestedDialog, shell);

    expect(background.getAttribute("aria-hidden")).toBe("true");
    expect(background.inert).toBe(true);
    expect(outerContent.getAttribute("aria-hidden")).toBe("true");
    expect(outerContent.inert).toBe(true);

    restoreNested();
    expect(background.getAttribute("aria-hidden")).toBe("true");
    expect(outerContent.getAttribute("aria-hidden")).toBeNull();
    expect(outerContent.inert).toBe(false);

    restoreOuter();
    expect(background.getAttribute("aria-hidden")).toBe("false");
    expect(background.inert).toBe(false);
  });

  it("isolates an older body portal while keeping the newest portal usable", () => {
    const documentBody = new FakeParent();
    const shell = new FakeParent(documentBody);
    const shellSurface = new FakeElement(shell);
    const olderPortal = new FakeParent(documentBody);
    const newestPortal = new FakeParent(documentBody);

    const targets = portaledModalIsolationTargets(shell, newestPortal, [olderPortal, newestPortal]);
    expect(targets).toEqual([shellSurface, olderPortal]);
    expect(targets).not.toContain(newestPortal);

    const restoreTargets = applyIsolationTargets(targets);

    expect(olderPortal.getAttribute("aria-hidden")).toBe("true");
    expect(olderPortal.inert).toBe(true);
    expect(newestPortal.getAttribute("aria-hidden")).toBeNull();
    expect(newestPortal.inert).toBe(false);
    restoreTargets();
    expect(olderPortal.getAttribute("aria-hidden")).toBeNull();
    expect(olderPortal.inert).toBe(false);
  });
});
