import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";

export const LOCAL_COMPUTER_AUTO_WARNING =
  "Autonomous mode lets this operator click, type, and use capabilities on the host workbench without asking at every step. Destructive and sensitive actions still stop at gates. Continue only while you can supervise the run.";

export function LocalComputerAutoWarning({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key === "Tab") {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Next frame, not now: a synchronous focus() here lands while the dialog is
      // still being torn down and the browser discards it, dropping focus to <body>.
      const target = returnFocusRef.current;
      if (target) requestAnimationFrame(() => target.focus());
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="local-auto-warning-title"
        aria-describedby="local-auto-warning-body"
        className="max-h-[calc(100vh-48px)] w-full max-w-[420px] overflow-y-auto rounded-md border border-hairline bg-panel p-5"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" />
          <div>
            <h2 id="local-auto-warning-title" className="font-display text-[20px] font-semibold text-ink">
              Grant autonomous host access?
            </h2>
            <p id="local-auto-warning-body" className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
              {LOCAL_COMPUTER_AUTO_WARNING}
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="min-h-9 w-full rounded-md border border-hairline/60 px-4 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink sm:w-auto"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="min-h-9 w-full rounded-md bg-accent px-4 text-[13px] font-medium text-accent-ink hover:bg-accent-border sm:w-auto"
          >
            Grant autonomous host access
          </button>
        </div>
      </div>
    </div>
  );
}
