// Helmryth System holds workspace-wide configuration. Operator-specific
// identity, runtime, and Workbench controls remain in SettingsPanel.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Coins, Globe, KeyRound, Monitor, Search, Smartphone, Terminal, Trash2, User, X } from "lucide-react";
import { api, useStore, type AppSettingsSection, type ConfigStatus } from "@/state/store";
import { analyticsAvailable, analyticsEnabled, setAnalyticsEnabled } from "@/lib/analytics";
import { builtInBrowserEnabled, showToolCallsEnabled, skillRecorderEnabled } from "@/lib/feature-flags";
import { ApiKeyRow, OpenAiCompatibleConnection, VpsConnection } from "./ApiKeys";
import { useUpdaterState } from "@/lib/updater";
import { EnginesSettings } from "./EnginesSettings";
import { LocalComputerSection } from "./LocalComputerSection";
import { CompanionSection } from "./CompanionSection";
import { Card } from "./SettingsPrimitives";
import { UsageSection } from "./UsageSection";
import { SkinPicker } from "./SkinPicker";
import { RoomTurnTimeoutSettings } from "./RoomTurnTimeoutSettings";
import { TranscriptionSettings } from "./TranscriptionSettings";
import { cn } from "@/lib/cn";
import { keepSystemSectionVisible, restoreSystemFocus } from "@/lib/system-settings";
import { captureFocusRestoreTarget, type FocusTargetLike } from "@/lib/overlay-focus";

export const SECTIONS: Array<{
  id: AppSettingsSection;
  label: string;
  icon: typeof User;
  keywords: string[];
}> = [
  // Keywords are the only other thing the search matches, so a control the
  // user searches for by its own noun ("telemetry", "privacy") has to name it
  // here or it is unreachable from the search box.
  { id: "general", label: "System", icon: User, keywords: ["identity", "name", "email", "profile", "appearance", "analytics", "telemetry", "privacy", "diagnostics", "updates", "capabilities", "trace"] },
  { id: "connections", label: "Connections", icon: KeyRound, keywords: ["keys", "api", "services", "box", "vps"] },
  { id: "engines", label: "Engines", icon: Terminal, keywords: ["models", "providers", "runtime", "cli"] },
  { id: "companion", label: "Helmryth Mobile", icon: Smartphone, keywords: ["phone", "pair", "mobile", "remote", "relay"] },
  { id: "computer", label: "Workbench", icon: Monitor, keywords: ["vm", "virtual", "desktop", "local"] },
  // "Run ledger" already names the in-transcript step timeline. This surface
  // is money and tokens, so it carries its own name.
  { id: "usage", label: "Spend ledger", icon: Coins, keywords: ["usage", "tokens", "cost", "billing", "runs", "spend", "run ledger"] },
];

export function sectionMatches(section: (typeof SECTIONS)[number], query: string): boolean {
  if (!query) return true;
  return [section.label, ...section.keywords].some((part) => part.toLowerCase().includes(query));
}

/** The address check the field only looked like it had. `type="email"` buys
 * browser constraint validation on submit, but this field saves on blur inside
 * no form, so that check never runs, and the config schema stores whatever
 * string arrives. Without this, the type is decoration. Empty stays valid —
 * clearing the address is a legitimate save. */
export function profileEmailError(email: string): string | null {
  const value = email.trim();
  if (!value) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "Enter an address like you@example.com, or leave this empty.";
  return null;
}

/** Persist name + email, reporting every outcome. The earlier version ended in
 * `.catch(() => {})`, so a 500, a rejected address, or an unreachable core all
 * looked exactly like a saved profile. */
export async function saveProfile(
  profile: { name: string; email: string },
  put: (path: string, init: RequestInit) => Promise<ConfigStatus> = api,
): Promise<{ ok: true; config: ConfigStatus } | { ok: false; error: string }> {
  const email = profile.email.trim().toLowerCase();
  const invalid = profileEmailError(email);
  if (invalid) return { ok: false, error: invalid };
  try {
    const config = await put("/api/config", {
      method: "PUT",
      body: JSON.stringify({ profile: { name: profile.name.trim(), email } }),
    });
    return { ok: true, config };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "Could not save your profile." };
  }
}

/** Name + email, persisted to /api/config {profile} on blur. */
function ProfileFields() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(state.config?.profile?.name ?? "");
  const [email, setEmail] = useState(state.config?.profile?.email ?? "");
  const [error, setError] = useState("");
  useEffect(() => {
    setName(state.config?.profile?.name ?? "");
    setEmail(state.config?.profile?.email ?? "");
  }, [state.config?.profile?.name, state.config?.profile?.email]);

  // Only the address field is marked invalid, and only for an address problem —
  // a failed write is reported without accusing the value the user typed.
  const addressRejected = error !== "" && profileEmailError(email) !== null;

  const save = () => {
    void saveProfile({ name, email }).then((result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError("");
      dispatch({ type: "configStatus", config: result.config });
    });
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
  return (
    <div className="flex flex-col gap-3">
      <input value={name} onChange={(e) => setName(e.target.value)} onBlur={save} placeholder="Your name" aria-label="Your name" className={inputClass} />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onBlur={save}
        placeholder="you@example.com"
        aria-label="Profile email"
        aria-invalid={addressRejected ? true : undefined}
        className={inputClass}
      />
      {error ? <p role="alert" className="text-[12px] leading-relaxed text-danger">{error}</p> : null}
    </div>
  );
}

function UpdatesRow() {
  const s = useUpdaterState();
  if (!window.helmryth?.updater) return null;
  const updater = window.helmryth.updater;
  const label =
    s?.status === "checking"
      ? "Checking…"
      : s?.status === "available"
        ? `${s.version} available`
        : s?.status === "downloading"
          ? `Downloading ${Math.round(s.percent ?? 0)}%`
          : s?.status === "downloaded"
            ? `${s.version} ready — restart to apply`
            : s?.status === "error"
              ? `Check failed: ${s.message ?? "unknown error"}`
              : "You're on the latest version we know of.";
  return (
    <Card title="Updates" subtitle={label}>
      <button
        onClick={() => {
          if (s?.status === "available") return void updater.download();
          if (s?.status === "downloaded") return void updater.install();
          void updater.check();
        }}
        disabled={s?.status === "checking" || s?.status === "downloading"}
        className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
      >
        {s?.status === "available"
          ? "Download"
          : s?.status === "downloaded"
            ? "Restart and install"
            : "Check for updates"}
      </button>
    </Card>
  );
}

function ManagedServicesRow() {
  const { state } = useStore();
  const services = state.config?.managedServices;
  if (!services) return null;
  const ready = services.state === "ready";
  return (
    <div className={cn(
      "rounded-lg border px-3 py-2.5",
      ready ? "border-success/25 bg-success/10" : "border-warning/30 bg-warning/10",
    )}>
      <div className={cn("text-[13px] font-medium", ready ? "text-success" : "text-warning")}>
        {ready ? "Helmryth managed services ready" : "Helmryth managed services unavailable"}
      </div>
      <div className="mt-1 break-all text-[11px] leading-relaxed text-ink-secondary">
        {ready
          ? `Registry ${services.registry.origin} · Conduit ${services.conduit.origin}`
          : services.state === "invalid"
            ? "This build’s managed-service configuration did not pass validation. Local features remain available."
            : "This build does not include managed-service routing. Local features remain available."}
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-wide text-ink-secondary">
        {services.source === "packaged" ? "Signed package configuration" : "Development configuration"}
      </div>
    </div>
  );
}

/** Usage analytics, OFF until the person opts in here (analyticsEnabled()
 * returns false with no stored choice). Naming what is sent
 * matters more than the switch: people who cannot see the scope assume the
 * worst, and the worst — conversation text — is exactly what this never
 * sends (autocapture is off; see lib/analytics.ts). */
function AnalyticsRow() {
  const [on, setOn] = useState(analyticsEnabled);
  const available = analyticsAvailable();
  return (
    <Card
      title="Product telemetry"
      subtitle={available
        ? "Anonymous product events record launches and feature use only after you opt in. They never include identity, workstreams, prompts, file contents, or operator output."
        : "No Helmryth telemetry endpoint is configured for this build, so no product events leave this machine."}
    >
      <button
        role="switch"
        aria-checked={on}
        aria-label={available ? "Send anonymous product telemetry" : "Product telemetry unavailable in this build"}
        disabled={!available && !on}
        onClick={() => {
          const next = !on;
          setAnalyticsEnabled(next);
          setOn(next);
        }}
        className={`${cnSwitch(on)} disabled:cursor-not-allowed disabled:opacity-40`}
      >
        <span className={cnKnob(on)} />
      </button>
    </Card>
  );
}

function ToolCallsRow() {
  const { state, dispatch } = useStore();
  const enabled = showToolCallsEnabled(state.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { showToolCalls: !enabled } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the capability-trace setting.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="Capability trace"
      subtitle="Show each capability an operator invokes inside the workstream. The operator pulse already communicates active work, so this stays off by default."
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">Show capability events</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            Named events for shell, search, and connected capabilities. Failures and operator handoffs always remain visible.
          </div>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label="Show capability events in workstreams"
          disabled={saving}
          onClick={() => void toggle()}
          className={`${cnSwitch(enabled)} disabled:cursor-wait disabled:opacity-50`}
        >
          <span className={cnKnob(enabled)} />
        </button>
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}

export function ExperimentalFeaturesRow() {
  const { state, dispatch } = useStore();
  const skillRecorder = skillRecorderEnabled(state.config);
  const browser = builtInBrowserEnabled(state.config);
  const desktopBrowser = Boolean(window.helmryth?.browser);
  const [saving, setSaving] = useState<"skillRecorder" | "browser" | null>(null);
  const [error, setError] = useState("");

  const toggle = async (feature: "skillRecorder" | "browser", next: boolean) => {
    if (saving) return;
    setSaving(feature);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { [feature]: next } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the experimental feature setting.");
    } finally {
      setSaving(null);
    }
  };

  // Not "they remain off until you enable them": the built-in browser ships ON
  // (builtInBrowserEnabled defaults true), so that promise was false for the
  // switch sitting directly below it.
  return (
    <Card
      title="Field trials"
      subtitle="Early capabilities may change while they are measured. Each switch below shows whether that capability is on right now."
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">Record a method</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            Show the method recorder in the score rail.
          </div>
        </div>
        <button
          role="switch"
          aria-checked={skillRecorder}
          aria-label="Show Record a method"
          disabled={saving !== null}
          onClick={() => void toggle("skillRecorder", !skillRecorder)}
          className={`${cnSwitch(skillRecorder)} disabled:cursor-wait disabled:opacity-50`}
        >
          <span className={cnKnob(skillRecorder)} />
        </button>
      </div>
      <div className="mt-4 flex items-center justify-between gap-4 border-t border-hairline/30 pt-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">Built-in browser</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            {desktopBrowser
              ? "Operators receive dedicated browser sessions in the Workbench. Turn this off globally; each operator also has an individual control."
              : "Needs the Helmryth desktop app."}
          </div>
        </div>
        <button
          role="switch"
          aria-checked={browser}
          aria-label="Enable the built-in browser"
          disabled={saving !== null || (!browser && !desktopBrowser)}
          onClick={() => void toggle("browser", !browser)}
          className={`${cnSwitch(browser)} disabled:cursor-wait disabled:opacity-50`}
        >
          <span className={cnKnob(browser)} />
        </button>
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}

/** Named browser sessions: rename or delete; deleting wipes that session's
 * logins, storage and cache and returns assigned operators to private sessions. */
function BrowserProfilesRow() {
  const { state, dispatch } = useStore();
  const profiles = state.config?.browserProfiles ?? [];
  const bridge = window.helmryth?.browser;
  const [busy, setBusy] = useState<string | null>(null);
  // Deleting a browser session is irreversible — it forgets every sign-in stored
  // in that partition — so the button arms before it fires.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState("");
  if (!builtInBrowserEnabled(state.config) || !bridge) return null;

  const save = async (next: typeof profiles, then?: () => Promise<void>) => {
    try {
      const config: ConfigStatus = await api("/api/config", { method: "PATCH", body: JSON.stringify({ browserProfiles: next }) });
      dispatch({ type: "configStatus", config });
      await then?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save browser profiles.");
    } finally {
      setBusy(null);
      setRenaming(null);
    }
  };
  const remove = (id: string) => {
    if (busy) return;
    setConfirmRemove(null);
    setBusy(id);
    setError("");
    void save(
      profiles.filter((profile) => profile.id !== id),
      async () => {
        // operators pointed at it fall back to their own session server-side; the
        // surface drops its views and wipes the partition's data
        for (const bot of state.bots) {
          if (bot.browserProfile === id) dispatch({ type: "updateBot", botId: bot.id, patch: { browserProfile: null } });
        }
        await bridge.forgetProfile?.(id);
      },
    );
  };
  const rename = () => {
    if (!renaming || busy) return;
    const name = renaming.name.trim();
    if (!name) return;
    setBusy(renaming.id);
    setError("");
    void save(profiles.map((profile) => (profile.id === renaming.id ? { ...profile, name } : profile)));
  };
  const usersOf = (id: string) => state.bots.filter((bot) => !bot.hidden && bot.browserProfile === id).map((bot) => bot.name);

  return (
    <Card
      title="Browser sessions"
      subtitle="Named sign-in sessions operators can share. Create one from an operator&rsquo;s Browser surface, then sign in once."
    >
      {profiles.length === 0 ? (
        <div className="border-l-2 border-signal pl-3 text-[13px] text-ink-secondary">No shared sessions. Open an operator&rsquo;s Browser surface and choose &ldquo;Add session&rdquo;.</div>
      ) : (
        <div className="flex flex-col divide-y divide-hairline/30">
          {profiles.map((profile) => {
            const users = usersOf(profile.id);
            const editing = renaming?.id === profile.id;
            return (
              <div key={profile.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Globe size={14} className="shrink-0 text-ink-secondary" />
                  {editing ? (
                    <form
                      className="flex items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        rename();
                      }}
                    >
                      <input
                        autoFocus
                        value={renaming.name}
                        onChange={(event) => setRenaming({ id: profile.id, name: event.target.value })}
                        maxLength={40}
                        className="rounded-md bg-inset px-2 py-1 text-[13px] text-ink outline-none"
                        aria-label="Browser session name"
                      />
                      <button type="submit" disabled={busy !== null} className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-ink disabled:opacity-50">
                        Save
                      </button>
                      <button type="button" onClick={() => setRenaming(null)} className="text-[12px] text-ink-secondary hover:text-ink">
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setRenaming({ id: profile.id, name: profile.name })}
                      className="truncate text-left text-[14px] font-medium text-ink hover:underline"
                      title="Rename browser session"
                    >
                      {profile.name}
                    </button>
                  )}
                  <span className="truncate text-[12px] text-ink-secondary">
                    {users.length ? `used by ${users.join(", ")}` : "not in use"}
                  </span>
                </div>
                <button
                  type="button"
                  // Arm first, then destroy. This wipes the session's stored sign-ins,
                  // storage and cache with no undo, and it used to happen on one click.
                  onClick={() => (confirmRemove === profile.id ? remove(profile.id) : setConfirmRemove(profile.id))}
                  onBlur={() => setConfirmRemove((current) => (current === profile.id ? null : current))}
                  disabled={busy !== null}
                  aria-label={
                    confirmRemove === profile.id
                      ? `Confirm deleting ${profile.name} and forgetting its sign-ins`
                      : `Delete ${profile.name} and forget its sign-ins`
                  }
                  className={cn(
                    "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] disabled:opacity-50",
                    confirmRemove === profile.id
                      ? "bg-danger/10 text-danger"
                      : "text-ink-secondary hover:bg-control hover:text-danger",
                  )}
                  title={`Delete ${profile.name} and forget its sign-ins`}
                >
                  <Trash2 size={13} /> {confirmRemove === profile.id ? "Confirm delete" : "Delete"}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}

const cnSwitch = (on: boolean) =>
  `relative h-6 w-11 shrink-0 rounded-full ${on ? "bg-accent" : "bg-control"}`;
const cnKnob = (on: boolean) =>
  `absolute left-[3px] top-[3px] h-[18px] w-[18px] rounded-full bg-panel transition-transform ${on ? "translate-x-[18px]" : ""}`;

/** Writes a redacted diagnostics file to a location the user picks. The
 * report holds versions, configured-or-not booleans and the server.log tail —
 * never credential values (the desktop shell does not read secret fields). */
function DiagnosticsRow() {
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const diagnosticsExporter = window.helmryth?.exportDiagnostics;
  const available = Boolean(diagnosticsExporter);

  const exportDiagnostics = async () => {
    if (!diagnosticsExporter || exporting) return;
    setExporting(true);
    setResult(null);
    try {
      const path = await diagnosticsExporter();
      if (path) setResult({ kind: "success", message: `Saved to ${path}` });
    } catch (e) {
      setResult({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card
      title="Diagnostics"
      subtitle="Versions, configuration on/off state and a redacted server log tail. Review the file before sharing it."
    >
      <div className="flex min-w-0 flex-col items-end gap-2">
        <button
          onClick={() => void exportDiagnostics()}
          disabled={!available || exporting}
          aria-label="Export diagnostics to a text file"
          title={available ? undefined : "Diagnostics export is available in the Helmryth desktop app."}
          className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
        >
          {exporting ? "Exporting…" : "Export Diagnostics…"}
        </button>
        {result ? (
          <span
            role={result.kind === "error" ? "alert" : "status"}
            className={`max-w-64 break-all text-right text-[12px] ${result.kind === "error" ? "text-danger" : "text-success"}`}
          >
            {result.message}
          </span>
        ) : !available ? (
          <span role="status" className="max-w-64 text-right text-[12px] leading-relaxed text-ink-secondary">
            Available in the Helmryth desktop app.
          </span>
        ) : null}
      </div>
    </Card>
  );
}

export function SettingsModal() {
  const { state, dispatch } = useStore();
  const section = state.appSettingsSection;
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<FocusTargetLike | null>(null);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const visibleSections = SECTIONS.filter((entry) => sectionMatches(entry, q));

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!returnFocusRef.current) {
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      returnFocusRef.current = captureFocusRestoreTarget(active, dialog);
    }
    dialog.focus();
  }, []);

  useEffect(() => {
    const visible = SECTIONS.filter((entry) => sectionMatches(entry, q));
    if (visible.some((entry) => entry.id === section)) return;
    const first = visible[0];
    if (first) dispatch({ type: "toggleAppSettings", open: true, section: first.id });
  }, [dispatch, q, section]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "toggleAppSettings", open: false });
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      restoreSystemFocus(returnFocusRef.current, dialog, () => {
        const launchers = Array.from(document.querySelectorAll<HTMLElement>("[data-helmryth-system-opener]"));
        return launchers.find((launcher) => launcher.getClientRects().length > 0)
          ?? document.querySelector<HTMLElement>('[aria-label="Open roster"]')
          ?? launchers[0]
          ?? null;
      });
    };
  }, [dispatch]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-0 sm:p-6"
      onMouseDown={(e) => e.target === e.currentTarget && dispatch({ type: "toggleAppSettings", open: false })}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="helmryth-system-title"
        tabIndex={-1}
        className="flex h-full w-full max-w-[920px] flex-col overflow-hidden border border-hairline/70 bg-app shadow-xl outline-none sm:h-[620px] sm:flex-row sm:rounded-lg"
      >
        {/* section nav */}
        <nav aria-label="System sections" className="flex w-full min-w-0 max-w-full shrink-0 flex-col gap-0.5 overflow-hidden border-b border-hairline/60 bg-panel p-2 sm:w-[204px] sm:border-b-0 sm:border-r sm:p-3">
          <div id="helmryth-system-title" className="px-2 pb-2 pt-1 text-[15px] font-semibold tracking-[-0.012em] text-ink sm:pb-3">
            Helmryth System
          </div>
          <div className="mb-1.5 flex items-center gap-2 rounded-lg bg-control/70 px-2.5 py-1.5">
            <Search size={14} className="shrink-0 text-ink-secondary" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.stopPropagation();
                if (query) setQuery("");
                else dispatch({ type: "toggleAppSettings", open: false });
              }}
              placeholder="Find a control"
              aria-label="Search Helmryth System"
              className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </div>
          <div className="flex w-full min-w-0 max-w-full snap-x snap-proximity gap-0.5 overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:thin] sm:flex-col sm:overflow-visible sm:pb-0">
            {visibleSections.length === 0 && (
              <div className="px-2.5 py-3 text-[12.5px] leading-relaxed text-ink-secondary sm:py-4">
                No System section matches &ldquo;{query.trim()}&rdquo;. Try &ldquo;Connections&rdquo; or &ldquo;Workbench&rdquo;.
              </div>
            )}
            {visibleSections.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: id })}
                onFocus={(event) => keepSystemSectionVisible(event.currentTarget)}
                aria-current={section === id ? "page" : undefined}
                className={cn(
                  "relative flex shrink-0 snap-start scroll-mx-2 items-center gap-2 border-l-2 px-2.5 py-2 text-left text-[13px] sm:gap-2.5 sm:text-[14px]",
                  section === id ? "border-accent bg-control/70 font-medium text-ink" : "border-transparent text-ink-secondary hover:bg-control/50 hover:text-ink",
                )}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-hairline/50 px-4 py-3 sm:px-6 sm:py-4">
            <span className="text-[15px] font-semibold text-ink">
              {SECTIONS.find((s) => s.id === section)?.label}
            </span>
            <button
              onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
              aria-label="Close Helmryth System"
              className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            >
              <X size={18} />
            </button>
          </div>

          <div className="flex flex-1 flex-col overflow-y-auto px-4 pb-5 sm:px-6 sm:pb-6">
            {section === "general" && (
              <>
                <Card title="Your identity" subtitle="Shown in the score rail and saved as you work.">
                  <ProfileFields />
                </Card>
                <Card title="Product identity" subtitle="One light-first instrument surface across every Helmryth screen.">
                  <SkinPicker />
                </Card>
                <Card title="Crew run limit" subtitle="Set the maximum time for each operator contribution inside a crew.">
                  <RoomTurnTimeoutSettings />
                </Card>
                <ToolCallsRow />
                <ExperimentalFeaturesRow />
                <BrowserProfilesRow />
                <UpdatesRow />
                <DiagnosticsRow />
                <AnalyticsRow />
              </>
            )}

            {section === "connections" && (
              <Card
                title="Connections"
                subtitle="Connected services become operator capabilities. Optional credentials remain protected on this Workbench."
              >
                <div className="flex flex-col gap-4">
                  <ManagedServicesRow />
                  {state.config?.composio.mode === "managed" ? (
                    <div className="rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-[13px] text-success">
                      Connected-services lane ready
                    </div>
                  ) : null}
                  <TranscriptionSettings />
                  <OpenAiCompatibleConnection />
                  <ApiKeyRow section="box" />
                  <VpsConnection />
                  <ApiKeyRow section="opencodeGo" />
                  <details className="border-y border-hairline/50 bg-inset/50 px-3 py-2">
                    <summary className="cursor-pointer text-[13px] text-ink-secondary">Self-host connected services</summary>
                    <div className="mt-3">
                      <ApiKeyRow section="composio" />
                    </div>
                  </details>
                </div>
              </Card>
            )}

            {section === "engines" && (
              <Card title="Engine commands" subtitle="Choose the executable behind each runtime. Changes save as you work.">
                <EnginesSettings />
              </Card>
            )}

            {section === "companion" && <CompanionSection profileEmail={state.config?.profile?.email} />}

            {section === "computer" && <LocalComputerSection />}

            {section === "usage" && <UsageSection />}
          </div>
        </div>
      </div>
    </div>
  );
}
