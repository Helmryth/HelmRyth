// Privacy-preserving product telemetry. The client stays completely dormant
// unless the user explicitly opts in AND this Helmryth build supplies both an
// owned PostHog project key and HTTPS endpoint. Autocapture is never enabled.
import posthog from "posthog-js";

export type AnalyticsProperty = string | number | boolean | null | undefined;
export type AnalyticsProperties = Record<string, AnalyticsProperty>;

type AnalyticsInit = {
  api_host: string;
  autocapture: false;
  capture_pageview: false;
  person_profiles: "identified_only";
  persistence: "localStorage";
};

export interface AnalyticsClient {
  init(key: string, options: AnalyticsInit): void;
  capture(event: string, properties?: AnalyticsProperties): void;
  opt_in_capturing(): void;
  opt_out_capturing(): void;
  has_opted_out_capturing(): boolean;
}

const OPT_IN_KEY = "helmryth.analytics.opt-in.v1";
const INSTALLED_KEY = "helmryth.install.first-seen.v1";
const PROFILE_GATE_KEY = "helmryth.onboarding.profile-step.v1";

// Read-only compatibility aliases. We never write these inherited keys. An
// old opt-out remains an opt-out; an old opt-in never becomes Helmryth consent.
const LEGACY_OPT_OUT_KEY = "omb-analytics-opt-out"; // brand-check: allow-legacy
const LEGACY_INSTALLED_KEY = "omb-installed"; // brand-check: allow-legacy
const LEGACY_PROFILE_GATE_KEY = "omb-email-gate"; // brand-check: allow-legacy

let ready = false;
let choice: boolean | undefined;
let activeClient: AnalyticsClient = posthog;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The session-level choice below remains authoritative when persistence is
    // unavailable. A restart returns to the privacy-safe disabled default.
  }
}

type AnalyticsRuntime = {
  posthogKey: string;
  posthogHost: string;
};

declare global {
  var __HELMRYTH_ANALYTICS__: AnalyticsRuntime | undefined;
}

function analyticsConfig(): { key: string; host: string } | null {
  const runtime = globalThis.__HELMRYTH_ANALYTICS__;
  const key = runtime?.posthogKey.trim() ?? "";
  const host = runtime?.posthogHost.trim() ?? "";
  if (!key || !host) return null;
  try {
    const endpoint = new URL(host);
    if (endpoint.protocol !== "https:") return null;
    return { key, host: endpoint.toString().replace(/\/$/, "") };
  } catch {
    return null;
  }
}

/** User preference only. A true value still cannot start an unconfigured build. */
export function analyticsEnabled(): boolean {
  if (choice !== undefined) return choice;
  const stored = readStorage(OPT_IN_KEY);
  if (stored !== null) return stored === "1";
  // Preserve an inherited refusal without treating inherited enablement as
  // consent for a separately branded product.
  if (readStorage(LEGACY_OPT_OUT_KEY) === "1") return false;
  return false;
}

/** Whether this build has an explicitly configured Helmryth telemetry sink. */
export function analyticsAvailable(): boolean {
  return analyticsConfig() !== null;
}

export type OptAction = "init" | "opt-in" | "opt-out" | "none";
export function optAction(enabled: boolean, running: boolean): OptAction {
  if (!enabled) return running ? "opt-out" : "none";
  return running ? "opt-in" : "init";
}

/** Persist an explicit user decision and apply it immediately. */
export function setAnalyticsEnabled(enabled: boolean): void {
  choice = enabled;
  writeStorage(OPT_IN_KEY, enabled ? "1" : "0");

  switch (optAction(enabled, ready)) {
    case "opt-out":
      activeClient.opt_out_capturing();
      break;
    case "opt-in":
      activeClient.opt_in_capturing();
      break;
    case "init":
      initAnalytics();
      break;
    case "none":
      break;
  }
}

export function initAnalytics(client: AnalyticsClient = posthog): void {
  const config = analyticsConfig();
  if (ready || !analyticsEnabled() || !config) return;

  activeClient = client;
  activeClient.init(config.key, {
    api_host: config.host,
    autocapture: false,
    capture_pageview: false,
    person_profiles: "identified_only",
    persistence: "localStorage",
  });
  if (activeClient.has_opted_out_capturing()) activeClient.opt_in_capturing();
  ready = true;

  const platform = navigator.userAgent.includes("Electron") ? "desktop" : "browser";
  const installed = readStorage(INSTALLED_KEY) ?? readStorage(LEGACY_INSTALLED_KEY);
  if (!installed) {
    writeStorage(INSTALLED_KEY, new Date().toISOString());
    activeClient.capture("app_first_open", { platform });
  }
  activeClient.capture("app_opened", { platform });
}

export function track(event: string, props?: AnalyticsProperties): void {
  if (!ready || !analyticsEnabled() || !analyticsConfig()) return;
  activeClient.capture(event, props);
}

/** @deprecated Identity is intentionally never sent by Helmryth telemetry. */
export function identifyEmail(_email: string): void {
  // Compatibility no-op: keeping the function avoids breaking older callers
  // without ever creating a PostHog person or emitting a personal identifier.
}

// First-run profile-step state. The inherited key is read only so existing
// installs are not forced back through setup; every new write is Helmryth-owned.
export function emailGateDone(): boolean {
  return Boolean(readStorage(PROFILE_GATE_KEY) ?? readStorage(LEGACY_PROFILE_GATE_KEY));
}

export function setEmailGateDone(status: "submitted" | "skipped"): void {
  writeStorage(PROFILE_GATE_KEY, status);
}
