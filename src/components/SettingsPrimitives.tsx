import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

export function Card({
  title,
  subtitle,
  children,
}: {
  title?: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="border-b border-hairline/50 py-5 first:pt-1 last:border-b-0">
      {title && <h2 className="text-[15px] font-semibold tracking-[-0.012em] text-ink">{title}</h2>}
      {subtitle && (
        <p className={title ? "mt-1 max-w-[68ch] text-[13px] leading-relaxed text-ink-secondary" : "max-w-[68ch] text-[13px] leading-relaxed text-ink-secondary"}>
          {subtitle}
        </p>
      )}
      {children && <div className={title || subtitle ? "mt-4" : undefined}>{children}</div>}
    </section>
  );
}

/** A command the user is meant to run, with one-click copy. */
export function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard permission can be denied; leave the button unchanged */
    }
  };

  return (
    <div className="flex items-center gap-2 border-y border-hairline/50 bg-inset/60 px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] text-ink">
        {command}
      </code>
      <button
        onClick={() => void copy()}
        aria-label={copied ? "Command copied" : "Copy command"}
        aria-live="polite"
        className="shrink-0 rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"
      >
        {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
      </button>
    </div>
  );
}
