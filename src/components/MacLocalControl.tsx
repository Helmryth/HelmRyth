import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Shield } from "lucide-react";
import { useDesktopCapabilities } from "./DesktopCapabilities";

export function MacLocalControl() {
  const { capabilities } = useDesktopCapabilities();
  const [pending, setPending] = useState(false);
  const [awaitingGrant, setAwaitingGrant] = useState<"accessibility" | "screen" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const retry = async () => {
    const bridge = window.helmryth?.localControl;
    if (!bridge) {
      setError("Host Workbench controls are unavailable in this Helmryth build.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await bridge.retry();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };

  const openSettings = async (permission: "accessibility" | "screen") => {
    const openPermission = window.helmryth?.permOpenSettings;
    if (!openPermission) {
      setError("macOS permission settings are unavailable in this Helmryth build.");
      return;
    }
    setError(null);
    setAwaitingGrant(permission);
    try {
      await openPermission(permission);
    } catch (reason) {
      setAwaitingGrant(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    if (!awaitingGrant) return;
    let used = false;
    const onFocus = () => {
      if (used) return;
      if (document.visibilityState !== "visible") return;
      used = true;
      setAwaitingGrant(null);
      void retry();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [awaitingGrant]);

  if (capabilities.host.platform !== "darwin") return null;
  if (capabilities.localComputer.available) return null;

  return (
    <section className="mt-4 border-l-2 border-warning bg-warning/10 px-4 py-3" aria-labelledby="mac-host-access-title">
      <div className="flex items-start gap-3">
        <Shield size={16} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <h3 id="mac-host-access-title" className="font-display text-[16px] font-medium text-ink">Prepare the Host Workbench</h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">
            macOS requires Accessibility and Screen Recording before an operator can use this Mac.
            Grant both in System Settings, then retry. macOS may ask you to relaunch Helmryth.
          </p>
          {error && (
            <div role="alert" className="mt-2 flex gap-1.5 text-[12px] text-danger">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <div>
                <span>Host Workbench access could not update.</span>
                <details className="mt-1 text-ink-secondary">
                  <summary className="cursor-pointer">Technical detail</summary>
                  <p className="mt-1 break-words">{error}</p>
                </details>
              </div>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void openSettings("accessibility")}
              disabled={pending || awaitingGrant !== null}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-[12.5px] font-medium text-accent-ink hover:bg-accent-border disabled:opacity-50"
            >
              {awaitingGrant === "accessibility" ? "Waiting for Accessibility…" : "Open Accessibility"}
            </button>
            <button
              type="button"
              onClick={() => void openSettings("screen")}
              disabled={pending || awaitingGrant !== null}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-hairline/60 px-3 text-[12.5px] font-medium text-ink hover:bg-raised disabled:opacity-50"
            >
              {awaitingGrant === "screen" ? "Waiting for Screen Recording…" : "Open Screen Recording"}
            </button>
            <button
              type="button"
              onClick={() => void retry()}
              disabled={pending || awaitingGrant !== null}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
            >
              {pending && <Loader2 size={13} className="motion-safe:animate-spin" />}
              Re-check access
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
