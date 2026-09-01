import { useEffect, useId, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

export const addressPreview = (value: string): string => {
  if (value.length <= 3) return "…";
  if (value.length < 10) return `${value.slice(0, 3)}…`;
  if (value.length < 17) return `${value.slice(0, 4)}…${value.slice(-3)}`;
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
};

/** Routes are operational details, not credentials. They stay compact until
 * explicitly revealed so the normal setup UI never leads with network noise. */
export function ConnectionDetail({ label, value }: { label: string; value: string }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const detailId = useId();
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyError(false);
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1_200);
    } catch {
      setCopyError(true);
      setRevealed(true);
    }
  };

  return (
    <div className="flex items-center gap-3 border-b border-hairline/50 px-1 py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium text-ink-secondary">{label}</div>
        <div id={detailId} className={`mt-0.5 font-sans text-[12px] tabular-nums text-ink ${revealed ? "select-all break-all" : "truncate"}`}>
          {revealed ? value : addressPreview(value)}
        </div>
        {copyError && <div role="alert" className="mt-1 text-[12px] text-danger">Clipboard access was blocked. The route is revealed for manual copying.</div>}
      </div>
      <button
        type="button"
        onClick={() => setRevealed((current) => !current)}
        aria-expanded={revealed}
        aria-controls={detailId}
        aria-label={`${revealed ? "Hide" : "Reveal"} ${label}`}
        className="min-h-9 shrink-0 rounded-md px-2 text-[12px] text-ink-secondary hover:bg-control hover:text-ink"
      >
        {revealed ? "Hide" : "Reveal"}
      </button>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`Copy ${label}`}
        className="flex size-9 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
      >
        {copied ? <Check size={13} className="text-success" aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        <span className="sr-only" aria-live="polite">{copied ? `${label} copied` : ""}</span>
      </button>
    </div>
  );
}
