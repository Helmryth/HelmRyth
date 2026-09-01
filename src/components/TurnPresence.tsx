// The score-line tail keeps the active operator and current action legible.
// When a record arrives, it hands off without duplicating the live status.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export function TurnPresence({
  avatar,
  visible,
  label = "Working",
  answering = false,
  children,
}: {
  avatar: ReactNode;
  visible: boolean;
  label?: string;
  answering?: boolean;
  children?: ReactNode;
}) {
  const [mounted, setMounted] = useState(visible);
  const [phase, setPhase] = useState<"think" | "answer" | "out">(answering ? "answer" : "think");
  const wasAnswering = useRef(answering);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setPhase(answering ? "answer" : "think");
      wasAnswering.current = answering;
      return;
    }
    if (!mounted) return;
    const handoff = wasAnswering.current;
    wasAnswering.current = false;
    if (handoff) {
      setMounted(false);
      return;
    }
    setPhase("out");
    const timer = setTimeout(() => setMounted(false), 280);
    return () => clearTimeout(timer);
  }, [visible, answering, mounted]);

  if (!mounted) return null;
  const statusLabel = label.trim() === "Thinking" || !label.trim() ? "Working" : label.trim();
  const showAnswer = phase === "answer" && children;
  const showWorking = phase === "think";
  return (
    <div className="turn-presence flex flex-col items-start">
      {showAnswer ? <div className="turn-answer">{children}</div> : null}
      <div
        className={cn(
          "flex items-center gap-2",
          showAnswer && "turn-sigil-tight",
          phase === "think" && "turn-sigil-in",
          phase === "out" && "turn-sigil-out",
        )}
      >
        {avatar}
        {showWorking ? (
          <span
            role="status"
            aria-live="polite"
            className="flex items-center gap-1.5 border-l border-hairline/70 pl-2 text-[12.5px] leading-none text-ink-secondary"
          >
            <span aria-hidden="true" className="size-1.5 rounded-[2px] bg-accent" />
            <span className="thinking-shimmer animate-shimmer">{statusLabel}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
