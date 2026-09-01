/**
 * Keeps the non-modal branches of the application unavailable while an
 * authored modal is open. The low-level functions intentionally use a tiny
 * DOM-shaped interface so the ancestor walk can be tested without a browser.
 */
type OverlayElementLike = {
  children: Iterable<OverlayElementLike>;
  inert?: boolean;
  parentElement: OverlayElementLike | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  removeAttribute(name: string): void;
  setAttribute(name: string, value: string): void;
};

interface IsolationSnapshot {
  ariaHidden: string | null;
  hadInertAttribute: boolean;
  inert: boolean;
}

export interface ShellModalIsolationOptions {
  /** App-owned modal roots that deliberately live outside the Shell. */
  excludedRoots?: readonly HTMLElement[];
}

export interface ShellModalIsolationController {
  disconnect(): void;
  refresh(): void;
}

// Keep this deliberately narrow. Shell modals are conditionally mounted, so
// broad layout/class mutations must not tear down and rebuild isolation.
export const SHELL_MODAL_MUTATION_ATTRIBUTES = ["aria-modal", "hidden", "open"] as const;

const isolationCounts = new WeakMap<OverlayElementLike, number>();
const isolationSnapshots = new WeakMap<OverlayElementLike, IsolationSnapshot>();

function elementContains(ancestor: OverlayElementLike, descendant: OverlayElementLike): boolean {
  if (ancestor === descendant) return true;
  let current = descendant.parentElement;
  while (current) {
    if (current === ancestor) return true;
    current = current.parentElement;
  }
  return false;
}

function isWithinBoundary(element: OverlayElementLike, boundary: OverlayElementLike): boolean {
  return elementContains(boundary, element);
}

/**
 * Returns the sibling branches from a modal to the Shell boundary. It never
 * visits the boundary's parent, which prevents a Shell dialog from affecting
 * onboarding or another app-level sibling.
 */
export function modalIsolationTargets(
  modal: OverlayElementLike,
  boundary: OverlayElementLike,
): OverlayElementLike[] {
  if (!isWithinBoundary(modal, boundary)) return [];

  const targets: OverlayElementLike[] = [];
  const seen = new Set<OverlayElementLike>();
  let current: OverlayElementLike = modal;

  while (current !== boundary) {
    const parent = current.parentElement;
    if (!parent) break;
    for (const sibling of parent.children) {
      if (sibling === current || seen.has(sibling)) continue;
      seen.add(sibling);
      targets.push(sibling);
    }
    current = parent;
  }

  return targets;
}

/** Applies ref-counted isolation to a known set of background branches. */
export function applyIsolationTargets(targets: readonly OverlayElementLike[]): () => void {
  for (const target of targets) {
    const count = isolationCounts.get(target) ?? 0;
    if (count === 0) {
      isolationSnapshots.set(target, {
        ariaHidden: target.getAttribute("aria-hidden"),
        hadInertAttribute: target.hasAttribute("inert"),
        inert: target.inert === true,
      });
    }
    isolationCounts.set(target, count + 1);
    target.setAttribute("aria-hidden", "true");
    target.setAttribute("inert", "");
    target.inert = true;
  }

  return () => {
    for (const target of targets) {
      const count = isolationCounts.get(target);
      if (!count) continue;
      if (count > 1) {
        isolationCounts.set(target, count - 1);
        continue;
      }
      isolationCounts.delete(target);
      const snapshot = isolationSnapshots.get(target);
      isolationSnapshots.delete(target);
      if (snapshot?.ariaHidden === null || snapshot?.ariaHidden === undefined) target.removeAttribute("aria-hidden");
      else target.setAttribute("aria-hidden", snapshot.ariaHidden);
      if (snapshot?.hadInertAttribute) target.setAttribute("inert", "");
      else target.removeAttribute("inert");
      target.inert = snapshot?.inert === true;
    }
  };
}

/** Applies isolation to a modal that is physically mounted inside `boundary`. */
export function applyModalIsolation(
  modal: OverlayElementLike,
  boundary: OverlayElementLike,
): () => void {
  return applyIsolationTargets(modalIsolationTargets(modal, boundary));
}

/**
 * Legacy one-level helper retained for callers outside the Shell controller.
 * New Shell dialogs should be isolated by `observeShellModalIsolation`.
 */
export function applyOverlayIsolation(root: OverlayElementLike): () => void {
  const parent = root.parentElement;
  if (!parent) return () => {};
  return applyIsolationTargets(Array.from(parent.children).filter((element) => element !== root));
}

function isHiddenOrDisconnected(dialog: HTMLElement): boolean {
  if (!dialog.isConnected) return true;
  for (let current: HTMLElement | null = dialog; current; current = current.parentElement) {
    if (current.hidden || current.hasAttribute("hidden")) return true;
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (style?.display === "none" || style?.visibility === "hidden") return true;
  }
  return false;
}

function isExcluded(dialog: HTMLElement, excludedRoots: readonly HTMLElement[]): boolean {
  return excludedRoots.some((root) => root.contains(dialog));
}

function isShellModal(
  dialog: HTMLElement,
  boundary: HTMLElement,
  excludedRoots: readonly HTMLElement[],
): boolean {
  if (isHiddenOrDisconnected(dialog) || isExcluded(dialog, excludedRoots)) return false;
  if (boundary.contains(dialog)) return true;

  // Several established Shell modals deliberately portal to document.body.
  // They are still authored by Shell, but have no physical ancestor path to
  // it. The controller handles them by isolating the Shell root as one branch
  // (see `targetsForShellModal`); onboarding is explicitly excluded above.
  return dialog.ownerDocument === boundary.ownerDocument && boundary.ownerDocument.body.contains(dialog);
}

function bodyBranch(element: HTMLElement): HTMLElement | null {
  const body = element.ownerDocument.body;
  let branch: HTMLElement = element;
  while (branch.parentElement && branch.parentElement !== body) branch = branch.parentElement;
  return branch.parentElement === body ? branch : null;
}

/**
 * Shell content plus the earlier portal branches that a newest portal must
 * cover. Kept pure so stacking semantics can be regression-tested without a
 * DOM runtime.
 */
export function portaledModalIsolationTargets(
  boundary: OverlayElementLike,
  modalBranch: OverlayElementLike,
  activePortalBranches: readonly OverlayElementLike[],
): OverlayElementLike[] {
  const targets = Array.from(boundary.children);
  for (const branch of activePortalBranches) {
    if (branch === modalBranch || elementContains(branch, modalBranch) || targets.includes(branch)) continue;
    targets.push(branch);
  }
  return targets;
}

function targetsForTopmostShellModal(
  modal: HTMLElement,
  boundary: HTMLElement,
  activeModals: readonly HTMLElement[],
): OverlayElementLike[] {
  if (boundary.contains(modal)) return modalIsolationTargets(modal, boundary);

  const modalBranch = bodyBranch(modal);
  if (!modalBranch) return Array.from(boundary.children);
  const activePortalBranches = activeModals
    .filter((candidate) => !boundary.contains(candidate))
    .map(bodyBranch)
    .filter((branch): branch is HTMLElement => branch !== null);
  return portaledModalIsolationTargets(boundary, modalBranch, activePortalBranches);
}

/**
 * Observes the app document for authored `aria-modal` dialogs and isolates
 * exactly the sibling branches between the topmost dialog and the Shell
 * boundary. DOM order is the app's z-order tie-breaker: Shell dialogs are
 * mounted in visual order, and React body portals append after existing
 * portals. Earlier modal branches are therefore background, not peers.
 * Its attribute filter intentionally excludes `inert`, `aria-hidden`, class,
 * and style: controller writes and routine layout changes cannot self-trigger
 * a refresh.
 */
export function observeShellModalIsolation(
  boundary: HTMLElement,
  options: ShellModalIsolationOptions = {},
): ShellModalIsolationController {
  const documentRef = boundary.ownerDocument;
  const excludedRoots = options.excludedRoots ?? [];
  let releases: Array<() => void> = [];
  let scheduled = false;

  const refresh = () => {
    for (const release of releases.splice(0)) release();

    const modals = Array.from(documentRef.querySelectorAll<HTMLElement>('[aria-modal="true"]')).filter((dialog) =>
      isShellModal(dialog, boundary, excludedRoots),
    );
    const topmost = modals[modals.length - 1];
    if (topmost) releases.push(applyIsolationTargets(targetsForTopmostShellModal(topmost, boundary, modals)));
  };

  const scheduleRefresh = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      refresh();
    });
  };

  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(documentRef.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [...SHELL_MODAL_MUTATION_ATTRIBUTES],
  });
  refresh();

  return {
    refresh,
    disconnect() {
      observer.disconnect();
      for (const release of releases.splice(0)) release();
    },
  };
}
