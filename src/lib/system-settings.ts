import { restoreOverlayFocus, type FocusTargetLike } from "./overlay-focus";

/** Canonical form used by the System routing editor. Provider drivers append
 * their own paths, so a terminal slash is transport noise rather than part of
 * the endpoint identity. Invalid in-progress text is left alone for the
 * server-side validator to explain when the user saves. */
export function normalizeOpenAiCompatibleEndpointUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    new URL(trimmed);
  } catch {
    return trimmed;
  }
  return trimmed.replace(/\/+$/, "");
}

/** Restore focus after the modal has actually unmounted. A modal can replace
 * another surface, so its exact opener may no longer be connected; in that
 * case the persistent System launcher is the honest fallback. */
export function restoreSystemFocus(
  preferred: FocusTargetLike | null,
  dialog: { isConnected: boolean } | null,
  fallback: () => FocusTargetLike | null,
  schedule: (callback: () => void) => void = (callback) => { requestAnimationFrame(callback); },
): void {
  restoreOverlayFocus(preferred, {
    fallback,
    schedule,
    block: () => dialog?.isConnected === true,
  });
}

/** Keep a keyboard-focused section tab reachable inside the compact,
 * horizontally scrollable System rail. This is deliberately width-agnostic:
 * it behaves the same at 390 px, 430 px, and intermediate phone widths. */
export function keepSystemSectionVisible(target: { scrollIntoView(options?: ScrollIntoViewOptions): void }): void {
  target.scrollIntoView({ block: "nearest", inline: "nearest" });
}
