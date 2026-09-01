// The expanded browser surface uses the same native view and control lease as
// its compact Workbench preview, so ownership survives the layout change.
import { useEffect, useRef, useState } from "react";
import { Globe, X } from "lucide-react";
import { z } from "zod";
import { useStore, type Bot } from "@/state/store";
import { BrowserPanel } from "./BrowserPanel";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

const controlSnapshotSchema = z.object({
  held: z.boolean().optional(),
  helpReason: z.string().nullable().optional(),
});

export function BrowserWorkspace({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const control = state.computerControl[bot.id] ?? { held: false, helpReason: null };
  const [controlPending, setControlPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    mainRef.current?.focus();
    return () => {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-browser-workbench-launcher="${CSS.escape(bot.id)}"]`)?.focus();
      });
    };
  }, [bot.id]);

  useEffect(() => {
    let alive = true;
    api(`/api/bots/${bot.id}/computer/control`)
      .then((raw) => {
        if (!alive) return;
        const snap = controlSnapshotSchema.parse(raw);
        dispatch({
          type: "computerControl",
          botId: bot.id,
          held: snap.held === true,
          helpReason: snap.helpReason ?? null,
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [bot.id, dispatch]);

  const controlAction = (action: "take" | "release") => {
    setControlPending(true);
    setError(null);
    api(`/api/bots/${bot.id}/computer/control`, { method: "POST", body: JSON.stringify({ action }) })
      .then((raw) => {
        const snap = controlSnapshotSchema.parse(raw);
        dispatch({
          type: "computerControl",
          botId: bot.id,
          held: snap.held === true,
          helpReason: snap.helpReason ?? null,
        });
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setControlPending(false));
  };

  return (
    <main ref={mainRef} tabIndex={-1} className="flex h-full min-w-0 flex-1 flex-col bg-app outline-none" aria-label={`${bot.name} Browser Workbench`}>
      <header className="flex min-h-[64px] items-center gap-3 border-b border-hairline/60 px-5 py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-hairline/60 bg-inset text-accent">
          <Globe size={18} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.09em] text-ink-secondary">Browser Workbench</div>
          <h1 className="truncate font-display text-[20px] font-semibold leading-tight text-ink">{bot.name}</h1>
          <p className="truncate text-[13px] text-ink-secondary">
            Live page · take the controls when needed · {bot.name} waits while you drive
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex size-9 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
          aria-label="Return browser to Workbench panel"
          title="Return to Workbench panel"
        >
          <X size={18} />
        </button>
      </header>
      {error && (
        <div role="alert" className="mx-5 mt-3 border-l-2 border-danger pl-3 text-[13px] text-danger">
          Browser Workbench controls could not update.
          <details className="mt-1 text-ink-secondary">
            <summary className="cursor-pointer text-[12px]">Technical detail</summary>
            <p className="mt-1 break-words text-[12px]">{error}</p>
          </details>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col px-5 pb-4">
        <BrowserPanel
          bot={bot}
          control={control}
          controlPending={controlPending}
          onControl={controlAction}
          size="expanded"
          onCollapse={onClose}
        />
      </div>
    </main>
  );
}
