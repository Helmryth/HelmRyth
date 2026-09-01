// Runs are durable work boundaries. Historical store action and type names
// stay intact while the user-facing surface follows Helmryth vocabulary.
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronDown, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useStore, formatTime, type Bot, type Group, type Task } from "@/state/store";
import { cn } from "@/lib/cn";
import { COMPACT_BUBBLE } from "@/lib/compact-chip";
import { formatTokens } from "@/lib/format-tokens";
import { nextRename } from "@/lib/rename";

/** Click-to-switch used to close this menu immediately, which unmounted the
 * row before a double-click (or right-click) could start a rename. Linger
 * just long enough for the second click to land; rename cancels the close. */
export const TASK_PICKER_DISMISS_MS = 500;

export const TASK_RENAME_HINT = "Click to open · double-click or right-click to rename this run";

/** One explicit name prevents the visible title and tally from collapsing
 * into an ambiguous string such as “Launch review2” in assistive tech. */
export function runLedgerTriggerLabel(title: string | undefined, count: number): string {
  const runTitle = title?.trim() || "Current run";
  return `Open run ledger for ${runTitle}. ${count} ${count === 1 ? "run" : "runs"}.`;
}

/** Parentheses keep the compact visible tally distinct from the run title,
 * including in text-only snapshots where flexbox gaps do not exist. */
export function runLedgerTriggerCount(count: number): string {
  return `(${count})`;
}

/** Decide what a pointer event on a task row should do. The click that
 * accompanies a dblclick (detail >= 2) must not switch/close — that is
 * what used to eat the advertised rename. */
export function taskPickerPointerIntent(
  type: string,
  detail = 1,
): "select" | "rename" | "ignore" {
  if (type === "dblclick" || type === "contextmenu") return "rename";
  if (type === "click" && detail >= 2) return "ignore";
  if (type === "click") return "select";
  return "ignore";
}

/** Filter the task switcher. Prefix matches float first so a few letters
 * still find the right row in a long list; within a tier the caller's
 * order (newest first) is preserved. */
export function filterTasks<T extends { title: string }>(tasks: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...tasks];
  const prefix: T[] = [];
  const substring: T[] = [];
  for (const task of tasks) {
    const title = task.title.toLowerCase();
    if (title.startsWith(needle)) prefix.push(task);
    else if (title.includes(needle)) substring.push(task);
  }
  return [...prefix, ...substring];
}

/** Quiet per-task token tally — input+output combined, because one honest
 * total reads faster than a split; the split lives in the hover title. */
function TaskUsage({ usage }: { usage: Task["usage"] }) {
  if (!usage) return null;
  const label = formatTokens(usage.input + usage.output);
  if (!label) return null;
  return (
    <span title={`${usage.input.toLocaleString()} in · ${usage.output.toLocaleString()} out`}>
      {" · "}
      {label}
    </span>
  );
}

type PickerTask = Pick<Task, "threadId" | "title" | "createdAt"> & { usage?: Task["usage"] };

function ConversationTaskPicker({
  threadId,
  tasks,
  busy,
  onNew,
  onSwitch,
  onRename,
  onDelete,
}: {
  threadId: string;
  tasks: PickerTask[];
  busy: boolean;
  onNew: () => void;
  onSwitch: (threadId: string) => void;
  onRename: (threadId: string, title: string) => void;
  onDelete: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishingRename = useRef(false);
  const panelId = useId();

  const current = tasks.find((t) => t.threadId === threadId);

  const clearDismiss = () => {
    if (dismissTimer.current) {
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
  };

  const closeMenu = () => {
    clearDismiss();
    setRenaming(null);
    setConfirmDelete(null);
    setQuery("");
    setOpen(false);
  };

  const queueDismiss = () => {
    clearDismiss();
    dismissTimer.current = setTimeout(() => {
      dismissTimer.current = null;
      setRenaming(null);
      setOpen(false);
    }, TASK_PICKER_DISMISS_MS);
  };

  const startRename = (task: PickerTask) => {
    clearDismiss();
    finishingRename.current = false;
    setDraft(task.title);
    setRenaming(task.threadId);
  };

  useEffect(() => () => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
  }, []);

  useEffect(() => {
    if (!open) {
      if (dismissTimer.current) {
        clearTimeout(dismissTimer.current);
        dismissTimer.current = null;
      }
      setRenaming(null);
      setConfirmDelete(null);
      setQuery("");
      return;
    }
    const onDown = (e: MouseEvent) => {
      // SAFETY: a mousedown target inside a document is always a DOM Node
      if (!ref.current?.contains(e.target as Node)) {
        if (dismissTimer.current) {
          clearTimeout(dismissTimer.current);
          dismissTimer.current = null;
        }
        setRenaming(null);
        setConfirmDelete(null);
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (renaming) return;
      if (dismissTimer.current) {
        clearTimeout(dismissTimer.current);
        dismissTimer.current = null;
      }
      setRenaming(null);
      setConfirmDelete(null);
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, renaming]);

  // A single run needs only the action that opens a fresh boundary.
  if (tasks.length <= 1) {
    return (
      <button
        type="button"
        onClick={onNew}
        disabled={busy}
        title={busy ? "Let the current step finish before opening a run" : "Start a fresh run"}
        aria-label={busy ? "New run unavailable while the current step is active" : "Start a fresh run"}
        className={cn(
          "flex min-h-8 items-center gap-1 rounded-sm border border-hairline/60 bg-raised px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40",
          COMPACT_BUBBLE,
        )}
      >
        <Plus size={12} className="@max-4xl/chathead:size-[14px]" aria-hidden="true" />
        <span className="@max-4xl/chathead:hidden">New run</span>
      </button>
    );
  }

  const commitRename = (threadId: string, save: boolean) => {
    // Escape unmounts the input, which fires blur. Without this guard the
    // blur would save the draft the user just cancelled.
    if (finishingRename.current) return;
    finishingRename.current = true;
    const currentTitle = tasks.find((task) => task.threadId === threadId)?.title ?? "";
    const title = save ? nextRename(currentTitle, draft) : null;
    setRenaming(null);
    if (title) onRename(threadId, title);
  };

  // Usage remains secondary; the open run's tally lives in the hover label.
  const u = current?.usage;
  const currentLabel = u ? formatTokens(u.input + u.output) : null;
  const switchTitle =
    u && currentLabel
      ? `Open another run · ${currentLabel} (${u.input.toLocaleString()} in · ${u.output.toLocaleString()} out)`
      : "Open another run";
  const visible = filterTasks(tasks, query);
  const looking = query.trim();

  const moveRunFocus = (event: ReactKeyboardEvent<HTMLElement>, direction: 1 | -1 | "first" | "last") => {
    const choices = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[data-run-choice]") ?? [])];
    if (!choices.length) return;
    event.preventDefault();
    if (direction === "first") {
      choices[0]?.focus();
      return;
    }
    if (direction === "last") {
      choices.at(-1)?.focus();
      return;
    }
    const currentIndex = choices.findIndex((choice) => choice === event.currentTarget);
    const nextIndex = currentIndex < 0 ? (direction === 1 ? 0 : choices.length - 1) : (currentIndex + direction + choices.length) % choices.length;
    choices[nextIndex]?.focus();
  };

  return (
    <div className="relative" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (open) closeMenu();
          else setOpen(true);
        }}
        title={switchTitle}
        aria-label={runLedgerTriggerLabel(current?.title, tasks.length)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={cn(
          "flex min-h-8 max-w-[220px] items-center gap-1.5 rounded-sm border border-hairline/60 bg-raised px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink",
          COMPACT_BUBBLE,
        )}
      >
        <span className="truncate @max-4xl/chathead:hidden">{current?.title ?? "Current run"}</span>
        {/* folded: just the count in the bubble — the title rides the tooltip */}
        <span
          className="shrink-0 tabular-nums opacity-60 @max-4xl/chathead:opacity-100"
          aria-hidden="true"
        >
          {runLedgerTriggerCount(tasks.length)}
        </span>
        <ChevronDown size={12} className="shrink-0 @max-4xl/chathead:hidden" aria-hidden="true" />
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Run ledger"
          className="absolute right-0 top-full z-40 mt-1 w-[320px] overflow-hidden rounded-md border border-hairline/70 bg-panel shadow-lg"
        >
          <div className="border-b border-hairline/40 p-2">
            <div className="flex items-center gap-2 rounded-sm border border-hairline/60 bg-raised px-2.5 py-2 focus-within:border-accent">
              <Search size={13} className="shrink-0 text-ink-secondary" aria-hidden="true" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    if (looking) setQuery("");
                    else closeMenu();
                    return;
                  }
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    const first = visible[0];
                    if (!first) return;
                    if (first.threadId !== threadId) onSwitch(first.threadId);
                    closeMenu();
                    return;
                  }
                  if (e.key === "ArrowDown") moveRunFocus(e, "first");
                  if (e.key === "ArrowUp") moveRunFocus(e, "last");
                }}
                placeholder="Find a run"
                aria-label="Find a run by title"
                className="w-full bg-transparent text-[12.5px] text-ink placeholder:text-ink-secondary focus:outline-none"
              />
            </div>
          </div>
          <div
            className="max-h-[320px] overflow-y-auto"
            role="list"
            aria-label={looking ? `${visible.length} matching runs` : `${visible.length} runs`}
          >
            {visible.length === 0 ? (
              <div className="border-l-2 border-hairline px-3 py-5 text-left" role="status">
                <div className="text-[12px] font-medium text-ink">No run matches “{looking}”</div>
                <div className="mt-1 text-[11px] leading-4 text-ink-secondary">
                  Clear the filter to return to the full run ledger.
                </div>
              </div>
            ) : visible.map((task) => {
              const active = task.threadId === threadId;
              if (confirmDelete === task.threadId) {
                return (
                  <div
                    key={task.threadId}
                    className="border-b border-danger/40 bg-danger/5 px-3 py-3 last:border-b-0"
                    role="listitem"
                  >
                    <div className="text-[12px] font-medium text-ink">Remove “{task.title}”?</div>
                    <div className="mt-1 text-[11px] leading-4 text-ink-secondary">
                      Its transcript and provider session will be removed from this operator.
                    </div>
                    <div className="mt-3 flex justify-end gap-2">
                      <button
                        type="button"
                        autoFocus
                        onClick={() => setConfirmDelete(null)}
                        className="rounded-sm border border-hairline/60 px-2.5 py-1.5 text-[11px] text-ink hover:bg-control"
                      >
                        Keep run
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onDelete(task.threadId);
                          setConfirmDelete(null);
                        }}
                        className="rounded-sm bg-danger px-2.5 py-1.5 text-[11px] font-medium text-[var(--color-danger-ink)]"
                      >
                        Remove run
                      </button>
                    </div>
                  </div>
                );
              }
              return (
                <div
                  key={task.threadId}
                  role="listitem"
                  className={cn(
                    "group flex items-center gap-2 border-b border-hairline/30 px-2.5 py-2 last:border-b-0",
                    active ? "bg-raised" : "hover:bg-raised-hover/40",
                  )}
                >
                  <Check
                    size={13}
                    className={cn("shrink-0", active ? "text-accent" : "opacity-0")}
                    aria-hidden="true"
                  />
                  {renaming === task.threadId ? (
                    <input
                      autoFocus
                      value={draft}
                      maxLength={80}
                      aria-label={`Rename run ${task.title}`}
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => setDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      onBlur={() => commitRename(task.threadId, true)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          e.stopPropagation();
                          commitRename(task.threadId, true);
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          e.stopPropagation();
                          commitRename(task.threadId, false);
                        }
                      }}
                      className="min-w-0 flex-1 rounded-sm border border-accent/60 bg-raised px-1.5 py-1 text-[13px] text-ink focus:outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      data-run-choice
                      aria-current={active ? "page" : undefined}
                      onClick={(e) => {
                        if (taskPickerPointerIntent("click", e.detail) !== "select") return;
                        if (!active) onSwitch(task.threadId);
                        queueDismiss();
                      }}
                      onDoubleClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        startRename(task);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        startRename(task);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowDown") moveRunFocus(event, 1);
                        if (event.key === "ArrowUp") moveRunFocus(event, -1);
                        if (event.key === "Home") moveRunFocus(event, "first");
                        if (event.key === "End") moveRunFocus(event, "last");
                      }}
                      className="min-w-0 flex-1 text-left"
                      title={TASK_RENAME_HINT}
                    >
                      <div className="truncate text-[13px] text-ink">{task.title}</div>
                      <div className="text-[11px] text-ink-secondary">
                        {formatTime(task.createdAt)}
                        <TaskUsage usage={task.usage} />
                      </div>
                    </button>
                  )}
                  {renaming !== task.threadId && (
                    <button
                      type="button"
                      onClick={() => startRename(task)}
                      aria-label={`Rename run ${task.title}`}
                      title="Rename this run"
                      className="rounded-sm p-1.5 text-ink-secondary opacity-0 hover:bg-control hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      <Pencil size={13} aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(task.threadId)}
                    disabled={busy && active}
                    aria-label={`Remove run ${task.title}`}
                    title={busy && active ? "Stop the active step before removing this run" : "Remove this run and its transcript"}
                    className="rounded-sm p-1.5 text-ink-secondary opacity-0 hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 disabled:opacity-20"
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => {
              onNew();
              closeMenu();
            }}
            disabled={busy}
            aria-label={busy ? "New run unavailable while the current step is active" : "Start a fresh run"}
            className="flex w-full items-center gap-2 border-t border-hairline/50 px-3 py-2.5 text-left text-[13px] font-medium text-ink hover:bg-control disabled:opacity-40"
          >
            <Plus size={13} className="text-accent-text" aria-hidden="true" /> Start a fresh run
          </button>
        </div>
      )}
    </div>
  );
}

export function TaskPicker({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  return (
    <ConversationTaskPicker
      threadId={bot.threadId}
      tasks={bot.tasks ?? []}
      busy={Boolean(bot.busy)}
      onNew={() => dispatch({ type: "newTask", botId: bot.id })}
      onSwitch={(threadId) => dispatch({ type: "switchTask", botId: bot.id, threadId })}
      onRename={(threadId, title) => dispatch({ type: "renameTask", botId: bot.id, threadId, title })}
      onDelete={(threadId) => dispatch({ type: "deleteTask", botId: bot.id, threadId })}
    />
  );
}

/** The same task affordance in a channel. DMs never render it because their
 * transcript is the private bot-to-bot exchange rather than user work. */
export function GroupTaskPicker({ group }: { group: Group }) {
  const { dispatch } = useStore();
  return (
    <ConversationTaskPicker
      threadId={group.threadId}
      tasks={group.tasks ?? []}
      busy={Boolean(group.busyBotId)}
      onNew={() => dispatch({ type: "newGroupTask", groupId: group.id })}
      onSwitch={(threadId) => dispatch({ type: "switchGroupTask", groupId: group.id, threadId })}
      onRename={(threadId, title) => dispatch({ type: "renameGroupTask", groupId: group.id, threadId, title })}
      onDelete={(threadId) => dispatch({ type: "deleteGroupTask", groupId: group.id, threadId })}
    />
  );
}
