// Helmryth launches with one deliberate visual identity. The persistence key
// remains an internal compatibility detail and is never marketed as a choice.
import { useEffect } from "react";
import { Check, Signal } from "lucide-react";
import { DEFAULT_SKIN, applySkin } from "@/lib/skins";

/**
 * The app's own layout at roughly 1/14 scale: score rail, roster with a selected
 * row, workstream, composer. The selected row and command control make the
 * hierarchy and accent placement legible at a glance.
 */
function IdentityPreview() {
  return (
    <div
      aria-hidden="true"
      className="flex h-[88px] w-full overflow-hidden rounded-md border border-hairline/70 bg-app"
    >
      {/* rail */}
      <div className="flex w-[14px] shrink-0 flex-col items-center gap-[4px] border-r border-hairline bg-panel pt-[6px]">
        <span className="h-[9px] w-[3px] bg-accent" />
        <span className="h-[6px] w-[3px] bg-ink-secondary/35" />
        <span className="h-[6px] w-[3px] bg-ink-secondary/35" />
      </div>
      {/* roster — the top row is the selected workstream */}
      <div className="flex w-[30px] shrink-0 flex-col gap-[3px] border-r border-hairline bg-panel p-[4px]">
        <span className="flex h-[9px] w-full items-center gap-[2px] border-l-2 border-accent bg-raised px-[2px]">
          <span className="size-[4px] shrink-0 rounded-[1px] bg-accent" />
          <span className="h-[2px] flex-1 rounded-full bg-ink/50" />
        </span>
        <span className="h-[3px] w-[80%] rounded-full bg-ink-secondary/30" />
        <span className="h-[3px] w-[62%] rounded-full bg-ink-secondary/30" />
        <span className="h-[3px] w-[74%] rounded-full bg-ink-secondary/30" />
      </div>
      {/* workstream */}
      <div className="flex min-w-0 flex-1 flex-col gap-[4px] p-[6px]">
        <span className="h-[12px] w-[62%] self-end rounded-[3px] border border-hairline bg-bubble-user" />
        <div className="flex w-[88%] flex-col gap-[3px] border-l border-signal bg-card p-[4px]">
          <span className="h-[2px] w-full rounded-full bg-ink/45" />
          <span className="h-[2px] w-[85%] rounded-full bg-ink/45" />
          <span className="h-[2px] w-[60%] rounded-full bg-ink-secondary/40" />
        </div>
        <div className="mt-auto flex items-center gap-[4px]">
          <span className="h-[11px] flex-1 rounded-[3px] bg-inset ring-1 ring-hairline" />
          {/* command accent carries its paired ink token for stable contrast */}
          <span className="flex size-[11px] items-center justify-center rounded-[3px] bg-accent">
            <span
              className="h-[1.5px] w-[5px] rounded-full"
              style={{ background: "var(--color-accent-ink)" }}
            />
          </span>
        </div>
      </div>
    </div>
  );
}

export function SkinPicker() {
  useEffect(() => {
    applySkin(DEFAULT_SKIN);
  }, []);

  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1.2fr)_minmax(220px,0.8fr)] sm:items-center">
      <IdentityPreview />
      <div className="border-l-2 border-accent pl-4">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
          <Signal size={14} className="text-signal" /> Helmryth light
          <Check size={13} className="ml-auto text-success" aria-label="Active identity" />
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
          Warm mineral paper, graphite ink, vermilion command, and petrol live signal. This is Helmryth&rsquo;s fixed product identity.
        </p>
      </div>
    </div>
  );
}
