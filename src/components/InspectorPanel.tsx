// The raw event inspector: what a thread's turns actually looked like on
// the wire, for the moment a bot misbehaves and the chat view can't say
// why. Two lenses over the same thread:
//
//   Events — the harness's normalized RuntimeEvent stream: turns, tool
//            items, requests, token usage, errors. Follows live over SSE.
//   Raw    — the provider's own protocol messages, verbatim (the native
//            tee). Read from disk; refreshed when a turn settles.
//
// Nothing here is captured for the panel's sake - both logs already exist
// under ~/.helmryth (server/harness/bus.ts, server/drivers/native.ts).
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown, ChevronRight, RefreshCw, Waypoints, X } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { formatTime, toRows, type InspectorEntry, type InspectorPage, type InspectorRow } from "@/lib/inspector";
import { openLiveEvents } from "@/lib/live-events";
import {
  captureFocusRestoreTarget,
  consumeTopmostEscape,
  type FocusTargetLike,
  restoreOverlayFocus,
} from "@/lib/overlay-focus";
import type { RuntimeEvent } from "../../server/contracts.ts";

type Lens = "events" | "raw";
export type InspectorLayoutMode = "dock" | "overlay";

const INSPECTOR_OVERLAY_QUERY = "(max-width: 767px)";
const INSPECTOR_FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const TRACE_LAUNCHER_SELECTOR = "[data-helmryth-trace-opener]";

export function inspectorLayoutModeForWidth(width: number): InspectorLayoutMode {
  return width < 768 ? "overlay" : "dock";
}

export function cycleInspectorFocus<T>(controls: readonly T[], active: T | null, backwards: boolean): T | null {
  if (controls.length === 0) return null;
  const index = active === null ? -1 : controls.indexOf(active);
  if (index < 0) return backwards ? controls[controls.length - 1] : controls[0];
  return controls[(index + (backwards ? -1 : 1) + controls.length) % controls.length];
}

function readInspectorLayoutMode(): InspectorLayoutMode {
  const matchMedia = globalThis.window?.matchMedia;
  if (!matchMedia) return "dock";
  return matchMedia(INSPECTOR_OVERLAY_QUERY).matches ? "overlay" : "dock";
}

function focusableInspectorControls(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(INSPECTOR_FOCUSABLE_SELECTOR)).filter(
    (control) => !control.hasAttribute("disabled") && !control.hidden && control.tabIndex !== -1,
  );
}

export function InspectorShell({
  mode,
  titleId,
  overlayRef,
  panelRef,
  onClose,
  children,
}: {
  mode: InspectorLayoutMode;
  titleId: string;
  overlayRef?: RefObject<HTMLDivElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children?: ReactNode;
}) {
  const panel = (
    <aside
      ref={panelRef}
      aria-labelledby={titleId}
      aria-modal={mode === "overlay" ? "true" : undefined}
      role={mode === "overlay" ? "dialog" : undefined}
      className={cn(
        "flex min-h-0 min-w-0 flex-col bg-panel",
        mode === "dock"
          ? "animate-panel-in h-full w-[460px] shrink-0 border-l border-hairline/40"
          : "animate-pop-in relative z-10 h-full w-full max-w-full overflow-hidden shadow-xl",
      )}
    >
      {children}
    </aside>
  );

  if (mode === "dock") return panel;

  return (
    <div ref={overlayRef} className="fixed inset-0 z-40 overflow-hidden md:hidden">
      <div
        aria-hidden="true"
        onMouseDown={onClose}
        className="absolute inset-0 bg-ink/20 backdrop-blur-[1px]"
      />
      {panel}
    </div>
  );
}

export function InspectorPanel({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const threadId = bot.threadId;
  const [lens, setLens] = useState<Lens>("events");
  const [page, setPage] = useState<InspectorPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const overlayReturnFocusRef = useRef<FocusTargetLike | null>(null);
  const stickToBottom = useRef(true);
  const loadAbort = useRef<AbortController | null>(null);
  const managedRefresh = useRef<() => void>(() => {});
  const [layoutMode, setLayoutMode] = useState<InspectorLayoutMode>(() => readInspectorLayoutMode());
  const titleId = useId();
  const closeInspector = useCallback(() => {
    dispatch({ type: "toggleInspector", open: false });
  }, [dispatch]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || overlayReturnFocusRef.current) return;
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlayReturnFocusRef.current = captureFocusRestoreTarget(activeElement, panel);
  }, []);

  useEffect(() => {
    const matchMedia = globalThis.window?.matchMedia;
    if (!matchMedia) return;
    const mediaQuery = matchMedia(INSPECTOR_OVERLAY_QUERY);
    const sync = (matches: boolean) => setLayoutMode(matches ? "overlay" : "dock");
    sync(mediaQuery.matches);
    const onChange = (event: MediaQueryListEvent) => {
      sync(event.matches);
    };
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", onChange);
      return () => mediaQuery.removeEventListener("change", onChange);
    }
    mediaQuery.addListener(onChange);
    return () => mediaQuery.removeListener(onChange);
  }, []);

  useEffect(() => {
    const windowRef = globalThis.window;
    const documentRef = globalThis.document;
    const panel = panelRef.current;
    return () => {
      restoreOverlayFocus(overlayReturnFocusRef.current, {
        fallback: () => documentRef?.querySelector<HTMLElement>(TRACE_LAUNCHER_SELECTOR) ?? null,
        schedule: (callback) => windowRef?.requestAnimationFrame(callback) ?? callback(),
        block: () => panel?.isConnected === true,
      });
    };
  }, []);

  const load = useCallback(async (): Promise<boolean> => {
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    try {
      const res = await fetch(`/api/threads/${threadId}/events?limit=400`, { signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status}`);
      // SAFETY: this same-version renderer calls the harness's typed
      // inspector endpoint; malformed transport data is handled by catch.
      const next = (await res.json()) as InspectorPage;
      if (controller.signal.aborted) return false;
      setPage(next);
      setError(null);
      return true;
    } catch (e) {
      if (controller.signal.aborted) return false;
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      if (loadAbort.current === controller) loadAbort.current = null;
    }
  }, [threadId]);

  // history from disk on open / thread change
  useEffect(() => {
    setPage(null);
    setExpanded(new Set());
    stickToBottom.current = true;
    void load();
    return () => loadAbort.current?.abort();
  }, [load]);

  // live: append this thread's runtime events as they stream, and re-read
  // the disk when a turn settles so the native tee (not on the SSE) catches
  // up. Own EventSource on purpose: the store folds runtime events into
  // chat state and does not re-emit them.
  useEffect(() => {
    let alive = true;
    let settle: ReturnType<typeof setTimeout> | null = null;
    let refreshGeneration = 0;
    let refreshing = false;
    const pendingRuntime: RuntimeEvent[] = [];

    const appendRuntime = (runtime: RuntimeEvent) => {
      setPage((prev) => {
        // A disk refresh and replay can overlap. eventId is canonical, so a
        // replayed entry already present in the snapshot is an exact no-op.
        if (
          prev?.entries.some(
            (entry) => entry.kind === "runtime" && entry.data.eventId === runtime.eventId,
          )
        ) {
          return prev;
        }
        const entry: InspectorEntry = { kind: "runtime", at: runtime.createdAt, data: runtime };
        if (!prev) return { entries: [entry], total: { runtime: 1, native: 0 } };
        return { entries: [...prev.entries, entry], total: { ...prev.total, runtime: prev.total.runtime + 1 } };
      });
    };

    const flushPendingRuntime = () => {
      for (const runtime of pendingRuntime.splice(0)) appendRuntime(runtime);
    };

    const refresh = async (flushLiveOnFailure: boolean): Promise<boolean> => {
      const generation = ++refreshGeneration;
      refreshing = true;
      const loaded = await load();
      // A later refresh aborts the earlier fetch. Only its completion owns
      // the buffered live tail, otherwise the earlier finally can flush
      // frames immediately before the newer snapshot overwrites them.
      if (!alive || generation !== refreshGeneration) return false;
      refreshing = false;
      // An ordinary Reload keeps the previous page when its fetch fails, so
      // live frames buffered during that request still belong on that page.
      // A replacement snapshot must not expose them: its caller will close
      // and replay the stream from the last acknowledged cursor instead.
      if (!loaded) {
        if (flushLiveOnFailure) flushPendingRuntime();
        return false;
      }
      flushPendingRuntime();
      return true;
    };
    const requestRefresh = () => void refresh(true);
    const refreshFromSnapshot = (): Promise<boolean> => {
      // A refused resume starts a new stream generation. Frames retained by
      // an earlier failed refresh will be present in the new disk snapshot or
      // replayed again, so do not carry them across the generation boundary.
      pendingRuntime.splice(0);
      return refresh(false);
    };
    managedRefresh.current = requestRefresh;

    const stopLive = openLiveEvents({
      screens: false,
      onSnapshotRequired: refreshFromSnapshot,
      onFrame: (frame) => {
        if (frame.kind !== "runtime") return;
        const event = frame.event;
        if (!event || Array.isArray(event) || Object(event) !== event) return;
        // SAFETY: runtime stream frames are produced from the typed harness
        // bus; this guard rejects non-object transport corruption.
        const runtime = event as RuntimeEvent;
        if (runtime.threadId !== threadId) return;
        if (refreshing) pendingRuntime.push(runtime);
        else appendRuntime(runtime);
        if (runtime.type === "turn.completed" || runtime.type === "runtime.error") {
          if (settle) clearTimeout(settle);
          settle = setTimeout(requestRefresh, 400);
        }
      },
    });
    return () => {
      alive = false;
      if (managedRefresh.current === requestRefresh) managedRefresh.current = () => {};
      stopLive();
      if (settle) clearTimeout(settle);
    };
  }, [threadId, load]);

  const entries = useMemo(
    () => (page ? page.entries.filter((e) => (lens === "raw" ? e.kind === "native" : e.kind === "runtime")) : []),
    [page, lens],
  );
  const rows = useMemo(() => toRows(entries), [entries]);

  // follow the tail unless the user has scrolled up to read
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [page?.entries.length, rows.length, lens]);
  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const shown = entries.length;
  const total = lens === "raw" ? (page?.total.native ?? 0) : (page?.total.runtime ?? 0);

  useEffect(() => {
    const documentRef = globalThis.document;
    const windowRef = globalThis.window;
    if (layoutMode !== "overlay" || !documentRef || !windowRef) return;
    const panel = panelRef.current;
    if (!panel) return;
    const previousOverflow = documentRef.body.style.overflow;
    documentRef.body.style.overflow = "hidden";
    const frame = windowRef.requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });
    const onKey = (event: KeyboardEvent) => {
      if (consumeTopmostEscape(event, panel, closeInspector, documentRef)) return;
      if (event.key !== "Tab") return;
      const controls = focusableInspectorControls(panel);
      const active = documentRef.activeElement instanceof HTMLElement ? documentRef.activeElement : null;
      const next = cycleInspectorFocus(controls, active, event.shiftKey);
      if (!next) return;
      if (!active || !controls.includes(active)) {
        event.preventDefault();
        next.focus();
        return;
      }
      const edge = event.shiftKey ? controls[0] : controls[controls.length - 1];
      if (active !== edge) return;
      event.preventDefault();
      next.focus();
    };
    windowRef.addEventListener("keydown", onKey, true);
    return () => {
      windowRef.cancelAnimationFrame(frame);
      windowRef.removeEventListener("keydown", onKey, true);
      documentRef.body.style.overflow = previousOverflow;
    };
  }, [layoutMode, closeInspector]);

  return (
    <InspectorShell
      mode={layoutMode}
      titleId={titleId}
      overlayRef={overlayRef}
      panelRef={panelRef}
      onClose={closeInspector}
    >
      <div className="flex items-center justify-between px-4 py-3">
        <h2 id={titleId} className="flex items-center gap-2 text-[15px] font-semibold text-ink">
          <Waypoints size={16} className="text-accent" /> Trace
        </h2>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={closeInspector}
          aria-label="Close Trace"
          title="Close Trace"
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/30"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex items-center gap-2 border-b border-hairline/40 px-4 pb-3">
        <div className="flex rounded-lg bg-inset p-0.5">
          {(["events", "raw"] as const).map((l) => (
            <button
              type="button"
              key={l}
              onClick={() => setLens(l)}
              aria-pressed={lens === l}
              className={cn(
                "rounded-md px-2.5 py-1 text-[12px] font-medium capitalize",
                lens === l ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              {l === "raw" ? "Provider" : "Events"}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-ink-secondary" role="status" aria-live="polite">
          {page ? (shown < total ? `last ${shown} of ${total}` : `${shown} entries`) : "loading…"}
        </span>
        <button
          type="button"
          onClick={() => managedRefresh.current()}
          aria-label="Reload Trace from disk"
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          title="Reload from disk"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <div ref={listRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto font-mono text-[11.5px]">
        {error && <div className="px-4 py-3 text-danger">Trace could not load: {error}</div>}
        {page && rows.length === 0 && !error && (
          <div className="px-4 py-6 text-ink-secondary">
            {lens === "raw" ? "No provider protocol entries recorded for this workstream." : "No runtime events recorded for this workstream."}
          </div>
        )}
        {rows.map((row) => (
          <Row key={row.key} row={row} open={expanded.has(row.key)} onToggle={() => toggle(row.key)} />
        ))}
      </div>
    </InspectorShell>
  );
}

function Row({ row, open, onToggle }: { row: InspectorRow; open: boolean; onToggle: () => void }) {
  return (
    <div
      className={cn(
        "border-b border-hairline/20",
        row.tone === "boundary" && "bg-raised/40",
        row.tone === "error" && "bg-danger/10",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-raised/60"
      >
        <span className="mt-[1px] shrink-0 text-ink-secondary">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
        <span className="shrink-0 tabular-nums text-ink-secondary">{formatTime(row.at)}</span>
        <span
          className={cn(
            "shrink-0 rounded px-1 text-[10.5px]",
            row.kind === "native" ? "bg-accent/15 text-accent" : row.tone === "error" ? "bg-danger/20 text-danger" : "bg-inset text-ink-secondary",
          )}
        >
          {row.tag}
          {row.count > 1 ? ` ×${row.count}` : ""}
        </span>
        <span className={cn("min-w-0 flex-1 truncate", row.tone === "error" ? "text-danger" : "text-ink")}>{row.summary}</span>
      </button>
      {open && (
        <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all border-t border-hairline/20 bg-app px-3 py-2 text-[11px] leading-relaxed text-ink">
          {JSON.stringify(row.data, null, 2)}
        </pre>
      )}
    </div>
  );
}
