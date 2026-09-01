// The browser surface of the Workbench panel. The page itself is a native
// WebContentsView the Electron main process owns; this component only draws
// the chrome around it (address, back, take-over, profile) and keeps main
// told where its rectangle is. Anything the renderer draws is painted UNDER
// the native view, so menus and dialogs that would overlap it hide it
// instead. Compact in the panel; expanded when handed the main column.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, Globe, Hand, Loader2, Maximize2, Minimize2, Plus, UserRound } from "lucide-react";
import { usePageVisible } from "@/lib/page-visible";
import { cn } from "@/lib/cn";
import { useStore, type Bot, type BrowserProfile } from "@/state/store";

type ControlSnapshot = { held: boolean; helpReason: string | null };

const NATIVE_VIEW_OVERLAY_SELECTOR = '[aria-modal="true"], [role="dialog"], [role="menu"], [popover], [data-native-view-overlay]';
const OWN_PROFILE = "";
const GUEST_PROFILE = "guest";
const NEW_PROFILE = "__new__";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

function elementBounds(element: HTMLElement | null): DesktopWorkspaceBounds | null {
  const rect = element?.getBoundingClientRect();
  if (!rect || rect.width < 1 || rect.height < 1) return null;
  return { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
}

/** A visible dialog/menu intersecting the host rectangle would be painted
 * under the native view — hide the view while it is up. */
function overlayIntersects(host: DesktopWorkspaceBounds): boolean {
  for (const node of document.querySelectorAll<HTMLElement>(NATIVE_VIEW_OVERLAY_SELECTOR)) {
    if (node.closest("[data-native-view-host]")) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const overlaps =
      rect.left < host.x + host.width && rect.right > host.x && rect.top < host.y + host.height && rect.bottom > host.y;
    if (overlaps) return true;
  }
  return false;
}

function displayUrl(url: string): string {
  if (!url || url === "about:blank") return "";
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

/** "Work Microsoft" → "work-microsoft"; collisions get a numeric suffix. */
function profileIdFor(name: string, taken: BrowserProfile[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "profile";
  let candidate = base;
  for (let n = 2; taken.some((profile) => profile.id === candidate); n += 1) candidate = `${base}-${n}`;
  return candidate;
}

/**
 * Keep the configured Browser surface discoverable in the web development
 * shell while being explicit that the native surface is a Desktop feature.
 * ComputerPanel owns whether the tab is configured; this component owns the
 * runtime bridge state.
 */
export function BrowserWorkbenchUnavailable() {
  return (
    <div className="flex h-full min-h-0 items-center justify-center px-2 py-8">
      <div className="w-full rounded-md border border-warning/35 bg-warning/10 px-4 py-5 text-center">
        <Globe size={22} aria-hidden="true" className="mx-auto mb-2 text-warning" />
        <div role="status" className="text-[13px] font-medium text-ink">
          Open Helmryth Desktop to use the Browser Workbench.
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">
          This browser shell cannot host the isolated native web surface.
        </p>
      </div>
    </div>
  );
}

export function BrowserPanel({
  bot,
  control,
  controlPending,
  onControl,
  size = "compact",
  onExpand,
  onCollapse,
}: {
  bot: Bot;
  control: ControlSnapshot;
  controlPending: boolean;
  onControl: (action: "take" | "release") => void;
  size?: "compact" | "expanded";
  /** Compact only: hand the tab to the main column. */
  onExpand?: () => void;
  /** Expanded only: hand the tab back to the panel. */
  onCollapse?: () => void;
}) {
  const { state, dispatch } = useStore();
  const bridge = window.helmryth?.browser;
  const pageVisible = usePageVisible();
  const hostRef = useRef<HTMLDivElement>(null);
  const [surface, setSurface] = useState<BrowserSurfaceState | null>(null);
  const [address, setAddress] = useState("");
  const [addressFocused, setAddressFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addingProfile, setAddingProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const addProfileButtonRef = useRef<HTMLButtonElement>(null);
  const botId = bot.id;
  const profiles = state.config?.browserProfiles ?? [];
  // a profile that was deleted falls back to the bot's own session; Guest is
  // never in the list, it is a throwaway the surface forgets on switch-away
  const activeProfile =
    bot.browserProfile === GUEST_PROFILE
      ? GUEST_PROFILE
      : bot.browserProfile && profiles.some((profile) => profile.id === bot.browserProfile)
        ? bot.browserProfile
        : OWN_PROFILE;

  // Layout: tell main where the tab's rectangle is, on every change that can
  // move it (resize, scroll, sidebar toggles, dialogs). Coalesced per frame.
  // The profile rides along: switching it swaps the tab's session.
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    let frame = 0;
    const send = () => {
      if (!alive) return;
      const bounds = elementBounds(hostRef.current);
      const target = bounds && pageVisible && !overlayIntersects(bounds) ? bounds : null;
      bridge
        .layout(botId, target, activeProfile, size)
        .then((next) => {
          if (alive) setSurface(next);
        })
        .catch((cause) => {
          if (alive) setError(cause instanceof Error ? cause.message : String(cause));
        });
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        send();
      });
    };
    send();
    const resize = new ResizeObserver(schedule);
    if (hostRef.current) resize.observe(hostRef.current);
    const mutation = new MutationObserver(schedule);
    mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "open", "aria-modal", "hidden"] });
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    return () => {
      alive = false;
      if (frame) window.cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      // The surface is gone; the page stays alive while an operator is running,
      // but nothing may paint over the workstream.
      void bridge.layout(botId, null).catch(() => {});
    };
  }, [bridge, botId, pageVisible, activeProfile, size]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onState((next) => {
      if (next.botId === botId) setSurface(next);
    });
  }, [bridge, botId]);

  useEffect(() => {
    if (!addressFocused) setAddress(displayUrl(surface?.url ?? ""));
  }, [surface?.url, addressFocused]);

  const navigate = useCallback(
    (raw: string) => {
      if (!bridge) return;
      const target = raw.trim();
      if (!target) return;
      setBusy(true);
      setError(null);
      bridge
        .navigate(botId, target)
        .then(() => setAddressFocused(false))
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setBusy(false));
    },
    [bridge, botId],
  );

  const back = () => {
    if (!bridge) return;
    setError(null);
    bridge.back(botId).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  const chooseProfile = (value: string) => {
    if (value === NEW_PROFILE) {
      setAddingProfile(true);
      return;
    }
    // null (not undefined) so the clear survives JSON serialisation
    dispatch({ type: "updateBot", botId, patch: { browserProfile: value === OWN_PROFILE ? null : value } });
  };

  const addProfile = async () => {
    const name = newProfileName.trim();
    if (!name || profileBusy) return;
    setProfileBusy(true);
    setError(null);
    try {
      const id = profileIdFor(name, profiles);
      const config = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ browserProfiles: [...profiles, { id, name }] }),
      });
      dispatch({ type: "configStatus", config });
      dispatch({ type: "updateBot", botId, patch: { browserProfile: id } });
      setAddingProfile(false);
      setNewProfileName("");
      window.requestAnimationFrame(() => addProfileButtonRef.current?.focus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProfileBusy(false);
    }
  };

  if (!bridge) {
    return <BrowserWorkbenchUnavailable />;
  }

  const currentUrl = surface?.url && surface.url !== "about:blank" ? surface.url : null;
  const expanded = size === "expanded";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!expanded && <div className="mb-2 mt-2 flex items-center justify-between border-b border-hairline/50 pb-2 text-[13px] text-ink-secondary">
        <span className="flex items-center gap-2">
          <Globe size={13} aria-hidden="true" />
          <span><span className="font-medium text-ink">{bot.name}</span> · browser</span>
          {surface?.loading || busy ? <Loader2 size={13} className="motion-safe:animate-spin" /> : null}
        </span>
        {onExpand ? (
          <button
            type="button"
            onClick={onExpand}
            data-browser-workbench-launcher={bot.id}
            className="flex min-h-9 items-center gap-1 rounded-md px-2.5 text-[12px] hover:bg-control hover:text-ink"
            title="Open the Browser Workbench"
          >
            <Maximize2 size={13} /> Open
          </button>
        ) : null}
      </div>}
      <form
        className="mb-2 flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(address);
        }}
      >
        <button
          type="button"
          onClick={back}
          disabled={!surface?.canGoBack}
          className="flex size-9 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          title="Back"
          aria-label="Back"
        >
          <ArrowLeft size={15} />
        </button>
        <div className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-hairline/60 bg-panel px-2.5 focus-within:border-accent">
          <Globe size={13} aria-hidden="true" className="shrink-0 text-ink-secondary" />
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={() => setAddressFocused(true)}
            onBlur={() => setAddressFocused(false)}
            placeholder="Enter a web address"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-secondary/70"
            aria-label="Web address"
          />
        </div>
        {currentUrl && (
          <button
            type="button"
            onClick={() => void window.helmryth?.openExternal?.(currentUrl)}
            className="flex size-9 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
            title="Open in your default browser"
            aria-label="Open in your default browser"
          >
            <ExternalLink size={15} />
          </button>
        )}
        {expanded && onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            className="flex size-9 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
            title="Return browser to the Workbench panel"
            aria-label="Return browser to the Workbench panel"
          >
            <Minimize2 size={15} />
          </button>
        )}
      </form>

      {/* The native view is positioned over this box by the main process. In
          the panel it is a small preview — click it to expand. */}
      <div
        ref={hostRef}
        data-native-view-host
        onClick={!expanded && onExpand ? onExpand : undefined}
        role={!expanded && onExpand ? "button" : undefined}
        tabIndex={!expanded && onExpand ? 0 : undefined}
        aria-label={!expanded && onExpand ? `Open ${bot.name} Browser Workbench` : undefined}
        aria-busy={surface?.loading || busy}
        onKeyDown={!expanded && onExpand ? (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onExpand();
          }
        } : undefined}
        title={!expanded && onExpand ? "Open Browser Workbench" : undefined}
        className={cn(
          "relative overflow-hidden rounded-md border border-hairline/60 bg-inset",
          expanded ? "min-h-[180px] flex-1" : "aspect-[16/10] w-full shrink-0 cursor-zoom-in",
        )}
      >
        {!currentUrl && !surface?.loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-[13px] text-ink-secondary">
            <Globe size={22} aria-hidden="true" className="opacity-60" />
            <span>Enter an address, or start a workstream and ask {bot.name} to research the web.</span>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="min-w-0 text-[13px] leading-relaxed text-ink-secondary" aria-live="polite" aria-atomic="true">
          {control.held
            ? `You hold this surface. ${bot.name} is waiting until you return it.`
            : `Take the controls at any point. ${bot.name} will pause while you drive.`}
        </div>
        <button
          onClick={() => onControl(control.held ? "release" : "take")}
          disabled={controlPending}
          className={cn(
            "flex min-h-9 shrink-0 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium disabled:opacity-60",
            control.held ? "bg-accent text-accent-ink" : "bg-control text-ink hover:bg-raised-hover",
          )}
        >
          <Hand size={14} />
          {control.held ? "Return controls" : "Take controls"}
        </button>
      </div>

      {/* Profile: which session (cookies and logins) this operator uses. */}
      <div className="mt-4 border-t border-hairline/50 pt-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-[13px] text-ink">
            <UserRound size={14} className="shrink-0 text-ink-secondary" />
            <span className="shrink-0">Profile</span>
            <select
              value={activeProfile}
              onChange={(event) => chooseProfile(event.target.value)}
              disabled={profileBusy}
              aria-label="Browser profile"
              className="min-w-0 flex-1 rounded-md bg-inset px-2 py-1 text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <option value={OWN_PROFILE}>{bot.name} · private</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
              <option value={GUEST_PROFILE}>Temporary · cleared on switch</option>
              <option value={NEW_PROFILE}>+ Add profile…</option>
            </select>
          </div>
          <button
            ref={addProfileButtonRef}
            type="button"
            onClick={() => setAddingProfile((open) => !open)}
            className="flex size-9 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
            title="Add a profile"
            aria-label="Add a profile"
          >
            <Plus size={15} />
          </button>
        </div>
        {addingProfile && (
          <form
            className="mt-2 flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void addProfile();
            }}
          >
            <input
              autoFocus
              value={newProfileName}
              onChange={(event) => setNewProfileName(event.target.value)}
              placeholder="Profile name, e.g. Work"
              maxLength={40}
              className="min-w-0 flex-1 rounded-md bg-inset px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-secondary/70 focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label="New profile name"
            />
            <button
              type="submit"
              disabled={!newProfileName.trim() || profileBusy}
              className="min-h-9 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-ink disabled:opacity-50"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => {
                setAddingProfile(false);
                setNewProfileName("");
                window.requestAnimationFrame(() => addProfileButtonRef.current?.focus());
              }}
              className="min-h-9 rounded-md px-3 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
            >
              Cancel
            </button>
          </form>
        )}
        <div className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">
          Profiles hold logins and cookies. Operators assigned to one profile share its session; {bot.name}'s private profile is isolated. Temporary sessions are cleared when you switch away.
        </div>
      </div>
      {error && (
        <div role="alert" className="mt-2 border-l-2 border-danger pl-3 text-[13px] text-danger">
          Browser Workbench could not complete the request.
          <details className="mt-1 text-ink-secondary">
            <summary className="cursor-pointer text-[12px]">Technical detail</summary>
            <p className="mt-1 break-words text-[12px]">{error}</p>
          </details>
        </div>
      )}
    </div>
  );
}
