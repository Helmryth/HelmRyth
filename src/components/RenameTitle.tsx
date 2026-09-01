// Direct, keyboard-operable naming for an operator title. The full operator
// record remains available through the adjacent activation target.
import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";

import { nextRename } from "@/lib/rename";
import { cn } from "@/lib/cn";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";

export function RenameTitle({
  value,
  onCommit,
  onEditingChange,
  onActivate,
  showEditButton = false,
  focusable = true,
  className,
  inputClassName,
}: {
  value: string;
  onCommit: (next: string) => void;
  onEditingChange?: (editing: boolean) => void;
  /** Optional single-click action for locations where the title opens a profile. */
  onActivate?: () => void;
  /** Drop the button role and tab stop. Required where this sits inside an
   * ancestor that is itself a button: nesting one button inside another is
   * invalid ARIA, and the focusable descendant is what axe flags. Double-click
   * to rename still works; keyboard rename stays on the header's edit button. */
  focusable?: boolean;
  /** Preserve deliberate inline rename beside an onActivate title. */
  showEditButton?: boolean;
  className?: string;
  inputClassName?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const setMode = (next: boolean) => {
    setEditing(next);
    onEditingChange?.(next);
  };

  const finish = (save: boolean) => {
    const next = save ? nextRename(value, draft) : null;
    setMode(false);
    if (next) onCommit(next);
    else setDraft(value);
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        maxLength={BOT_PROFILE_LIMITS.name}
        aria-label={`New operator name for ${value}`}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => finish(true)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            finish(true);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(false);
          }
        }}
        className={cn("min-w-0 border-b border-accent bg-transparent text-ink focus:outline-none", inputClassName)}
      />
    );
  }

  const startRename = (event: { preventDefault(): void; stopPropagation(): void }) => {
    event.preventDefault();
    event.stopPropagation();
    setDraft(value);
    setMode(true);
  };

  if (showEditButton) {
    return (
      <span className="flex min-w-0 items-center gap-0.5">
        {onActivate ? (
          <button
            type="button"
            onClick={onActivate}
            aria-label={`Open ${value}'s operator profile`}
            // min-h-6 belongs here, not in each caller's class string. At 15px
            // on a 1.5 line box this measured 39x23 CSS px — one pixel under the
            // WCAG 2.5.8 floor — and pinning it in ChatView alone left every
            // other `showEditButton` caller (GroupView among them) short.
            className={cn("inline-block min-h-6 min-w-0 truncate text-left", className)}
            title="Open operator profile"
          >
            {value}
          </button>
        ) : (
          <span className={cn("min-w-0 truncate", className)}>{value}</span>
        )}
        <button
          type="button"
          onClick={startRename}
          aria-label={`Rename operator ${value}`}
          title="Rename operator"
          className="flex size-10 shrink-0 items-center justify-center rounded-sm text-ink-secondary opacity-70 hover:bg-raised hover:text-ink hover:opacity-100"
        >
          <Pencil size={12} />
        </button>
      </span>
    );
  }

  return (
    <span
      // min-h-6 + centring keeps this rename target at the 24px WCAG 2.5.8
      // minimum; the bare text box measured 22.5px tall.
      className={cn("inline-flex min-h-6 items-center cursor-text", className)}
      title="Double-click to rename operator"
      tabIndex={focusable ? 0 : undefined}
      role={focusable ? "button" : undefined}
      aria-label={focusable ? `Rename operator ${value}` : undefined}
      onDoubleClick={startRename}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          startRename(event);
        }
      }}
    >
      {value}
    </span>
  );
}
