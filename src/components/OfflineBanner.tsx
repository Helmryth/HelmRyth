// The event stream is the app's liveness signal. When it drops, every surface
// keeps rendering its last snapshot: the roster is listed, the composer accepts
// typing, and a direction sent into a dead core simply vanishes. This is the
// one first-party place that says so, so the state is visible from whichever
// view happens to be open.
import { Loader2, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import { useStore } from "@/state/store";

// A reconnect between frames is normal and must not flash a scary banner; only
// a drop that persists is worth interrupting the user for.
const SETTLE_MS = 2500;

export function OfflineBanner() {
  const { state } = useStore();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (state.connected) {
      setShow(false);
      return;
    }
    const timer = setTimeout(() => setShow(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [state.connected]);

  if (!show) return null;

  return (
    <div
      role="alert"
      className="flex items-center justify-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-[12.5px] text-ink"
    >
      <Unplug size={14} className="shrink-0 text-warning" aria-hidden />
      <span>
        Helmryth can’t reach its local service. Nothing you send will be delivered until it reconnects.
      </span>
      <Loader2 size={13} className="shrink-0 animate-spin text-ink-secondary" aria-hidden />
      <span className="text-ink-secondary">Reconnecting…</span>
    </div>
  );
}
