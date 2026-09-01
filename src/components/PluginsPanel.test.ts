import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearPendingAuthorizationUrl,
  connectedInventoryCopy,
  connectorActionLabel,
  connectorMutationsDisabled,
  connectionsSettingsAction,
  consumeConnectionsSetupFocusIntent,
  disconnectAccountConfirmation,
  mergeCompleteConnectorStatus,
  mergeCurrentConnectorStatus,
  onlyLatestConnectorResponses,
  pendingAuthorizationUrl,
  pendingAuthorizationSettled,
  preloadConnectedApps,
  rememberPendingAuthorizationUrl,
  requestConnectionsSetupFocus,
  requiresAccountAlias,
  STALE_CAPABILITY_INVENTORY_COPY,
  type ConnectorStatus,
} from "@/lib/connected-apps-inventory";
import {
  activeCapability,
  capabilityAccountStatusLabel,
  CapabilityCatalogError,
  preserveCapabilityOpener,
  restoreCapabilityFocusAfterClose,
  ServiceIcon,
} from "./PluginsPanel";

afterEach(() => {
  vi.unstubAllGlobals();
  clearPendingAuthorizationUrl("gmail");
  consumeConnectionsSetupFocusIntent();
});

describe("connected-app status races", () => {
  it("counts only genuinely active capabilities", () => {
    expect(activeCapability({
      connected: true,
      pending: false,
      status: "ACTIVE",
      accounts: [{ id: "ca_active", status: "ACTIVE" }],
    })).toBe(true);
    expect(activeCapability({
      connected: false,
      pending: true,
      status: "INITIALIZING",
      accounts: [{ id: "ca_pending", status: "INITIALIZING" }],
    })).toBe(false);
    expect(activeCapability({
      connected: false,
      pending: false,
      status: "EXPIRED",
      accounts: [{ id: "ca_expired", status: "EXPIRED" }],
    })).toBe(false);
    expect(activeCapability({
      connected: true,
      pending: false,
      status: "EXPIRED",
      accounts: [{ id: "ca_contradictory", status: "EXPIRED" }],
    })).toBe(false);
  });

  it("describes non-active account states without calling them active", () => {
    expect(capabilityAccountStatusLabel("ACTIVE")).toBe("Active");
    expect(capabilityAccountStatusLabel("INITIALIZING")).toBe("Setup in progress");
    expect(capabilityAccountStatusLabel("INITIATED")).toBe("Setup started");
    expect(capabilityAccountStatusLabel("PENDING")).toBe("Setup pending");
    expect(capabilityAccountStatusLabel("EXPIRED")).toBe("Authorization expired");
    expect(capabilityAccountStatusLabel("FAILED")).toBe("Connection failed");
  });

  it("uses a local monogram even when the catalog supplies remote artwork", () => {
    const markup = renderToStaticMarkup(createElement(ServiceIcon, {
      card: {
        slug: "cloudlayer",
        label: "Cloudlayer",
        blurb: "Document generation",
        logo: "https://cloudlayer.io/logo.png",
        domain: "cloudlayer.io",
      },
    }));
    expect(markup).toContain("C");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("cloudlayer.io");
    expect(markup).not.toContain("google.com");
  });

  it("restores the original opener only after the dialog is removed", () => {
    const focus = vi.fn();
    let scheduled: (() => void) | undefined;
    const dialog = { isConnected: true };
    restoreCapabilityFocusAfterClose(
      { focus, isConnected: true },
      dialog,
      (callback) => { scheduled = callback; },
    );

    expect(focus).not.toHaveBeenCalled();
    scheduled?.();
    expect(focus).not.toHaveBeenCalled();

    dialog.isConnected = false;
    restoreCapabilityFocusAfterClose(
      { focus, isConnected: true },
      dialog,
      (callback) => callback(),
    );
    expect(focus).toHaveBeenCalledOnce();
  });

  it("preserves the external opener across Strict Mode effect rehearsal", () => {
    const opener = { id: "capabilities-opener" };
    const dialogSearch = { id: "capabilities-search" };
    expect(preserveCapabilityOpener(null, opener, false)).toBe(opener);
    expect(preserveCapabilityOpener(opener, dialogSearch, true)).toBe(opener);
  });

  it("does not let an older not_connected response erase a newer OAuth attempt", async () => {
    const generations = new Map([["gmail", 0]]);
    const initialRequestGenerations = new Map(generations);
    let deliverInitialResponse: (value: Record<string, ConnectorStatus>) => void = () => {};
    const delayedInitialResponse = new Promise<Record<string, ConnectorStatus>>((resolve) => {
      deliverInitialResponse = resolve;
    });

    generations.set("gmail", 1);
    const localOAuthState = {
      gmail: { connected: false, pending: true, status: "INITIATED" },
    };
    deliverInitialResponse({ gmail: { connected: false, pending: false, status: "not_connected" } });

    const merged = mergeCurrentConnectorStatus(
      localOAuthState,
      await delayedInitialResponse,
      generations,
      initialRequestGenerations,
    );

    expect(merged.gmail).toEqual({ connected: false, pending: true, status: "INITIATED" });
  });

  it("still applies a response from the current generation", () => {
    const generations = new Map([["gmail", 1]]);
    const merged = mergeCurrentConnectorStatus(
      { gmail: { connected: false, pending: true, status: "INITIATED" } },
      { gmail: { connected: true, pending: false, status: "ACTIVE" } },
      generations,
      new Map(generations),
    );

    expect(merged.gmail).toEqual({ connected: true, pending: false, status: "ACTIVE" });
  });

  it("drops an older status response when a newer request for the same app has started", () => {
    const latestRequests = new Map([["gmail", 2], ["slack", 1]]);
    const requestIds = new Map([["gmail", 1], ["slack", 1]]);
    expect(
      onlyLatestConnectorResponses(
        {
          gmail: { connected: false, status: "not_connected" },
          slack: { connected: true, status: "ACTIVE" },
        },
        latestRequests,
        requestIds,
      ),
    ).toEqual({ slack: { connected: true, status: "ACTIVE" } });
  });

  it("keeps a connected account beyond the first 40 marketplace cards", () => {
    const catalog = Array.from({ length: 45 }, (_, index) => `toolkit_${index + 1}`);
    const accountSlug = catalog[40];
    expect(catalog.slice(0, 40)).not.toContain(accountSlug);

    const merged = mergeCompleteConnectorStatus(
      {},
      {
        [accountSlug]: {
          connected: true,
          pending: false,
          status: "ACTIVE",
          accounts: [{ id: "ca_toolkit_41", alias: "overflow", status: "ACTIVE" }],
        },
      },
      new Map(),
      new Map(),
    );

    expect(merged[accountSlug]?.accounts).toEqual([
      { id: "ca_toolkit_41", alias: "overflow", status: "ACTIVE" },
    ]);
  });

  it("clears externally removed accounts without overwriting a newer OAuth attempt", () => {
    const generations = new Map([["gmail", 2]]);
    const removed = mergeCompleteConnectorStatus(
      { gmail: { connected: true, accounts: [{ id: "ca_old", status: "ACTIVE" }] } },
      {},
      generations,
      new Map(generations),
    );
    expect(removed.gmail).toEqual({
      connected: false,
      pending: false,
      status: "not_connected",
      accounts: [],
    });

    const preserved = mergeCompleteConnectorStatus(
      { gmail: { connected: false, pending: true, status: "INITIATED" } },
      {},
      new Map([["gmail", 3]]),
      generations,
    );
    expect(preserved.gmail).toEqual({ connected: false, pending: true, status: "INITIATED" });

    // The generation guard specifically: a connected entry WITH accounts is
    // exactly what the clearing branch targets, so only the advanced
    // generation can save it — a freshly-connected account must survive a
    // stale /connected response racing the Connect click.
    const racing = mergeCompleteConnectorStatus(
      { gmail: { connected: true, accounts: [{ id: "ca_new", status: "ACTIVE" }] } },
      {},
      new Map([["gmail", 3]]),
      generations,
    );
    expect(racing.gmail).toEqual({ connected: true, accounts: [{ id: "ca_new", status: "ACTIVE" }] });
  });

  it("names the exact account and limits disconnect confirmation to that account", () => {
    expect(disconnectAccountConfirmation("Gmail", { id: "ca_work", alias: "work" })).toBe(
      "Disconnect “work” (ca_work) from Gmail? Only this Gmail account will be revoked. Your other Gmail accounts will stay connected.",
    );
    expect(disconnectAccountConfirmation("GitHub", { id: "ca_personal" })).toContain(
      "Disconnect “ca_personal” from GitHub? Only this GitHub account will be revoked.",
    );
  });

  it("recognizes the existing-account alias guard and ignores unrelated errors", () => {
    expect(requiresAccountAlias("Add an account alias so the existing connection is not replaced")).toBe(true);
    expect(requiresAccountAlias("Authorization expired")).toBe(false);
  });

  it("never presents unloaded account state as disconnected", () => {
    expect(connectedInventoryCopy("loading").title).toBe("Checking active capabilities…");
    expect(connectorActionLabel("loading", {
      busy: false,
      included: false,
      canContinue: false,
      hasAccounts: false,
      failed: false,
    })).toBe("Checking…");
    expect(connectorActionLabel("ready", {
      busy: false,
      included: false,
      canContinue: false,
      hasAccounts: true,
      failed: false,
    })).toBe("Add account");
    expect(connectorActionLabel("error", {
      busy: false,
      included: false,
      canContinue: false,
      hasAccounts: false,
      failed: false,
    })).toBe("Unavailable");
  });

  it("does not overstate a stale capability inventory as current connection truth", () => {
    expect(STALE_CAPABILITY_INVENTORY_COPY).toContain("cannot verify the current connection state");
    expect(STALE_CAPABILITY_INVENTORY_COPY).not.toMatch(/still connected|currently connected/i);
  });

  it("disables every account mutation until inventory authority is restored", () => {
    expect(connectorMutationsDisabled({ configured: true, phase: "ready", stale: true, busy: false })).toBe(true);
    expect(connectorMutationsDisabled({ configured: true, phase: "loading", stale: false, busy: false })).toBe(true);
    expect(connectorMutationsDisabled({ configured: true, phase: "error", stale: false, busy: false })).toBe(true);
    expect(connectorMutationsDisabled({ configured: true, phase: "ready", stale: false, busy: false })).toBe(false);
  });

  it("routes setup directly to Connections and records one focus intent", () => {
    expect(connectionsSettingsAction()).toEqual({
      type: "toggleAppSettings",
      open: true,
      section: "connections",
    });
    requestConnectionsSetupFocus();
    expect(consumeConnectionsSetupFocusIntent()).toBe(true);
    expect(consumeConnectionsSetupFocusIntent()).toBe(false);
  });

  it("retains a pending authorization URL only in process memory until settlement", () => {
    rememberPendingAuthorizationUrl("gmail", "https://accounts.example.test/authorize/one-time");
    expect(pendingAuthorizationUrl("gmail")).toBe("https://accounts.example.test/authorize/one-time");
    expect(pendingAuthorizationSettled({ connected: false, pending: true, status: "INITIATED" })).toBe(false);
    expect(pendingAuthorizationSettled({ connected: true, pending: false, status: "ACTIVE" })).toBe(true);
    clearPendingAuthorizationUrl("gmail");
    expect(pendingAuthorizationUrl("gmail")).toBeUndefined();
    expect(() => rememberPendingAuthorizationUrl("gmail", "http://attacker.example.test/authorize")).toThrow(
      "unsafe authorization address",
    );
  });

  it("rejects transport failure instead of converting it into stale success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(preloadConnectedApps(true)).rejects.toThrow("offline");
  });

  it("renders catalog failure as a retryable state instead of a loading spinner", () => {
    const markup = renderToStaticMarkup(createElement(CapabilityCatalogError, {
      retrying: false,
      onRetry: vi.fn(),
    }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Couldn’t load the capability catalog");
    expect(markup).toContain("Retry");
    expect(markup).not.toContain("Loading catalog");
  });
});

describe("an answer the server was not sure about", () => {
  const connectedGmail = {
    gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "ca_1", status: "ACTIVE" }] },
  } satisfies Record<string, ConnectorStatus>;

  it("keeps a connected app when the response was not authoritative", () => {
    // the credential store was unreadable, so the server sent {} — that is
    // ignorance, and clearing on it is how a connected app turns into a
    // Connect button the user never asked for
    const merged = mergeCompleteConnectorStatus(connectedGmail, {}, new Map(), new Map(), false);
    expect(merged.gmail.connected).toBe(true);
  });

  it("still clears an app the server authoritatively no longer lists", () => {
    // disconnection has to remain possible: revoking from Composio's
    // dashboard must show up here on the next successful check
    const merged = mergeCompleteConnectorStatus(connectedGmail, {}, new Map(), new Map(), true);
    expect(merged.gmail.connected).toBe(false);
    expect(merged.gmail.status).toBe("not_connected");
  });

  it("treats a missing authority flag as authoritative, preserving today's behaviour", () => {
    const merged = mergeCompleteConnectorStatus(connectedGmail, {}, new Map(), new Map());
    expect(merged.gmail.connected).toBe(false);
  });
});
