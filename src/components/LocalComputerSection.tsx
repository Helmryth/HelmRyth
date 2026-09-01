// One-place setup for the Isolated Workbench image and allocation policy.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import {
  AlertTriangle,
  Check,
  Circle,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import { CommandLine } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";

type Action = "pull" | "run" | "start" | "stop" | "remove" | "recreate";

/** Name the action the user pressed. A failed Start is not a failed status read,
 * and saying so sends people to debug the wrong thing. */
const ACTION_FAILURE_HEADLINE = {
  pull: "Could not prepare the Workbench image.",
  run: "Could not create the Isolated Workbench.",
  start: "Could not start the Isolated Workbench.",
  stop: "Could not stop the Isolated Workbench.",
  remove: "Could not remove the Isolated Workbench.",
  recreate: "Could not rebuild the Isolated Workbench.",
  policy: "Could not save the workbench allocation.",
} satisfies Record<Action | "policy", string>;

export interface LocalWorkbenchStatus {
  platform: string;
  runtime: string | null;
  available: string[];
  daemonUp: boolean;
  image: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  image_ref: string;
  base_image_ref: string;
  driver_version: string;
  container_name: string;
  workspace_path: string;
  workspace_guest_path: string;
  viewer_url: string;
  idle_timeout_ms: number;
  mode: "shared" | "per-bot";
  max_instances: number;
  commands: {
    install: string | null;
    runtimeStart: string | null;
    pull: string | null;
    run: string | null;
    start: string | null;
    stop: string | null;
    remove: string | null;
    view: string;
  };
}

const statusSchema = z.object({
  platform: z.string(),
  runtime: z.string().nullable(),
  available: z.array(z.string()),
  daemonUp: z.boolean(),
  image: z.boolean(),
  imageMatches: z.boolean(),
  managed: z.boolean(),
  container: z.enum(["running", "stopped", "missing"]),
  network: z.enum(["loopback", "unsafe", "unknown"]),
  security: z.enum(["hardened", "unsafe", "unknown"]),
  persistence: z.enum(["durable", "unsafe", "unknown"]),
  desktopReady: z.boolean(),
  ready: z.boolean(),
  problem: z.string().nullable(),
  image_ref: z.string(),
  base_image_ref: z.string(),
  driver_version: z.string(),
  container_name: z.string(),
  workspace_path: z.string(),
  workspace_guest_path: z.string(),
  viewer_url: z.string(),
  idle_timeout_ms: z.number(),
  mode: z.enum(["shared", "per-bot"]),
  max_instances: z.number().int().positive(),
  commands: z.object({
    install: z.string().nullable(),
    runtimeStart: z.string().nullable(),
    pull: z.string().nullable(),
    run: z.string().nullable(),
    start: z.string().nullable(),
    stop: z.string().nullable(),
    remove: z.string().nullable(),
    view: z.string(),
  }),
}) satisfies z.ZodType<LocalWorkbenchStatus>;

const errorResponseSchema = z.object({ error: z.string().optional() }).passthrough();

export type WorkbenchReadinessIssue =
  | "status-unavailable"
  | "runtime-missing"
  | "runtime-stopped"
  | "image-missing"
  | "workbench-missing"
  | "image-mismatch"
  | "unmanaged"
  | "network-unsafe"
  | "security-unsafe"
  | "persistence-unsafe"
  | "workbench-stopped"
  | "desktop-starting"
  | "not-ready";

export interface WorkbenchReadiness {
  issue: WorkbenchReadinessIssue;
  message: string;
}

function runtimeLabel(runtime: string): string {
  if (runtime === "docker") return "Docker";
  if (runtime === "podman") return "Podman";
  if (runtime === "container") return "Apple container";
  return "the container runtime";
}

/**
 * The Workbench API reports several default false/unknown fields when it
 * cannot reach the runtime. Keep the user-facing diagnosis ordered by what
 * they can fix now instead of surfacing downstream compatibility noise.
 */
export function workbenchReadiness(status: LocalWorkbenchStatus | null): WorkbenchReadiness {
  if (!status) return { issue: "status-unavailable", message: "Workbench status is unavailable" };
  if (!status.runtime) {
    return { issue: "runtime-missing", message: "Install a supported container runtime first" };
  }
  if (!status.daemonUp) {
    return { issue: "runtime-stopped", message: `Start ${runtimeLabel(status.runtime)} first` };
  }
  if (!status.image) {
    return { issue: "image-missing", message: "Prepare the Workbench image" };
  }
  if (status.container === "missing") {
    return { issue: "workbench-missing", message: "Create the Isolated Workbench" };
  }
  if (!status.imageMatches) {
    return { issue: "image-mismatch", message: "The Workbench image needs replacement" };
  }
  if (!status.managed) {
    return { issue: "unmanaged", message: "This Workbench is not managed by the current Helmryth installation" };
  }
  if (status.network === "unsafe") {
    return { issue: "network-unsafe", message: "The viewer network boundary is unsafe" };
  }
  if (status.security === "unsafe") {
    return { issue: "security-unsafe", message: "The Workbench security boundary is unsafe" };
  }
  if (status.persistence === "unsafe") {
    return { issue: "persistence-unsafe", message: "The durable workspace boundary is unsafe" };
  }
  if (status.container === "stopped") {
    return { issue: "workbench-stopped", message: "The Isolated Workbench is stopped" };
  }
  if (!status.desktopReady) {
    return { issue: "desktop-starting", message: "The Isolated Workbench is starting" };
  }
  return { issue: "not-ready", message: "The Isolated Workbench is not ready" };
}

export function workbenchProblem(status: LocalWorkbenchStatus | null): string {
  return workbenchReadiness(status).message;
}

export function workbenchNeedsRecreation(status: LocalWorkbenchStatus | null): boolean {
  if (!status) return false;
  if (!status.runtime || !status.daemonUp || !status.image || status.container === "missing") return false;
  const issue = workbenchReadiness(status).issue;
  return (
    issue === "image-mismatch" ||
    issue === "unmanaged" ||
    issue === "network-unsafe" ||
    issue === "security-unsafe" ||
    issue === "persistence-unsafe" ||
    issue === "workbench-stopped"
  );
}

function WorkbenchSection({
  title,
  subtitle,
  children,
}: {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const titleId = useId();
  return (
    <section className="border-t border-hairline/60 py-5 first:border-t-0" aria-labelledby={title ? titleId : undefined}>
      {title && <h3 id={titleId} className="font-display text-[16px] font-semibold text-ink">{title}</h3>}
      {subtitle && <p className="mt-1 max-w-[760px] text-[13px] leading-relaxed text-ink-secondary">{subtitle}</p>}
      <div className={title || subtitle ? "mt-4" : undefined}>{children}</div>
    </section>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px]",
          done ? "bg-success/20 text-success" : "border border-hairline/50 text-ink-secondary",
        )}
      >
        {done ? <Check size={12} /> : n}
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn("text-[14px]", done ? "text-ink-secondary line-through" : "text-ink")}>{title}</div>
        {!done && children && <div className="mt-2 flex flex-col items-start gap-2 [&>*]:max-w-full">{children}</div>}
      </div>
    </div>
  );
}

function ActionButton({
  action,
  pending,
  children,
  onClick,
  danger = false,
}: {
  action: Action;
  pending: Action | null;
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending !== null}
      className={cn(
        "flex min-h-9 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium disabled:opacity-50",
        danger ? "bg-danger/15 text-danger hover:bg-danger/20" : "bg-accent text-accent-ink hover:bg-accent-border",
      )}
    >
      {pending === action && <Loader2 size={13} className="motion-safe:animate-spin" />}
      {children}
    </button>
  );
}

function WorkbenchMutationGate({
  action,
  onCancel,
  onConfirm,
}: {
  action: "remove" | "recreate" | null;
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
  const replacing = action === "recreate";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-6">
      <div ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby="workbench-mutation-title" aria-describedby="workbench-mutation-copy" className="max-h-[calc(100vh-48px)] w-full max-w-[440px] overflow-y-auto rounded-md border border-hairline bg-panel p-5">
        <h2 id="workbench-mutation-title" className="font-display text-[20px] font-semibold text-ink">
          {replacing ? "Replace the Isolated Workbench?" : "Delete the Isolated Workbench?"}
        </h2>
        <p id="workbench-mutation-copy" className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
          {replacing
            ? "Helmryth will delete the disposable desktop state and rebuild it from the verified image. Durable work files and browser sign-ins remain."
            : "Helmryth will delete the disposable desktop and stop its viewer. Durable work files and browser sign-ins remain; creating another workbench requires setup again."}
        </p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button ref={cancelRef} type="button" onClick={onCancel} className="min-h-9 w-full rounded-md border border-hairline/60 px-4 text-[13px] text-ink hover:bg-raised sm:w-auto">Keep workbench</button>
          <button type="button" onClick={onConfirm} className="min-h-9 w-full rounded-md bg-danger px-4 text-[13px] font-medium text-[var(--color-danger-ink)] sm:w-auto">
            {replacing ? "Replace workbench" : "Delete workbench"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function LocalComputerSection() {
  const [status, setStatus] = useState<LocalWorkbenchStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Action | null>(null);
  // Two different failures, two different lifetimes. The 5s status poll owns
  // `statusError` and clears it the moment a read succeeds; an action the user
  // pressed owns `actionError` and must survive until they act again, or the
  // next poll would erase the only explanation they were given.
  const [statusError, setStatusError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ action: Action | "policy"; message: string } | null>(null);
  const [policyPending, setPolicyPending] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [gateAction, setGateAction] = useState<"remove" | "recreate" | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/local-computer", { signal });
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const parsedError = errorResponseSchema.safeParse(body);
      throw new Error(parsedError.success ? parsedError.data.error ?? `Status request failed (${response.status})` : `Status request failed (${response.status})`);
    }
    setStatus(statusSchema.parse(body));
    setStatusError(null);
  }, []);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const poll = async () => {
      controller = new AbortController();
      try {
        await refresh(controller.signal);
      } catch (e) {
        if (active && !(e instanceof DOMException && e.name === "AbortError")) {
          setStatusError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (active) {
          setLoading(false);
          timer = window.setTimeout(() => void poll(), 5000);
        }
      }
    };
    void poll();
    return () => {
      active = false;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh, refreshKey]);

  const post = async (action: Exclude<Action, "recreate">) => {
    const response = await fetch(`/api/local-computer/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const parsedError = errorResponseSchema.safeParse(body);
      throw new Error(parsedError.success ? parsedError.data.error ?? `${action} failed` : `${action} failed`);
    }
    setStatus(statusSchema.parse(body));
  };

  const act = async (action: Action, confirmed = false) => {
    if (!confirmed && (action === "remove" || action === "recreate")) {
      setGateAction(action);
      return;
    }
    setPending(action);
    setActionError(null);
    try {
      if (action === "recreate") {
        await post("remove");
        await post("run");
      } else {
        await post(action);
      }
      // The desktop starts after the container process; keep the progress
      // state honest and let the regular poll mark it Ready a few seconds on.
      await refresh();
    } catch (e) {
      setActionError({ action, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setPending(null);
    }
  };

  const savePolicy = async (mode: LocalWorkbenchStatus["mode"], maxInstances: number) => {
    setPolicyPending(true);
    setActionError(null);
    try {
      const response = await fetch("/api/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ localVm: { mode, maxInstances } }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not save the Isolated Workbench allocation policy");
      setStatus((current) => current ? { ...current, mode, max_instances: maxInstances } : current);
      await refresh();
    } catch (e) {
      setActionError({ action: "policy", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setPolicyPending(false);
    }
  };

  const c = status?.commands;
  const ready = status?.ready === true;
  const existing = status !== null && status.container !== "missing";
  const needsRecreate = workbenchNeedsRecreation(status);
  const unavailable = !loading && !status;
  const host = status?.platform === "darwin" ? "Mac" : "host";
  const perBot = status?.mode === "per-bot";
  const perBotRuntimeUnsupported = perBot && status?.runtime === "container";
  const headerReady = perBot ? Boolean(status?.daemonUp && status?.image && !perBotRuntimeUnsupported) : ready;

  return (
    <>
      <WorkbenchSection
        title="Isolated Workbench"
        subtitle={perBot
          ? `Private Linux workbenches run locally in containers on this ${host}. Each operator receives a durable workspace and can run concurrently; idle workbenches stop after 8 hours.`
          : `One Linux workbench runs locally in an isolated container on this ${host}. Operators share its durable workspace one at a time; it stops after 8 idle hours.`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span
            role="status"
            aria-live="polite"
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px]",
              headerReady ? "bg-success/15 text-success" : "bg-control text-ink-secondary",
            )}
          >
            {loading ? <Loader2 size={12} className="motion-safe:animate-spin" /> : headerReady ? <Check size={12} /> : <Circle size={9} />}
            {loading
              ? "Checking…"
              : unavailable
                ? "Status unavailable"
                : perBot && headerReady
                  ? "Ready for dedicated workbenches"
                  : perBotRuntimeUnsupported
                    ? "Dedicated allocation requires Docker or Podman"
                  : ready
                    ? "Ready"
                    : workbenchProblem(status)}
          </span>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              setRefreshKey((key) => key + 1);
            }}
            disabled={loading || pending !== null}
            className="flex min-h-9 items-center gap-1.5 rounded-md border border-hairline/60 px-2.5 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
          >
            <RefreshCw size={12} /> Re-check
          </button>
          {ready && !perBot && (
            <a
              href={status?.viewer_url ?? c?.view}
              target="_blank"
              rel="noreferrer"
              className="flex min-h-9 items-center gap-1.5 rounded-md border border-hairline/60 px-2.5 text-[12.5px] text-ink hover:bg-control"
            >
              <ExternalLink size={12} /> Watch screen
            </a>
          )}
        </div>
        {actionError && (
          <div role="alert" className="mt-3 border-l-2 border-danger bg-danger/10 px-3 py-2 text-[13px] text-danger">
            <div className="flex items-start justify-between gap-3">
              <span>{ACTION_FAILURE_HEADLINE[actionError.action]}</span>
              <button
                onClick={() => setActionError(null)}
                className="shrink-0 text-[12px] text-ink-secondary underline-offset-2 hover:underline"
              >
                Dismiss
              </button>
            </div>
            <p className="mt-1 break-words text-[12px] text-ink-secondary">{actionError.message}</p>
          </div>
        )}
        {statusError && !actionError && (
          <div role="alert" className="mt-3 border-l-2 border-danger bg-danger/10 px-3 py-2 text-[13px] text-danger">
            Isolated Workbench status could not update.
            <details className="mt-1 text-ink-secondary">
              <summary className="cursor-pointer text-[12px]">Technical detail</summary>
              <p className="mt-1 break-words text-[12px]">{statusError}</p>
            </details>
          </div>
        )}
      </WorkbenchSection>

      <WorkbenchSection
        title="Allocation"
        subtitle="Shared uses one isolated desktop in sequence. Dedicated gives every operator a separate container, durable workspace, viewer route, control lease, and idle timer."
      >
        <div role="group" aria-label="Workbench allocation" className="flex overflow-hidden rounded-md border border-hairline/60">
          {(["shared", "per-bot"] as const).map((mode, index) => (
            <button
              key={mode}
              type="button"
              disabled={!status || policyPending}
              onClick={() => void savePolicy(mode, status?.max_instances ?? 2)}
              aria-pressed={status?.mode === mode}
              className={cn(
                "min-h-9 flex-1 px-3 text-[13px] disabled:opacity-50",
                index > 0 && "border-l border-hairline/40",
                status?.mode === mode ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              {mode === "shared" ? "Shared workbench" : "Dedicated per operator"}
            </button>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] text-ink">Maximum dedicated workbenches</div>
            <div className="text-[12px] text-ink-secondary">Limits storage and host resource use; each running desktop may use up to 4 GB and 2 CPUs.</div>
          </div>
          <select
            aria-label="Maximum dedicated workbenches"
            value={status?.max_instances ?? 2}
            disabled={!status || policyPending}
            onChange={(event) => void savePolicy(status?.mode ?? "shared", Number(event.target.value))}
            className="min-h-9 rounded-md border border-hairline/60 bg-control px-2.5 text-[13px] text-ink outline-none focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/30 disabled:opacity-50"
          >
            {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
        {policyPending && <div role="status" className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-secondary"><Loader2 size={12} className="motion-safe:animate-spin" /> Saving allocation…</div>}
      </WorkbenchSection>

      <WorkbenchSection title="Prepare" subtitle="Once a container runtime is open, Helmryth verifies and prepares the Isolated Workbench image.">
        <div className="flex flex-col gap-4">
          <Step n={1} title="Install a container runtime" done={Boolean(status?.runtime)}>
            <div className="text-[13px] leading-relaxed text-ink-secondary">
              Podman and Colima are free. Docker Desktop may require a paid licence for larger companies and government use.
            </div>
            {c?.install ? (
              <CommandLine command={c.install} />
            ) : (
              <a href="https://podman.io/docs/installation" target="_blank" rel="noreferrer" className="text-[13px] text-accent hover:underline">
                Open the Podman installation guide (new tab)
              </a>
            )}
          </Step>

          <Step
            n={2}
            title={status?.runtime && !status.daemonUp ? `Open and start ${status.runtime}` : "Start the container runtime"}
            done={Boolean(status?.daemonUp)}
          >
            {!status?.runtime ? null : c?.runtimeStart ? (
              <CommandLine command={c.runtimeStart} />
            ) : (
              <div className="text-[13px] text-ink-secondary">Open the installed runtime and start its engine, then re-check.</div>
            )}
          </Step>

          <Step n={3} title="Prepare the Workbench image (one-time download and build)" done={Boolean(status?.image)}>
            {status?.daemonUp && (
              <ActionButton action="pull" pending={pending} onClick={() => void act("pull")}>Prepare Workbench image</ActionButton>
            )}
            {c?.pull && <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer">Show base-image download</summary><div className="mt-2"><CommandLine command={c.pull} /></div></details>}
          </Step>

          <Step
            n={4}
            title={perBot ? "Create a private workbench from each operator's Workbench panel" : needsRecreate ? "Replace the outdated or unsafe workbench" : "Create and start the Isolated Workbench"}
            done={!perBot && ready}
          >
            {perBot ? (
              <div className="text-[13px] leading-relaxed text-ink-secondary">
                {perBotRuntimeUnsupported
                  ? "Apple container requires an explicit host port, so Helmryth will not guess or expose one. Install or start Docker or Podman for safe dynamic loopback ports per operator."
                  : <>
                      Choose <b className="text-ink">Isolated</b> for an operator, open that operator's Workbench panel, then create the workbench there. Helmryth assigns a private workspace and loopback-only viewer route automatically.
                    </>}
              </div>
            ) : needsRecreate ? (
              <>
                <div className="flex gap-2 text-[13px] text-warning">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  <span>{workbenchProblem(status)}</span>
                </div>
                {status?.image ? (
                  <ActionButton action="recreate" pending={pending} onClick={() => void act("recreate")} danger>
                    <RotateCcw size={13} /> Delete and recreate
                  </ActionButton>
                ) : (
                  <div className="text-[13px] text-ink-secondary">Prepare the verified Workbench image above before replacing this workbench.</div>
                )}
              </>
            ) : status?.container === "stopped" ? (
              <ActionButton action="start" pending={pending} onClick={() => void act("start")}>Start Isolated Workbench</ActionButton>
            ) : status?.container === "running" ? (
              <div className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={13} className="motion-safe:animate-spin" /> Waiting for the desktop…</div>
            ) : status?.image ? (
              <ActionButton action="run" pending={pending} onClick={() => void act("run")}>Create Isolated Workbench</ActionButton>
            ) : null}
            {c?.run && <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer">Show command</summary><div className="mt-2"><CommandLine command={c.run} /></div></details>}
          </Step>
        </div>
      </WorkbenchSection>

      {unavailable && (
        <WorkbenchSection>
          <div className="flex gap-2 text-[13px] text-ink-secondary">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>Helmryth could not inspect the container runtime. Re-check, or review the app logs.</span>
          </div>
        </WorkbenchSection>
      )}

      <WorkbenchSection
        title="Boundaries and storage"
        subtitle="Durable work files remain on this host; isolated desktop state stays disposable. Internet access remains available."
      >
        {existing && (
          <div className="flex flex-wrap gap-2">
            {status?.container === "running" && (
              <ActionButton action="stop" pending={pending} onClick={() => void act("stop")}>
                <Square size={12} /> Stop
              </ActionButton>
            )}
            <ActionButton action="remove" pending={pending} onClick={() => void act("remove")} danger>
              <Trash2 size={12} /> {perBot ? "Delete shared workbench" : "Delete workbench"}
            </ActionButton>
          </div>
        )}
        <div className="mt-3 break-all text-[12px] text-ink-secondary">
          Durable workspace: {status?.workspace_path ?? "not created"} ·{" "}
          Workbench Driver: {status?.driver_version || "not detected"} · Workbench image: {status?.image_ref ?? "not prepared"}
          {status?.base_image_ref ? <> · Base: {status.base_image_ref}</> : null}
        </div>
        <details className="mt-3 border-t border-hairline/60 pt-3 text-[12px] leading-relaxed text-ink-secondary">
          <summary className="cursor-pointer font-medium text-ink">Technical boundaries</summary>
          <p className="mt-2">
            {perBot
              ? "The Workbench Driver can act only inside each isolated desktop. Every operator gets a private host workspace; files and browser profiles survive replacement. Viewers bind only to loopback, and operator-scoped targets prevent cross-workbench attachment."
              : "The Workbench Driver can act only inside the isolated desktop. One private host workspace preserves files and browser sign-ins while the rest stays disposable. The protected viewer is available only on this host."}
            {" "}Each workbench is limited to 4 GB, 2 CPUs, 512 processes, and minimal Linux capabilities.
          </p>
        </details>
      </WorkbenchSection>
      <WorkbenchMutationGate
        action={gateAction}
        onCancel={() => setGateAction(null)}
        onConfirm={() => {
          const action = gateAction;
          setGateAction(null);
          if (action) void act(action, true);
        }}
      />
    </>
  );
}
