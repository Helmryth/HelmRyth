// Workstream records found from the roster search. The transport still uses
// the established search contract; this surface gives each hit enough origin
// and path context to be useful before the user opens it.
import { useEffect, useState } from "react";
import { FileText, GitBranch, Wrench } from "lucide-react";
import { api, useStore, formatTime } from "@/state/store";
import { SigilAvatar } from "./Avatar";
import { cn } from "@/lib/cn";
import type { SearchHit } from "@/lib/search-hit";
import { landOnSearchHit } from "@/lib/focus-message";

export const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

export function SearchResults({ query, onLanded }: { query: string; onLanded: () => void }) {
  const { state, dispatch } = useStore();
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = query.trim();

  useEffect(() => {
    if (q.length < MIN_QUERY) {
      setHits(null);
      setError(null);
      return;
    }
    // Do not leave the previous query's hits clickable while the debounced
    // request for this query is still in flight.
    setHits(null);
    setError(null);
    let alive = true;
    const t = setTimeout(() => {
      api(`/api/search?q=${encodeURIComponent(q)}&limit=40`)
        .then((r: { hits: SearchHit[] }) => alive && (setHits(r.hits), setError(null)))
        .catch((error: Error) => alive && setError(error.message));
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);

  if (q.length < MIN_QUERY) return null;

  const land = async (hit: SearchHit) => {
    try {
      await landOnSearchHit(hit, state, dispatch);
      onLanded();
    } catch (e) {
      dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <section className="mt-2 border-t border-hairline/60 pt-2" aria-label="Workstream search results" aria-busy={!hits && !error}>
      <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">
        Workstream records{hits ? ` · ${hits.length}${hits.length === 40 ? "+" : ""}` : ""}
      </div>
      {!hits && !error && (
        <div role="status" className="px-3 py-3 text-[12.5px] text-ink-secondary">
          Searching across workstreams…
        </div>
      )}
      {error && (
        <div role="alert" className="border-l-2 border-danger px-3 py-2 text-[12.5px] text-danger">
          Search stopped. {error}
        </div>
      )}
      {hits && hits.length === 0 && !error && (
        <div role="status" className="px-3 py-3 text-[13px] leading-relaxed text-ink-secondary">
          No workstream records match “{q}”. Try a name, phrase, or file reference.
        </div>
      )}
      {hits?.map((hit) => {
        const bot = hit.botId ? state.bots.find((b) => b.id === hit.botId) : undefined;
        const before = hit.snippet.slice(0, hit.matchStart);
        const match = hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength);
        const after = hit.snippet.slice(hit.matchStart + hit.matchLength);
        return (
          <button
            key={`${hit.threadId}:${hit.messageId}`}
            type="button"
            onClick={() => void land(hit)}
            aria-label={`Open record from ${hit.from ?? hit.name}${hit.task ? ` in ${hit.task}` : ""}`}
            className="flex w-full items-start gap-2.5 border-l-2 border-transparent px-3 py-2 text-left hover:border-accent hover:bg-raised/60"
          >
            {bot ? (
              <SigilAvatar color={bot.color} state="idle" size={26} animated={false} />
            ) : (
              <span className="flex size-[26px] shrink-0 items-center justify-center rounded-sm border border-hairline/60 bg-raised text-ink-secondary">
                <FileText size={13} aria-hidden="true" />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5 text-[12px] text-ink-secondary">
                <span className="truncate font-medium text-ink">{hit.from ?? hit.name}</span>
                {hit.task ? <span className="truncate">· Run: {hit.task}</span> : null}
                <span className="ml-auto shrink-0 tabular-nums">{formatTime(hit.at)}</span>
              </span>
              <span className={cn("mt-0.5 line-clamp-2 text-[12.5px] leading-snug", hit.role === "user" ? "text-ink" : "text-ink-secondary")}>
                {hit.kind === "activity" && <Wrench size={11} className="mr-1 inline text-ink-secondary" />}
                {before}
                <mark className="rounded-sm bg-accent/25 px-0.5 text-ink">{match}</mark>
                {after}
              </span>
              {!hit.onActivePath && (
                <span className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-secondary">
                  <GitBranch size={10} aria-hidden="true" /> Alternate path
                </span>
              )}
            </span>
          </button>
        );
      })}
    </section>
  );
}
