import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MonitorCog,
  Power,
  RotateCcw,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { useDesktopCapabilities } from "./DesktopCapabilities";

function DisableHostWorkbenchGate({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])');
      if (!controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus.current?.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-6">
      <div ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby="disable-host-title" aria-describedby="disable-host-copy" className="w-full max-w-[420px] rounded-md border border-hairline bg-panel p-5">
        <h2 id="disable-host-title" className="font-display text-[20px] font-semibold text-ink">Stop runs and disable the Host Workbench?</h2>
        <p id="disable-host-copy" className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
          Helmryth will interrupt active runs using this host, release their input sessions, and disable host control. Workstreams and remote or isolated workbenches remain available.
        </p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button ref={cancelRef} type="button" onClick={onCancel} className="min-h-9 w-full rounded-md border border-hairline/60 px-4 text-[13px] text-ink hover:bg-raised sm:w-auto">Keep Host Workbench</button>
          <button type="button" onClick={onConfirm} className="min-h-9 w-full rounded-md bg-danger px-4 text-[13px] font-medium text-[var(--color-danger-ink)] sm:w-auto">Stop runs and disable</button>
        </div>
      </div>
    </div>
  );
}

export function LinuxLocalControl() {
  const { capabilities } = useDesktopCapabilities();
  const local = capabilities.localComputer;
  const [pending, setPending] = useState<"enable" | "disable" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disableGateOpen, setDisableGateOpen] = useState(false);

  if (capabilities.host.platform !== "linux") return null;
  const busy = pending !== null || local.status === "checking" || local.status === "starting";
  const ready = local.available;
  const waylandSafetyBlocked = local.reasonCode === "linux-wayland-seat-safety-blocked";
  const wayland = capabilities.host.session === "wayland";
  const bundledDriver = local.driverSource === "bundled";

  const run = async (action: "enable" | "disable" | "retry") => {
    const bridge = window.helmryth?.localControl;
    if (!bridge) {
      setError("Host Workbench controls are unavailable in this Helmryth build.");
      return;
    }
    setPending(action);
    setError(null);
    try {
      if (action === "disable") {
        const response = await fetch("/api/local-computer/interrupt", {
          method: "POST",
          headers: { "content-type": "application/json" },
        });
        if (!response.ok) throw new Error("Could not stop active host-workbench runs.");
      }
      await bridge[action]();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="mt-4 border-t border-hairline/60 pt-4" aria-labelledby="linux-local-control-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="linux-local-control-title" className="flex items-center gap-2 font-display text-[16px] font-medium text-ink">
            <MonitorCog size={16} className={ready ? "text-success" : "text-ink-secondary"} />
            Host workbench
          </h3>
          <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
            Beta · Ubuntu 24.04 GNOME/{wayland ? "Wayland" : "Xorg"} · Workbench Driver {local.driverVersion || "not detected"}
          </div>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-1 text-[11px] font-medium",
            ready
              ? "bg-success/10 text-success"
              : waylandSafetyBlocked
                ? "bg-danger/10 text-danger"
                : local.enabled
                  ? "bg-warning/10 text-warning"
                  : "bg-raised text-ink-secondary",
          )}
        >
          {ready ? "Ready" : waylandSafetyBlocked ? "Unavailable on Wayland" : local.enabled ? "Needs attention" : "Off"}
        </span>
      </div>

      {waylandSafetyBlocked ? (
        <div className="mt-3 border-l-2 border-danger bg-danger/5 p-3">
          <div className="flex gap-2 text-[12px] leading-relaxed text-ink-secondary">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" />
            <span>
              Local control is available on Ubuntu Xorg. It remains disabled on Wayland until its input-safety
              boundary is validated. Sign out and choose <strong className="font-medium text-ink">Ubuntu on Xorg</strong>
              {" "}to use the host workbench. Workstreams, remote workbenches, isolated workbenches, and preview remain available.
            </span>
          </div>
        </div>
      ) : !local.enabled ? (
        <div className="mt-3 border-l-2 border-warning bg-warning/5 p-3">
          <div className="flex gap-2 text-[12px] leading-relaxed text-ink-secondary">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>
              Enabling lets operators explicitly assigned to the <strong className="font-medium text-ink">host workbench</strong>{" "}
              inspect the active desktop and request pointer or keyboard actions. Routine actions follow the operator's access mode; destructive and sensitive actions always stop at Gates.
              {wayland && " GNOME may also ask you to allow foreground input for this desktop session."}
            </span>
          </div>
        </div>
      ) : (
        <div className="mt-3 border-l-2 border-hairline bg-panel p-3 text-[12px] text-ink-secondary">
          <div className="flex items-start gap-2">
            {ready ? (
              <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-success" />
            ) : busy ? (
              <Loader2 size={15} className="mt-0.5 shrink-0 motion-safe:animate-spin" />
            ) : (
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            )}
            <span aria-live="polite">
              {ready
                ? "Ready for operators assigned to the host workbench. Operator actions use a private cursor, so your pointer stays under your control."
                : "The Workbench Driver needs recovery. Open Driver trace & recovery below."}
            </span>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="mt-2 border-l-2 border-danger pl-3 text-[12px] text-danger">
          Host Workbench controls could not update.
          <details className="mt-1 text-ink-secondary">
            <summary className="cursor-pointer">Technical detail</summary>
            <p className="mt-1 break-words">{error}</p>
          </details>
        </div>
      )}

      {!waylandSafetyBlocked && <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        {!local.enabled ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("enable")}
            className="flex flex-1 items-center justify-center gap-2 rounded-md bg-accent py-2 text-[13px] font-medium text-accent-ink hover:bg-accent-border disabled:opacity-50"
          >
            {pending === "enable" ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <Power size={14} />}
            Enable host workbench (Beta)
          </button>
        ) : (
          <>
            {!ready && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run("retry")}
                className="flex min-h-9 flex-1 items-center justify-center gap-2 rounded-md bg-raised px-3 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {pending === "retry" ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <RotateCcw size={14} />}
                Try again
              </button>
            )}
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => setDisableGateOpen(true)}
              className="flex min-h-9 flex-1 items-center justify-center gap-2 rounded-md bg-raised px-3 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            >
              {pending === "disable" ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <Power size={14} />}
              Stop active runs and disable
            </button>
          </>
        )}
      </div>}

      <details className="mt-3 border-t border-hairline/60 pt-3 text-[12px] text-ink-secondary">
        <summary className="cursor-pointer font-medium text-ink">Driver trace & recovery</summary>
        <p className="mt-2 leading-relaxed">
          {capabilities.host.packaged
            ? "Helmryth Desktop includes the Workbench Driver. If retry fails, restart Helmryth and confirm the supported GNOME session above."
            : "Source builds require the Workbench Driver to be installed before retrying host control."}
        </p>
        {local.driverPath && (
          <div className="mt-2 break-all font-sans text-[11px]" title={local.driverPath}>
            {bundledDriver ? "Bundled Workbench Driver" : local.driverPath}
            {local.driverVersion ? ` · ${local.driverVersion}` : ""}
          </div>
        )}
      </details>
      <DisableHostWorkbenchGate
        open={disableGateOpen}
        onCancel={() => setDisableGateOpen(false)}
        onConfirm={() => {
          setDisableGateOpen(false);
          void run("disable");
        }}
      />
    </section>
  );
}
