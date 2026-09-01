import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CompanionAccountState } from "../types/helmryth";
import {
  companionStateRefreshIsCurrent,
  mutateCompanionBridgeState,
  PhoneSetupFlowView,
  phonePairingManualCodeMode,
  type PhoneSetupController,
  type CompanionState,
} from "./PhoneSetupFlow";
import {
  companionAccountActionError,
  companionPairingMode,
  deriveCompanionPanelStatus,
  loadCompanionBridgeState,
  shouldHydrateCompanionEmail,
} from "./CompanionSection";

const account = (status: CompanionAccountState["status"], message?: string): CompanionAccountState => ({
  available: true,
  status,
  message,
});

function setupController(overrides: Partial<PhoneSetupController> = {}): PhoneSetupController {
  return {
    state: null,
    account: null,
    phase: "intro",
    statusPhase: "ready",
    accountBridgeAvailable: true,
    email: "operator@example.com",
    code: "",
    codeSent: false,
    busy: false,
    accountBusy: false,
    error: null,
    accountError: null,
    pairingLink: null,
    secondsLeft: 0,
    address: undefined,
    pairingPort: 8810,
    hostedReady: false,
    localFallback: false,
    tailscaleFallback: false,
    tailscaleAvailable: false,
    pairingExpired: false,
    setupTimedOut: false,
    setEmail: vi.fn(),
    setCode: vi.fn(),
    changeEmail: vi.fn(),
    start: vi.fn(),
    useLocal: vi.fn(),
    useTailscale: vi.fn(),
    requestCode: vi.fn(),
    verifyCode: vi.fn(),
    retryAccount: vi.fn(),
    retryStatus: vi.fn(),
    cancel: vi.fn(),
    refreshCode: vi.fn(),
    finish: vi.fn(),
    skip: vi.fn(),
    act: vi.fn(async () => {}),
    accountAct: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("companion account action errors", () => {
  it("shows retry and sign-out failures while the account remains signed in", () => {
    expect(companionAccountActionError(account("ready"), "Sign out could not finish")).toBe(
      "Sign out could not finish",
    );
    expect(companionAccountActionError(account("error"), "Retry could not finish")).toBe(
      "Retry could not finish",
    );
  });

  it("uses only approved account messages as the signed-out fallback", () => {
    expect(companionAccountActionError(account("signed-out", "Enter a valid email address."), null)).toBe(
      "Enter a valid email address.",
    );
    expect(companionAccountActionError(account("signed-out", "/private/keychain failed"), null)).toBe(
      "Helmryth Relay needs attention. Check the email address and try again.",
    );
    expect(companionAccountActionError(account("error", "Secure connection needs attention"), null)).toBeNull();
  });
});

describe("companion status refresh", () => {
  it("omits the redundant status pill when phone access is ready for its first pairing", () => {
    expect(deriveCompanionPanelStatus({
      enabled: true,
      devices: [],
    })).toBeNull();
  });

  it("does not show a healthy status when the enabled sidecar reports an error", () => {
    expect(deriveCompanionPanelStatus({
      enabled: true,
      devices: [],
      error: "sidecar stopped responding",
    })).toEqual({ label: "Helmryth Mobile link failed", good: false });
  });

  it("keeps account refreshes when the local Companion status fails", async () => {
    const remoteAccount = account("signed-out", "Email a code");
    const refreshed = await loadCompanionBridgeState(
      { state: () => Promise.reject(new Error("sidecar unavailable")) },
      { state: () => Promise.resolve(remoteAccount) },
    );

    expect(refreshed.companion).toBeNull();
    expect(refreshed.account).toBe(remoteAccount);
  });

  it("keeps local Companion refreshes when account status fails", async () => {
    const companion = {
      enabled: true,
      keepAwake: false,
      port: 8811,
      devices: [],
      pairing: null,
    };
    const refreshed = await loadCompanionBridgeState(
      { state: () => Promise.resolve(companion) },
      { state: () => Promise.reject(new Error("account unavailable")) },
    );

    expect(refreshed.companion).toBe(companion);
    expect(refreshed.account).toBeNull();
  });

  it("does not let a pre-mutation poll overwrite a newly opened pairing", async () => {
    const pairingToken = `hry_pair_${"a".repeat(43)}`;
    const staleState: CompanionState = {
      enabled: true,
      keepAwake: false,
      port: 8811,
      devices: [],
      pairing: null,
    };
    const pairedState: CompanionState = {
      ...staleState,
      pairing: { code: "004209", token: pairingToken, expiresAt: Date.now() + 60_000 },
    };
    let signalCompanionRead = () => {};
    const companionRead = new Promise<void>((resolve) => {
      signalCompanionRead = resolve;
    });
    let resolveAccount = (_value: CompanionAccountState) => {};
    const accountRead = new Promise<CompanionAccountState>((resolve) => {
      resolveAccount = resolve;
    });
    const epoch = { current: 0 };
    const refreshEpoch = epoch.current;
    let visibleState: CompanionState | null = null;
    const refresh = loadCompanionBridgeState(
      {
        state: () => {
          signalCompanionRead();
          return Promise.resolve(staleState);
        },
      },
      { state: () => accountRead },
    ).then((next) => {
      if (next.companion && companionStateRefreshIsCurrent(epoch, refreshEpoch)) {
        visibleState = next.companion;
      }
      return next;
    });

    await companionRead;
    visibleState = await mutateCompanionBridgeState(epoch, () => Promise.resolve(pairedState));
    resolveAccount(account("ready"));
    const refreshed = await refresh;

    expect(refreshed.companion).toBe(staleState);
    expect(visibleState).toBe(pairedState);
    expect(epoch.current).toBe(2);
  });

  it("does not let a pre-mutation account poll overwrite successful Relay verification", async () => {
    const epoch = { current: 0 };
    const refreshEpoch = epoch.current;
    let resolveStale = (_value: CompanionAccountState) => {};
    const staleRead = new Promise<CompanionAccountState>((resolve) => {
      resolveStale = resolve;
    });
    let visibleAccount: CompanionAccountState | null = null;
    const refresh = staleRead.then((next) => {
      if (companionStateRefreshIsCurrent(epoch, refreshEpoch)) visibleAccount = next;
    });

    visibleAccount = await mutateCompanionBridgeState(epoch, () => Promise.resolve(account("ready")));
    resolveStale(account("signed-out"));
    await refresh;

    expect(visibleAccount?.status).toBe("ready");
    expect(epoch.current).toBe(2);
  });

  it("hydrates an untouched email field but preserves user edits", () => {
    const remoteAccount = { ...account("signed-out"), email: "old@example.com" };

    expect(shouldHydrateCompanionEmail(false, remoteAccount)).toBe(true);
    expect(shouldHydrateCompanionEmail(true, remoteAccount)).toBe(false);
  });
});

describe("Mobile setup accessibility and controlled copy", () => {
  it("renders explicit loading and unavailable recovery states", () => {
    const loading = renderToStaticMarkup(createElement(PhoneSetupFlowView, {
      controller: setupController({ statusPhase: "loading" }),
      variant: "settings",
    }));
    expect(loading).toContain("Checking Mobile availability");

    const unavailable = renderToStaticMarkup(createElement(PhoneSetupFlowView, {
      controller: setupController({
        statusPhase: "unavailable",
        error: "Helmryth Mobile setup requires Helmryth Desktop.",
      }),
      variant: "settings",
    }));
    expect(unavailable).toContain("Mobile setup unavailable");
    expect(unavailable).toContain("Retry Mobile status");
  });

  it("does not render an inert Relay retry when the account bridge is absent", () => {
    const markup = renderToStaticMarkup(createElement(PhoneSetupFlowView, {
      controller: setupController({
        phase: "sign-in",
        state: { enabled: true, keepAwake: false, port: 8810, devices: [], pairing: null },
        accountBridgeAvailable: false,
      }),
      variant: "settings",
    }));

    expect(markup).toContain("Relay setup is unavailable in this desktop build");
    expect(markup).not.toContain("Reconnect Helmryth Relay");
  });

  it("keeps secondary controls at least 36px tall and phase focus visible", () => {
    const markup = renderToStaticMarkup(createElement(PhoneSetupFlowView, {
      controller: setupController({
        phase: "sign-in",
        codeSent: true,
        state: { enabled: true, keepAwake: false, port: 8810, devices: [], pairing: null },
        account: account("signed-out"),
      }),
      variant: "settings",
    }));

    expect(markup).toMatch(/Use another email<\/button>/);
    expect(markup).toMatch(/class="[^"]*min-h-9[^"]*"[^>]*>Use another email/);
    expect(markup).toContain("focus:ring-2");
  });

  it("announces expiry politely and disables duplicate code refreshes while busy", () => {
    const markup = renderToStaticMarkup(createElement(PhoneSetupFlowView, {
      controller: setupController({
        phase: "qr",
        pairingExpired: true,
        busy: true,
      }),
      variant: "settings",
    }));

    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("That code expired");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Creating a new code…<\/button>/);
  });

  it("never exposes arbitrary account messages and uses accountable Gate language", () => {
    const signIn = renderToStaticMarkup(createElement(PhoneSetupFlowView, {
      controller: setupController({
        phase: "sign-in",
        state: { enabled: true, keepAwake: false, port: 8810, devices: [], pairing: null },
        account: account("error", "/private/keychain failed for old-service"),
      }),
      variant: "settings",
    }));
    const intro = renderToStaticMarkup(createElement(PhoneSetupFlowView, {
      controller: setupController(),
      variant: "settings",
    }));

    expect(signIn).not.toContain("/private/keychain");
    expect(signIn).not.toContain("old-service");
    expect(intro).toContain("review Gates");
    expect(intro).not.toContain("Clear gates");
  });
});

describe("manual pairing code placement", () => {
  it("shows the code directly when no QR link can be built", () => {
    expect(phonePairingManualCodeMode(true, null)).toBe("direct");
  });

  it("keeps the code in troubleshooting details when a QR is available", () => {
    expect(phonePairingManualCodeMode(true, "helmryth://pair?token=example")).toBe("details");
    expect(phonePairingManualCodeMode(false, null)).toBe("hidden");
  });
});

describe("companion pairing availability", () => {
  const localCompanion = (enabled: boolean) => ({ enabled, endpoints: [] });
  const hostedCompanion = {
    enabled: true,
    endpoints: [
      { kind: "hosted" as const, url: "https://device.companion.example", priority: 0 },
    ],
  };

  it("waits while a signed-in account is provisioning its hosted route", () => {
    expect(companionPairingMode(account("connecting"), localCompanion(true))).toBe(
      "hosted-connecting",
    );
    expect(companionPairingMode(account("connecting"), localCompanion(false))).toBe(
      "hosted-connecting",
    );
  });

  it("starts a ready account when Companion is off, then waits for its hosted route", () => {
    expect(companionPairingMode(account("ready"), localCompanion(false))).toBe(
      "hosted-startable",
    );
    expect(companionPairingMode(account("ready"), localCompanion(true))).toBe(
      "hosted-connecting",
    );
  });

  it("allows pairing as soon as the hosted route is published", () => {
    expect(companionPairingMode(account("ready"), hostedCompanion)).toBe("hosted-ready");
    // The companion endpoint is the source of truth even if the separately
    // polled account state is one render behind.
    expect(companionPairingMode(account("connecting"), hostedCompanion)).toBe("hosted-ready");
  });

  it("preserves local-only pairing when hosted access is not configured or failed", () => {
    expect(companionPairingMode(account("signed-out"), localCompanion(true))).toBe("local-only");
    expect(
      companionPairingMode({ available: false, status: "signed-out" }, localCompanion(true)),
    ).toBe("local-only");
    expect(companionPairingMode(account("error"), localCompanion(true))).toBe("local-only");
  });
});
