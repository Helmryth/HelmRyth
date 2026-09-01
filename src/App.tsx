import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2, Menu } from "lucide-react";
import { StoreProvider, useStore, type AppState } from "@/state/store";
import { Onboarding } from "@/components/Onboarding";
import { emailGateDone, initAnalytics } from "@/lib/analytics";
import { unreadConversationCount } from "@/lib/unread";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { UpdateBanner } from "@/components/UpdateBanner";
import { OfflineBanner } from "@/components/OfflineBanner";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { NoEngines } from "@/components/NoEngines";
import { CommandPalette } from "@/components/CommandPalette";
import {
  consumeConnectionsSetupFocusIntent,
  preloadConnectedApps,
} from "@/lib/connected-apps-inventory";
import { syncModalBoundary } from "@/lib/modal-boundary";
import { restoreOverlayFocus } from "@/lib/overlay-focus";
import { observeShellModalIsolation } from "@/lib/overlay-isolation";

const SettingsPanel = lazy(() =>
  import("@/components/SettingsPanel").then((module) => ({ default: module.SettingsPanel })),
);
const PluginsPanel = lazy(() =>
  import("@/components/PluginsPanel").then((module) => ({ default: module.PluginsPanel })),
);
const ComputerPanel = lazy(() =>
  import("@/components/ComputerPanel").then((module) => ({ default: module.ComputerPanel })),
);
const InspectorPanel = lazy(() =>
  import("@/components/InspectorPanel").then((module) => ({ default: module.InspectorPanel })),
);
const SettingsModal = lazy(() =>
  import("@/components/SettingsModal").then((module) => ({ default: module.SettingsModal })),
);
const RoutinesPage = lazy(() =>
  import("@/components/RoutinesPage").then((module) => ({ default: module.RoutinesPage })),
);
const LocalVmWorkspace = lazy(() =>
  import("@/components/LocalVmWorkspace").then((module) => ({ default: module.LocalVmWorkspace })),
);
const BrowserWorkspace = lazy(() =>
  import("@/components/BrowserWorkspace").then((module) => ({ default: module.BrowserWorkspace })),
);
const SkillRecorderPage = lazy(() =>
  import("@/components/SkillRecorderPage").then((module) => ({ default: module.SkillRecorderPage })),
);
const TeamMapPage = lazy(() =>
  import("@/components/TeamMapPage").then((module) => ({ default: module.TeamMapPage })),
);

export const CONNECTION_SETUP_FOCUS_SELECTOR = 'input[aria-label="Composio project key"]';
export const WORKBENCH_LAUNCHER_SELECTOR = "[data-helmryth-workbench-opener]";

export function focusConnectionSetup(root: ParentNode): boolean {
  const input = root.querySelector<HTMLInputElement>(CONNECTION_SETUP_FOCUS_SELECTOR);
  if (!input) return false;
  const details = input.closest("details");
  if (details) details.open = true;
  input.focus();
  return true;
}

export function focusWorkbenchLauncher(
  querySelector: (selector: string) => { focus(): void } | null,
): boolean {
  const launcher = querySelector(WORKBENCH_LAUNCHER_SELECTOR);
  if (!launcher) return false;
  launcher.focus();
  return true;
}

/**
 * The roster trigger shares the workstream's compact mobile masthead. Keep the
 * complete 44px hit area explicit here: an icon's visual size must not become
 * its touch target size.
 */
export const MOBILE_ROSTER_TRIGGER_CLASS =
  "absolute left-3 top-3 z-30 flex size-11 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink md:hidden";

type MobileRosterCloseState = Pick<
  AppState,
  | "selectedId"
  | "activeView"
  | "pluginsOpen"
  | "settingsOpen"
  | "appSettingsOpen"
  | "inspectorOpen"
  | "computerOpen"
>;

/** Changes whenever navigation or a shell overlay must dismiss the phone roster. */
export function mobileRosterCloseSignal(state: MobileRosterCloseState): string {
  return JSON.stringify([
    state.selectedId,
    state.activeView,
    state.pluginsOpen,
    state.settingsOpen,
    state.appSettingsOpen,
    state.inspectorOpen,
    state.computerOpen,
  ]);
}

function MainSurfaceFallback({ label }: { label: string }) {
  return (
    <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
      <Loader2 size={20} className="animate-spin" />
      <div className="text-[14px]" role="status" aria-live="polite">
        {label}
      </div>
    </main>
  );
}

function OverlayFallback({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-app/70 text-ink-secondary backdrop-blur-[2px]">
      <div className="flex items-center gap-2 rounded-full border border-hairline/60 bg-panel/92 px-4 py-2 text-[13px] shadow-lg">
        <Loader2 size={15} className="animate-spin" />
        <span role="status" aria-live="polite">{label}</span>
      </div>
    </div>
  );
}

function Shell() {
  const { state, dispatch } = useStore();
  const unreadCount = unreadConversationCount(state.bots, state.groups);
  // Mobile-only drawer state. Above md, none of these properties are emitted
  // at all — Sidebar scopes every mobile class with max-md: rather than
  // cancelling them with md:, which would still emit a translate value and
  // turn the aside into a containing block for its fixed descendants (see
  // Sidebar.tsx's className comment).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [localVmWorkspaceBotId, setLocalVmWorkspaceBotId] = useState<string | null>(null);
  // the Browser tab, expanded into the main column (the small preview in
  // the panel hands off to this and back)
  const [browserWorkspaceBotId, setBrowserWorkspaceBotId] = useState<string | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const group = state.groups.find((g) => g.id === state.selectedId);
  const bot = group ? undefined : (state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0]);
  const rosterCloseSignal = mobileRosterCloseSignal(state);

  // Nothing on this machine can run a bot. A missing cloud login does not
  // count — that CLI can still host a local model. Wait for the first
  // /api/instances response before deciding: an empty list means "not asked
  // yet", and flashing the setup screen at every launch would be worse.
  const noEngines =
    state.connected &&
    state.instances.length > 0 &&
    !state.instances.some((i) => i.snapshot.state === "available");

  // App-wide shortcuts: ⌘N new bot · ⌘1–9 jump to bot · ⌘⇧[ / ⌘⇧] prev/next.
  // Kept deliberately small; every panel already closes on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const bots = state.bots.filter((b) => !b.hidden);
      if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "newBot" });
      } else if (/^[1-9]$/.test(e.key)) {
        const target = bots[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          dispatch({ type: "select", id: target.id });
        }
        // Match on e.code: holding Shift rewrites e.key for these keys to "{"
        // and "}", so an e.key === "[" test can never fire for this chord.
      } else if (e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
        const idx = bots.findIndex((b) => b.id === state.selectedId);
        const next = bots[(idx + (e.code === "BracketRight" ? 1 : -1) + bots.length) % bots.length];
        if (next) {
          e.preventDefault();
          dispatch({ type: "select", id: next.id });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.bots, state.selectedId, dispatch]);

  useEffect(() => {
    window.helmryth?.setUnreadCount?.(unreadCount);
  }, [unreadCount]);

  // Warm connected-account state as soon as the local server is available.
  // The modal then opens with the correct Connect/Add account buttons and
  // quietly revalidates instead of rediscovering every account from scratch.
  useEffect(() => {
    if (!state.connected) return;
    void preloadConnectedApps().catch(() => {});
  }, [state.connected]);

  useEffect(() => {
    if (!state.appSettingsOpen || state.appSettingsSection !== "connections") return;
    if (!consumeConnectionsSetupFocusIntent()) return;
    const frame = requestAnimationFrame(() => {
      focusConnectionSetup(document);
    });
    return () => cancelAnimationFrame(frame);
  }, [state.appSettingsOpen, state.appSettingsSection]);

  // Picking a conversation closes the drawer: on a phone the chat is what you
  // asked for, and leaving the list up would hide it. Watching activeView too
  // catches re-selecting the bot that is already current from another view.
  // Every shell overlay participates too: System can be opened from inside the
  // roster itself, and leaving that drawer mounted would make the new modal an
  // inaccessible background layer on a phone.
  useEffect(() => {
    setDrawerOpen(false);
  }, [rosterCloseSignal]);

  useEffect(() => {
    if (
      localVmWorkspaceBotId &&
      (state.activeView !== "chat" || state.selectedId !== localVmWorkspaceBotId)
    ) {
      setLocalVmWorkspaceBotId(null);
    }
  }, [localVmWorkspaceBotId, state.activeView, state.selectedId]);

  const openLocalVmWorkspace = (botId: string) => {
    dispatch({ type: "toggleComputer", open: false });
    setLocalVmWorkspaceBotId(botId);
  };
  const openBrowserWorkspace = (botId: string) => {
    dispatch({ type: "toggleComputer", open: false });
    setBrowserWorkspaceBotId(botId);
  };
  const closeComputerPanel = () => {
    dispatch({ type: "toggleComputer", open: false });
    restoreOverlayFocus(document.activeElement instanceof HTMLElement ? document.activeElement : null, {
      fallback: () => document.querySelector<HTMLElement>(WORKBENCH_LAUNCHER_SELECTOR),
      schedule: (callback) => window.requestAnimationFrame(callback),
      block: () => Boolean(document.querySelector('[aria-label="Close Workbench panel"]')),
    });
  };
  const closeBrowserWorkspace = () => {
    setBrowserWorkspaceBotId(null);
    dispatch({ type: "toggleComputer", open: true });
  };
  useEffect(() => {
    if (browserWorkspaceBotId && (state.activeView !== "chat" || state.selectedId !== browserWorkspaceBotId)) {
      setBrowserWorkspaceBotId(null);
    }
  }, [browserWorkspaceBotId, state.activeView, state.selectedId]);

  const openComputerFromWorkspace = (botId: string) => {
    setLocalVmWorkspaceBotId(null);
    dispatch({ type: "select", id: botId });
    dispatch({ type: "toggleComputer", open: true });
  };

  const nativeViewOverlayOpen =
    drawerOpen ||
    paletteOpen ||
    state.settingsOpen ||
    state.computerOpen ||
    state.inspectorOpen ||
    state.appSettingsOpen ||
    state.pluginsOpen;

  // The viewer outlives ComputerPanel and can target any bot, so release control
  // here (always mounted) when a bot's viewer closes. release() is idempotent.
  useEffect(() => {
    return window.helmryth?.desktopViewer?.onState((viewer) => {
      if (viewer.open || !viewer.contextId) return;
      const botId = viewer.contextId;
      void fetch(`/api/bots/${botId}/computer/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "release" }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((snap) => {
          if (snap) dispatch({ type: "computerControl", botId, held: snap.held === true, helpReason: snap.helpReason ?? null });
        })
        .catch(() => {});
      void fetch(`/api/bots/${botId}/computer/viewer-close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => {});
    });
  }, [dispatch]);

  return (
    <div className="flex h-full flex-col">
      {/* fixed-position popup, bottom-left — outside the layout flow */}
      <UpdateBanner />
      {/* in the layout flow and above every view: a dead core must be visible
          from the roster, a workstream, the map or the cadence calendar alike */}
      <OfflineBanner />
      <div className="relative flex min-h-0 flex-1">
      <button
        type="button"
        ref={menuButtonRef}
        aria-label="Open roster"
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
        className={MOBILE_ROSTER_TRIGGER_CLASS}
      >
        <Menu size={18} />
      </button>
      <Sidebar
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          menuButtonRef.current?.focus();
        }}
      />
      {state.activeView === "team-map" ? (
        <Suspense fallback={<MainSurfaceFallback label="Opening the operations map…" />}>
          <TeamMapPage />
        </Suspense>
      ) : state.activeView === "routines" ? (
        <Suspense fallback={<MainSurfaceFallback label="Opening cadences…" />}>
          <RoutinesPage />
        </Suspense>
      ) : state.activeView === "skill-recorder" ? (
        <Suspense fallback={<MainSurfaceFallback label="Opening the skill recorder…" />}>
          <SkillRecorderPage />
        </Suspense>
      ) : browserWorkspaceBotId && bot && bot.id === browserWorkspaceBotId ? (
        <Suspense fallback={<MainSurfaceFallback label="Opening the browser workbench…" />}>
          <BrowserWorkspace bot={bot} onClose={closeBrowserWorkspace} />
        </Suspense>
      ) : localVmWorkspaceBotId ? (
        <Suspense fallback={<MainSurfaceFallback label="Opening the local workbench…" />}>
          <LocalVmWorkspace
            primaryBotId={localVmWorkspaceBotId}
            overlayOpen={nativeViewOverlayOpen}
            onClose={() => setLocalVmWorkspaceBotId(null)}
            onOpenComputer={openComputerFromWorkspace}
          />
        </Suspense>
      ) : noEngines ? (
        <NoEngines />
      ) : group ? (
        <GroupView key={group.id} group={group} />
      ) : bot ? (
        <ChatView bot={bot} />
      ) : (
        <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
          <Loader2 size={20} className="animate-spin" />
          <div className="text-[14px]">
            {state.connected ? "No operators yet" : "Connecting to the Helmryth service…"}
          </div>
          {!state.connected && (
            <div className="max-w-[420px] text-center text-[12px]">
              {import.meta.env.DEV
                // `pnpm dev:server` means nothing inside a packaged desktop app,
                // and this branch is what a first-run user sees on a cold start.
                ? <>Start it with <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code></>
                : "Helmryth is still starting its local service. If this persists, quit and reopen the app."}
            </div>
          )}
        </main>
      )}
      {state.settingsOpen && bot && (
        <Suspense fallback={<OverlayFallback label="Opening operator settings…" />}>
          <SettingsPanel bot={bot} />
        </Suspense>
      )}
      {state.computerOpen && bot && (
        <Suspense fallback={<OverlayFallback label="Opening the workbench…" />}>
          <ComputerPanel
            bot={bot}
            onClose={closeComputerPanel}
            onOpenVmWorkspace={openLocalVmWorkspace}
            onExpandBrowser={openBrowserWorkspace}
          />
        </Suspense>
      )}
      {state.inspectorOpen && bot && (
        <Suspense fallback={<OverlayFallback label="Opening the event inspector…" />}>
          <InspectorPanel bot={bot} />
        </Suspense>
      )}
      {state.appSettingsOpen && (
        <Suspense fallback={<OverlayFallback label="Opening system settings…" />}>
          <SettingsModal />
        </Suspense>
      )}
      {state.pluginsOpen && (
        <Suspense fallback={<OverlayFallback label="Opening connections…" />}>
          <PluginsPanel />
        </Suspense>
      )}
      {/* mounted after the modals: same z-50 tier, so DOM order keeps the
          palette on top when one of them is open underneath */}
      <CommandPalette onOpenChange={setPaletteOpen} />
      </div>
    </div>
  );
}

export default function App() {
  const [gated, setGated] = useState(() => !emailGateDone());
  const shellRef = useRef<HTMLDivElement>(null);
  const onboardingBoundaryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    initAnalytics();
  }, []);
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    return observeShellModalIsolation(shell, {
      // Onboarding is an intentional sibling app boundary, not a Shell modal.
      excludedRoots: onboardingBoundaryRef.current ? [onboardingBoundaryRef.current] : [],
    }).disconnect;
  }, []);
  useLayoutEffect(() => {
    syncModalBoundary(shellRef.current, gated);
  }, [gated]);
  return (
    <DesktopCapabilitiesProvider>
      <StoreProvider>
        <div ref={shellRef} className="h-full" aria-hidden={gated ? "true" : undefined}>
          <Shell />
        </div>
        <div ref={onboardingBoundaryRef}>
          {gated && <Onboarding onDone={() => setGated(false)} />}
        </div>
      </StoreProvider>
    </DesktopCapabilitiesProvider>
  );
}
