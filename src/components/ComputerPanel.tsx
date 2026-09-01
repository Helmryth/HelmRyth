// The operator's Workbench, in the right-side slot. Its execution surface
// determines provisioning, preview, control leases, and safety boundaries.
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  CalendarClock,
  CalendarDays,
  Columns2,
  Globe,
  Hand,
  Loader2,
  Maximize2,
  Monitor,
  Moon,
  Plus,
  Power,
  Settings,
  Smartphone,
  X,
} from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import type { Routine } from "@/lib/routines";
import { ApiKeyRow } from "./ApiKeys";
import { cn } from "@/lib/cn";
import { usePageVisible } from "@/lib/page-visible";
import { CloudBackendPicker } from "./CloudBackendPicker";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { RoutineEditor } from "./RoutinesPage";
import { AndroidDevicePanel, useAndroidUsbDevices } from "./AndroidDevicePanel";
import { BrowserPanel } from "./BrowserPanel";
import { builtInBrowserEnabled } from "@/lib/feature-flags";
import { LocalScreenPreview } from "./LocalScreenPreview";
import { LinuxLocalControl } from "./LinuxLocalControl";
import { MacLocalControl } from "./MacLocalControl";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import {
  autoSelectsLocalComputer,
  instanceSupportsLocalComputer,
  linuxAutoDescription,
  localComputerDisabledReason,
  localComputerSelectable,
} from "@/lib/local-computer";
import { vpsComputerNeedsReplacement, type VpsComputerStatus } from "@/lib/vps-computer";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

const computerControlSnapshotSchema = z.object({
  held: z.boolean().optional(),
  helpReason: z.string().nullable().optional(),
}).passthrough();

const computerScreenshotSchema = z.object({ image: z.string().optional() });

type Phase =
  | "checking"
  | "unconfigured"
  | "starting"
  | "ready"
  | "vm"
  | "vm-unavailable"
  | "vps-unconfigured"
  | "vps-incompatible"
  | "vps-stopped"
  | "local"
  | "local-unavailable"
  | "off"
  | "error";

interface LocalVmStatus {
  mode: "shared" | "per-bot";
  max_instances: number;
  image: boolean;
  create_supported: boolean;
  container: "running" | "stopped" | "missing";
  imageMatches: boolean;
  managed: boolean;
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  viewer_url: string;
}

function routineScheduleLabel(routine: Routine) {
  if (routine.schedule.type === "once") {
    return new Date(routine.schedule.at).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  const days = routine.schedule.weekdays;
  const cadence =
    days.length === 7
      ? "Every day"
      : days.join(",") === "1,2,3,4,5"
        ? "Weekdays"
        : days.map((day) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).join(", ");
  const [hour, minute] = routine.schedule.time.split(":").map(Number);
  return `${cadence} · ${new Date(2000, 0, 1, hour, minute).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function nextRunLabel(at: number | null) {
  if (at == null) return "Paused";
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return `${sameDay ? "Today" : date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

const PANEL_WIDTH_KEY = "helmryth-workbench-panel-width";
const PANEL_MIN_WIDTH = 360;
const PANEL_MAX_WIDTH = 960;
const PANEL_DEFAULT_WIDTH = 400;
const PANEL_FULL_WIDTH_MAX_VIEWPORT = 639;
const PANEL_DOCK_MIN_VIEWPORT = 1200;
const PANEL_OVERLAY_MARGIN = 48;
const ROSTER_WIDTH_RESERVE = 320;
const WORKSTREAM_WIDTH_RESERVE = 520;

export type WorkbenchPanelLayout = {
  mode: "full" | "overlay" | "dock";
  width: number;
  minWidth: number;
  maxWidth: number;
  resizable: boolean;
};

function clampPanelPreference(width: number): number {
  return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, width));
}

/**
 * Resolve a stored preference against the space the current shell can safely
 * surrender. Mobile owns the viewport, tablet floats over the workstream, and
 * desktop leaves room for both the widest roster and a readable workstream.
 */
export function workbenchPanelLayout(viewportWidth: number, requestedWidth: number): WorkbenchPanelLayout {
  const viewport = Math.max(0, Math.round(viewportWidth));
  if (viewport <= PANEL_FULL_WIDTH_MAX_VIEWPORT) {
    return {
      mode: "full",
      width: viewport,
      minWidth: viewport,
      maxWidth: viewport,
      resizable: false,
    };
  }

  if (viewport < PANEL_DOCK_MIN_VIEWPORT) {
    const maxWidth = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, viewport - PANEL_OVERLAY_MARGIN));
    return {
      mode: "overlay",
      width: Math.min(maxWidth, clampPanelPreference(requestedWidth)),
      minWidth: PANEL_MIN_WIDTH,
      maxWidth,
      resizable: maxWidth > PANEL_MIN_WIDTH,
    };
  }

  const maxWidth = Math.min(
    PANEL_MAX_WIDTH,
    Math.max(PANEL_MIN_WIDTH, viewport - ROSTER_WIDTH_RESERVE - WORKSTREAM_WIDTH_RESERVE),
  );
  return {
    mode: "dock",
    width: Math.min(maxWidth, clampPanelPreference(requestedWidth)),
    minWidth: PANEL_MIN_WIDTH,
    maxWidth,
    resizable: maxWidth > PANEL_MIN_WIDTH,
  };
}

export function readStoredWorkbenchPanelWidth(storage?: Pick<Storage, "getItem"> | null): number {
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    const stored = Number(target?.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0) return clampPanelPreference(stored);
  } catch {
    /* storage blocked — default width */
  }
  return PANEL_DEFAULT_WIDTH;
}

export function workbenchPanelWidthAfterDrag(
  startWidth: number,
  startPointerX: number,
  pointerX: number,
  viewportWidth: number,
): number {
  return workbenchPanelLayout(viewportWidth, startWidth + (startPointerX - pointerX)).width;
}

export function workbenchPanelWidthAfterKey(
  currentWidth: number,
  key: string,
  viewportWidth: number,
): number | null {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return null;
  const layout = workbenchPanelLayout(viewportWidth, currentWidth);
  if (!layout.resizable) return layout.width;
  if (key === "ArrowLeft") return Math.min(layout.maxWidth, layout.width + 24);
  if (key === "ArrowRight") return Math.max(layout.minWidth, layout.width - 24);
  if (key === "Home") return layout.minWidth;
  if (key === "End") return layout.maxWidth;
  return layout.width;
}

export type BrowserWorkbenchAvailability = "hidden" | "unavailable" | "available";

export function browserWorkbenchAvailability(
  config: Parameters<typeof builtInBrowserEnabled>[0],
  operatorEnabled: boolean | undefined,
  nativeBridgeAvailable: boolean,
): BrowserWorkbenchAvailability {
  if (!builtInBrowserEnabled(config) || operatorEnabled === false) return "hidden";
  return nativeBridgeAvailable ? "available" : "unavailable";
}

type WorkbenchConfirmation = "vm-recreate" | "vm-delete" | "vps-replace";

function WorkbenchPanelGate({
  action,
  operatorName,
  onCancel,
  onConfirm,
}: {
  action: WorkbenchConfirmation | null;
  operatorName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useEffect(() => {
    if (!action) return;
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
  }, [action]);
  if (!action) return null;
  const remote = action === "vps-replace";
  const deleting = action === "vm-delete";
  const title = remote
    ? `Replace ${operatorName}'s Remote Workbench?`
    : deleting
      ? `Delete ${operatorName}'s Isolated Workbench?`
      : `Replace ${operatorName}'s Isolated Workbench?`;
  const body = remote
    ? "Helmryth will delete the disposable VPS container and provision the version required by this update. Files stored only inside that container will be lost."
    : deleting
      ? "Helmryth will delete the disposable desktop and viewer. The operator's private durable workspace remains."
      : "Helmryth will replace the disposable desktop with the verified image. The operator's private durable workspace remains.";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-6">
      <div ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby="panel-workbench-gate-title" aria-describedby="panel-workbench-gate-copy" className="max-h-[calc(100vh-48px)] w-full max-w-[440px] overflow-y-auto rounded-md border border-hairline bg-panel p-5">
        <h2 id="panel-workbench-gate-title" className="font-display text-[20px] font-semibold text-ink">{title}</h2>
        <p id="panel-workbench-gate-copy" className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{body}</p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button ref={cancelRef} type="button" onClick={onCancel} className="min-h-9 w-full rounded-md border border-hairline/60 px-4 text-[13px] text-ink hover:bg-raised sm:w-auto">Keep workbench</button>
          <button type="button" onClick={onConfirm} className="min-h-9 w-full rounded-md bg-danger px-4 text-[13px] font-medium text-[var(--color-danger-ink)] sm:w-auto">
            {deleting ? "Delete workbench" : "Replace workbench"}
          </button>
        </div>
      </div>
    </div>
  );
}

function readPanelWidth(): number {
  return readStoredWorkbenchPanelWidth();
}

export function ComputerPanel({
  bot,
  onClose,
  onOpenVmWorkspace,
  onExpandBrowser,
}: {
  bot: Bot;
  onClose: () => void;
  onOpenVmWorkspace?: (botId: string) => void;
  onExpandBrowser?: (botId: string) => void;
}) {
  // The panel is a fixed column by default; a drag handle on its left edge
  // makes it wide enough to actually read a page in the Browser tab.
  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);
  const panelLayout = workbenchPanelLayout(viewportWidth, panelWidth);
  const compactPanelHeader = panelLayout.width < 520;
  const panelWidthRef = useRef(panelLayout.width);
  const resizeFrom = useRef<{ x: number; width: number } | null>(null);
  const onResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!panelLayout.resizable) return;
    panelWidthRef.current = panelLayout.width;
    resizeFrom.current = { x: event.clientX, width: panelLayout.width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizeMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    const next = workbenchPanelWidthAfterDrag(
      resizeFrom.current.width,
      resizeFrom.current.x,
      event.clientX,
      viewportWidth,
    );
    panelWidthRef.current = next;
    setPanelWidth(next);
  };
  const onResizeEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    resizeFrom.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidthRef.current));
    } catch {
      /* storage blocked — width lives for this session */
    }
  };
  const onResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const next = workbenchPanelWidthAfterKey(panelLayout.width, event.key, viewportWidth);
    if (next == null) return;
    event.preventDefault();
    panelWidthRef.current = next;
    setPanelWidth(next);
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(next));
    } catch {
      /* storage blocked — width lives for this session */
    }
  };
  const { state, dispatch } = useStore();
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const localAvailable = capabilities.localComputer.available;
  const isLinux = capabilities.host.platform === "linux";
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  const localSelectable = localComputerSelectable({ capabilities, providerSupportsLocal });
  const [localAutoWarning, setLocalAutoWarning] = useState(false);
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
  const [phase, setPhase] = useState<Phase>("checking");
  const [boxState, setBoxState] = useState<string | null>(null);
  const [polledFrame, setPolledFrame] = useState<{ png: string; mime: string } | null>(null);
  const [vmFrame, setVmFrame] = useState<string | null>(null);
  // The Local VM's interactive noVNC viewer (passworded, autoconnect). The
  // preview below is a periodic screenshot that swallows clicks — this URL is
  // the only way a person can actually drive the VM.
  const [vmViewerUrl, setVmViewerUrl] = useState<string | null>(null);
  const [vmStatus, setVmStatus] = useState<LocalVmStatus | null>(null);
  const [vpsStatus, setVpsStatus] = useState<VpsComputerStatus | null>(null);
  const [localFrame, setLocalFrame] = useState<string | null>(null);
  const [pending, setPending] = useState<
    "join" | "sleep" | "provision" | "vps-replace" | "vm-create" | "vm-recreate" | "vm-delete" | null
  >(null);
  const [controlPending, setControlPending] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  // Where the message came from decides how it is titled: a status read that
  // returned a problem is not an operation the user asked for and failed.
  const [error, setError] = useState<{ kind: "action" | "status"; message: string } | null>(null);
  const [creatingRoutine, setCreatingRoutine] = useState(false);
  const [confirmation, setConfirmation] = useState<WorkbenchConfirmation | null>(null);
  const [panelView, setPanelView] = useState<"computer" | "android" | "browser">("computer");
  const androidStatus = useAndroidUsbDevices();
  const androidConnected = androidStatus.devices.length > 0;
  // A configured Browser tab stays discoverable in the development shell so
  // it can explain its Desktop dependency. The bridge decides availability,
  // never whether the configured surface exists.
  const browserAvailability = browserWorkbenchAvailability(
    state.config,
    bot.browser,
    Boolean(window.helmryth?.browser),
  );
  const browserTabEnabled = browserAvailability !== "hidden";
  // bumped when a Box API key is saved inline, to re-run the spin-up flow
  const [retry, setRetry] = useState(0);
  const vmReadinessAttempts = useRef(0);
  const selectedInstance = state.instances.find(
    (instance) => instance.instanceId === bot.modelSelection.instanceId,
  );

  // Pause the screenshot poll while this bot's viewer is open; seed from the
  // live viewer so a remount/switch mid-session doesn't wrongly resume it.
  useEffect(() => {
    let alive = true;
    const dv = window.helmryth?.desktopViewer;
    if (dv?.currentState) {
      void dv
        .currentState()
        .then((s) => {
          if (alive) setViewerOpen(s.open && s.contextId === bot.id);
        })
        .catch(() => {});
    }
    const off = dv?.onState((viewer) => {
      if (viewer.contextId === bot.id) setViewerOpen(viewer.open);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [bot.id]);

  useEffect(() => {
    if (!androidConnected && panelView === "android") setPanelView("computer");
    if (!browserTabEnabled && panelView === "browser") setPanelView("computer");
  }, [androidConnected, browserTabEnabled, panelView]);
  useEffect(() => {
    vmReadinessAttempts.current = 0;
  }, [bot.id, bot.computer]);
  const vmSupported = Boolean(
    selectedInstance?.snapshot.state === "available" &&
      selectedInstance.capabilities?.computerMcp &&
      selectedInstance.driverKind !== "boxAgent",
  );
  const computerToolSupported = selectedInstance?.capabilities?.computerMcp === true;
  const vpsSupported = Boolean(computerToolSupported && selectedInstance?.driverKind !== "boxAgent");
  const cloudBackend = bot.cloudBackend ?? "box";
  const cloudSupported = cloudBackend === "vps"
    ? vpsSupported
    : computerToolSupported || selectedInstance?.driverKind === "boxAgent";
  const botRoutines = state.routines
    .filter((routine) => routine.botId === bot.id)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
  const cloudRoutineReady = Boolean(
    state.config?.box.configured &&
      state.instances.some((instance) => instance.driverKind === "boxAgent" && instance.snapshot.state === "available"),
  );
  const activeRoutineRun = state.routineRuns.find(
    (run) => run.botId === bot.id && ["queued", "running", "waiting"].includes(run.status),
  );
  const computerDestination =
    bot.computer === "cloud"
      ? cloudBackend === "vps" ? "this self-hosted Remote Workbench" : "this managed Remote Workbench"
      : bot.computer === "vm"
        ? "the Isolated Workbench"
      : bot.computer === "local"
        ? "the Host Workbench"
        : bot.computer === "off"
          ? null
          : phase === "ready"
            ? cloudBackend === "vps" ? "the self-hosted Remote Workbench selected automatically" : "the managed Remote Workbench selected automatically"
            : "the Host Workbench selected automatically";

  // resolve the mode on open; box endpoints are only ever hit on the
  // cloud path, so local/off can never render a JSON error as an image
  useEffect(() => {
    let alive = true;
    setPhase("checking");
    setPolledFrame(null);
    setVmFrame(null);
    setVmViewerUrl(null);
    setVmStatus(null);
    setVpsStatus(null);
    setLocalFrame(null);
    setError(null);
    if (bot.computer === "off") {
      setPhase("off");
      return;
    }
    if (bot.computer === "local") {
      if (!providerSupportsLocal) {
        setError({ kind: "status", message: "This model engine cannot use the Host Workbench. Choose Claude or an ACP engine." });
      }
      setPhase(capabilitiesReady && localAvailable && providerSupportsLocal ? "local" : "local-unavailable");
      return;
    }
    if (bot.computer === "vm") {
      if (!vmSupported) {
        setError({ kind: "status", message: "This model engine cannot use an Isolated Workbench. Choose Claude or an ACP engine." });
        setPhase("vm-unavailable");
        return;
      }
      let retryTimer: number | undefined;
      api(`/api/bots/${bot.id}/local-computer`)
        .then((rawStatus) => {
          if (!alive) return;
          const status: LocalVmStatus = rawStatus;
          setVmStatus(status);
          // parse at the boundary: our own status endpoint sends a string or nothing
          const viewerUrl = String(status.viewer_url ?? "");
          if (viewerUrl.startsWith("http")) setVmViewerUrl(viewerUrl);
          if (status.ready) {
            vmReadinessAttempts.current = 0;
            setPhase("vm");
          } else if (
            status.container === "running" &&
            status.imageMatches &&
            status.managed &&
            status.network === "loopback" &&
            status.security === "hardened" &&
            status.persistence === "durable" &&
            !status.desktopReady &&
            vmReadinessAttempts.current < 15
          ) {
            vmReadinessAttempts.current += 1;
            setError(null);
            setPhase("checking");
            retryTimer = window.setTimeout(() => setRetry((n) => n + 1), 2000);
          }
          else {
            const canCreateHere =
              status.mode === "per-bot" &&
              status.container === "missing" &&
              status.image &&
              status.create_supported;
            setError(canCreateHere ? null : { kind: "status", message: `${status.problem ?? "The Isolated Workbench is not ready"}. Open System → Isolated Workbench.` });
            setPhase("vm-unavailable");
          }
        })
        .catch((e) => {
          if (!alive) return;
          setError({ kind: "status", message: e.message });
          setPhase("vm-unavailable");
        });
      return () => {
        alive = false;
        if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      };
    }
    if (bot.computer === "cloud" && !cloudSupported) {
      setError({ kind: "status", message: "This model engine cannot use a Remote Workbench. Choose Claude, an ACP engine, or the Workbench engine." });
      setPhase("error");
      return;
    }
    if (bot.computer !== "cloud" && !capabilitiesReady) return;
    if (cloudBackend === "vps") {
      const autoLocal =
        !isLinux && bot.computer !== "cloud" && capabilitiesReady && localSelectable;
      if (!vpsSupported) {
        if (autoLocal) setPhase("local");
        else {
          setError({ kind: "status", message: "This model engine cannot use a self-hosted Remote Workbench. Choose Claude or an ACP engine, or switch the remote provider to Box." });
          setPhase("error");
        }
        return;
      }
      api(`/api/bots/${bot.id}/computer`)
        .then((rawStatus) => {
          if (!alive) return;
          const status: VpsComputerStatus = rawStatus;
          setVpsStatus(status);
          if (!status.configured) {
            if (autoLocal) setPhase("local");
            else {
              setError({ kind: "status", message: "Add the VPS SSH alias in System → Connections." });
              setPhase("vps-unconfigured");
            }
            return;
          }
          if (status.ready) {
            setBoxState(status.container ?? null);
            setPhase("ready");
            return;
          }
          // App updates can bump IMAGE_LAYER_VERSION while this bot still has
          // a managed container from the previous release. Provision refuses
          // to overwrite it by design, so surface the explicit replacement
          // path instead of automatically issuing a request that can only 409.
          if (vpsComputerNeedsReplacement(status)) {
            setError(status.problem ? { kind: "status", message: status.problem } : null);
            setPhase("vps-incompatible");
            return;
          }
          if (bot.computer === "cloud") {
            setPhase("starting");
            return api(`/api/bots/${bot.id}/computer/provision`, { method: "POST" }).then((result) => {
              if (!alive) return;
              setBoxState(result.container ?? null);
              if (result.ready) setPhase("ready");
              else {
                setError({ kind: "status", message: result.problem ?? "The self-hosted Remote Workbench is not ready yet" });
                setPhase("error");
              }
            });
          }
          if (autoLocal) {
            setPhase("local");
            return;
          }
          setBoxState(status.container ?? null);
          setError({ kind: "status", message:
            bot.autoStartVps
              ? `${status.problem ?? "No ready VPS container"}. Helmryth will prepare or wake it when ${bot.name} next works.`
              : `${status.problem ?? "No ready VPS container"}. Enable automatic VPS start below, or choose Remote to provision it.`,
           });
          setPhase(status.container === "stopped" ? "vps-stopped" : "vps-unconfigured");
        })
        .catch((e) => {
          if (!alive) return;
          setError({ kind: "status", message: e.message });
          setPhase("error");
        });
      return () => {
        alive = false;
      };
    }
    // cloud, or auto (cloud box wins when one exists, else local in-app)
    api(`/api/bots/${bot.id}/computer`)
      .then((status) => {
        if (!alive) return;
        const autoLocal = autoSelectsLocalComputer({
          platform: capabilities.host.platform,
          computer: bot.computer,
          capabilitiesReady,
          localSelectable,
        });
        if (!status.configured) {
          setPhase(autoLocal ? "local" : "unconfigured");
          return;
        }
        if (!status.box && autoLocal) {
          setPhase("local");
          return;
        }
        setPhase("starting");
        return api(`/api/bots/${bot.id}/computer/provision`, { method: "POST" }).then((r) => {
          if (!alive) return;
          setBoxState(r.state ?? null);
          setPhase("ready");
        });
      })
      .catch((e) => {
        if (!alive) return;
        setError({ kind: "status", message: e.message });
        setPhase("error");
      });
    return () => {
      alive = false;
    };
  }, [
    bot.id,
    bot.computer,
    bot.autoStartVps,
    cloudBackend,
    retry,
    capabilitiesReady,
    localSelectable,
    isLinux,
    providerSupportsLocal,
    vmSupported,
    cloudSupported,
    vpsSupported,
    state.config?.vps?.sshAlias,
  ]);

  // cloud preview: SSE frames win while the bot works; otherwise poll.
  // Every preview poll below gates on visibility and slows way down for an
  // idle bot — a drawer left open overnight must not keep shooting.
  const pageVisible = usePageVisible();
  const live = state.screens[bot.id];
  const sseFlowing = Boolean(bot.busy && live);
  const inFlight = useRef(false);
  useEffect(() => {
    if (phase !== "ready" || sseFlowing || viewerOpen || !pageVisible) return;
    let alive = true;
    const shoot = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const { png, format } = await api(`/api/bots/${bot.id}/computer/screenshot`, { method: "POST" });
        if (alive) setPolledFrame({ png, mime: format === "jpeg" ? "image/jpeg" : "image/png" });
      } catch {
        /* box mid-command or asleep — next tick */
      } finally {
        inFlight.current = false;
      }
    };
    void shoot();
    const timer = setInterval(shoot, bot.busy ? 4000 : 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase, sseFlowing, bot.id, viewerOpen, pageVisible, bot.busy]);

  // Isolated Workbench preview comes directly from the Workbench Driver. It
  // does not use the password-protected noVNC viewer or cloud endpoints.
  const vmInFlight = useRef(false);
  useEffect(() => {
    if (phase !== "vm" || viewerOpen || !pageVisible) return;
    let alive = true;
    const shoot = async () => {
      if (vmInFlight.current) return;
      vmInFlight.current = true;
      try {
        const result = computerScreenshotSchema.parse(
          await api(`/api/bots/${bot.id}/local-computer/screenshot`, { method: "POST" }),
        );
        if (alive && result.image !== undefined) setVmFrame(result.image);
      } catch (e) {
        if (alive) setError({ kind: "status", message: e instanceof Error ? e.message : String(e) });
      } finally {
        vmInFlight.current = false;
      }
    };
    void shoot();
    const timer = window.setInterval(() => void shoot(), bot.busy ? 3000 : 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [phase, bot.id, viewerOpen, pageVisible, bot.busy]);

  // local preview: frames from the Electron main process. The FIRST capture
  // attempt is what makes macOS show the Screen Recording prompt (there is
  // no reliable pre-grant flow on macOS 15+), so repeated empty frames mean
  // the user denied — surface the Settings repair path instead of spinning.
  const [localMisses, setLocalMisses] = useState(0);
  useEffect(() => {
    if (phase !== "local" || !window.helmryth || isLinux || !pageVisible) return;
    let alive = true;
    setLocalMisses(0);
    const shoot = async () => {
      try {
        const url = await window.helmryth!.screenFrame();
        if (alive && url) setLocalFrame(url);
        else if (alive) setLocalMisses((n) => n + 1);
      } catch {
        if (alive) setLocalMisses((n) => n + 1);
      }
    };
    void shoot();
    // A real ScreenCaptureKit capture + PNG encode per tick: idle bots get a
    // slow heartbeat, working ones the live cadence.
    const timer = setInterval(shoot, bot.busy ? 3000 : 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase, isLinux, pageVisible, bot.busy]);

  const lastScreenMessage = [...bot.messages].reverse().find((m) => m.kind === "screen" && m.png);
  const cloudFrame =
    live ??
    polledFrame ??
    (lastScreenMessage ? { png: lastScreenMessage.png!, mime: lastScreenMessage.mime ?? "image/png" } : null);
  const frameSrc =
    phase === "vm"
      ? vmFrame
      : phase === "local" && !isLinux
      ? localFrame
      : phase === "ready" || phase === "starting"
        ? cloudFrame && `data:${cloudFrame.mime};base64,${cloudFrame.png}`
        : null;
  const previewOpensDesktop = Boolean(
    frameSrc &&
      ((phase === "vm" && vmViewerUrl) || phase === "ready"),
  );

  // who-is-driving: SSE keeps this fresh; the mount fetch covers a panel
  // opened after the last frame (e.g. an app reload mid-hold)
  const control = state.computerControl[bot.id] ?? { held: false, helpReason: null };
  useEffect(() => {
    let alive = true;
    api(`/api/bots/${bot.id}/computer/control`)
      .then((raw) => {
        if (!alive) return;
        const snap = computerControlSnapshotSchema.parse(raw);
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
  const requestControl = async (action: "take" | "release" | "dismiss-help") => {
    const snap = computerControlSnapshotSchema.parse(
      await api(`/api/bots/${bot.id}/computer/control`, {
        method: "POST",
        body: JSON.stringify({ action }),
      }),
    );
    dispatch({
      type: "computerControl",
      botId: bot.id,
      held: snap.held === true,
      helpReason: snap.helpReason ?? null,
    });
    return snap;
  };

  const controlAction = (action: "take" | "release" | "dismiss-help") => {
    setControlPending(true);
    requestControl(action)
      .catch((e) => setError({ kind: "action", message: e.message }))
      .finally(() => setControlPending(false));
  };

  const openDesktop = async () => {
    setPending("join");
    setControlPending(true);
    setError(null);
    let tookControl = false;
    // A plain-web development session still needs a synchronous blank tab;
    // the packaged app uses the reliable Electron viewer window below.
    let fallbackTab: Window | null = null;
    if (!window.helmryth?.desktopViewer && !window.helmryth?.openExternal) {
      fallbackTab = window.open("", "_blank");
      if (fallbackTab) fallbackTab.opener = null;
    }
    try {
      if (!control.held) {
        await requestControl("take");
        tookControl = true;
      }

      let viewerUrl = vmViewerUrl;
      if (phase === "ready") {
        const result = await api(`/api/bots/${bot.id}/computer/join`, { method: "POST" });
        viewerUrl = result.joinUrl?.constructor === String ? String(result.joinUrl) : null;
      }
      if (!viewerUrl) throw new Error("The Workbench did not return a live desktop link");

      if (window.helmryth?.desktopViewer) {
        const opened = await window.helmryth.desktopViewer.open(viewerUrl, `${bot.name}'s live desktop`, bot.id);
        if (!opened) throw new Error("Helmryth could not open the live desktop");
      } else if (fallbackTab) {
        fallbackTab.location.replace(viewerUrl);
      } else if (window.helmryth?.openExternal) {
        const opened = await window.helmryth.openExternal(viewerUrl);
        if (!opened) throw new Error("Helmryth could not open the live desktop link");
      } else if (!window.open(viewerUrl, "_blank", "noopener")) {
        throw new Error("Your browser blocked the live desktop tab");
      }
    } catch (e) {
      fallbackTab?.close();
      // Release the operator before best-effort tunnel cleanup. A failed SSH
      // process must never leave the operator paused indefinitely.
      if (tookControl) await requestControl("release").catch(() => {});
      if (phase === "ready" && cloudBackend === "vps") {
        await api(`/api/bots/${bot.id}/computer/viewer-close`, { method: "POST", body: "{}" }).catch(() => {});
      }
      setError({ kind: "action", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setPending(null);
      setControlPending(false);
    }
  };

  const run = (kind: "sleep" | "provision") => {
    setPending(kind);
    setError(null);
    api(`/api/bots/${bot.id}/computer/${kind}`, { method: "POST" })
      .then((result) => {
        if (kind === "provision") {
          setBoxState(result.container ?? null);
          if (result.ready) setPhase("ready");
          else {
            setError({ kind: "action", message: result.problem ?? "The self-hosted Remote Workbench is not ready yet" });
            setPhase("error");
          }
        }
        if (kind === "sleep") {
          setBoxState(cloudBackend === "vps" ? "stopped" : "archived");
          if (cloudBackend === "vps") setPhase("vps-stopped");
        }
      })
      .catch((e) => {
        setError({ kind: "action", message: e.message });
      })
      .finally(() => setPending(null));
  };

  const runVmAction = async (action: "vm-create" | "vm-recreate" | "vm-delete", confirmed = false) => {
    if (!confirmed && (action === "vm-recreate" || action === "vm-delete")) {
      setConfirmation(action);
      return;
    }
    setPending(action);
    setError(null);
    setVmStatus(null);
    vmReadinessAttempts.current = 0;
    try {
      if (action !== "vm-create") {
        await api(`/api/bots/${bot.id}/local-computer/remove`, {
          method: "POST",
          body: "{}",
        });
      }
      if (action !== "vm-delete") {
        const status: LocalVmStatus = await api(`/api/bots/${bot.id}/local-computer/run`, {
          method: "POST",
          body: "{}",
        });
        setVmStatus(status);
        setPhase(status.ready ? "vm" : "checking");
      } else {
        setVmStatus((current) => current ? { ...current, container: "missing", ready: false } : current);
        setPhase("vm-unavailable");
      }
      setRetry((n) => n + 1);
    } catch (e) {
      // No retry bump here. `retry` is a dependency of the status effect, whose
      // body clears `error` — bumping it on failure batches into the same tick
      // and wipes the message before a single frame renders it.
      setError({ kind: "action", message: e instanceof Error ? e.message : String(e) });
      setPhase("vm-unavailable");
    } finally {
      setPending(null);
    }
  };

  const replaceVpsComputer = async (confirmed = false) => {
    if (!confirmed) {
      setConfirmation("vps-replace");
      return;
    }
    setPending("vps-replace");
    setError(null);
    try {
      await api(`/api/bots/${bot.id}/computer/remove`, { method: "POST", body: "{}" });
      const result: VpsComputerStatus = await api(`/api/bots/${bot.id}/computer/provision`, {
        method: "POST",
        body: "{}",
      });
      setVpsStatus(result);
      setBoxState(result.container ?? null);
      setPhase(result.ready ? "ready" : "error");
      if (!result.ready) setError({ kind: "action", message: result.problem ?? "The replacement Remote Workbench is not ready yet" });
      setRetry((n) => n + 1);
    } catch (e) {
      // see runVmAction: a retry bump on failure erases the error it reports
      setError({ kind: "action", message: e instanceof Error ? e.message : String(e) });
      setPhase("error");
    } finally {
      setPending(null);
    }
  };

  const openVmSettings = () => {
    window.sessionStorage.setItem("helmryth.settings.section", "computer");
    dispatch({ type: "toggleAppSettings", open: true });
  };

  const openConnectionSettings = () => {
    dispatch({ type: "toggleAppSettings", open: true, section: "connections" });
  };

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || confirmation) return;
      if (event.key !== "Escape") return;
      const topmostModal = document.querySelector<HTMLElement>('[aria-modal="true"]');
      if (topmostModal && topmostModal !== panel) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [confirmation, onClose]);

  const emptyState = {
    checking: "Checking…",
    starting: `Starting ${bot.name}'s Workbench…`,
    unconfigured: "No managed Remote Workbench configured",
    "vps-unconfigured": `No self-hosted Remote Workbench is configured for ${bot.name}`,
    "vps-incompatible": "This Remote Workbench needs the current Helmryth image",
    "vps-stopped": "The self-hosted Remote Workbench is stopped",
    "local-unavailable": localDisabledReason ?? "The Host Workbench is not ready.",
    "vm-unavailable": `The Isolated Workbench is unavailable for ${bot.name}`,
    off: `${bot.name}'s Workbench is off`,
    error: "Couldn't reach the Workbench",
  } satisfies Record<Exclude<Phase, "ready" | "local" | "vm">, string>;

  return (
    <>
    <aside
      ref={panelRef}
      className={cn(
        "animate-panel-in relative flex h-full min-w-0 shrink-0 flex-col overflow-x-hidden border-l border-hairline/40 bg-panel",
        panelLayout.mode !== "dock" && "absolute bottom-0 right-0 top-0 z-30 shadow-xl",
        panelLayout.mode === "full" && "left-0 border-l-0",
      )}
      style={{ width: `${panelLayout.width}px`, maxWidth: "100vw" }}
      data-workbench-panel-layout={panelLayout.mode}
      aria-label={`${bot.name} Workbench panel`}
      role={panelLayout.mode === "dock" ? undefined : "dialog"}
      aria-modal={panelLayout.mode === "dock" ? undefined : "true"}
    >
      <div
        role="separator"
        tabIndex={panelLayout.resizable ? 0 : -1}
        aria-hidden={panelLayout.resizable ? undefined : true}
        aria-orientation="vertical"
        aria-label="Resize Workbench panel"
        aria-valuemin={panelLayout.minWidth}
        aria-valuemax={panelLayout.maxWidth}
        aria-valuenow={panelLayout.width}
        aria-valuetext={`${panelLayout.width} pixels wide`}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onKeyDown={onResizeKeyDown}
        className={cn(
          "absolute inset-y-0 left-0 z-10 w-6 -translate-x-1/2 touch-none cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-transparent hover:after:bg-accent/50 focus-visible:after:bg-accent",
          !panelLayout.resizable && "hidden",
        )}
      />
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={() => dispatch({ type: "toggleSettings", open: true })}
          className="flex size-9 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
          title={`Open ${bot.name}'s operator settings`}
          aria-label={`Open ${bot.name}'s operator settings`}
        >
          <Settings size={18} />
        </button>
        {androidConnected || browserTabEnabled ? (
          <div role="group" aria-label="Workbench surface" className="flex overflow-hidden rounded-md border border-hairline/60">
            <button
              type="button"
              onClick={() => setPanelView("computer")}
              aria-pressed={panelView === "computer"}
              aria-label="Workbench"
              className={cn(
                "flex min-h-9 items-center gap-1.5 px-2.5 text-[12.5px]",
                panelView === "computer" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              <Monitor size={13} /> <span className={cn(compactPanelHeader && "sr-only")}>Workbench</span>
            </button>
            {androidConnected && (
            <button
              type="button"
              onClick={() => setPanelView("android")}
              aria-pressed={panelView === "android"}
              aria-label="Android Workbench"
              className={cn(
                "flex min-h-9 items-center gap-1.5 border-l border-hairline/60 px-2.5 text-[12.5px]",
                panelView === "android" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              <Smartphone size={13} /> <span className={cn(compactPanelHeader && "sr-only")}>Android</span>
            </button>
            )}
            {browserTabEnabled && (
            <button
              type="button"
              onClick={() => setPanelView("browser")}
              aria-pressed={panelView === "browser"}
              aria-label="Browser Workbench"
              className={cn(
                "flex min-h-9 items-center gap-1.5 border-l border-hairline/60 px-2.5 text-[12.5px]",
                panelView === "browser" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              <Globe size={13} /> <span className={cn(compactPanelHeader && "sr-only")}>Browser</span>
            </button>
            )}
          </div>
        ) : (
          <span className="text-[15px] font-semibold text-ink">Workbench</span>
        )}
        <button
          type="button"
          onClick={onClose}
          className="flex size-9 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
          aria-label="Close Workbench panel"
        >
          <X size={18} />
        </button>
      </div>

      {panelView === "browser" && browserTabEnabled ? (
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
          <BrowserPanel
            bot={bot}
            control={control}
            controlPending={controlPending}
            onControl={controlAction}
            onExpand={onExpandBrowser ? () => onExpandBrowser(bot.id) : undefined}
          />
        </div>
      ) : panelView === "android" && androidConnected ? (
        <div className="flex-1 overflow-y-auto px-4 pt-2">
          <AndroidDevicePanel status={androidStatus} />
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto px-5 pb-5">
          {/* Screen preview */}
          <div className="mb-2 mt-2 flex items-center justify-between border-b border-hairline/50 pb-2 text-[13px] text-ink-secondary">
            <span><span className="font-medium text-ink">{bot.name}</span> · live surface</span>
            {phase === "local" && <span className="text-[12px]">Host Workbench</span>}
            {phase === "vm" && <span className="text-[12px]">Isolated Workbench</span>}
            {cloudBackend === "vps" && (phase === "ready" || phase === "starting") && <span className="text-[12px]">Remote · self-hosted</span>}
        </div>
        <div className="flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-md border border-hairline/60 bg-inset">
          {frameSrc && previewOpensDesktop ? (
            <button
              type="button"
              onClick={() => void openDesktop()}
              disabled={controlPending || pending === "join"}
              className="group relative flex h-full w-full cursor-pointer items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait"
              aria-label={`Open ${bot.name}'s live Workbench`}
              title="Open live Workbench"
            >
              <img
                src={frameSrc}
                alt={`${bot.name}'s screen`}
                className="h-full w-full object-contain"
              />
              <span className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 rounded-md bg-ink/85 px-2 py-1 text-[11px] font-medium text-[var(--color-accent-ink)] opacity-90 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                {pending === "join" ? <Loader2 size={12} className="motion-safe:animate-spin" /> : <Maximize2 size={12} />}
                Open
              </span>
            </button>
          ) : frameSrc ? (
            <img
              src={frameSrc}
              alt={`${bot.name}'s screen`}
              className="h-full w-full object-contain"
              title={phase === "vm" ? "Watch-only preview" : undefined}
            />
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
              {phase === "checking" || phase === "starting" || phase === "vm" || (phase === "local" && !isLinux) ? (
                <Loader2 size={18} className="motion-safe:animate-spin" />
              ) : phase === "off" ? (
                <Power size={22} />
              ) : (
                <Monitor size={22} />
              )}
              <span className="text-[12px]" aria-live="polite" aria-atomic="true">
                {phase === "ready"
                  ? "Waiting for the first frame…"
                  : phase === "vm"
                    ? "Capturing the Isolated Workbench…"
                  : phase === "local"
                    ? isLinux
                      ? "Ready for gated operator actions. Start the host preview below when you need to watch the screen."
                      : localMisses >= 3
                      ? "No frames yet — the preview needs Screen Recording permission. After granting, relaunch the app."
                      : "Capturing the Host Workbench…"
                    : emptyState[phase]}
              </span>
              {phase === "local" && !isLinux && localMisses >= 3 && (
                <button
                  onClick={() => window.helmryth?.permOpenSettings?.("screen")}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  Open Settings
                </button>
              )}
              {phase === "vm-unavailable" && (
                vmStatus?.mode === "per-bot" && vmStatus.image && vmStatus.create_supported ? (
                  <button
                    onClick={() => void runVmAction(vmStatus.container === "missing" ? "vm-create" : "vm-recreate")}
                    disabled={pending !== null}
                    className="mt-1 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink hover:bg-accent-border disabled:opacity-50"
                  >
                    {(pending === "vm-create" || pending === "vm-recreate") && (
                      <Loader2 size={13} className="mr-1.5 inline motion-safe:animate-spin" />
                    )}
                    {vmStatus.container === "missing" ? `Create ${bot.name}'s workbench` : `Replace ${bot.name}'s workbench`}
                  </button>
                ) : (
                  <button
                    onClick={openVmSettings}
                    className="mt-1 min-h-9 rounded-md bg-control px-3 text-[12px] text-ink hover:bg-raised-hover"
                  >
                    Open Isolated Workbench setup
                  </button>
                )
              )}
              {(phase === "vps-unconfigured" || phase === "vps-stopped") && (
                <button
                  onClick={openConnectionSettings}
                    className="mt-1 min-h-9 rounded-md bg-control px-3 text-[12px] text-ink hover:bg-raised-hover"
                >
                  Open Remote Workbench settings
                </button>
              )}
              {(phase === "vps-stopped" || (phase === "vps-unconfigured" && vpsStatus?.configured)) &&
                (bot.computer === "cloud" || bot.autoStartVps) && (
                <button
                  onClick={() => run("provision")}
                  disabled={pending === "provision"}
                  className="mt-1 min-h-9 rounded-md bg-control px-3 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50"
                >
                  {pending === "provision" && <Loader2 size={13} className="mr-1.5 inline motion-safe:animate-spin" />}
                  {phase === "vps-stopped" ? "Start Remote Workbench" : "Prepare Remote Workbench"}
                </button>
              )}
              {phase === "vps-incompatible" && vpsStatus?.managed &&
                (bot.computer === "cloud" || bot.autoStartVps) && (
                <button
                  onClick={() => void replaceVpsComputer()}
                  disabled={pending === "vps-replace"}
                  className="mt-1 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink hover:bg-accent-border disabled:opacity-50"
                >
                  {pending === "vps-replace" && <Loader2 size={13} className="mr-1.5 inline motion-safe:animate-spin" />}
                  Replace Remote Workbench
                </button>
              )}
            </div>
          )}
        </div>

        {error && (
          <div role="alert" className="mt-2 border-l-2 border-danger bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {error.kind === "action" ? (
              <>
                Workbench could not complete this operation.
                <details className="mt-1 text-ink-secondary">
                  <summary className="cursor-pointer text-[12px]">Technical detail</summary>
                  <p className="mt-1 break-words text-[12px]">{error.message}</p>
                </details>
              </>
            ) : (
              <p className="break-words">{error.message}</p>
            )}
          </div>
        )}
        {phase === "unconfigured" && (
          <div className="mt-3 border-l-2 border-warning bg-warning/10 px-4 py-3">
            <div className="mb-3 text-[13px] text-ink-secondary">
              Add a Box API key to prepare a managed Remote Workbench for {bot.name}.
            </div>
            <ApiKeyRow
              section="box"
              onSaved={(configured) => configured && setRetry((n) => n + 1)}
            />
          </div>
        )}
        {phase === "vps-unconfigured" && (
          <div className="mt-3 border-l-2 border-warning bg-warning/10 px-4 py-3">
            <div className="mb-3 text-[13px] text-ink-secondary">
              Configure a VPS SSH alias in System → Connections. Automatic selection only reuses a ready container.
            </div>
            <button
              onClick={openConnectionSettings}
              className="min-h-9 rounded-md bg-control px-3 text-[13px] text-ink hover:bg-raised-hover"
            >
              Open Remote Workbench settings
            </button>
          </div>
        )}

        {phase === "vm" &&
          vmStatus?.mode === "per-bot" &&
          window.helmryth?.desktopWorkspace &&
          onOpenVmWorkspace && (
            <button
              type="button"
              onClick={() => onOpenVmWorkspace(bot.id)}
              data-split-workbench-launcher={bot.id}
              disabled={pending !== null}
              className="mt-3 flex min-h-9 w-full items-center justify-center gap-2 rounded-md border border-accent/30 bg-accent/10 px-3 text-[13px] font-medium text-ink hover:bg-accent/15 disabled:opacity-50"
              title="Watch two Isolated Workbenches together without pausing either operator"
            >
              <Columns2 size={14} />
              Open Split Workbench
            </button>
          )}

        {/* Who is driving — take the wheel / hand it back */}
        {(phase === "ready" || phase === "vm") && control.helpReason && !control.held && (
          <div className="mt-3 border-l-2 border-warning bg-warning/10 px-4 py-3">
              <div role="alert" className="text-[13px] leading-relaxed text-warning">
              <b>{bot.name}</b> asked for your hands: {control.helpReason}
            </div>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() =>
                  phase === "vm" || phase === "ready" ? void openDesktop() : controlAction("take")
                }
                disabled={controlPending || pending === "join"}
                className="flex flex-1 items-center justify-center gap-2 rounded-md bg-accent py-2 text-[13px] font-medium text-accent-ink hover:bg-accent-border disabled:opacity-50"
              >
                {pending === "join" ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <Hand size={14} />}
                Take controls
              </button>
              <button
                onClick={() => controlAction("dismiss-help")}
                disabled={controlPending}
                className="min-h-9 rounded-md bg-control px-3 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        {(phase === "ready" || phase === "vm") && control.held && (
          <div role="status" aria-live="polite" className="mt-3 border-l-2 border-accent bg-accent/10 px-4 py-3">
            <div className="text-[13px] leading-relaxed text-ink">
              You hold the controls. {bot.name}'s clicks and keystrokes are refused until you return them.
              {phase === "ready" && " Open the live Workbench to drive."}
              {phase === "vm" && " Open the live Workbench to drive; this preview is view-only."}
            </div>
            <button
              onClick={() => {
                controlAction("release");
                void window.helmryth?.desktopViewer?.close(bot.id);
              }}
              disabled={controlPending}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-md bg-accent py-2 text-[13px] font-medium text-accent-ink hover:bg-accent-border disabled:opacity-50"
            >
              <Hand size={14} />
              Return controls
            </button>
          </div>
        )}
        {phase === "vm" && vmViewerUrl && control.held && (
          <button
            onClick={() => void openDesktop()}
            disabled={pending === "join"}
            className="mt-3 flex min-h-9 w-full items-center justify-center gap-2 rounded-md bg-control px-3 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            title="Open the Isolated Workbench inside Helmryth"
          >
            {pending === "join" ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <Monitor size={14} />}
            Open live Workbench
          </button>
        )}
        {phase === "vm" && !control.held && !control.helpReason && (
          <button
            onClick={() => void openDesktop()}
            disabled={controlPending || pending === "join" || !vmViewerUrl}
            className="mt-3 flex min-h-9 w-full items-center justify-center gap-2 rounded-md bg-control px-3 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            title={`Pause ${bot.name} and open the Isolated Workbench`}
          >
            {pending === "join" ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <Hand size={14} />}
            Take controls
          </button>
        )}
        {phase === "vm" && vmStatus?.mode === "per-bot" && (
          <button
            onClick={() => void runVmAction("vm-delete")}
            disabled={pending !== null || bot.busy}
            className="mt-2 flex min-h-9 w-full items-center justify-center gap-2 rounded-md border border-danger/30 px-3 text-[13px] text-danger hover:bg-danger/10 disabled:opacity-50"
            title={bot.busy ? `Stop ${bot.name}'s active run before deleting the workbench` : `Delete ${bot.name}'s Isolated Workbench`}
          >
            {pending === "vm-delete" ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <Power size={14} />}
            Delete Isolated Workbench
          </button>
        )}
        {/* Cloud-only actions */}
        {phase === "ready" && (
          <div className="mt-3 flex gap-2">
            {!control.held && !control.helpReason && (
              <button
                onClick={() =>
                  void openDesktop()
                }
                disabled={controlPending || pending === "join"}
                className="flex min-h-9 flex-1 items-center justify-center gap-2 rounded-md bg-control px-3 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
                title={`Pause ${bot.name} and drive this Workbench yourself`}
              >
                {pending === "join" ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <Hand size={14} />}
                Take controls
              </button>
            )}
            {control.held && (
              <button
                onClick={() => void openDesktop()}
                disabled={pending === "join"}
                className="flex min-h-9 flex-1 items-center justify-center gap-2 rounded-md bg-control px-3 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {pending === "join" ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <Monitor size={14} />}
                Open live Workbench
              </button>
            )}
            {(cloudBackend === "vps" || boxState !== "archived") && (
              <button
                onClick={() => run("sleep")}
                disabled={pending === "sleep"}
                className="flex min-h-9 flex-1 items-center justify-center gap-2 rounded-md bg-control px-3 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
                title="Put the Remote Workbench to sleep"
              >
                {pending === "sleep" ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <Moon size={14} />}
                Sleep
              </button>
            )}
          </div>
        )}

        <LocalScreenPreview />
        <LinuxLocalControl />
        <MacLocalControl />

        {/* Workbench source */}
          <section className="mt-5 border-t border-hairline/60 pt-4" aria-labelledby="workbench-surface-title">
            <h3 id="workbench-surface-title" className="font-display text-[16px] font-medium text-ink">Execution surface</h3>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {!bot.computer &&
                (isLinux || !localSelectable
                  ? cloudBackend === "vps"
                    ? "Automatic selection reuses a ready self-hosted workbench; otherwise Workbench access stays off. "
                    : `${linuxAutoDescription()} `
                  : cloudBackend === "vps"
                    ? "Automatic selection reuses a ready self-hosted workbench, otherwise the Host Workbench. "
                    : "Automatic selection uses a managed remote workbench when ready, otherwise the Host Workbench. ")}
              Choose where {bot.name} works. <b className="text-ink">Isolated</b> is a Linux desktop in a local container,
              separate from your own desktop. Prepare it in System → Isolated Workbench.
          </div>
          <div role="group" aria-label="Execution surface" className="mt-3 flex overflow-hidden rounded-md border border-hairline/60">
            {(
              [
                ["cloud", "Remote"],
                ["vm", "Isolated"],
                ["local", "Host"],
                ["off", "Off"],
              ] as const
            ).map(([mode, label], i) => (
              (() => {
                const disabled =
                  (mode === "cloud" && !cloudSupported) ||
                  (mode === "vm" && !vmSupported) ||
                  (mode === "local" && !localSelectable);
                const unavailableTitle =
                  mode === "vm" && !vmSupported
                    ? "This model engine cannot use an Isolated Workbench"
                    : mode === "cloud" && !cloudSupported
                      ? "This model engine cannot use a Remote Workbench"
                      : mode === "local" && !localSelectable
                        ? localDisabledReason ?? "The Host Workbench is not ready"
                          : undefined;
                return (
              <button
                key={mode}
                disabled={disabled}
                title={unavailableTitle}
                aria-pressed={bot.computer === mode}
                onClick={() => {
                  if (mode === bot.computer) return;
                  if (mode === "local" && bot.autoApprove) setLocalAutoWarning(true);
                  else dispatch({ type: "updateBot", botId: bot.id, patch: { computer: mode } });
                }}
                className={cn(
                  "min-h-9 flex-1 px-2 text-[13px]",
                  i > 0 && "border-l border-hairline/40",
                  disabled && "cursor-not-allowed opacity-40",
                  bot.computer === mode
                    ? "bg-control text-ink"
                    : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                )}
              >
                {label}
              </button>
                );
              })()
            ))}
          </div>
          {(!bot.computer || bot.computer === "cloud") && (
            <>
              <CloudBackendPicker
                value={cloudBackend}
                vpsSupported={vpsSupported}
                onChange={(backend) => dispatch({ type: "updateBot", botId: bot.id, patch: { cloudBackend: backend } })}
              />
              {!bot.computer && cloudBackend === "vps" && (
                <div className="mt-3 flex items-center justify-between gap-4 border-y border-hairline/60 px-1 py-3">
                  <div className="min-w-0">
                    <div className="text-[13px] text-ink">Start Remote Workbench automatically</div>
                    <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                      Off by default. When enabled, Helmryth may create or wake {bot.name}'s managed VPS container.
                    </div>
                  </div>
                  <button
                    role="switch"
                    aria-checked={Boolean(bot.autoStartVps)}
                    aria-label="Start Remote Workbench automatically"
                    onClick={() => dispatch({
                      type: "updateBot",
                      botId: bot.id,
                      patch: { autoStartVps: !bot.autoStartVps },
                    })}
                    className={cn(
                      "relative h-6 w-11 shrink-0 rounded-full",
                      bot.autoStartVps ? "bg-accent" : "bg-control",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute left-[3px] top-[3px] size-[18px] rounded-full bg-panel transition-transform",
                        bot.autoStartVps ? "translate-x-[20px]" : "translate-x-0",
                      )}
                    />
                  </button>
                </div>
              )}
            </>
          )}
        </section>

        {/* Cadences */}
        <section className="mt-5 border-t border-hairline/60 pt-4" aria-labelledby="workbench-cadences-title">
          <div className="flex items-center justify-between gap-2">
            <h3 id="workbench-cadences-title" className="flex items-center gap-2 font-display text-[16px] font-medium text-ink">
              <CalendarClock size={16} className="text-accent" />
              Cadences
            </h3>
            {botRoutines.length > 0 && (
              <span className="rounded-full bg-control px-2 py-0.5 text-[11px] font-medium text-ink-secondary">
                {botRoutines.length}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            Schedule recurring runs for {bot.name}. Use the current execution surface or a managed Remote Workbench.
          </div>
          {!computerDestination && (
            <div role="status" className="mt-3 flex items-start gap-2 border-l-2 border-warning bg-warning/10 px-3 py-2 text-[12px] leading-relaxed text-warning">
              <Power size={13} className="mt-0.5 shrink-0" />
              Cadences cannot use a desktop while Workbench access is off. Choose Remote in the cadence editor to run inside a managed workbench.
            </div>
          )}
          {activeRoutineRun && (
            <button
              onClick={() => dispatch({ type: "showRoutines" })}
              className="mt-3 flex min-h-9 w-full items-center gap-2 border-l-2 border-accent bg-accent/10 px-3 py-2 text-left text-[13px] text-accent hover:bg-accent/15"
            >
              <Loader2 size={13} className={activeRoutineRun.status === "queued" ? "" : "motion-safe:animate-spin"} />
              <span className="min-w-0 flex-1 truncate">
                {activeRoutineRun.routineName} · {activeRoutineRun.status === "waiting" ? "needs you" : activeRoutineRun.status}
              </span>
            </button>
          )}
          {botRoutines.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {botRoutines.slice(0, 3).map((routine) => (
                <button
                  key={routine.id}
                  onClick={() => dispatch({ type: "showRoutines" })}
                  className="flex min-h-9 w-full items-center gap-2 rounded-md bg-inset px-3 py-2 text-left hover:bg-control/60"
                >
                  <span className={cn("shrink-0 text-[11px] font-medium", routine.enabled ? "text-success" : "text-ink-secondary")}>
                    {routine.enabled ? "Active" : "Paused"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-ink">{routine.name}</span>
                    <span className="block truncate text-[11.5px] text-ink-secondary">
                      {routineScheduleLabel(routine)}{routine.runOn === "cloud" ? " · Remote Workbench" : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11.5px] text-ink-secondary">{nextRunLabel(routine.nextRunAt)}</span>
                </button>
              ))}
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => setCreatingRoutine(true)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-accent py-2 text-[13px] font-medium text-accent-ink hover:bg-accent-border"
            >
              <Plus size={14} />
              Create cadence
            </button>
            <button
              onClick={() => dispatch({ type: "showRoutines" })}
              className="flex min-h-9 items-center justify-center gap-1.5 rounded-md bg-control px-3 text-[13px] text-ink hover:bg-raised-hover"
              title="Open cadences"
            >
              <CalendarDays size={14} />
              Cadences
            </button>
          </div>
        </section>
      </div>
      )}
      {creatingRoutine && (
        <RoutineEditor
          bots={[bot]}
          lockedBotId={bot.id}
          defaultRunOn={cloudRoutineReady ? "cloud" : "local"}
          onClose={() => setCreatingRoutine(false)}
        />
      )}
    </aside>
    <LocalComputerAutoWarning
      open={localAutoWarning}
      onCancel={() => setLocalAutoWarning(false)}
      onConfirm={() => {
        dispatch({ type: "updateBot", botId: bot.id, patch: { computer: "local", acknowledgeLocalAuto: true } });
        setLocalAutoWarning(false);
      }}
    />
    <WorkbenchPanelGate
      action={confirmation}
      operatorName={bot.name}
      onCancel={() => setConfirmation(null)}
      onConfirm={() => {
        const action = confirmation;
        setConfirmation(null);
        if (action === "vps-replace") void replaceVpsComputer(true);
        else if (action) void runVmAction(action, true);
      }}
    />
    </>
  );
}
