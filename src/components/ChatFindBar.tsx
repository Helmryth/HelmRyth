import { useEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

import { landOnSearchHit } from "@/lib/focus-message";
import type { SearchHit } from "@/lib/search-hit";
import { api, useStore } from "@/state/store";

export interface WorkstreamFocusTarget {
  focus: () => void;
}

export function restoreWorkstreamFocus(
  target: WorkstreamFocusTarget | null,
  schedule: (callback: () => void) => void = (callback) => requestAnimationFrame(callback),
): void {
  if (!target) return;
  schedule(() => target.focus());
}

export function ChatFindBar({
  threadId,
  onClose,
  returnFocusRef,
}: {
  threadId: string;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { state, dispatch } = useStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const latestStateRef = useRef(state);
  const landedStateRef = useRef(state);
  latestStateRef.current = state;
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    const target = returnFocusRef?.current ?? null;
    onClose();
    restoreWorkstreamFocus(target);
  };

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    const request = ++requestRef.current;
    const stateAtRequest = latestStateRef.current;
    if (!trimmed) {
      setHits([]);
      setIndex(0);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      void api(`/api/search?q=${encodeURIComponent(trimmed)}&limit=100&threadId=${encodeURIComponent(threadId)}`)
        .then((body) => {
          if (request !== requestRef.current) return;
          const nextHits = Array.isArray(body?.hits) ? body.hits : [];
          landedStateRef.current = stateAtRequest;
          setHits(nextHits);
          setIndex(0);
          setError(null);
        })
        .catch((error) => {
          if (request !== requestRef.current) return;
          setHits([]);
          setError(error instanceof Error ? error.message : "The workstream index did not respond.");
        })
        .finally(() => {
          if (request === requestRef.current) setLoading(false);
        });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [dispatch, query, threadId]);

  const land = (next: number) => {
    const hit = hits[next];
    if (!hit) return;
    setIndex(next);
    void landOnSearchHit(hit, state, dispatch).catch((error) =>
      dispatch({ type: "error", message: error instanceof Error ? error.message : "That workstream record is unavailable." }),
    );
  };
  const move = (delta: number) => {
    if (!hits.length) return;
    land((index + delta + hits.length) % hits.length);
  };

  useEffect(() => {
    const first = hits[0];
    if (!first) return;
    void landOnSearchHit(first, landedStateRef.current, dispatch).catch((error) =>
      dispatch({ type: "error", message: error instanceof Error ? error.message : "That workstream record is unavailable." }),
    );
  }, [dispatch, hits]);

  return (
    <div className="w-full border-y border-hairline/60 bg-panel px-5 py-2">
      <div className="flex items-center gap-1.5">
        <Search size={15} aria-hidden="true" className="shrink-0 text-accent" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            } else if (event.key === "Enter") {
              event.preventDefault();
              move(event.shiftKey ? -1 : 1);
            }
          }}
          placeholder="Find in this workstream"
          aria-label="Find in this workstream"
          aria-describedby="workstream-find-status"
          className="min-w-0 flex-1 border-b border-transparent bg-transparent px-1 py-0.5 text-[13px] text-ink outline-none placeholder:text-ink-secondary/70 focus:border-accent"
        />
        <span id="workstream-find-status" aria-live="polite" className="min-w-[76px] text-right text-[11.5px] tabular-nums text-ink-secondary">
          {loading
            ? "Searching…"
            : error
              ? "Search stopped"
              : query.trim()
                ? hits.length
                  ? `${index + 1} of ${hits.length}`
                  : "No matches"
                : ""}
        </span>
        <button
          type="button"
          onClick={() => move(-1)}
          disabled={!hits.length}
          aria-label="Previous matching record"
          title="Previous matching record (Shift+Enter)"
          className="flex size-7 items-center justify-center rounded-sm text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-30"
        >
          <ChevronUp size={15} />
        </button>
        <button
          type="button"
          onClick={() => move(1)}
          disabled={!hits.length}
          aria-label="Next matching record"
          title="Next matching record (Enter)"
          className="flex size-7 items-center justify-center rounded-sm text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-30"
        >
          <ChevronDown size={15} />
        </button>
        <button
          type="button"
          onClick={close}
          aria-label="Close workstream find"
          title="Close workstream find (Escape)"
          className="flex size-7 items-center justify-center rounded-sm text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={15} />
        </button>
      </div>
      {error && <p role="alert" className="mt-1 border-l-2 border-danger pl-2 text-[11.5px] text-danger">Search stopped. {error}</p>}
    </div>
  );
}
