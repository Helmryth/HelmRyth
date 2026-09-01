// Connected apps marketplace, backed by Composio Sessions. Catalog comes
// from /api/connectors/catalog — the full toolkit list when a Composio API
// key is configured, a curated set otherwise. Catalog artwork is deliberately
// not loaded in the renderer: a local monogram keeps this private surface free
// of third-party requests and broken-image noise.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Loader2, RefreshCw, Search, TriangleAlert, X } from "lucide-react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import {
  clearPendingAuthorizationUrl,
  connectedInventoryCopy,
  connectorActionLabel,
  connectorMutationsDisabled,
  connectionsSettingsAction,
  disconnectAccountConfirmation,
  mergeCompleteConnectorStatus,
  mergeCurrentConnectorStatus,
  onlyLatestConnectorResponses,
  pendingAuthorizationEntries,
  pendingAuthorizationSettled,
  preloadConnectedApps,
  readRememberedConnectorInventory,
  rememberedConnectorInventoryStale,
  rememberPendingAuthorizationUrl,
  requestConnectionsSetupFocus,
  requiresAccountAlias,
  STALE_CAPABILITY_INVENTORY_COPY,
  UNVERIFIED_CAPABILITY_INVENTORY_COPY,
  credentialStoreUnavailable,
  writeRememberedConnectorInventory,
  type ConnectorInventoryPhase,
  type ConnectorStatus,
} from "@/lib/connected-apps-inventory";

export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  noAuth?: boolean;
  domain: string | null;
}
type CapabilityCatalogPhase = "loading" | "ready" | "error";

export function CapabilityCatalogError({
  retrying,
  onRetry,
}: {
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className="flex min-h-56 flex-col items-center justify-center text-center">
      <div className="text-[14px] font-medium text-ink">Couldn’t load the capability catalog</div>
      <div className="mt-1 max-w-md text-[12.5px] text-ink-secondary">
        Helmryth could not reach the catalog service. Your confirmed connections were not changed.
      </div>
      <button
        type="button"
        disabled={retrying}
        onClick={onRetry}
        className="mt-4 flex min-h-9 items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-50"
      >
        <RefreshCw size={13} className={cn(retrying && "animate-spin")} />
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}


export function ServiceIcon({ card }: { card: ToolkitCard }) {
  return (
    <div
      aria-hidden="true"
      className="flex size-11 items-center justify-center rounded-xl bg-raised text-[15px] font-semibold text-ink-secondary"
    >
      {card.label.slice(0, 1).toUpperCase()}
    </div>
  );
}

function activeAccountStatus(status: string): boolean {
  return /^active$/i.test(status.trim());
}

/** A capability belongs in the Active view only when the service contract and
 * at least one returned account agree that it is active. Account-less no-auth
 * services use their own ACTIVE service state. */
export function activeCapability(service: ConnectorStatus | undefined): boolean {
  if (service?.connected !== true) return false;
  const accounts = service.accounts ?? [];
  if (accounts.length > 0) return accounts.some((account) => activeAccountStatus(account.status));
  return activeAccountStatus(service.status ?? "");
}

export function capabilityAccountStatusLabel(status: string): string {
  switch (status.trim().toUpperCase()) {
    case "ACTIVE": return "Active";
    case "INITIALIZING": return "Setup in progress";
    case "INITIATED": return "Setup started";
    case "PENDING": return "Setup pending";
    case "EXPIRED": return "Authorization expired";
    case "FAILED": return "Connection failed";
    case "NOT_CONNECTED": return "Not connected";
    default: {
      const normalized = status.trim().toLowerCase().replace(/[_-]+/g, " ");
      return normalized ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}` : "Status unavailable";
    }
  }
}

interface FocusTarget {
  focus(): void;
  isConnected: boolean;
}

export function preserveCapabilityOpener<T>(
  current: T | null,
  active: T | null,
  activeIsInsideDialog: boolean,
): T | null {
  return active && !activeIsInsideDialog ? active : current;
}

export function restoreCapabilityFocusAfterClose(
  opener: FocusTarget | null,
  dialog: Pick<FocusTarget, "isConnected"> | null,
  schedule: (callback: () => void) => void = (callback) => { window.requestAnimationFrame(callback); },
): void {
  schedule(() => {
    // Strict Mode rehearses effect cleanup while the dialog remains mounted.
    // A real close removes it; one animation frame also gives modal isolation
    // time to release `inert` from the opener's branch before focus returns.
    if (dialog?.isConnected || opener?.isConnected === false) return;
    opener?.focus();
  });
}

export function PluginsPanel() {
  const { dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const rememberedInventory = useRef(readRememberedConnectorInventory()).current;
  const [cards, setCards] = useState<ToolkitCard[] | null>(null);
  const [catalogPhase, setCatalogPhase] = useState<CapabilityCatalogPhase>("loading");
  const [source, setSource] = useState<"api" | "curated">("curated");
  const [configured, setConfigured] = useState(true);
  const [mode, setMode] = useState<"managed" | "self-hosted" | "unavailable">("unavailable");
  // Paint what we last knew before any request goes out: the module cache if
  // this window already fetched, otherwise the inventory saved on disk. An
  // empty panel is never the first thing a connected user sees.
  const [status, setStatus] = useState<Record<string, ConnectorStatus>>(
    () => {
      const initial = { ...rememberedInventory?.services };
      for (const [slug] of pendingAuthorizationEntries()) {
        initial[slug] = {
          ...initial[slug],
          connected: initial[slug]?.connected ?? false,
          pending: true,
          status: "INITIATED",
        };
      }
      return initial;
    },
  );
  /** true when what is on screen is remembered rather than confirmed */
  const [stale, setStale] = useState(
    rememberedInventory !== null && rememberedConnectorInventoryStale(),
  );
  /** why the list is remembered: an unopenable credential store, or a
   * request that never completed. The two need different advice. */
  // Defaults to the generic wording: a remembered inventory restored at mount
  // carries no evidence about *why* it went stale, and the credential-store
  // copy tells the user to restart, which only helps for that one cause.
  const [staleReason, setStaleReason] = useState<"credential-store" | "unverified">("unverified");
  const [pendingUrls, setPendingUrls] = useState<Record<string, string>>(
    () => Object.fromEntries(pendingAuthorizationEntries()),
  );
  const [aliasSlug, setAliasSlug] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [inventoryPhase, setInventoryPhase] = useState<ConnectorInventoryPhase>(
    rememberedInventory === null ? "loading" : "ready",
  );
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"marketplace" | "connected">("marketplace");

  const pollTimers = useRef(new Map<string, ReturnType<typeof setInterval>>());
  const statusGenerations = useRef(new Map<string, number>());
  const latestStatusRequests = useRef(new Map<string, number>());
  const catalogRequest = useRef(0);

  const settlePendingUrl = useCallback((slug: string) => {
    clearPendingAuthorizationUrl(slug);
    setPendingUrls((current) => {
      if (!current[slug]) return current;
      const next = { ...current };
      delete next[slug];
      return next;
    });
  }, []);

  const refreshStatus = useCallback((slugs: string[]): Promise<Record<string, ConnectorStatus>> => {
    if (!slugs.length) return Promise.resolve({});
    const requestGenerations = new Map(slugs.map((slug) => [slug, statusGenerations.current.get(slug) ?? 0]));
    const requestIds = new Map(slugs.map((slug) => {
      const requestId = (latestStatusRequests.current.get(slug) ?? 0) + 1;
      latestStatusRequests.current.set(slug, requestId);
      return [slug, requestId];
    }));
    return api(`/api/connectors?services=${slugs.join(",")}`)
      .then((r) => {
        const services = onlyLatestConnectorResponses(
          r.services ?? {},
          latestStatusRequests.current,
          requestIds,
        );
        // A one-service OAuth poll must not erase every other app's state.
        // A request that began before Connect must also not erase the newer
        // local INITIATED state when its stale not_connected result arrives.
        setStatus((current) => mergeCurrentConnectorStatus(
          current,
          services,
          statusGenerations.current,
          requestGenerations,
        ));
        for (const [slug, state] of Object.entries(services)) {
          const isCurrent = (statusGenerations.current.get(slug) ?? 0) === (requestGenerations.get(slug) ?? 0);
          if (isCurrent && pendingAuthorizationSettled(state)) settlePendingUrl(slug);
        }
        return services;
      })
      .catch(() => {
        setStale(true);
        setStaleReason("unverified");
        setInventoryPhase("error");
        setInventoryError("Helmryth could not verify active capabilities. Retry the secure inventory check.");
        return {};
      });
  }, [settlePendingUrl]);

  const refreshConnectedStatus = useCallback((force = false): Promise<Record<string, ConnectorStatus>> => {
    const requestGenerations = new Map(statusGenerations.current);
    setRefreshing(true);
    return preloadConnectedApps(force)
      .then(({ services, authoritative }) => {
        setStale(!authoritative);
        if (!authoritative) setStaleReason(credentialStoreUnavailable() ? "credential-store" : "unverified");
        setStatus((current) => mergeCompleteConnectorStatus(
          current,
          services,
          statusGenerations.current,
          requestGenerations,
          authoritative,
        ));
        for (const [slug, state] of Object.entries(services)) {
          const isCurrent = (statusGenerations.current.get(slug) ?? 0) === (requestGenerations.get(slug) ?? 0);
          if (isCurrent && pendingAuthorizationSettled(state)) settlePendingUrl(slug);
        }
        return services;
      })
      .finally(() => setRefreshing(false));
  }, [settlePendingUrl]);

  const loadConnectionInventory = useCallback((force = false) => {
    const hadCachedInventory = rememberedInventory !== null;
    if (!hadCachedInventory) setInventoryPhase("loading");
    setInventoryError(null);
    setError(null);
    return refreshConnectedStatus(force)
      .then((services) => {
        setInventoryPhase("ready");
        return services;
      })
      .catch(() => {
        setInventoryPhase("error");
        setStale(hadCachedInventory);
        setStaleReason("unverified");
        setInventoryError("Helmryth could not verify active capabilities. Retry the secure inventory check.");
        return {};
      });
  }, [refreshConnectedStatus, rememberedInventory]);

  const loadCatalog = useCallback(() => {
    const request = ++catalogRequest.current;
    setCatalogPhase("loading");
    return api("/api/connectors/catalog")
      .then((response) => {
        if (request !== catalogRequest.current) return;
        setCards(response.cards ?? []);
        setSource(response.source ?? "curated");
        setConfigured(Boolean(response.configured));
        setMode(response.mode ?? "unavailable");
        setCatalogPhase("ready");
      })
      .catch(() => {
        if (request !== catalogRequest.current) return;
        setCatalogPhase("error");
      });
  }, []);

  useEffect(() => () => {
    for (const timer of pollTimers.current.values()) clearInterval(timer);
    pollTimers.current.clear();
  }, []);

  useEffect(() => {
    if (inventoryPhase !== "ready") return;
    writeRememberedConnectorInventory(status, stale);
  }, [inventoryPhase, stale, status]);

  useEffect(() => {
    void loadConnectionInventory();
    void loadCatalog();
    return () => {
      catalogRequest.current += 1;
    };
  }, [loadCatalog, loadConnectionInventory]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Strict Mode runs this setup twice. Preserve the first element outside
    // the dialog instead of replacing it with the search input on rehearsal.
    returnFocusRef.current = preserveCapabilityOpener(
      returnFocusRef.current,
      activeElement,
      Boolean(activeElement && dialog?.contains(activeElement)),
    );
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );

    (dialog?.querySelector<HTMLElement>("input") ?? focusable()[0] ?? dialog)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "togglePlugins", open: false });
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      restoreCapabilityFocusAfterClose(returnFocusRef.current, dialog);
    };
  }, [dispatch]);

  const openConnectUrl = async (url: string) => {
    if (window.helmryth?.openExternal) {
      await window.helmryth.openExternal(url);
      return;
    }
    // Browser development fallback. If a popup blocker rejects the first
    // asynchronous open, the visible Continue button retries from a direct
    // user gesture using the URL retained in pendingUrls.
    const opened = window.open("", "_blank");
    if (!opened) throw new Error("Your browser blocked the connection page. Click Continue to open it.");
    // Open a same-origin blank page first so the OAuth origin never receives
    // an opener reference, while a real null remains a reliable blocked signal.
    opened.opener = null;
    opened.location.replace(url);
  };

  const startPolling = useCallback((slug: string) => {
    const old = pollTimers.current.get(slug);
    if (old) clearInterval(old);
    let tries = 0;
    const timer = setInterval(() => {
      void refreshStatus([slug]).then((services) => {
        const state = services[slug];
        if (++tries >= 24 || (state?.connected && !state.pending) || (state?.status && /^(expired|failed)$/i.test(state.status))) {
          clearInterval(timer);
          pollTimers.current.delete(slug);
        }
      });
    }, 5000);
    pollTimers.current.set(slug, timer);
  }, [refreshStatus]);

  useEffect(() => {
    for (const [slug] of pendingAuthorizationEntries()) startPolling(slug);
  }, [startPolling]);

  const connect = async (slug: string, alias?: string) => {
    statusGenerations.current.set(slug, (statusGenerations.current.get(slug) ?? 0) + 1);
    setBusySlug(slug);
    setError(null);
    try {
      const request: RequestInit = { method: "POST" };
      if (alias) request.body = JSON.stringify({ alias });
      const { url } = await api(`/api/connectors/${slug}/authorize`, request);
      const safeUrl = rememberPendingAuthorizationUrl(slug, url);
      setPendingUrls((current) => ({ ...current, [slug]: safeUrl }));
      setStatus((current) => ({
        ...current,
        [slug]: {
          ...current[slug],
          connected: current[slug]?.connected ?? false,
          pending: true,
          status: "INITIATED",
        },
      }));
      setAliasSlug(null);
      setAliasDraft("");
      startPolling(slug);
      await openConnectUrl(url);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (requiresAccountAlias(message)) {
        // Recover gracefully if an existing account was discovered after the
        // button rendered. Show the label field and refresh only this app.
        setAliasSlug(slug);
        setAliasDraft("");
        setError("This app already has an account. Add a label such as work or personal to connect another.");
        void refreshStatus([slug]);
      } else {
        setError(message);
      }
    } finally {
      setBusySlug(null);
    }
  };

  const disconnectAccount = (slug: string, accountId: string) => {
    setBusySlug(slug);
    api(`/api/connectors/${slug}/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" })
      .then(() => refreshStatus([slug]))
      .catch((e) => setError(e.message))
      .finally(() => setBusySlug(null));
  };

  const matching = (cards ?? []).filter(
    (c) => !search || `${c.label} ${c.slug} ${c.blurb}`.toLowerCase().includes(search.toLowerCase()),
  );
  const visible = matching.filter((card) =>
    tab === "marketplace" || activeCapability(status[card.slug])
  );
  const connectedCount = Object.values(status).filter(activeCapability).length;
  const connectedEmptyCopy = connectedInventoryCopy(inventoryPhase);
  const close = () => dispatch({ type: "togglePlugins", open: false });
  const openConnectionsSettings = () => {
    requestConnectionsSetupFocus();
    dispatch(connectionsSettingsAction());
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-4 sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="capabilities-title"
        tabIndex={-1}
        className="animate-pop-in flex h-[min(780px,calc(100dvh-2rem))] w-full max-w-[1040px] flex-col overflow-hidden rounded-md border border-hairline/60 bg-panel shadow-xl"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-3 pt-6 sm:px-8 sm:pt-7">
          <div>
            <h2 id="capabilities-title" className="text-[22px] font-semibold tracking-[-0.01em] text-ink">Capabilities</h2>
            <p className="mt-1 text-[13px] text-ink-secondary">Connect the services your operators may use during a run.</p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void loadConnectionInventory(true)}
              disabled={refreshing}
              className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
              aria-label="Refresh capability connections"
              title="Refresh capability status"
            >
              <RefreshCw size={17} className={cn(refreshing && "animate-spin")} />
            </button>
            <button
              onClick={close}
              aria-label="Close capabilities"
              className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <X size={21} />
            </button>
          </div>
        </header>

        {stale && (
          // Say which of the two things is true. Silence here is what makes a
          // remembered list indistinguishable from a confirmed one.
          <div className="mx-6 mb-1 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12.5px] text-warning sm:mx-8">
            <TriangleAlert size={14} className="mt-px shrink-0" />
            <span>{staleReason === "credential-store" ? STALE_CAPABILITY_INVENTORY_COPY : UNVERIFIED_CAPABILITY_INVENTORY_COPY}</span>
          </div>
        )}

        <div className="flex flex-col gap-3 px-6 pb-4 pt-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div className="flex w-fit rounded-md border border-hairline bg-raised/70 p-1" role="tablist" aria-label="Capabilities view">
            <button
              role="tab"
              aria-selected={tab === "marketplace"}
              onClick={() => setTab("marketplace")}
              className={cn(
                "rounded-lg px-4 py-2 text-[13.5px] transition-colors",
                tab === "marketplace" ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
              )}
            >
              Catalog
            </button>
            <button
              role="tab"
              aria-selected={tab === "connected"}
              onClick={() => setTab("connected")}
              className={cn(
                "rounded-lg px-4 py-2 text-[13.5px] transition-colors",
                tab === "connected" ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
              )}
            >
              Active{connectedCount > 0 ? ` ${connectedCount}` : ""}
            </button>
          </div>
          <label className="flex h-11 w-full items-center gap-2.5 rounded-xl bg-raised/70 px-3.5 sm:w-[320px]">
            <Search size={17} className="shrink-0 text-ink-secondary" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search capabilities"
              aria-label="Search capabilities"
              className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </label>
        </div>

        {/* Two notices about the same fact is one too many: the stale banner
            above already explains this launch, and "configure your own
            connection service" is advice for someone who never set one up. */}
        {!configured && !stale && (
          <div className="mx-6 mb-1 rounded-xl bg-warning/10 px-4 py-3 text-[13px] text-warning sm:mx-8">
            Capabilities are temporarily unavailable. Retry after restarting, or configure your own connection service.{" "}
            <button
              className="font-medium underline underline-offset-2"
              onClick={openConnectionsSettings}
            >
              Open settings
            </button>
          </div>
        )}
        {configured && source === "curated" && mode === "self-hosted" && (
          <div className="mx-6 mb-1 text-[12px] text-ink-secondary sm:mx-8">
            Showing featured capabilities.{" "}
            <button
              className="underline underline-offset-2 hover:text-ink"
              onClick={openConnectionsSettings}
            >
              Update your Composio key
            </button>{" "}
            for the full catalog.
          </div>
        )}
        {inventoryError && (tab === "marketplace" || visible.length > 0) && (
          <div role="alert" className="mx-6 mt-2 flex items-center justify-between gap-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger sm:mx-8">
            <span>{inventoryError}</span>
            <button
              type="button"
              disabled={refreshing}
              onClick={() => void loadConnectionInventory(true)}
              className="shrink-0 rounded-md border border-danger/25 px-2.5 py-1 font-medium disabled:opacity-50"
            >
              {refreshing ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}
        {error && <div role="alert" className="mx-6 mt-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger sm:mx-8">{error}</div>}

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-5 sm:px-8">
          {catalogPhase === "loading" ? (
            <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-ink-secondary">
              <Loader2 size={14} className="animate-spin" /> Loading catalog…
            </div>
          ) : catalogPhase === "error" ? (
            <CapabilityCatalogError
              retrying={refreshing}
              // A fault that takes out the catalog takes out the inventory with
              // it — same origin, same core. Reloading only the catalog leaves
              // `stale` latched, which keeps every Connect action disabled even
              // though the cards came back.
              onRetry={() => {
                void loadCatalog();
                void loadConnectionInventory(true);
              }}
            />
          ) : (
            <div>
              <div className="mb-3 text-[12px] font-medium text-ink-secondary">
                {tab === "connected" ? "Active capabilities" : search ? "Search results" : "Capability catalog"}
              </div>
              <div className="max-w-[800px] border-t border-hairline/35">
              {visible.map((card) => {
              const serviceStatus = status[card.slug];
              const pending = serviceStatus?.pending;
              const failed = serviceStatus?.status && /^(expired|failed)$/i.test(serviceStatus.status);
              const accounts = serviceStatus?.accounts ?? [];
              // connected with no accounts and nothing in flight = a no-auth
              // toolkit: there is no OAuth to run, so "Connect" would mint a
              // pointless authorize. It ships included.
              const included = card.noAuth === true
                || (serviceStatus?.connected === true && !accounts.length && !pending && !failed);
              const addingAccount = aliasSlug === card.slug;
              const busy = busySlug === card.slug;
              return (
                <div
                  key={card.slug}
                  className="min-h-[88px] border-b border-hairline/35 px-1 py-4"
                >
                  <div className="flex items-center gap-3">
                    <ServiceIcon card={card} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-medium text-ink">{card.label}</div>
                      <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary">
                        {pending ? "Finish setup in your browser" : failed && !accounts.length ? "Authorization expired — try again" : card.blurb}
                      </div>
                    </div>
                    <button
                      type="button"
                      // Every row rendered the bare word "Connect", so a screen-reader
                      // user navigating the catalog by button heard it hundreds of
                      // times with nothing to tell the services apart.
                      aria-label={`${connectorActionLabel(inventoryPhase, {
                        busy,
                        included,
                        canContinue: Boolean(pending && pendingUrls[card.slug]),
                        hasAccounts: accounts.length > 0,
                        failed: Boolean(failed),
                      })} ${card.label}`}
                      disabled={connectorMutationsDisabled({ configured, phase: inventoryPhase, stale, busy }) || included}
                      onClick={() => {
                        if (pending && pendingUrls[card.slug]) {
                          setError(null);
                          void openConnectUrl(pendingUrls[card.slug]).catch((e) => setError(e.message));
                        } else if (accounts.length) {
                          setAliasSlug((current) => current === card.slug ? null : card.slug);
                          setAliasDraft("");
                        } else void connect(card.slug);
                      }}
                      className="flex min-w-[88px] items-center justify-center gap-1.5 rounded-md border border-hairline bg-raised px-3 py-2 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-40"
                    >
                      {busy ? (
                        <Loader2 size={13} className="mx-auto animate-spin" />
                      ) : (
                        connectorActionLabel(inventoryPhase, {
                          busy,
                          included,
                          canContinue: Boolean(pending && pendingUrls[card.slug]),
                          hasAccounts: accounts.length > 0,
                          failed: Boolean(failed),
                        })
                      )}
                    </button>
                  </div>
                  {accounts.length > 0 && (
                    <div className="ml-14 mt-3 space-y-2">
                      {accounts.map((account) => {
                        const active = activeAccountStatus(account.status);
                        return (
                          <div key={account.id} className="flex items-center gap-2 rounded-lg bg-raised/45 px-3 py-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
                                {active && <Check size={13} className="shrink-0 text-success" />}
                                <span className="truncate">{account.alias || account.id}</span>
                              </div>
                              <div className="mt-0.5 truncate text-[10.5px] text-ink-secondary">
                                {account.alias ? `${account.id} · ` : ""}{capabilityAccountStatusLabel(account.status)}
                              </div>
                            </div>
                            <button
                              type="button"
                              disabled={connectorMutationsDisabled({ configured, phase: inventoryPhase, stale, busy })}
                              onClick={() => {
                                if (!window.confirm(disconnectAccountConfirmation(card.label, account))) return;
                                disconnectAccount(card.slug, account.id);
                              }}
                              className="rounded-md px-2 py-1 text-[11px] text-ink-secondary transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                              aria-label={`Disconnect ${account.alias || account.id} from ${card.label}`}
                            >
                              Disconnect
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {addingAccount && (
                    <form
                      className="ml-14 mt-3 flex items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const alias = aliasDraft.trim();
                        if (!alias) {
                          setError("Enter a label for the account, such as work or personal.");
                          return;
                        }
                        void connect(card.slug, alias);
                      }}
                    >
                      <input
                        autoFocus
                        disabled={stale || inventoryPhase !== "ready"}
                        value={aliasDraft}
                        maxLength={64}
                        onChange={(event) => setAliasDraft(event.target.value)}
                        placeholder="Account label (work, personal…)"
                        aria-label={`Label for another ${card.label} account`}
                        className="min-w-0 flex-1 rounded-lg bg-raised px-3 py-2 text-[12px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent"
                      />
                      <button
                        type="submit"
                        disabled={stale || inventoryPhase !== "ready" || busy || !aliasDraft.trim()}
                        className="rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-white disabled:opacity-40"
                      >
                        Continue
                      </button>
                    </form>
                  )}
                </div>
              );
              })}
              </div>
            </div>
          )}
          {catalogPhase === "ready" && cards !== null && visible.length === 0 && (
            <div className="flex min-h-56 flex-col items-center justify-center text-center">
              <div className="text-[14px] font-medium text-ink">
                {tab === "connected" ? connectedEmptyCopy.title : "No capabilities found"}
              </div>
              <div className="mt-1 text-[12.5px] text-ink-secondary">
                {tab === "connected" ? connectedEmptyCopy.description : "Try a different search."}
              </div>
              {tab === "connected" && inventoryPhase === "error" && (
                <button
                  type="button"
                  disabled={refreshing}
                  onClick={() => void loadConnectionInventory(true)}
                  className="mt-4 flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-50"
                >
                  <RefreshCw size={13} className={cn(refreshing && "animate-spin")} />
                  Retry
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
