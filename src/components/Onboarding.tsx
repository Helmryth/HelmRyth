import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, AlertTriangle, Loader2, Mic } from "lucide-react";
import { setEmailGateDone, track } from "@/lib/analytics";
import { loadSharedInstances, loadValidatedInstances, type InstancesFetch } from "@/lib/instances-loader";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { EngineSetup } from "./EngineSetup";
import { ProviderMark } from "./ProviderIcons";
import { PhoneSetupFlow } from "./PhoneSetupFlow";
import type { InstanceInfo } from "@/state/store";
import { HELMRYTH } from "@/lib/helmryth";

// First-run onboarding: who you are (email), what's installed (live engine
// checks from the harness), what the app may use (TCC), then an optional
// Helmryth Mobile setup that can always be resumed from System → Helmryth Mobile.
// Every check is skippable — onboarding must never brick the app.

type InstanceRow = InstanceInfo;
type OnboardingAnalytics = {
  track: typeof track;
  setEmailGateDone: typeof setEmailGateDone;
};

export async function loadOnboardingInstances(fetchInstances: InstancesFetch): Promise<InstanceRow[]> {
  return loadValidatedInstances(fetchInstances);
}

export function createOnboardingInstancesRefresh(
  loadInstances: (options?: { force?: boolean }) => Promise<InstanceRow[]>,
  commit: (instances: InstanceRow[]) => void,
) {
  let active = true;
  let pending: Promise<void> | null = null;

  return {
    refresh() {
      // Window-focus can fire while focus is being moved into the newly
      // mounted dialog. Coalescing avoids launching duplicate provider probes
      // and, crucially, prevents a later request from starving an earlier
      // successful result.
      if (pending) return pending;
      const request = loadInstances()
        .then((instances) => {
          if (active) commit(instances);
        })
        .finally(() => {
          if (pending === request) pending = null;
        });
      pending = request;
      return request;
    },
    stop() {
      active = false;
    },
  };
}

const DEFAULT_ONBOARDING_ANALYTICS: OnboardingAnalytics = { track, setEmailGateDone };

const FOCUSABLE_ONBOARDING_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

export function onboardingDialogTitle(step: number): string {
  return `Setup step ${step + 1} of 4: ${
    step === 0 ? "Identity" : step === 1 ? "Engines" : step === 2 ? "Input boundary" : "Helmryth Mobile"
  }`;
}

export function onboardingFocusWrapTarget<T>(focusables: readonly T[], current: T | null, backwards: boolean): T | null {
  if (focusables.length === 0) return null;
  if (!current) return backwards ? focusables[focusables.length - 1] ?? null : focusables[0] ?? null;
  if (backwards && current === focusables[0]) return focusables[focusables.length - 1] ?? null;
  if (!backwards && current === focusables[focusables.length - 1]) return focusables[0] ?? null;
  return null;
}

function dialogFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_ONBOARDING_SELECTOR)).filter(
    (element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true",
  );
}

function focusOnboardingEntry(container: HTMLElement | null): void {
  if (!container) return;
  const preferred = container.querySelector<HTMLElement>("[data-onboarding-autofocus='true']");
  if (preferred) {
    preferred.focus();
    return;
  }
  const focusables = dialogFocusableElements(container);
  (focusables[0] ?? container).focus();
}

function StatusRow({
  ok,
  warn,
  title,
  detail,
  mark,
  children,
}: {
  ok: boolean;
  warn?: boolean;
  title: string;
  detail?: string;
  mark?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 border-t border-hairline/50 py-3.5">
      <span
        className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md ${
          ok ? "bg-success/15 text-success" : warn ? "bg-warning/15 text-warning" : "bg-raised text-ink-secondary"
        }`}
      >
        {ok ? <Check size={14} /> : <AlertTriangle size={13} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
          {mark}
          <span className="min-w-0 truncate">{title}</span>
        </div>
        {detail && <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">{detail}</div>}
        {children}
      </div>
    </div>
  );
}

/** One engine on the setup screen: what it's called, what the harness
 * found, and the one-liner to show when it's good to go. Ready states get
 * a sentence; anything the user has to act on gets the shared setup UI, so
 * the instructions come from the driver and are correct for this platform. */
interface EngineEntry {
  instance: InstanceRow;
  label: string;
  readyNote: string;
}

function engineReady(instance: InstanceRow): boolean {
  return (
    instance.snapshot.state === "available" &&
    (instance.access === "custom" || instance.snapshot.authenticated !== false)
  );
}

function engineTitle({ instance, label }: EngineEntry): string {
  const version = instance?.snapshot.version ? ` · ${instance.snapshot.version.split(" ")[0]}` : "";
  return `${label}${version}`;
}

/** A ready engine needs no attention: a small tile in the grid, so five
 * engines don't read as one long list where the good news and the setup
 * work look the same. */
function ReadyTile(entry: EngineEntry) {
  return (
    <div className="flex items-start gap-2.5 border-t border-hairline/50 py-3">
      <ProviderMark driverKind={entry.instance.driverKind} size={17} />
      <div className="min-w-0">
        <div className="truncate text-[13.5px] font-medium text-ink">{engineTitle(entry)}</div>
        <div className="mt-0.5 text-[12px] leading-snug text-ink-secondary">{entry.readyNote}</div>
      </div>
    </div>
  );
}

/** An engine that still needs installing or signing in keeps the full-width
 * row: the command box and terminal button need the width. */
function SetupRow(entry: EngineEntry) {
  return (
    <StatusRow
      ok={false}
      warn
      title={engineTitle(entry)}
      mark={<ProviderMark driverKind={entry.instance.driverKind} size={16} />}
    >
      <EngineSetup
        instance={entry.instance}
        className="mt-0.5"
        intent={entry.instance.access === "custom" ? "inject" : "cloud"}
      />
    </StatusRow>
  );
}

export function Onboarding({
  onDone,
  analytics = DEFAULT_ONBOARDING_ANALYTICS,
  desktopState,
}: {
  onDone: () => void;
  analytics?: OnboardingAnalytics;
  desktopState?: ReturnType<typeof useDesktopCapabilities>;
}) {
  const liveDesktopState = useDesktopCapabilities();
  const { capabilities } = desktopState ?? liveDesktopState;
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [profileSkipped, setProfileSkipped] = useState(false);
  const [instances, setInstances] = useState<InstanceRow[] | null>(null);
  const [perms, setPerms] = useState<{ mic: string } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const progressId = useId();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

  const saveProfile = (includeEmail = true) => {
    const normalizedEmail = includeEmail ? email.trim().toLowerCase() : "";
    // persisted server-side (~/.helmryth/config.json) — the score rail
    // footer reads it back through /api/config
    void fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: name.trim(), email: normalizedEmail } }),
    }).catch(() => {});
    setProfileSkipped(!includeEmail);
    setStep(1);
  };

  useEffect(() => {
    analytics.track("onboarding_step", { step });
  }, [analytics, step]);

  useLayoutEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusOnboardingEntry(dialogRef.current);
    return () => {
      restoreFocusRef.current?.focus();
    };
  }, []);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (dialog.contains(document.activeElement)) return;
    focusOnboardingEntry(dialog);
  }, [step]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== "Tab") return;
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const current = activeElement && dialog.contains(activeElement) ? activeElement : null;
      const focusables = dialogFocusableElements(dialog);
      const wrapTarget = onboardingFocusWrapTarget(focusables, current, event.shiftKey);
      if (!wrapTarget) return;
      event.preventDefault();
      wrapTarget.focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  useEffect(() => {
    if (step !== 1) return;
    const loader = createOnboardingInstancesRefresh(loadSharedInstances, setInstances);
    const refresh = () => void loader.refresh();
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      loader.stop();
      window.removeEventListener("focus", refresh);
    };
  }, [step]);

  useEffect(() => {
    if (step === 2 && capabilities.dictation.available) {
      const poll = () => window.helmryth?.permStatus?.().then(setPerms).catch(() => {});
      poll();
      // keep polling — the user may grant in System Settings and come back
      const t = setInterval(poll, 2000);
      return () => clearInterval(t);
    }
  }, [step, capabilities.dictation.available]);

  const finish = () => {
    analytics.track("onboarding_completed", {
      engines_available: instances?.filter((i) => i.snapshot.state === "available").length ?? -1,
      mic: perms?.mic ?? "n/a",
    });
    analytics.setEmailGateDone(profileSkipped ? "skipped" : "submitted");
    onDone();
  };

  const engines: EngineEntry[] = (instances ?? [])
    .filter((instance) => instance.install)
    .map((instance) => ({
      instance,
      label: instance.displayName,
      readyNote:
        instance.access === "custom"
          ? "Installed — ready for a local model."
          : "Installed — ready for operator runs.",
    }));
  const readyEngines = engines.filter((e) => engineReady(e.instance));
  const setupEngines = engines.filter((e) => !engineReady(e.instance));
  const examples = HELMRYTH.exampleOperators.slice(0, 3);
  const dialogTitle = onboardingDialogTitle(step);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app p-3 sm:p-8">
      {/* the engines step lays tiles out two across, so it gets more width —
          but never more than the window: the panel caps at the viewport and
          the engine list scrolls inside it, so the header and Continue stay
          put and nothing runs into the edges */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${descriptionId} ${progressId}`}
        tabIndex={-1}
        className={`flex max-h-full w-full flex-col overflow-hidden rounded-lg border border-hairline/70 bg-panel p-6 shadow-xl sm:p-8 ${step === 1 ? "max-w-[720px]" : step === 3 ? "max-w-[640px]" : "max-w-[500px]"}`}
      >
        <h2 id={titleId} className="sr-only">{dialogTitle}</h2>
        <p id={descriptionId} className="sr-only">
          First-run setup. Finish or skip each step inside this dialog before the main workspace becomes available.
        </p>
        {/* Advancing a step swaps the dialog's accessible name, and focus moves
            inside the new step rather than back to the dialog — so nothing
            re-reads the name and the step change happens in silence. This
            region is mounted for the dialog's whole life, so each new title is
            announced as a change. */}
        <p id={progressId} role="status" aria-live="polite" className="sr-only">{dialogTitle}</p>
        <div className="mb-6 flex items-center gap-3" aria-label={`Setup step ${step + 1} of 4`}>
          <div className="flex items-center gap-1" aria-hidden="true">
            {[0, 1, 2, 3].map((index) => (
              <span key={index} className={`h-1 w-8 ${index <= step ? "bg-accent" : "bg-hairline"}`} />
            ))}
          </div>
          <span className="ml-auto text-[10.5px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">
            {step === 0 ? "Identity" : step === 1 ? "Engines" : step === 2 ? "Input" : "Helmryth Mobile"}
          </span>
        </div>
        {step === 0 && (
          <div className="flex flex-col">
            <div aria-hidden="true" className="relative h-12 w-12 overflow-hidden rounded-md border border-hairline bg-inset">
              <span className="absolute left-2 top-1 h-10 w-[3px] -rotate-[24deg] bg-accent" />
              <span className="absolute left-[21px] top-1 h-10 w-[3px] rotate-[24deg] bg-signal" />
              <span className="absolute right-2 top-1 h-10 w-[3px] -rotate-[24deg] bg-ink" />
            </div>
            <div className="mt-5 text-[11px] font-semibold uppercase tracking-[0.075em] text-signal">Welcome to Helmryth</div>
            <h1 className="mt-1 text-[26px] font-semibold tracking-[-0.035em] text-ink">{HELMRYTH.tagline}</h1>
            <p className="mt-2 max-w-[54ch] text-[14px] leading-relaxed text-ink-secondary">
              Name the person at the helm. Helmryth keeps persistent operators, real capabilities, and every consequential gate visible.
            </p>
            <div className="mt-4 grid grid-cols-3 divide-x divide-hairline border-y border-hairline/60 py-3">
              {examples.map((operator) => (
                <div key={operator.name} className="px-3 first:pl-0 last:pr-0">
                  <div className="text-[12.5px] font-semibold text-ink">{operator.name}</div>
                  <div className="mt-0.5 text-[10.5px] leading-snug text-ink-secondary">{operator.role}</div>
                </div>
              ))}
            </div>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              aria-label="Your name"
              data-onboarding-autofocus="true"
              className="mt-5 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || !valid) return;
                // Without this the discrete keydown flushes synchronously, the next
                // step mounts and autofocuses its Continue button, and the SAME
                // keypress activates it — skipping the whole Engines step unseen.
                e.preventDefault();
                saveProfile();
              }}
              placeholder="you@example.com"
              aria-label="Profile email stored locally"
              className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            />
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-secondary">
              Optional. Your profile email stays on this machine and is never included in product telemetry.
            </p>
            <button
              onClick={() => saveProfile()}
              disabled={!valid}
              className="mt-3 w-full rounded-md bg-accent py-2.5 text-[15px] font-medium text-accent-ink disabled:opacity-40"
            >
              Continue
            </button>
            <button
              onClick={() => {
                track("email_skipped");
                saveProfile(false);
              }}
              className="mt-3 text-[12px] text-ink-secondary hover:text-ink"
            >
              Continue without email
            </button>
          </div>
        )}

        {step === 1 && (
          <div className="flex min-h-0 flex-col">
            <div className="text-[11px] font-semibold uppercase tracking-[0.075em] text-signal">Runtime inventory</div>
            <h1 className="mt-1 text-[20px] font-semibold tracking-[-0.02em] text-ink">Choose how work moves</h1>
            <p className="mt-1 text-[13.5px] text-ink-secondary">
              Operators run through model engines already connected to this machine. Here is the live inventory.
            </p>
            <div className="mt-4 flex min-h-0 flex-col gap-2.5 overflow-y-auto pr-1 [scrollbar-width:thin]">
              {!instances ? (
                <div className="flex items-center gap-2 py-6 text-ink-secondary">
                  <Loader2 size={16} className="animate-spin" /> Checking…
                </div>
              ) : (
                <>
                  {readyEngines.length > 0 && (
                    <>
                      <div className="text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">Ready</div>
                      <div className="grid grid-cols-2 gap-2.5">
                        {readyEngines.map((e) => (
                          <ReadyTile key={e.label} {...e} />
                        ))}
                      </div>
                    </>
                  )}
                  {setupEngines.length > 0 && (
                    <>
                      <div className={`text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary ${readyEngines.length ? "mt-2" : ""}`}>
                        Needs setup
                      </div>
                      {setupEngines.map((e) => (
                        <SetupRow key={e.label} {...e} />
                      ))}
                    </>
                  )}
                  {engines.length === 0 && (
                    <div className="border-l-2 border-warning pl-3 text-[13px] leading-relaxed text-ink-secondary">
                      No installable engine was advertised by this build. Continue, then open System → Engines to inspect runtime commands.
                    </div>
                  )}
                </>
              )}
            </div>
            <button
              onClick={() => setStep(capabilities.dictation.available ? 2 : 3)}
              className="mt-5 w-full shrink-0 rounded-md bg-accent py-2.5 text-[15px] font-medium text-accent-ink"
            >
              Continue
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col">
            <div className="text-[11px] font-semibold uppercase tracking-[0.075em] text-signal">Input boundary</div>
            <h1 className="mt-1 text-[20px] font-semibold tracking-[-0.02em] text-ink">Grant only what you intend</h1>
            <p className="mt-1 text-[13.5px] text-ink-secondary">
              This input remains optional and is requested only when you invoke the capability.
            </p>
            <div className="mt-4 flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-3 border-y border-hairline/50 py-3.5">
                <div className="flex items-start gap-3">
                  <Mic size={18} className="mt-0.5 shrink-0 text-ink-secondary" />
                  <div>
                    <div className="text-[14px] font-medium text-ink">Microphone & speech</div>
                    <div className="mt-0.5 text-[12.5px] text-ink-secondary">
                      Voice dictation into the composer, transcribed on-device.
                    </div>
                  </div>
                </div>
                {perms?.mic === "granted" ? (
                  <Check size={16} className="shrink-0 text-success" />
                ) : perms?.mic === "denied" || perms?.mic === "restricted" ? (
                  <button
                    onClick={() => window.helmryth?.permOpenSettings?.("mic")}
                    className="shrink-0 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
                  >
                    Open Settings
                  </button>
                ) : (
                  <button
                    onClick={() =>
                      window.helmryth?.permRequestMic?.().then(() => window.helmryth?.permStatus?.().then(setPerms))
                    }
                    className="shrink-0 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
                  >
                    Enable
                  </button>
                )}
              </div>
              {/* Screen Recording deliberately has no row here: macOS 15+
                  makes a pre-grant unreliable (per-process status caching,
                  helper misattribution, periodic re-prompts) — the OS flow
                  triggers on the first real capture in the Workbench,
                  which is the moment the user has context for the dialog. */}
            </div>
            <button onClick={() => setStep(3)} className="mt-5 w-full rounded-md bg-accent py-2.5 text-[15px] font-medium text-accent-ink">
              Continue
            </button>
            <button onClick={() => setStep(3)} className="mt-3 text-[12px] text-ink-secondary hover:text-ink">
              Skip for now
            </button>
          </div>
        )}

        {step === 3 && (
          <PhoneSetupFlow
            variant="onboarding"
            profileEmail={email}
            onSkip={() => {
              track("phone_setup_skipped");
              finish();
            }}
            onComplete={() => {
              track("phone_setup_completed");
              finish();
            }}
          />
        )}

      </div>
    </div>
  );
}
