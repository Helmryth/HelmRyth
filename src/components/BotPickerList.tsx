// The checkbox roster shared by crew creation and membership management.
// Store and component APIs retain their historical names; this surface speaks
// Helmryth's operator vocabulary throughout.
import { Check } from "lucide-react";
import type { Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { cn } from "@/lib/cn";

export function BotPickerList({
  bots,
  picked,
  onToggle,
  emptyHint,
}: {
  bots: Bot[];
  picked: Set<string>;
  onToggle: (id: string) => void;
  /** shown in place of the list when there is nothing to pick from */
  emptyHint: string;
}) {
  const visibleEmptyHint = /\b(bot|agent|channel|room)s?\b/i.test(emptyHint)
    ? "Create an operator first, then assemble a crew from the roster."
    : emptyHint;

  return (
    <div
      className="flex max-h-64 flex-col overflow-y-auto border-y border-hairline/40"
      role="group"
      aria-label="Available operators"
    >
      {bots.length === 0 && (
        <div className="px-3 py-6 text-left" role="status">
          <div className="text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">
            Roster required
          </div>
          <p className="mt-1 max-w-[28rem] text-[13px] leading-5 text-ink">{visibleEmptyHint}</p>
        </div>
      )}
      {bots.map((b) => (
        <button
          key={b.id}
          type="button"
          onClick={() => onToggle(b.id)}
          role="checkbox"
          aria-checked={picked.has(b.id)}
          aria-label={`${picked.has(b.id) ? "Remove" : "Add"} ${b.name} ${picked.has(b.id) ? "from" : "to"} crew`}
          className={cn(
            "flex min-h-11 items-center gap-3 border-b border-hairline/30 px-3 py-2 text-left last:border-b-0 hover:bg-raised-hover/50",
            picked.has(b.id) && "bg-raised/70",
          )}
        >
          <BotAvatar bot={b} state="happy" size={28} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium text-ink">{b.name}</span>
            <span className="block text-[11px] text-ink-secondary">
              {picked.has(b.id) ? "Assigned to crew" : "Available operator"}
            </span>
          </span>
          <span
            aria-hidden="true"
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-sm border",
              picked.has(b.id)
                ? "border-accent bg-accent text-[var(--color-accent-ink)]"
                : "border-hairline/70 bg-raised text-transparent",
            )}
          >
            <Check size={13} />
          </span>
        </button>
      ))}
    </div>
  );
}
