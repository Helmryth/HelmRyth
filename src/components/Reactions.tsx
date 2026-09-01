// Compact record marks. Stored values retain the existing reaction contract,
// while the interface presents deliberate line symbols and accountable names
// instead of an emoji toolbar.
import { useEffect, useId, useRef, useState } from "react";
import {
  BadgeCheck,
  Brain,
  CircleAlert,
  CircleHelp,
  Coffee,
  Cpu,
  Eye,
  Flame,
  Gem,
  Handshake,
  Heart,
  Laugh,
  Lightbulb,
  PartyPopper,
  Plus,
  Rocket,
  Skull,
  Sparkles,
  Target,
  ThumbsDown,
  ThumbsUp,
  X,
  Zap,
} from "lucide-react";
import { useStore, type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";

export const REACTION_SET = ["👍", "❤️", "😂", "🎉", "👀"] as const;

/** Values stay within the established eight-character persistence limit. */
const EXTENDED_SET = [
  "👍", "👎", "❤️", "🔥", "🚀", "🧠",
  "💡", "🫡", "💯", "❓", "‼️", "😂",
  "🤖", "🎯", "👀", "🤝", "⚡", "💎",
  "💀", "✨", "🎉", "☕",
] as const;

const REACTION_META = [
  ["👍", { label: "Acknowledge", Icon: ThumbsUp }],
  ["👎", { label: "Challenge", Icon: ThumbsDown }],
  ["❤️", { label: "Strong", Icon: Heart }],
  ["🔥", { label: "Urgent", Icon: Flame }],
  ["🚀", { label: "Ship it", Icon: Rocket }],
  ["🧠", { label: "Insightful", Icon: Brain }],
  ["💡", { label: "Useful idea", Icon: Lightbulb }],
  ["🫡", { label: "Understood", Icon: BadgeCheck }],
  ["💯", { label: "Exact", Icon: Target }],
  ["❓", { label: "Question", Icon: CircleHelp }],
  ["‼️", { label: "Needs attention", Icon: CircleAlert }],
  ["😂", { label: "Amusing", Icon: Laugh }],
  ["🤖", { label: "System work", Icon: Cpu }],
  ["🎯", { label: "On target", Icon: Target }],
  ["👀", { label: "Watching", Icon: Eye }],
  ["🤝", { label: "Agreed", Icon: Handshake }],
  ["⚡", { label: "Fast", Icon: Zap }],
  ["💎", { label: "Precise", Icon: Gem }],
  ["💀", { label: "Failed hard", Icon: Skull }],
  ["✨", { label: "Polished", Icon: Sparkles }],
  ["🎉", { label: "Celebrate", Icon: PartyPopper }],
  ["☕", { label: "Pause", Icon: Coffee }],
] as const;

function reactionMeta(value: string) {
  return REACTION_META.find(([reaction]) => reaction === value)?.[1] ?? { label: "Marked", Icon: BadgeCheck };
}

export function reactionGridDestination(
  index: number,
  key: string,
  count: number,
  columns = 6,
): number | null {
  if (count <= 0 || index < 0 || index >= count) return null;
  const delta = key === "ArrowRight"
    ? 1
    : key === "ArrowLeft"
      ? -1
      : key === "ArrowDown"
        ? columns
        : key === "ArrowUp"
          ? -columns
          : 0;
  if (delta === 0) return null;
  return (index + delta + count) % count;
}

export function ReactionBar({ threadId, message }: { threadId: string; message: Message }) {
  const { dispatch } = useStore();
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerId = useId();
  const anchorRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // same dismiss contract as the sidebar menus: outside click, Escape, blur
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node)) return;
      const target = e.target;
      if (!pickerRef.current?.contains(target) && !anchorRef.current?.contains(target)) {
        setPickerOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setPickerOpen(false);
      toggleRef.current?.focus();
    };
    const onBlur = () => setPickerOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) return;
    pickerRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [pickerOpen]);

  return (
    <div className="relative shrink-0">
      <div
        ref={anchorRef}
        className="flex items-center gap-0.5 rounded-sm border border-hairline/60 bg-panel opacity-100 shadow-sm transition-opacity motion-reduce:transition-none sm:px-1 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100"
      >
        {REACTION_SET.map((emoji) => {
          const { label, Icon } = reactionMeta(emoji);
          const selected = (message.reactions ?? []).some((reaction) => reaction.emoji === emoji && reaction.by === "user");
          return (
            <button
              key={emoji}
              type="button"
              onClick={() => dispatch({ type: "toggleReaction", threadId, messageId: message.id, emoji })}
              aria-label={`${selected ? "Remove" : "Add"} ${label.toLowerCase()} mark`}
              aria-pressed={selected}
              title={label}
              className={cn(
                "hidden size-9 items-center justify-center rounded-sm text-ink-secondary hover:bg-control hover:text-ink sm:flex",
                selected && "bg-accent/15 text-accent",
              )}
            >
              <Icon size={13} aria-hidden="true" />
            </button>
          );
        })}
        <button
          ref={toggleRef}
          type="button"
          onClick={() => setPickerOpen((o) => !o)}
          aria-label={pickerOpen ? "Close record marks" : "More record marks"}
          aria-expanded={pickerOpen}
          aria-controls={pickerId}
          title={pickerOpen ? "Close record marks" : "More record marks"}
          className="flex size-9 items-center justify-center rounded-sm text-ink-secondary hover:bg-control hover:text-ink"
        >
          {pickerOpen ? <X size={12} /> : <Plus size={12} />}
        </button>
      </div>
      {pickerOpen && (
        <div
          id={pickerId}
          ref={pickerRef}
          data-reaction-picker
          role="group"
          aria-label="Record marks"
          onKeyDown={(event) => {
            if (!(event.target instanceof HTMLButtonElement)) return;
            const buttons = [...(pickerRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
            const current = buttons.indexOf(event.target);
            const next = reactionGridDestination(current, event.key, buttons.length);
            if (next === null) return;
            event.preventDefault();
            buttons[next]?.focus();
          }}
          className="fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-40 rounded-md border border-hairline/70 bg-card p-2 shadow-[0_12px_32px_rgb(37_31_24_/_0.14)] sm:absolute sm:inset-x-auto sm:bottom-full sm:right-0 sm:mb-1.5 sm:w-[218px]"
        >
          <div className="border-b border-hairline/50 px-1 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">
            Mark this record
          </div>
          <div className="grid grid-cols-6 justify-items-center gap-0.5">
            {EXTENDED_SET.map((emoji) => {
              const { label, Icon } = reactionMeta(emoji);
              const selected = (message.reactions ?? []).some((reaction) => reaction.emoji === emoji && reaction.by === "user");
              return (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => {
                    dispatch({ type: "toggleReaction", threadId, messageId: message.id, emoji });
                    setPickerOpen(false);
                    toggleRef.current?.focus();
                  }}
                  aria-label={`${selected ? "Remove" : "Add"} ${label.toLowerCase()} mark`}
                  aria-pressed={selected}
                  title={label}
                  className={cn(
                    "flex size-9 items-center justify-center rounded-sm text-ink-secondary hover:bg-control hover:text-ink",
                    selected && "bg-accent/15 text-accent",
                  )}
                >
                  <Icon size={15} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function ReactionChips({
  threadId,
  message,
  members,
  align = "left",
}: {
  threadId: string;
  message: Message;
  members?: Bot[];
  align?: "left" | "right";
}) {
  const { dispatch } = useStore();
  const reactions = message.reactions ?? [];
  if (!reactions.length) return null;
  // Group identical marks into one accountable summary.
  const grouped = new Map<string, string[]>();
  for (const r of reactions) grouped.set(r.emoji, [...(grouped.get(r.emoji) ?? []), r.by]);
  const nameOf = (by: string) =>
    by === "user" ? "You" : (members?.find((b) => b.id === by)?.name ?? "Operator");
  return (
    <div className={cn("mt-1 flex flex-wrap gap-1", align === "right" ? "justify-end" : "justify-start")}>
      {[...grouped].map(([emoji, bys]) => {
        const { label, Icon } = reactionMeta(emoji);
        const names = bys.map(nameOf).join(", ");
        const selected = bys.includes("user");
        return (
          <button
            key={emoji}
            type="button"
            onClick={() => dispatch({ type: "toggleReaction", threadId, messageId: message.id, emoji })}
            aria-label={`${selected ? "Remove your" : "Add"} ${label.toLowerCase()} mark. Marked by ${names}`}
            aria-pressed={selected}
            title={`${label} · ${names}`}
            className={cn(
              "flex min-h-9 items-center gap-1 rounded-sm border px-2 py-1 text-[12px] leading-none",
              selected
                ? "border-accent/60 bg-accent/15 text-accent"
                : "border-hairline/60 bg-panel text-ink-secondary hover:bg-control hover:text-ink",
            )}
          >
            <Icon size={11} aria-hidden="true" />
            {bys.length > 1 && <span className="text-[11px] tabular-nums">{bys.length}</span>}
          </button>
        );
      })}
    </div>
  );
}
