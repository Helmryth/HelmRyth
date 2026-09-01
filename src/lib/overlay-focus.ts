export const MODAL_SELECTOR =
  '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';

export interface ModalElement {
  isConnected: boolean;
}

export interface ModalRoot {
  querySelectorAll(selector: string): ArrayLike<ModalElement>;
}

export interface FocusTargetLike {
  isConnected?: boolean;
  ownerDocument?: { activeElement?: FocusNodeLike; body?: FocusNodeLike };
  parentElement?: FocusTargetLike | null;
  hidden?: boolean;
  inert?: boolean;
  disabled?: boolean;
  focus(options?: FocusOptions): void;
  getAttribute?(name: string): string | null;
  getClientRects?(): ArrayLike<unknown>;
  hasAttribute?(name: string): boolean;
}

export type FocusNodeLike = FocusTargetLike | Node | null;

export interface FocusOverlayLike {
  contains(node: FocusNodeLike): boolean;
}

export interface OverlayFocusRestoreOptions {
  activeElement?: () => FocusNodeLike;
  block?: () => boolean;
  fallback?: () => FocusTargetLike | null;
  maxAttempts?: number;
  schedule?: (callback: () => void) => void;
}

function isFocusTargetLike(value: FocusNodeLike): value is FocusTargetLike {
  return Boolean(value && "focus" in value && value.focus instanceof Function);
}

function documentActiveFocusTarget(): FocusTargetLike | null {
  const activeElement = globalThis.document?.activeElement ?? null;
  return isFocusTargetLike(activeElement) ? activeElement : null;
}

function isNodeLike(value: FocusNodeLike): value is Node {
  const NodeCtor = globalThis.Node;
  return Boolean(NodeCtor && value instanceof NodeCtor);
}

/**
 * Escape belongs to the last modal in document order. This mirrors the
 * overlay-isolation layer's definition of the active modal and prevents one
 * key press from unwinding a nested dialog and its parent together.
 */
export function isTopmostModal(
  dialog: ModalElement | null,
  root: ModalRoot | null = globalThis.document ?? null,
): boolean {
  if (!dialog || !root) return false;
  const modals = Array.from(root.querySelectorAll(MODAL_SELECTOR)).filter(
    (candidate) => candidate.isConnected,
  );
  return modals.at(-1) === dialog;
}

export type DismissalKeyEvent = Pick<
  KeyboardEvent,
  "key" | "preventDefault" | "stopPropagation"
> & {
  stopImmediatePropagation?: () => void;
};

/** Consume Escape only when `dialog` is the active modal. */
export function consumeTopmostEscape(
  event: DismissalKeyEvent,
  dialog: ModalElement | null,
  onClose: () => void,
  root: ModalRoot | null = globalThis.document ?? null,
): boolean {
  if (event.key !== "Escape" || !isTopmostModal(dialog, root)) return false;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
  onClose();
  return true;
}

function focusTargetSuppressed(target: FocusTargetLike | null): boolean {
  if (!target) return true;
  if (target.isConnected === false) return true;
  if (target.ownerDocument?.body && target === target.ownerDocument.body) return true;
  if (target.hidden === true || target.inert === true || target.disabled === true) return true;
  if (target.hasAttribute?.("hidden") || target.hasAttribute?.("inert") || target.hasAttribute?.("disabled")) {
    return true;
  }
  if (target.getClientRects && target.getClientRects().length === 0) return true;
  for (let current: FocusTargetLike | null | undefined = target; current; current = current.parentElement) {
    if (current.hidden === true || current.inert === true) return true;
    if (current.hasAttribute?.("hidden") || current.hasAttribute?.("inert")) return true;
    if (current.getAttribute?.("aria-hidden") === "true") return true;
  }
  return false;
}

function focusTargetOwnsActiveElement(target: FocusTargetLike, activeElement: FocusNodeLike): boolean {
  if (activeElement === target) return true;
  return isNodeLike(target) && isNodeLike(activeElement) && target.contains(activeElement);
}

export function captureFocusRestoreTarget(
  activeElement: FocusTargetLike | null = documentActiveFocusTarget(),
  overlay: FocusOverlayLike | null = null,
): FocusTargetLike | null {
  if (!activeElement) return null;
  if (overlay && overlay.contains(activeElement)) return null;
  return focusTargetSuppressed(activeElement) ? null : activeElement;
}

/**
 * Restore focus after React has removed the overlay and the shell isolation
 * observer has made the opener interactive again.
 */
export function restoreOverlayFocus(
  target: FocusTargetLike | null,
  options: OverlayFocusRestoreOptions = {},
): void {
  const fallback = options.fallback ?? (() => null);
  const activeElement = options.activeElement ?? (() => target?.ownerDocument?.activeElement ?? documentActiveFocusTarget());
  const maxAttempts = Math.max(options.maxAttempts ?? 30, 1);
  const schedule = options.schedule ?? ((callback: () => void) => {
    const requestAnimationFrame = globalThis.window?.requestAnimationFrame;
    if (requestAnimationFrame) requestAnimationFrame(callback);
    else callback();
  });
  let attempts = 0;

  const restore = () => {
    if (options.block?.()) {
      if (attempts++ < maxAttempts) schedule(restore);
      return;
    }
    // A connected opener is often temporarily inert/aria-hidden while React
    // removes the overlay boundary. Prefer waiting for that exact opener over
    // immediately focusing a different launcher. A fallback is appropriate
    // only when the opener was actually unmounted, or when it never becomes
    // usable within the bounded retry window.
    const preferredConnected = Boolean(target && target.isConnected !== false);
    if (preferredConnected && focusTargetSuppressed(target) && attempts++ < maxAttempts) {
      schedule(restore);
      return;
    }
    const preferred = preferredConnected && !focusTargetSuppressed(target) ? target : null;
    const candidate = preferred ?? fallback();
    if (!candidate || focusTargetSuppressed(candidate)) {
      if (attempts++ < maxAttempts) schedule(restore);
      return;
    }
    candidate.focus({ preventScroll: true });
    if (!focusTargetOwnsActiveElement(candidate, activeElement())) {
      if (attempts++ < maxAttempts) schedule(restore);
    }
  };

  schedule(restore);
}
