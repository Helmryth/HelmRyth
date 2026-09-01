// ⌘K switcher: bots and rooms from local state, transcript hits from
// /api/search. Self-contained — owns its open state and its global chord,
// so App.tsx only mounts it.
import { useEffect, useRef, useState } from "react";
import { CircleGauge as OperatorIcon, MessageSquare, Search, Users } from "lucide-react";
import { api, useStore, type Bot, type Group } from "@/state/store";
import { rankByName } from "@/lib/palette-rank";
import { cn } from "@/lib/cn";
import type { SearchHit } from "@/lib/search-hit";
import { landOnSearchHit } from "@/lib/focus-message";

type PaletteEntry =
  | { kind: "bot"; bot: Bot }
  | { kind: "room"; group: Group }
  | { kind: "message"; hit: SearchHit };

export function CommandPalette({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [messageHits, setMessageHits] = useState<SearchHit[]>([]);
  const [searchError, setSearchError] = useState(false);
  const [cursor, setCursor] = useState(0);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // The chord fires from anywhere — Shell's app-wide shortcuts (⌘N, ⌘1–9)
  // set the precedent of not guarding against focused inputs, and a
  // modifier chord never collides with typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // fresh palette every open; stale queries from last time would flash
  useEffect(() => {
    if (!open) return;
    // Capture the caller's focus before moving it into the search field. An
    // `autoFocus` attribute would run during commit — ahead of this effect —
    // so the ref would capture the palette's own input and closing would
    // restore focus to a detached node.
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    searchRef.current?.focus();
    setQuery("");
    setMessageHits([]);
    setSearchError(false);
    setCursor(0);
  }, [open]);

  useEffect(() => {
    if (open || !returnFocusRef.current) return;
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    // Restore on the next frame. Calling focus() synchronously here lands while
    // the dialog is still being torn down, and the browser discards it — the
    // call is made but no focusin ever fires and focus falls to <body>.
    const frame = requestAnimationFrame(() => target.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    onOpenChange?.(open);
  }, [onOpenChange, open]);

  const q = query.trim().toLowerCase();

  // Same debounce pattern as the sidebar search: names answer instantly
  // from local state, transcript hits arrive a beat later, and a stale
  // response for an outdated query is dropped.
  useEffect(() => {
    if (!open || !q) {
      setMessageHits([]);
      setSearchError(false);
      return;
    }
    // Results for the previous query must not remain clickable while the
    // debounce and request for this query are pending.
    setMessageHits([]);
    setSearchError(false);
    let alive = true;
    const timer = setTimeout(() => {
      api(`/api/search?q=${encodeURIComponent(q)}&limit=12`)
        .then((result: { hits?: SearchHit[] }) => {
          if (!alive) return;
          setMessageHits(result.hits ?? []);
          setSearchError(false);
        })
        .catch(() => {
          if (!alive) return;
          setMessageHits([]);
          setSearchError(true);
        });
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, q]);

  useEffect(() => setCursor(0), [q]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [cursor, messageHits]);

  if (!open) return null;

  const bots = rankByName(state.bots.filter((b) => !b.hidden), q);
  const rooms = rankByName(state.groups, q);
  const entries: PaletteEntry[] = [
    ...bots.map((bot): PaletteEntry => ({ kind: "bot", bot })),
    ...rooms.map((group): PaletteEntry => ({ kind: "room", group })),
    // message hits only make sense for a typed query; empty = switcher mode
    ...(q ? messageHits.map((hit): PaletteEntry => ({ kind: "message", hit })) : []),
  ];
  // hits arriving or rows filtering away can strand the cursor past the end
  const selected = entries.length ? Math.min(cursor, entries.length - 1) : 0;

  const activate = async (entry: PaletteEntry) => {
    if (entry.kind === "message") {
      const hit = entry.hit;
      try {
        await landOnSearchHit(hit, state, dispatch);
      } catch (error) {
        dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    } else {
      dispatch({ type: "select", id: entry.kind === "bot" ? entry.bot.id : entry.group.id });
    }
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      // shield the window listeners other modals hang their own Esc on
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "Tab") {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
        'input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (controls.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(entries.length ? (selected + 1) % entries.length : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(entries.length ? (selected - 1 + entries.length) % entries.length : 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = entries[selected];
      if (entry) void activate(entry);
    }
  };

  // flat cursor across sections; each row needs its absolute index
  const roomOffset = bots.length;
  const messageOffset = bots.length + rooms.length;

  const row = (key: string, index: number, onPick: () => void, children: React.ReactNode, twoLine = false) => (
    <button
      key={key}
      ref={index === selected ? selectedRef : undefined}
      onClick={onPick}
      // mousemove, not mouseenter: rows shifting under a resting pointer
      // (hits arriving) must not steal the keyboard selection
      onMouseMove={() => setCursor(index)}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left",
        twoLine && "flex-col items-stretch gap-0.5",
        index === selected ? "bg-raised" : "hover:bg-raised/50",
      )}
    >
      {children}
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/20 p-6 pt-[14vh]"
      onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
      onKeyDown={onKeyDown}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Helmryth command palette"
        tabIndex={-1}
        className="flex max-h-[min(480px,70vh)] w-full max-w-[560px] flex-col overflow-hidden rounded-md border border-hairline/60 bg-panel shadow-xl"
      >
        <div className="flex items-center gap-3 border-b border-hairline/40 px-4 py-3">
          <Search size={16} className="shrink-0 text-ink-secondary" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search operators, crews, workstreams…"
            className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
          <kbd className="shrink-0 rounded-md border border-hairline/40 px-1.5 py-0.5 text-[11px] text-ink-secondary">
            esc
          </kbd>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {searchError && (
            <div role="status" className="mx-2 mb-2 border-y border-warning/35 bg-warning/10 px-3 py-2 text-[12px] text-ink-secondary">
              Workstream search is unavailable. Operator and crew matches are still current.
            </div>
          )}
          {entries.length === 0 && !searchError && (
            <div className="px-3 py-6 text-center text-[13px] text-ink-secondary">
              {q ? `No operators, crews, or workstreams match “${query}”` : "Create an operator or crew to begin."}
            </div>
          )}
          {bots.length > 0 && (
            <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
              Operators
            </div>
          )}
          {bots.map((bot, i) =>
            row(
              `bot:${bot.id}`,
              i,
              () => void activate({ kind: "bot", bot }),
              <>
                <OperatorIcon size={16} className="shrink-0 text-ink-secondary" />
                <span className="truncate text-[14px] text-ink">{bot.name}</span>
                {bot.title && (
                  <span className="min-w-0 truncate text-[12.5px] text-ink-secondary">{bot.title}</span>
                )}
              </>,
            ),
          )}
          {rooms.length > 0 && (
            <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
              Crews
            </div>
          )}
          {rooms.map((group, i) =>
            row(
              `room:${group.id}`,
              roomOffset + i,
              () => void activate({ kind: "room", group }),
              <>
                <Users size={16} className="shrink-0 text-ink-secondary" />
                <span className="truncate text-[14px] text-ink">{group.name}</span>
              </>,
            ),
          )}
          {q && messageHits.length > 0 && (
            <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
              Workstreams
            </div>
          )}
          {q &&
            messageHits.map((hit, i) => {
              const before = hit.snippet.slice(0, hit.matchStart);
              const match = hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength);
              const after = hit.snippet.slice(hit.matchStart + hit.matchLength);
              return row(
                `msg:${hit.threadId}:${hit.messageId}`,
                messageOffset + i,
                () => void activate({ kind: "message", hit }),
                <>
                  <span className="flex items-center gap-2 truncate text-[13px] font-medium text-ink">
                    <MessageSquare size={13} className="shrink-0 text-ink-secondary" />
                    {hit.name}
                    {hit.task ? <span className="font-normal text-ink-secondary"> · {hit.task}</span> : null}
                  </span>
                  <span className="line-clamp-2 text-[12.5px] text-ink-secondary">
                    {before}<mark className="rounded-sm bg-accent/25 px-0.5 text-ink">{match}</mark>{after}
                  </span>
                </>,
                true,
              );
            })}
        </div>
      </div>
    </div>
  );
}
