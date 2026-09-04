import { track } from "@/lib/analytics";
import { Fragment, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { z } from "zod";
import {
  Archive,
  BookOpenCheck,
  ArrowDownToLine,
  BellDot,
  CalendarDays,
  Check,
  CircleGauge,
  ClipboardCopy,
  Copy,
  FolderMinus,
  FolderPlus,
  Library,
  Loader2,
  Network,
  Pencil,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Puzzle,
  Trash2,
  Users,
  Waypoints,
  X,
} from "lucide-react";
import {
  api,
  useStore,
  formatTime,
  visibleMessages,
  type Bot,
  type Group,
} from "@/state/store";

import { BotAvatar, InitialsAvatar } from "./Avatar";
import { stateForBot } from "@/lib/sigil";
import { useUpdaterState } from "@/lib/updater";
import { cn } from "@/lib/cn";
import { skillRecorderEnabled } from "@/lib/feature-flags";
import { nextRename } from "@/lib/rename";
import { downloadAllBots } from "@/lib/team-files";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { MIN_QUERY, SearchResults } from "./SearchResults";
import { TeamLibraryPanel, type TeamImportResult } from "./TeamLibraryPanel";
import { RenameTitle } from "./RenameTitle";
import { BotPickerList } from "./BotPickerList";
import { presentRuntimeActivityLabel } from "../../shared/runtime-error";
import {
  loadSidebarDensity,
  saveSidebarDensity,
  type SidebarDensity,
} from "@/lib/sidebar-preferences";
import { phoneSettingsAction, SidebarPhoneButton } from "./SidebarPhoneButton";
import {
  consumeTopmostEscape,
  isTopmostModal,
  type FocusTargetLike,
  restoreOverlayFocus,
} from "@/lib/overlay-focus";

const reversibleImportSchema = z.object({
  transactionId: z.string(),
  idempotencyKey: z.string(),
  fingerprint: z.string(),
  committedAt: z.string(),
  name: z.string(),
  members: z.number().int().nonnegative(),
  botIds: z.array(z.string()),
  groupIds: z.array(z.string()),
  routineIds: z.array(z.string()),
  archived: z.array(z.object({ id: z.string(), chiefOfStaff: z.boolean() })),
  pending: z.boolean().default(false),
});

const reversibleImportsSchema = z.object({ imports: z.array(reversibleImportSchema) });

function reversibleImportResult(value: z.output<typeof reversibleImportSchema>): TeamImportResult {
  return {
    name: value.name,
    members: value.members,
    importedBotIds: value.botIds,
    importedGroupIds: value.groupIds,
    importedRoutineIds: value.routineIds,
    archived: value.archived,
    transaction: {
      transactionId: value.transactionId,
      idempotencyKey: value.idempotencyKey,
      fingerprint: value.fingerprint,
      committedAt: value.committedAt,
    },
  };
}

/** "Ada Lovelace" → "AL", "ada" → "A", "you@x.dev" → "Y", unset → "?" */
function profileInitials(profile?: { name?: string; email?: string }): string {
  const name = profile?.name?.trim();
  if (name) {
    const words = name.split(/\s+/);
    return words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  }
  // Deliberately not derived from the email, matching the label above.
  return "?";
}

/** Manual update check, next to the settings gear. Packaged app only (no
 * bridge in dev/browser). One button, state-dependent: check → download →
 * restart, with a brief "up to date" tick when a check finds nothing so a
 * click is never silent. The bottom-left popup handles the loud cases. */
function UpdateButton() {
  const s = useUpdaterState();
  const [checkedAt, setCheckedAt] = useState(0);
  const updater = window.helmryth?.updater;
  const status = s?.status ?? "idle";
  // download and install both round-trip through main before the status
  // changes — spin on the click itself, and let the new status clear it
  const [pending, setPending] = useState(false);
  useEffect(() => setPending(false), [status]);
  // a check that found nothing lands back on idle — acknowledge it for 3s
  const upToDate =
    Boolean(checkedAt) &&
    (!s || s.status === "idle") &&
    Date.now() - checkedAt < 3000;
  useEffect(() => {
    if (!upToDate) return;
    const timer = setTimeout(() => setCheckedAt(0), 3000);
    return () => clearTimeout(timer);
  }, [upToDate]);
  if (!updater) return null;

  const working =
    pending ||
    status === "checking" ||
    status === "downloading" ||
    status === "installing";
  const label =
    status === "available"
      ? `Version ${s?.version ?? ""} available — download`
      : status === "downloading"
        ? s?.percent == null
          ? "Starting download…"
          : `Downloading… ${Math.round(s.percent)}%`
        : status === "downloaded"
          ? `Version ${s?.version ?? ""} ready — restart to update`
          : status === "installing"
            ? "Restarting to update…"
            : status === "checking"
              ? "Checking for updates…"
              : upToDate
                ? "You're up to date"
                : "Check for updates";

  return (
    <button
      onClick={() => {
        if (status === "downloaded") {
          setPending(true);
          return void updater.install();
        }
        if (status === "available") {
          setPending(true);
          return void updater.download();
        }
        setCheckedAt(Date.now());
        void updater.check();
      }}
      disabled={working}
      title={label}
      aria-label={label}
      className="relative flex size-10 items-center justify-center rounded-md text-accent hover:bg-raised disabled:opacity-60"
    >
      {working ? (
        <Loader2 size={18} className="animate-spin" />
      ) : upToDate ? (
        <Check size={18} />
      ) : status === "available" ? (
        <ArrowDownToLine size={18} />
      ) : (
        <RefreshCw size={18} />
      )}
      {status === "downloaded" && (
        <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-accent" />
      )}
    </button>
  );
}

function preview(bot: Bot): string {
  if (bot.activity === "waiting-on-you") return "Waiting at your gate";
  if (bot.busy) return "Run in progress";
  // the visible branch's tail — bot.messages holds every fork, so its last
  // entry can belong to a version the user switched away from
  const last = visibleMessages(bot).at(-1);
  if (!last) return "";
  if (last.kind === "options" && last.card) return last.card.title;
  if (last.kind === "activity" && last.tool) {
    return presentRuntimeActivityLabel(last.tool.name, last.tool.setup, last.tool.runtimeError);
  }
  if (last.kind === "screen") return "Workbench capture";
  return last.text ?? "";
}

interface MenuState {
  botId: string;
  x: number;
  y: number;
  trigger: HTMLElement | null;
}

interface RoomMenuState {
  groupId: string;
  x: number;
  y: number;
  trigger: HTMLElement | null;
}

export type RosterDeletionSubject =
  | { kind: "operator"; id: string; name: string; taskCount: number }
  | { kind: "crew"; id: string; name: string; taskCount: number };

interface PendingRosterDeletion {
  subject: RosterDeletionSubject;
  returnFocus: HTMLElement | null;
}

export interface RosterDeletionPresentation {
  title: string;
  consequence: string;
  confirmLabel: string;
  path: string;
}

export function rosterDeletionPresentation(subject: RosterDeletionSubject): RosterDeletionPresentation {
  const taskWorkstreams = `${subject.taskCount} ${subject.taskCount === 1 ? "task workstream" : "task workstreams"}`;
  if (subject.kind === "operator") {
    return {
      title: `Permanently delete operator “${subject.name}”?`,
      consequence:
        `This erases ${subject.name}'s operator record, main workstream, ${taskWorkstreams}, and operator workspace. ` +
        "Its cadences and webhooks are disabled. Other operators and crew workstreams stay.",
      confirmLabel: `Delete ${subject.name} permanently`,
      path: `/api/bots/${subject.id}`,
    };
  }
  return {
    title: `Permanently delete crew “${subject.name}”?`,
    consequence:
      `This erases the ${subject.name} crew record, its shared workstream, and ${taskWorkstreams}. ` +
      "Member operators and their individual workstreams stay.",
    confirmLabel: `Delete ${subject.name} permanently`,
    path: `/api/groups/${subject.id}`,
  };
}

type RosterDeleteRequest = (
  path: string,
  init: { method: "DELETE" },
) => Promise<void>;

export type RosterDeletionResult =
  | { status: "deleted" }
  | { status: "duplicate" }
  | { status: "error"; message: string };

/** Lock before awaiting so double click, Enter repeat, and click+Enter share one request. */
export async function executeRosterDeletion(
  subject: RosterDeletionSubject,
  request: RosterDeleteRequest,
  inFlight: { current: boolean },
): Promise<RosterDeletionResult> {
  if (inFlight.current) return { status: "duplicate" };
  inFlight.current = true;
  try {
    await request(rosterDeletionPresentation(subject).path, { method: "DELETE" });
    // Keep the lock held through the successful unmount boundary.
    return { status: "deleted" };
  } catch (cause) {
    inFlight.current = false;
    return {
      status: "error",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function groupPreview(group: Group, bots: Bot[]): string {
  if (group.busyBotId) {
    return `${bots.find((b) => b.id === group.busyBotId)?.name ?? "An operator"} is working…`;
  }
  const last = group.messages.at(-1);
  if (!last) return "Ready for its first run";
  const text = last.kind === "activity" && last.tool
    ? presentRuntimeActivityLabel(last.tool.name, last.tool.setup, last.tool.runtimeError)
    : (last.text ?? "");
  if (last.role === "user") return `You: ${text}`;
  return last.from ? `${last.from.name}: ${text}` : text;
}

export type SidebarLayoutMode = "dock" | "overlay";

const SIDEBAR_OVERLAY_QUERY = "(max-width: 767px)";
export const MOBILE_ROSTER_CLOSE_CLASS =
  "flex size-11 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/30";

export function sidebarLayoutModeForWidth(width: number): SidebarLayoutMode {
  return width < 768 ? "overlay" : "dock";
}

export interface SkipTarget {
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  focus(): void;
}

/** Tab from the top of the document crosses the whole roster — 43 stops on a
 * three-operator team — before it reaches anything the user came to type in.
 * The skip control prefers the live composer and falls back to the view's main
 * region, because a fixed `href="#composer"` would silently do nothing on
 * every view that renders no composer. */
export function skipDestination<T extends SkipTarget>(
  querySelector: (selector: string) => T | null,
): T | null {
  return querySelector("[data-helmryth-composer-input]") ?? querySelector("main");
}

export function focusSkipTarget<T extends SkipTarget>(
  querySelector: (selector: string) => T | null,
): boolean {
  const target = skipDestination(querySelector);
  if (!target) return false;
  // <main> is not focusable on its own, so focus() would be a no-op and the
  // next Tab would restart at the top of the document.
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus();
  return true;
}

/** A roster row that archives or deletes itself takes focus with it and the
 * browser falls back to <body>: the next Tab restarts at the top of the app and
 * a screen-reader user has no position at all. Hand focus to the nearest
 * surviving row, then to the roster's own chrome. */
export function rosterFocusAfterRemoval<T extends { dataset?: { rosterId?: string } }>(
  items: readonly T[],
  removedId: string,
  fallbacks: readonly (T | null | undefined)[],
): T | null {
  const survivor = items.find((item) => item.dataset?.rosterId !== removedId);
  if (survivor) return survivor;
  return fallbacks.find((candidate): candidate is T => Boolean(candidate)) ?? null;
}

/** role="menu" promises arrow-key navigation. Without it the menu is a list
 * only Tab can walk, and Tab is exactly the key that is supposed to leave a
 * menu. `current` is -1 when focus has not landed on an item yet. */
export function contextMenuFocusIndex(count: number, current: number, key: string): number | null {
  if (count === 0) return null;
  if (key === "ArrowDown") return current + 1 >= count ? 0 : current + 1;
  if (key === "ArrowUp") return current <= 0 ? count - 1 : current - 1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

function readSidebarLayoutMode(): SidebarLayoutMode {
  const matchMedia = globalThis.window?.matchMedia;
  if (!matchMedia) return "dock";
  return matchMedia(SIDEBAR_OVERLAY_QUERY).matches ? "overlay" : "dock";
}

export function SidebarShell({
  mode,
  open,
  overlayRef,
  panelRef,
  onClose,
  children,
}: {
  mode: SidebarLayoutMode;
  open: boolean;
  overlayRef?: RefObject<HTMLDivElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children?: ReactNode;
}) {
  const sidebar = children ? (
    <aside
      ref={panelRef}
      aria-label="Operator roster and navigation"
      aria-modal={mode === "overlay" ? "true" : undefined}
      role={mode === "overlay" ? "dialog" : undefined}
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-hairline/40 bg-panel transition-[width] duration-200",
        mode === "overlay" && "relative z-10 max-w-full shadow-xl",
      )}
    >
      {children}
    </aside>
  ) : null;

  if (mode === "dock") return sidebar;
  if (!open || !sidebar) return null;

  return (
    <div ref={overlayRef} className="fixed inset-0 z-40 overflow-hidden md:hidden">
      <div aria-hidden="true" onMouseDown={onClose} className="absolute inset-0 bg-ink/20 backdrop-blur-[1px]" />
      {sidebar}
    </div>
  );
}

/** Crew mark: 2–3 overlapping operator sigils in the roster slot. */
function StackedSigiles({
  members,
  density,
}: {
  members: Bot[];
  density: SidebarDensity;
}) {
  const iconOnly = density === "icons";
  const slotSize = iconOnly
    ? "size-12"
    : density === "compact"
      ? "size-10"
      : "size-14";
  const singleSize = iconOnly ? 44 : density === "compact" ? 40 : 56;
  if (members.length <= 1) {
    const b = members[0];
    return (
      <div
        className={cn("flex shrink-0 items-center justify-center", slotSize)}
      >
        {b ? (
          <BotAvatar bot={b} state="happy" size={singleSize} animated={false} />
        ) : (
          <Users size={24} className="text-ink-secondary" />
        )}
      </div>
    );
  }
  const shown = members.slice(0, 3);
  const extra = members.length - shown.length;
  return (
    <div className={cn("flex shrink-0 items-center justify-center", slotSize)}>
      <div className="flex items-center -space-x-3">
        {shown.map((b) => (
          <BotAvatar
            key={b.id}
            bot={b}
            state="happy"
            size={30}
            animated={false}
          />
        ))}
        {extra > 0 && (
          <span className="z-10 flex size-[22px] items-center justify-center rounded-full border border-hairline/40 bg-raised text-[10px] font-medium text-ink-secondary">
            +{extra}
          </span>
        )}
      </div>
    </div>
  );
}

function GroupListItem({
  group,
  density,
  onMenu,
}: {
  group: Group;
  density: SidebarDensity;
  onMenu: (menu: RoomMenuState) => void;
}) {
  const { state, dispatch } = useStore();
  const selected = state.activeView === "chat" && state.selectedId === group.id;
  const members = group.memberIds
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is Bot => Boolean(b));
  const last = group.messages.at(-1);
  return (
    <button
      onClick={() => dispatch({ type: "select", id: group.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({
          groupId: group.id,
          x: e.clientX,
          y: e.clientY,
          trigger: e.currentTarget,
        });
      }}
      // the menu must be reachable without a pointer: Shift+F10, and the
      // dedicated ContextMenu key (whose native event carries no useful
      // coordinates) both open it centered on the row
      onKeyDown={(e) => {
        if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        onMenu({
          groupId: group.id,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          trigger: e.currentTarget,
        });
      }}
      data-roster-item
      data-roster-kind="crew"
      data-roster-id={group.id}
      className={cn(
        "relative flex w-full items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
        density === "icons"
          ? "justify-center px-1 py-1.5"
          : density === "compact"
            ? "gap-2 px-2 py-1.5"
            : "gap-3 px-3 py-2.5",
        selected
          ? "border-l-2 border-l-accent bg-raised"
          : "border-l-2 border-l-transparent hover:bg-raised/50",
      )}
      title={density === "icons" ? group.name : undefined}
      aria-label={`${group.name} crew${group.unread ? ", unread updates" : ""}`}
    >
      <StackedSigiles members={members} density={density} />
      <div className={cn("min-w-0 flex-1", density === "icons" && "hidden")}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[15px] font-semibold text-ink">
            {group.name}
          </span>
          {selected && last && (
            <span className="shrink-0 text-xs text-ink-secondary">
              {formatTime(last.at)}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] text-ink-secondary">
            {groupPreview(group, state.bots)}
          </span>
          {group.unread && (
            <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-accent">
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-accent"
              />{" "}
              New
            </span>
          )}
        </div>
      </div>
      {density === "icons" && group.unread && (
        <span className="absolute bottom-1.5 right-1.5 size-2 rounded-full border border-panel bg-accent" />
      )}
    </button>
  );
}

function RoomContextMenu({
  menu,
  onClose,
  onMoveToSection,
  onRequestDelete,
}: {
  menu: RoomMenuState;
  onClose: () => void;
  onMoveToSection: (groupId: string) => void;
  onRequestDelete: (group: Group, returnFocus: HTMLElement | null) => void;
}) {
  const { state, dispatch } = useStore();
  const group = state.groups.find((g) => g.id === menu.groupId);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(group?.name ?? "");

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (
        !(e.target instanceof Element) ||
        !e.target.closest("[data-room-menu]")
      )
        onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!group) return null;
  const saveRename = () => {
    const name = nextRename(group.name, draft);
    if (name)
      dispatch({ type: "patchGroup", groupId: group.id, patch: { name } });
    onClose();
  };
  const top = Math.min(menu.y, window.innerHeight - 204);
  const left = Math.min(menu.x, window.innerWidth - 240);
  return createPortal(
    <div
      data-room-menu
      style={{ top, left }}
      role="group"
      aria-label={`${group.name} crew actions`}
      className="fixed z-[70] w-[228px] overflow-hidden rounded-lg border border-hairline bg-card py-1.5 shadow-xl"
    >
      {renaming ? (
        <div className="flex items-center gap-1 px-2 py-1">
          <input
            autoFocus
            value={draft}
            maxLength={100}
            aria-label={`Rename ${group.name} crew`}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                saveRename();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            className="min-w-0 flex-1 rounded-lg bg-raised px-2 py-1.5 text-[14px] text-ink focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={saveRename}
            aria-label="Save crew name"
            title="Save"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Check size={15} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cancel crew rename"
            title="Cancel"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => {
            setDraft(group.name);
            setRenaming(true);
          }}
          className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
        >
          <Pencil size={16} className="text-ink-secondary" />
          Rename crew
        </button>
      )}
      <button
        onClick={() => {
          onClose();
          onMoveToSection(group.id);
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
      >
        <FolderPlus size={16} className="text-ink-secondary" />
        Move crew to context
      </button>
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(group.threadId);
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
      >
        <ClipboardCopy size={16} className="text-ink-secondary" />
        Copy workstream ID
      </button>
      <button
        onClick={() => {
          onRequestDelete(group, menu.trigger);
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger hover:bg-raised/70"
      >
        <Trash2 size={16} />
        Delete crew
      </button>
    </div>,
    document.body,
  );
}

/** Pick members and an optional Work/Personal/project context, then create. */
function NewRoomPanel({
  onClose,
  returnFocusRef,
}: {
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const [section, setSection] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const bots = state.bots.filter((b) => !b.hidden);
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const create = () => {
    if (!picked.size) return;
    dispatch({
      type: "createGroup",
      memberIds: [...picked],
      name: name.trim() || undefined,
      section: section.trim() || undefined,
    });
    track("room_created", {
      members: picked.size,
      context: Boolean(section.trim()),
    });
    onClose();
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (consumeTopmostEscape(event, dialog, () => onCloseRef.current(), document)) return;
      if (event.key !== "Tab" || !isTopmostModal(dialog, document)) return;
      const controls = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (controls.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = controls[0]!;
      const last = controls.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown, true);
      restoreOverlayFocus(returnFocusRef.current);
    };
  }, [returnFocusRef]);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-crew-title"
      aria-describedby="new-crew-description"
      tabIndex={-1}
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/20 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-[400px] rounded-lg border border-hairline bg-card p-5 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-3 border-b border-hairline pb-3">
          <div>
            <div
              id="new-crew-title"
              className="text-[16px] font-semibold text-ink"
            >
              Assemble a crew
            </div>
            <p id="new-crew-description" className="mt-1 text-[13px] leading-5 text-ink-secondary">
              Choose the operators who will share one workstream.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Assemble crew"
            title="Close"
            className="flex size-9 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X size={18} />
          </button>
        </div>
        <input
          ref={nameRef}
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
          }}
          placeholder="Crew name, for example Launch desk"
          aria-label="Crew name"
          className="mb-3 w-full rounded-md border border-hairline bg-raised px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-2 focus:ring-focus"
        />
        <input
          value={section}
          maxLength={60}
          onChange={(e) => setSection(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
          }}
          placeholder="Context (optional): Work, Personal, Client…"
          aria-label="Crew context"
          className="mb-3 w-full rounded-md border border-hairline bg-raised px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-2 focus:ring-focus"
        />
        <BotPickerList
          bots={bots}
          picked={picked}
          onToggle={toggle}
          emptyHint="Create an operator first. A crew needs at least one operator."
        />
        <button
          onClick={create}
          disabled={!picked.size}
          className="mt-4 w-full rounded-md bg-accent py-2 text-[14px] font-medium text-[var(--color-accent-ink)] hover:bg-accent-border disabled:opacity-40"
        >
          Assemble crew
          {picked.size
            ? ` · ${picked.size} ${picked.size === 1 ? "operator" : "operators"}`
            : ""}
        </button>
      </div>
    </div>
  );
}

function RosterDeletionDialog({
  pending,
  onCancel,
  onDeleted,
  onRestoreFocus,
}: {
  pending: PendingRosterDeletion;
  onCancel: () => void;
  onDeleted: (subject: RosterDeletionSubject) => void;
  onRestoreFocus: (deleted: boolean) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inFlightRef = useRef(false);
  const completedRef = useRef(false);
  const busyRef = useRef(false);
  const callbacksRef = useRef({ onCancel, onDeleted, onRestoreFocus });
  callbacksRef.current = { onCancel, onDeleted, onRestoreFocus };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  busyRef.current = busy;
  const presentation = rosterDeletionPresentation(pending.subject);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && busyRef.current && isTopmostModal(dialog, document)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
      }
      if (consumeTopmostEscape(event, dialog, () => callbacksRef.current.onCancel(), document)) return;
      if (event.key !== "Tab" || !isTopmostModal(dialog, document)) return;
      const controls = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (controls.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = controls[0]!;
      const last = controls.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown, true);
      // Strict Mode rehearses effects while this exact dialog remains in the
      // document. Restore only after the real unmount.
      window.requestAnimationFrame(() => {
        if (!dialog.isConnected) {
          callbacksRef.current.onRestoreFocus(completedRef.current);
        }
      });
    };
  }, []);

  const confirm = async () => {
    setError("");
    setBusy(true);
    const result = await executeRosterDeletion(
      pending.subject,
      async (path, init) => {
        await api(path, init);
      },
      inFlightRef,
    );
    if (result.status === "deleted") {
      completedRef.current = true;
      callbacksRef.current.onDeleted(pending.subject);
      return;
    }
    if (result.status === "error") {
      setError(result.message);
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/25 p-4 backdrop-blur-[1px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="roster-delete-title"
        aria-describedby="roster-delete-consequence"
        tabIndex={-1}
        className="animate-pop-in w-full max-w-[460px] rounded-lg border border-danger/25 bg-card p-5 shadow-xl outline-none sm:p-6"
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger">
            <Trash2 size={18} />
          </div>
          <div className="min-w-0">
            <h2 id="roster-delete-title" className="text-[18px] font-semibold text-ink">
              {presentation.title}
            </h2>
            <p id="roster-delete-consequence" className="mt-2 text-[13px] leading-5 text-ink-secondary">
              {presentation.consequence}
            </p>
          </div>
        </div>
        {error && (
          <div role="alert" className="mt-4 rounded-md border border-danger/25 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            Nothing was deleted. {error}
          </div>
        )}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="min-h-10 rounded-md border border-hairline bg-raised px-4 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            aria-busy={busy}
            className="flex min-h-10 items-center justify-center gap-2 rounded-md bg-danger px-4 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-60"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {busy ? "Deleting permanently…" : presentation.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Labeled divider between sidebar sections. Same typographic register as
 * EngineGroupLabel so the sidebar reads as one system. */
function SectionDivider({ name }: { name: string }) {
  return (
    <div
      className="flex items-center gap-2 px-3 pb-1 pt-3 first:pt-0"
      data-section={name}
    >
      <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
        {name}
      </span>
      <span className="h-px flex-1 bg-hairline/40" />
    </div>
  );
}

/** Move-to-section popover: existing sections as chips (checkmark on the
 * target's current one), a create field, and a remove action. Serves bots
 * and channels alike — the caller supplies the assignment. Mirrors the
 * context menu's fixed positioning + dismiss-on-outside-click contract. */
function SectionPicker({
  current,
  anchor,
  onClose,
  onAssign,
}: {
  /** the target's current section; undefined = none */
  current: string | undefined;
  anchor: { x: number; y: number };
  onClose: () => void;
  /** "" clears — the server drops an empty section */
  onAssign: (section: string) => void;
}) {
  const { state } = useStore();
  const [name, setName] = useState("");
  const trimmed = name.trim();

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (
        !(e.target instanceof Element) ||
        !e.target.closest("[data-section-picker]")
      )
        onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  // Hidden bots can carry a stale assignment; don't offer it as a context.
  // Channels and bots share one namespace, so Work or Personal can hold both.
  const sections = [
    ...new Set([
      ...state.bots
        .filter((b) => !b.hidden && b.section)
        .map((b) => b.section!),
      ...state.groups.filter((g) => g.section).map((g) => g.section!),
    ]),
  ];

  const assign = (section: string) => {
    onAssign(section);
    onClose();
  };

  const top = Math.max(8, Math.min(anchor.y, window.innerHeight - 300));
  const left = Math.min(anchor.x, window.innerWidth - 260);

  return (
    <div
      data-section-picker
      style={{ top, left }}
      role="group"
      aria-label="Choose roster context"
      className="fixed z-[70] w-[236px] overflow-hidden rounded-lg border border-hairline bg-card py-2 shadow-xl"
    >
      <div className="px-3.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
        Move to context
      </div>
      {sections.length > 0 && (
        <div className="flex flex-col gap-0.5 px-1.5 py-1">
          {sections.map((section) => (
            <button
              key={section}
              onClick={() => assign(section)}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]",
                section === current
                  ? "bg-raised text-ink"
                  : "text-ink hover:bg-raised/70",
              )}
            >
              <span className="truncate">{section}</span>
              {section === current && (
                <Check size={14} className="shrink-0 text-accent" />
              )}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex items-center gap-1.5 px-2.5 py-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed || trimmed.length > 60) return;
          assign(trimmed);
        }}
      >
        <input
          autoFocus
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New context…"
          aria-label="New context name"
          className="w-full rounded-md border border-hairline bg-raised px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-2 focus:ring-focus"
        />
        <button
          type="submit"
          disabled={!trimmed || trimmed.length > 60}
          className={cn(
            "shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] font-medium",
            trimmed
              ? "bg-accent text-[var(--color-accent-ink)]"
              : "bg-raised text-ink-secondary",
          )}
        >
          Add
        </button>
      </form>
      {current && (
        <>
          <div className="mx-2 my-1 border-t border-hairline/40" />
          <button
            onClick={() => assign("")}
            className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[13px] text-danger hover:bg-raised/70"
          >
            <FolderMinus size={15} />
            Remove from context
          </button>
        </>
      )}
    </div>
  );
}

function BotContextMenu({
  menu,
  onClose,
  onArchive,
  onMoveToSection,
  onRequestDelete,
}: {
  menu: MenuState;
  onClose: () => void;
  onArchive: (bot: Bot) => void;
  onMoveToSection: (botId: string) => void;
  onRequestDelete: (bot: Bot, returnFocus: HTMLElement | null) => void;
}) {
  const { state, dispatch } = useStore();
  const bot = state.bots.find((b) => b.id === menu.botId);
  const menuRef = useRef<HTMLDivElement>(null);
  const trigger = menu.trigger;

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (
        !(e.target instanceof Element) ||
        !e.target.closest("[data-bot-menu]")
      )
        onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      onClose();
      // Dismissing the menu must not strand focus on <body>: send it back to
      // the roster row the Shift+F10 press came from.
      trigger?.focus();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose, trigger]);

  // Shift+F10 and the ContextMenu key open this menu from the roster row. The
  // menu renders in a portal-height fixed layer far from the row in DOM order,
  // so without an explicit handoff the actions the user just opened sit a
  // dozen Tab stops away.
  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')
      ?.focus();
  }, []);

  if (!bot) return null;
  const engine = state.instances.find(
    (instance) => instance.instanceId === bot.modelSelection.instanceId,
  );
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  const visibleBotCount = state.bots.filter(
    (candidate) => !candidate.hidden,
  ).length;
  const archiveBlocked = Boolean(bot.chiefOfStaff) || visibleBotCount <= 1;
  const archiveHint = bot.chiefOfStaff
    ? "Choose another lead operator first"
    : visibleBotCount <= 1
      ? "Keep at least one active operator"
      : undefined;
  // keep the menu on-screen near the click
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 380));
  const left = Math.min(menu.x, window.innerWidth - 240);

  const item = (
    icon: React.ReactNode,
    label: string,
    onClick?: () => void,
    opts?: { danger?: boolean; disabled?: boolean; hint?: string },
  ) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      // Roving focus lives on the menu itself; Tab is meant to leave a menu,
      // not to walk it.
      tabIndex={-1}
      disabled={opts?.disabled}
      onClick={() => {
        onClick?.();
        onClose();
      }}
      title={opts?.hint}
      className={cn(
        "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px]",
        opts?.danger ? "text-danger" : "text-ink",
        opts?.disabled ? "cursor-default opacity-40" : "hover:bg-raised/70",
      )}
    >
      {icon}
      {label}
    </button>
  );
  const divider = (key: string) => (
    <div key={key} role="separator" className="mx-2 my-1 border-t border-hairline/40" />
  );

  return (
    <div
      ref={menuRef}
      data-bot-menu
      style={{ top, left }}
      role="menu"
      aria-label={`${bot.name} operator actions`}
      onKeyDown={(event) => {
        const items = Array.from(
          menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [],
        );
        const next = contextMenuFocusIndex(
          items.length,
          items.findIndex((item) => item === document.activeElement),
          event.key,
        );
        if (next === null) return;
        event.preventDefault();
        items[next]?.focus();
      }}
      className="fixed z-[70] w-[228px] overflow-hidden rounded-lg border border-hairline bg-card py-1.5 shadow-xl"
    >
      {[
        item(
          bot.pinned ? (
            <PinOff size={16} className="text-ink-secondary" />
          ) : (
            <Pin size={16} className="text-ink-secondary" />
          ),
          bot.pinned ? "Unpin" : "Pin",
          () =>
            dispatch({
              type: "updateBot",
              botId: bot.id,
              patch: { pinned: !bot.pinned },
            }),
        ),
        item(
          <CircleGauge
            size={16}
            className={bot.chiefOfStaff ? "text-accent" : "text-ink-secondary"}
          />,
          bot.chiefOfStaff ? "Remove lead operator" : "Make lead operator",
          () =>
            dispatch({
              type: "updateBot",
              botId: bot.id,
              patch: { chiefOfStaff: !bot.chiefOfStaff },
            }),
          {
            disabled: !bot.chiefOfStaff && !canCoordinate,
            hint:
              !bot.chiefOfStaff && !canCoordinate
                ? "Choose a coordination-capable engine first"
                : undefined,
          },
        ),
        item(
          <FolderPlus size={16} className="text-ink-secondary" />,
          "Move to section",
          () => {
            onClose();
            onMoveToSection(bot.id);
          },
        ),
        item(
          <BellDot size={16} className="text-ink-secondary" />,
          "Mark workstream unread",
          () => dispatch({ type: "markUnread", botId: bot.id }),
        ),
        divider("d1"),
        item(
          <Pencil size={16} className="text-ink-secondary" />,
          "Configure operator",
          () => {
            dispatch({ type: "select", id: bot.id });
            dispatch({ type: "toggleSettings", open: true });
          },
        ),
        item(
          <Copy size={16} className="text-ink-secondary" />,
          "Duplicate operator",
          () => dispatch({ type: "duplicateBot", botId: bot.id }),
        ),
        divider("d2"),
        item(
          <ClipboardCopy size={16} className="text-ink-secondary" />,
          "Copy workstream ID",
          () => {
            void navigator.clipboard?.writeText(bot.threadId);
          },
        ),
        divider("d3"),
        item(
          <Archive size={16} className="text-ink-secondary" />,
          "Archive operator",
          () => onArchive(bot),
          {
            disabled: archiveBlocked,
            hint: archiveHint,
          },
        ),
        item(
          <Trash2 size={16} />,
          "Delete operator",
          () => onRequestDelete(bot, menu.trigger),
          {
            danger: true,
          },
        ),
      ]}
    </div>
  );
}

function BotListItem({
  bot,
  density,
  onMenu,
  onArchive,
  archiveDisabled,
}: {
  bot: Bot;
  density: SidebarDensity;
  onMenu: (menu: MenuState) => void;
  onArchive: (bot: Bot) => void;
  archiveDisabled: boolean;
}) {
  const { state, dispatch } = useStore();
  const [renaming, setRenaming] = useState(false);
  const selected = state.activeView === "chat" && state.selectedId === bot.id;
  const sigilMotion =
    selected && state.sigilMotion?.botId === bot.id ? state.sigilMotion : null;
  const iconOnly = density === "icons";
  useEffect(() => {
    if (iconOnly) setRenaming(false);
  }, [iconOnly]);
  const avatarSize = iconOnly ? 44 : density === "compact" ? 40 : 56;
  // the visible branch, so a version switch changes the row with the chat
  const visible = visibleMessages(bot);
  const last = visible.at(-1);
  const rowClass = cn(
    "flex w-full items-center rounded-md border text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
    iconOnly
      ? "justify-center px-1 py-1.5"
      : density === "compact"
        ? "gap-2 px-2 py-1.5 pr-12"
        : "gap-3 px-3 py-2.5 pr-12",
    bot.chiefOfStaff
      ? selected
        ? "border-accent/40 bg-accent/15"
        : "border-accent/25 bg-accent/5 hover:bg-accent/10"
      : selected
        ? "border-transparent bg-raised"
        : "border-transparent hover:bg-raised/50",
  );
  const body = (
    <>
      <BotAvatar
        bot={bot}
        state={stateForBot({ ...bot, messages: visible })}
        size={avatarSize}
        motion={sigilMotion?.kind ?? "none"}
        motionKey={sigilMotion?.nonce ?? 0}
        // Motion means something is happening. A resting bot holds a resting
        // pose — N idle rows bobbing at display rate was most of the app's
        // visible-idle CPU (states are keyword-derived, so "working" can be
        // decorative; busy/unread/motion are the real signals).
        animated={
          Boolean(bot.busy) ||
          Boolean(bot.unread) ||
          (sigilMotion?.kind ?? "none") !== "none"
        }
      />
      <div className={cn("min-w-0 flex-1", iconOnly && "hidden")}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[15px] font-semibold text-ink">
            {bot.pinned && (
              <Pin size={12} className="shrink-0 text-ink-secondary" />
            )}
            <RenameTitle
              focusable={false}
              key={iconOnly ? "icons" : "expanded"}
              value={bot.name}
              onCommit={(name) =>
                dispatch({ type: "updateBot", botId: bot.id, patch: { name } })
              }
              onEditingChange={setRenaming}
              className="truncate"
              inputClassName="w-full rounded bg-inset px-1 py-0.5 text-[15px] font-semibold"
            />
          </span>
          {selected && last && !renaming && (
            <span className="shrink-0 text-xs text-ink-secondary transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
              {formatTime(last.at)}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[13px] text-ink-secondary">
            {bot.chiefOfStaff && (
              <span className="flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-accent">
                <CircleGauge size={11} /> Lead operator
              </span>
            )}
            {bot.chiefOfStaff && preview(bot) && (
              <span className="shrink-0 text-ink-secondary/60">·</span>
            )}
            <span className="truncate">{preview(bot)}</span>
          </span>
          {bot.unread && (
            <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-accent">
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-accent"
              />{" "}
              New
            </span>
          )}
        </div>
      </div>
    </>
  );
  const onContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    onMenu({
      botId: bot.id,
      x: event.clientX,
      y: event.clientY,
      trigger: event.currentTarget,
    });
  };

  // Keep the rename <input> out of role="button" — a button's descendants
  // are presentational, which hides the field from assistive tech.
  if (renaming) {
    return (
      <div
        className={rowClass}
        onContextMenu={onContextMenu}
        data-roster-item
        data-roster-kind="operator"
        data-roster-id={bot.id}
      >
        {body}
      </div>
    );
  }

  return (
    <div className="group relative" title={iconOnly ? bot.name : undefined}>
      <div
        role="button"
        tabIndex={0}
        aria-label={`${bot.name} operator${bot.unread ? ", unread updates" : ""}`}
        onClick={() => dispatch({ type: "select", id: bot.id })}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            onMenu({
              botId: bot.id,
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              trigger: event.currentTarget,
            });
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            dispatch({ type: "select", id: bot.id });
          }
        }}
        onContextMenu={onContextMenu}
        data-roster-item
        data-roster-kind="operator"
        data-roster-id={bot.id}
        className={rowClass}
      >
        {body}
      </div>
      {iconOnly && bot.unread && (
        <span className="pointer-events-none absolute bottom-1.5 right-1.5 size-2 rounded-full border border-panel bg-accent" />
      )}
      {!iconOnly && (
        <button
          type="button"
          disabled={archiveDisabled}
          onClick={() => onArchive(bot)}
          aria-label={`Archive ${bot.name}`}
          title={
            bot.chiefOfStaff
              ? "Choose another lead operator first"
              : archiveDisabled
                ? "Keep at least one active operator"
                : `Archive ${bot.name}`
          }
          className="absolute right-1 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-lg bg-card/90 text-ink-secondary opacity-0 shadow-sm transition hover:bg-raised hover:text-ink focus:opacity-100 disabled:cursor-default disabled:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100"
        >
          <Archive size={14} />
        </button>
      )}
    </div>
  );
}

function ArchivedBotsPanel({
  bots,
  onClose,
  onRestored,
}: {
  bots: Bot[];
  onClose: () => void;
  onRestored: (message: string) => void;
}) {
  const { dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [restoringAll, setRestoringAll] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyId && !restoringAll) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busyId, onClose, restoringAll]);

  const restore = async (bot: Bot) => {
    setBusyId(bot.id);
    setError("");
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      dispatch({ type: "select", id: bot.id });
      onRestored(`${bot.name} restored`);
      if (bots.length === 1) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const restoreAll = async () => {
    setRestoringAll(true);
    setError("");
    try {
      const responses = await Promise.all(
        bots.map((bot) =>
          api(`/api/bots/${bot.id}`, {
            method: "PATCH",
            body: JSON.stringify({ hidden: false }),
          }),
        ),
      );
      for (const response of responses)
        dispatch({ type: "botPatched", bot: response.bot });
      const first = bots[0];
      if (first) dispatch({ type: "select", id: first.id });
      onRestored(
        `${bots.length} ${bots.length === 1 ? "operator" : "operators"} restored`,
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestoringAll(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-4 sm:p-6"
      onMouseDown={(event) =>
        event.target === event.currentTarget &&
        !busyId &&
        !restoringAll &&
        onClose()
      }
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="archived-operators-title"
        tabIndex={-1}
        className="animate-pop-in flex max-h-[min(680px,calc(100dvh-2rem))] w-full max-w-[760px] flex-col overflow-hidden rounded-lg border border-hairline bg-panel shadow-xl outline-none"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-4 pt-6 sm:px-8 sm:pt-7">
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-accent">
              Roster record
            </div>
            <h2
              id="archived-operators-title"
              className="text-[22px] font-semibold tracking-[-0.01em] text-ink"
            >
              Archived operators
            </h2>
            <p className="mt-1 text-[13px] text-ink-secondary">
              Their workstreams remain intact until you delete the operator.
            </p>
          </div>
          <div className="flex items-center gap-1">
            {bots.length > 1 && (
              <button
                onClick={() => void restoreAll()}
                disabled={restoringAll || Boolean(busyId)}
                className="flex items-center gap-1.5 rounded-md border border-hairline bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40"
              >
                {restoringAll && <Loader2 size={13} className="animate-spin" />}
                Restore all
              </button>
            )}
            <button
              onClick={onClose}
              disabled={restoringAll || Boolean(busyId)}
              className="flex size-10 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
              aria-label="Close archived operators"
            >
              <X size={21} />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-3 sm:px-8">
          <div className="mb-3 text-[12px] font-medium text-ink-secondary">
            {bots.length} {bots.length === 1 ? "operator" : "operators"}{" "}
            archived
          </div>
          <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2">
            {bots.map((bot) => (
              <div
                key={bot.id}
                className="flex min-h-[82px] items-center gap-3 border-b border-hairline/35 px-1 py-3"
              >
                <BotAvatar bot={bot} state="happy" size={42} animated={false} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-ink">
                    {bot.name}
                  </div>
                  <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary">
                    {bot.title || "Operator"}
                  </div>
                </div>
                <button
                  onClick={() => void restore(bot)}
                  aria-label={`Restore ${bot.name}`}
                  disabled={restoringAll || Boolean(busyId)}
                  className="flex min-w-[78px] items-center justify-center gap-1.5 rounded-md border border-hairline bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40"
                >
                  {busyId === bot.id && (
                    <Loader2 size={13} className="animate-spin" />
                  )}
                  Restore
                </button>
              </div>
            ))}
          </div>
          {error && (
            <div
              role="alert"
              className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger"
            >
              {error}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function Sidebar({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const importReturnRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sectionPicker, setSectionPicker] = useState<MenuState | null>(null);
  const [roomMenu, setRoomMenu] = useState<RoomMenuState | null>(null);
  const [roomSectionPicker, setRoomSectionPicker] = useState<{
    groupId: string;
    x: number;
    y: number;
  } | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [newRoom, setNewRoom] = useState(false);
  const [teamLibraryOpen, setTeamLibraryOpen] = useState(false);
  const [teamInstallUrl, setTeamInstallUrl] = useState<string | null>(null);
  const [archivedBotsOpen, setArchivedBotsOpen] = useState(false);
  const [pendingDeletion, setPendingDeletion] = useState<PendingRosterDeletion | null>(null);
  const [exportingTeam, setExportingTeam] = useState(false);
  const [teamFeedback, setTeamFeedback] = useState<{
    error: boolean;
    text: string;
    undo?: TeamImportResult;
    restoreBot?: { id: string; name: string };
    pending?: boolean;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [density, setDensityState] = useState<SidebarDensity>(() =>
    loadSidebarDensity(),
  );
  const [lastExpandedDensity, setLastExpandedDensity] = useState<
    Exclude<SidebarDensity, "icons">
  >(() => {
    const saved = loadSidebarDensity();
    return saved === "icons" ? "comfortable" : saved;
  });
  const [densityOpen, setDensityOpen] = useState(false);
  const [layoutMode, setLayoutMode] = useState<SidebarLayoutMode>(() => readSidebarLayoutMode());
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const rosterReturnFocusRef = useRef<FocusTargetLike | null>(null);

  const setDensity = (next: SidebarDensity) => {
    setDensityState(next);
    if (next !== "icons") setLastExpandedDensity(next);
    // Search is hidden in avatar-only mode. Keeping its value would silently
    // filter bots, rooms, and message results with no visible way to clear it.
    else setQuery("");
    saveSidebarDensity(next);
    setDensityOpen(false);
  };

  const toggleCollapsed = () => {
    if (density === "icons") setDensity(lastExpandedDensity);
    else {
      setLastExpandedDensity(density);
      setDensity("icons");
    }
  };

  // The roster owns Escape only while it is the topmost modal. A nested crew,
  // library, archive, or destructive-action dialog consumes its own press.
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      // A nested overlay may synchronously unmount during its capture-phase
      // handler. defaultPrevented is the durable ownership signal after that
      // dialog has disappeared from the topmost-modal query.
      if (event.defaultPrevented) return;
      consumeTopmostEscape(event, panelRef.current, onClose, document);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  useEffect(() => {
    if (!densityOpen) return;
    const closeDensityMenu = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDensityOpen(false);
    };
    window.addEventListener("keydown", closeDensityMenu);
    return () => window.removeEventListener("keydown", closeDensityMenu);
  }, [densityOpen]);

  useEffect(() => {
    if (!plusOpen) return;
    const closePlusMenu = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPlusOpen(false);
    };
    window.addEventListener("keydown", closePlusMenu);
    return () => window.removeEventListener("keydown", closePlusMenu);
  }, [plusOpen]);

  useEffect(() => {
    const matchMedia = globalThis.window?.matchMedia;
    if (!matchMedia) return;
    const mediaQuery = matchMedia(SIDEBAR_OVERLAY_QUERY);
    const sync = (matches: boolean) => setLayoutMode(matches ? "overlay" : "dock");
    sync(mediaQuery.matches);
    const onChange = (event: MediaQueryListEvent) => {
      sync(event.matches);
    };
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", onChange);
      return () => mediaQuery.removeEventListener("change", onChange);
    }
    mediaQuery.addListener(onChange);
    return () => mediaQuery.removeListener(onChange);
  }, []);

  useEffect(() => {
    const documentRef = globalThis.document;
    const windowRef = globalThis.window;
    if (layoutMode !== "overlay" || !open || !documentRef || !windowRef) return;
    const panel = panelRef.current;
    const activeElement = documentRef.activeElement instanceof HTMLElement ? documentRef.activeElement : null;
    if (activeElement && !panel?.contains(activeElement)) {
      rosterReturnFocusRef.current = activeElement;
    }
    const previousOverflow = documentRef.body.style.overflow;
    documentRef.body.style.overflow = "hidden";
    const frame = windowRef.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      windowRef.cancelAnimationFrame(frame);
      documentRef.body.style.overflow = previousOverflow;
      restoreOverlayFocus(
        rosterReturnFocusRef.current,
        { schedule: (callback: () => void) => windowRef.requestAnimationFrame(callback) },
      );
    };
  }, [layoutMode, open]);

  useEffect(() => {
    return window.helmryth?.onPackageInstall?.((url) => {
      setTeamInstallUrl(url);
      setTeamLibraryOpen(true);
    });
  }, []);

  useEffect(() => {
    let active = true;
    void api("/api/teams/imports?limit=1")
      .then((value) => reversibleImportsSchema.parse(value))
      .then(({ imports }) => {
        const latest = imports[0];
        if (!active || !latest) return;
        const undo = reversibleImportResult(latest);
        if (latest.pending) {
          setTeamFeedback((current) => current ?? {
            error: false,
            pending: true,
            text: `${undo.name} cleanup is pending reconciliation`,
          });
          return;
        }
        setTeamFeedback((current) => current ?? {
          error: false,
          text: `${undo.name} can still be undone`,
          undo,
        });
      })
      .catch(() => {
        // Import recovery is optional UI state; the server remains authoritative.
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!teamFeedback || teamFeedback.undo || teamFeedback.pending) return;
    const timer = window.setTimeout(() => setTeamFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [teamFeedback]);

  const exportAllBots = async () => {
    setExportingTeam(true);
    setTeamFeedback(null);
    try {
      const exported = await downloadAllBots();
      track("team_exported", {
        members: exported.members,
        scope: "all_visible",
      });
      setTeamFeedback({
        error: false,
        text: `${exported.members} ${exported.members === 1 ? "operator" : "operators"} exported`,
      });
    } catch (cause) {
      setTeamFeedback({
        error: true,
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setExportingTeam(false);
    }
  };

  const undoTeamLoad = async (result: TeamImportResult) => {
    setTeamFeedback(null);
    try {
      const response = await api(`/api/teams/imports/${result.transaction.transactionId}/undo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (response.pending === true) {
        setTeamFeedback({
          error: false,
          pending: true,
          text: response.message ?? "Undo cleanup is pending reconciliation",
        });
        return;
      }
      const [snapshot, routineState] = await Promise.all([
        api("/api/bots"),
        api("/api/routines"),
      ]);
      dispatch({
        type: "hydrate",
        bots: snapshot.bots,
        groups: snapshot.groups,
        computerControl: snapshot.computerControl ?? {},
      });
      dispatch({ type: "routinesHydrated", routines: routineState.routines, runs: routineState.runs });
      const first = result.archived[0];
      if (first) dispatch({ type: "select", id: first.id });
      setTeamFeedback({ error: false, text: "Previous roster restored" });
    } catch (cause) {
      setTeamFeedback({
        error: true,
        text: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const archiveBot = async (bot: Bot) => {
    const activeBots = state.bots.filter((candidate) => !candidate.hidden);
    if (bot.chiefOfStaff || activeBots.length <= 1) return;
    setTeamFeedback(null);
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: true }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      if (state.selectedId === bot.id) {
        const next = activeBots.find((candidate) => candidate.id !== bot.id);
        if (next) dispatch({ type: "select", id: next.id });
      }
      // The Archive control lives inside the row it removes. Once the row
      // unmounts the browser drops focus to <body>, so a keyboard or
      // screen-reader user is left with no position in the roster and no idea
      // the count changed.
      rosterFocusAfterRemoval(
        Array.from(panelRef.current?.querySelectorAll<HTMLElement>("[data-roster-item]") ?? []),
        bot.id,
        [importReturnRef.current, closeButtonRef.current, panelRef.current],
      )?.focus();
      setTeamFeedback({
        error: false,
        text: `${bot.name} archived`,
        restoreBot: { id: bot.id, name: bot.name },
      });
    } catch (cause) {
      setTeamFeedback({
        error: true,
        text: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const undoBotArchive = async (bot: { id: string; name: string }) => {
    setTeamFeedback(null);
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      dispatch({ type: "select", id: bot.id });
      setTeamFeedback({ error: false, text: `${bot.name} restored` });
    } catch (cause) {
      setTeamFeedback({
        error: true,
        text: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const macInset = capabilities.windowChrome === "mac-inset";
  const browser = capabilities.host.label === "Browser";
  // SAFETY: Electron's documented -webkit-app-region CSS property is not in
  // React's CSSProperties type, but the renderer accepts it as an inline style.
  const windowDragStyle = macInset
    ? ({ WebkitAppRegion: "drag" } as React.CSSProperties)
    : undefined;
  // SAFETY: Same Electron-only CSS property as windowDragStyle; interactive
  // buttons must explicitly opt out of the draggable title-bar region.
  const windowNoDragStyle = macInset
    ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties)
    : undefined;

  const q = query.trim().toLowerCase();

  // Message search rides the same box as the name filter: names match
  // instantly from local state; transcript hits are the SearchResults
  // section below the list (debounced, lands on the message).

  const matchingBots = state.bots
    .filter((b) => !b.hidden)
    .filter(
      (b) =>
        !q ||
        b.name.toLowerCase().includes(q) ||
        (b.title ?? "").toLowerCase().includes(q) ||
        preview(b).toLowerCase().includes(q),
    );
  const unsectionedChief = matchingBots.find(
    (bot) => bot.chiefOfStaff && !bot.section,
  );
  const sectionChiefs = matchingBots.filter(
    (bot) => bot.chiefOfStaff && bot.section,
  );
  const sectionedBots = matchingBots
    .filter((bot) => !bot.chiefOfStaff && bot.section)
    .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
  const visibleBots = matchingBots
    .filter((bot) => !bot.chiefOfStaff && !bot.section)
    .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
  const visibleGroups = state.groups.filter(
    (g) => !q || g.name.toLowerCase().includes(q),
  );
  const sectionedGroups = visibleGroups.filter((g) => g.section);
  const unsectionedGroups = visibleGroups.filter((g) => !g.section);
  // sections keep first-appearance order within the current list; a section
  // whose members all moved away (or fell out of the filter) simply vanishes
  const sectionNames: string[] = [];
  for (const bot of sectionedBots) {
    if (!sectionNames.includes(bot.section!)) sectionNames.push(bot.section!);
  }
  for (const bot of sectionChiefs) {
    if (!sectionNames.includes(bot.section!)) sectionNames.push(bot.section!);
  }
  for (const group of sectionedGroups) {
    if (!sectionNames.includes(group.section!))
      sectionNames.push(group.section!);
  }
  const activeBotCount = state.bots.filter((bot) => !bot.hidden).length;
  const archivedBots = state.bots.filter((bot) => bot.hidden);
  const pendingTeamUndo = teamFeedback?.undo;
  const pendingBotUndo = teamFeedback?.restoreBot;

  return (
    <SidebarShell mode={layoutMode} open={open} overlayRef={overlayRef} panelRef={panelRef} onClose={onClose}>
      <div
        className={cn(
          "flex h-full flex-col",
          density === "icons"
            ? "w-[80px]"
            : density === "compact"
              ? "w-[272px]"
              : "w-[320px]",
          layoutMode === "overlay" && "max-w-[calc(100vw-1rem)]",
        )}
      >
      <button
        type="button"
        onClick={() => focusSkipTarget((selector) => document.querySelector<HTMLElement>(selector))}
        className="sr-only rounded-md focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[80] focus:border focus:border-hairline focus:bg-card focus:px-3 focus:py-2 focus:text-[13px] focus:text-ink focus:shadow-xl"
      >
        Skip to the workstream
      </button>
      {layoutMode === "overlay" && (
        <div className="flex items-center justify-between border-b border-hairline/40 px-4 py-3 md:hidden">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-accent">Helmryth</div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close roster"
            title="Close roster"
            className={MOBILE_ROSTER_CLOSE_CLASS}
          >
            <X size={18} />
          </button>
        </div>
      )}
      {/* macOS owns inset traffic lights; Linux/Windows use native chrome. */}
      <div
        className={cn(
          "flex items-center pt-3.5 pb-1",
          density === "icons" ? "flex-col gap-1 px-2" : "justify-between px-4",
        )}
        style={windowDragStyle}
      >
        {macInset ? (
          <div className={density === "icons" ? "h-5 w-full" : "w-14"} />
        ) : browser ? (
          <div className="flex items-center gap-2">
            <span className="size-3 rounded-full bg-[#ff5f57]" />
            <span className="size-3 rounded-full bg-[#febc2e]" />
            <span className="size-3 rounded-full bg-[#28c840]" />
          </div>
        ) : (
          <div />
        )}
        <div
          className={cn(
            "relative flex items-center",
            density === "icons" ? "flex-col gap-1" : "gap-1",
          )}
          style={windowNoDragStyle}
        >
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={
              density === "icons"
                ? "Expand roster"
                : "Collapse roster to sigils"
            }
            className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            title={density === "icons" ? "Expand roster" : "Collapse to sigils"}
          >
            {density === "icons" ? (
              <PanelLeftOpen size={20} />
            ) : (
              <PanelLeftClose size={20} />
            )}
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setDensityOpen((value) => !value)}
              aria-label="Choose roster density"
              aria-expanded={densityOpen}
              className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
              title="Roster density"
            >
              <span
                aria-hidden="true"
                className="flex size-5 flex-col items-center justify-center gap-[3px]"
              >
                <span className="h-px w-3.5 rounded-full bg-current" />
                <span className="h-px w-2.5 rounded-full bg-current" />
                <span className="h-px w-3.5 rounded-full bg-current" />
              </span>
            </button>
            {densityOpen && (
              <>
                <div
                  className="fixed inset-0 z-30"
                  onMouseDown={() => setDensityOpen(false)}
                />
                <div
                  className={cn(
                    "absolute top-full z-40 mt-1 w-40 overflow-hidden rounded-lg border border-hairline bg-card py-1.5 shadow-xl",
                    density === "icons" ? "left-0" : "right-0",
                  )}
                >
                  {(["comfortable", "compact", "icons"] as const).map(
                    (option) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setDensity(option)}
                        className={cn(
                          "flex w-full items-center justify-between px-3 py-2 text-left text-[13px] capitalize hover:bg-raised/70",
                          density === option
                            ? "border-l-2 border-accent text-accent"
                            : "border-l-2 border-transparent text-ink",
                        )}
                      >
                        {option === "icons" ? "Sigils only" : option}
                        {density === option && <Check size={14} />}
                      </button>
                    ),
                  )}
                </div>
              </>
            )}
          </div>
          <button
            ref={importReturnRef}
            onClick={() => setPlusOpen((o) => !o)}
            aria-label="Create or import"
            aria-haspopup="menu"
            aria-expanded={plusOpen}
            className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            title="Create or import"
          >
            <Plus size={20} strokeWidth={2} />
          </button>
          {plusOpen && (
            <>
              <div
                className="fixed inset-0 z-30"
                onMouseDown={() => setPlusOpen(false)}
              />
              <div
                className={cn(
                  "absolute top-full z-40 mt-1 w-48 overflow-hidden rounded-lg border border-hairline bg-card py-1.5 shadow-xl",
                  density === "icons" ? "left-0" : "right-0",
                )}
              >
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    track("bot_created");
                    dispatch({ type: "newBot" });
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <Waypoints size={16} className="text-ink-secondary" />
                  New operator
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    setNewRoom(true);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <Users size={16} className="text-ink-secondary" />
                  Assemble crew
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    void exportAllBots();
                  }}
                  disabled={exportingTeam}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  {exportingTeam ? (
                    <Loader2
                      size={16}
                      className="animate-spin text-ink-secondary"
                    />
                  ) : (
                    <ArrowDownToLine size={16} className="text-ink-secondary" />
                  )}
                  {exportingTeam ? "Exporting…" : "Export roster"}
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    setTeamLibraryOpen(true);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <Library size={16} className="text-ink-secondary" />
                  Crew library
                </button>
                {archivedBots.length > 0 && (
                  <button
                    onClick={() => {
                      setPlusOpen(false);
                      setArchivedBotsOpen(true);
                    }}
                    className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                  >
                    <Archive size={16} className="text-ink-secondary" />
                    <span className="flex-1">Archived operators</span>
                    <span className="text-[11.5px] text-ink-secondary">
                      {archivedBots.length}
                    </span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {density !== "icons" && (
        <div className="flex items-end justify-between gap-3 px-4 pb-1 pt-2">
          <div>
            {/* accent-text, not accent: at 10px the lighter accent measures
                4.27:1 on the panel, under the 4.5:1 minimum for body-size text.
                Matches the existing use on other small uppercase labels. */}
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-text">
              Helmryth
            </div>
            <div className="text-[17px] font-semibold tracking-[-0.015em] text-ink">
              Roster
            </div>
          </div>
          <span className="pb-0.5 text-[11px] text-ink-secondary">
            {activeBotCount} {activeBotCount === 1 ? "operator" : "operators"}
          </span>
        </div>
      )}

      {/* Search */}
      <div className={cn("pt-2 pb-3", density === "icons" ? "hidden" : "px-3")}>
        {/* The ring sits on the wrapper: the input is visually part of a
            composite field with the icon, so focusing it must light the whole
            control rather than a bare inner box. */}
        <div className="flex items-center gap-2 rounded-lg bg-raised/70 px-3 py-2 focus-within:ring-2 focus-within:ring-focus">
          <Search size={16} className="text-ink-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Search roster and workstreams"
            aria-label="Search operators, crews, and workstream entries"
            className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </div>
      </div>

      {/* Bot list */}
      <div className="flex-1 overflow-y-auto px-2">
        <div className="flex flex-col gap-0.5">
          {activeBotCount === 0 &&
            visibleGroups.length === 0 &&
            !q &&
            density !== "icons" && (
              <div className="border-y border-hairline px-3 py-6 text-left">
                <div className="text-[14px] font-semibold text-ink">
                  Assemble your roster
                </div>
                <p className="mt-1 text-[13px] leading-5 text-ink-secondary">
                  Create an operator, give it a clear remit, then open the first
                  workstream.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    track("bot_created");
                    dispatch({ type: "newBot" });
                  }}
                  className="mt-3 rounded-md bg-accent px-3 py-2 text-[13px] font-medium text-[var(--color-accent-ink)] hover:bg-accent-border"
                >
                  Create operator
                </button>
              </div>
            )}
          {!unsectionedChief &&
            sectionChiefs.length === 0 &&
            visibleBots.length === 0 &&
            sectionedBots.length === 0 &&
            visibleGroups.length === 0 &&
            q &&
            q.length < MIN_QUERY && (
              <div className="border-y border-hairline px-3 py-6 text-[13px] text-ink-secondary">
                No roster match for “{query}”. Try an operator, crew, or phrase
                from a workstream.
              </div>
            )}
          {unsectionedChief && (
            <div className="mb-1.5">
              <BotListItem
                bot={unsectionedChief}
                density={density}
                onMenu={setMenu}
                onArchive={(bot) => void archiveBot(bot)}
                archiveDisabled
              />
            </div>
          )}
          {unsectionedGroups.length > 0 && density !== "icons" && (
            <SectionDivider name="Crews" />
          )}
          {unsectionedGroups.map((g) => (
            <GroupListItem
              key={g.id}
              group={g}
              density={density}
              onMenu={setRoomMenu}
            />
          ))}
          {visibleBots.length > 0 && density !== "icons" && (
            <SectionDivider name="Operators" />
          )}
          {visibleBots.map((b) => (
            <BotListItem
              key={b.id}
              bot={b}
              density={density}
              onMenu={setMenu}
              onArchive={(bot) => void archiveBot(bot)}
              archiveDisabled={activeBotCount <= 1}
            />
          ))}
          {sectionNames.map((name) => (
            <Fragment key={name}>
              {density !== "icons" && <SectionDivider name={name} />}
              {sectionChiefs
                .filter((bot) => bot.section === name)
                .map((bot) => (
                  <BotListItem
                    key={bot.id}
                    bot={bot}
                    density={density}
                    onMenu={setMenu}
                    onArchive={(candidate) => void archiveBot(candidate)}
                    archiveDisabled
                  />
                ))}
              {sectionedGroups
                .filter((g) => g.section === name)
                .map((g) => (
                  <GroupListItem
                    key={g.id}
                    group={g}
                    density={density}
                    onMenu={setRoomMenu}
                  />
                ))}
              {sectionedBots
                .filter((b) => b.section === name)
                .map((b) => (
                  <BotListItem
                    key={b.id}
                    bot={b}
                    density={density}
                    onMenu={setMenu}
                    onArchive={(bot) => void archiveBot(bot)}
                    archiveDisabled={activeBotCount <= 1}
                  />
                ))}
            </Fragment>
          ))}
          <SearchResults query={query} onLanded={() => setQuery("")} />
        </div>
      </div>

      {/* Footer */}
      <div className={cn("pb-3 pt-2", density === "icons" ? "px-2" : "px-3")}>
        <button
          onClick={() => dispatch({ type: "showTeamMap" })}
          // Active state is otherwise carried only by a left border and a
          // background tint, which assistive tech cannot see.
          aria-current={state.activeView === "team-map" ? "page" : undefined}
          aria-label={density === "icons" ? "Operations map" : undefined}
          title={density === "icons" ? "Operations map" : undefined}
          className={cn(
            "flex min-h-10 w-full items-center rounded-md border-l-2 py-2 text-left transition-colors",
            density === "icons" ? "justify-center px-2" : "gap-3 px-3",
            state.activeView === "team-map"
              ? "border-accent bg-raised text-ink"
              : "border-transparent text-ink hover:bg-raised/50",
          )}
        >
          <Network
            size={20}
            className={
              state.activeView === "team-map"
                ? "text-accent"
                : "text-ink-secondary"
            }
          />
          <span
            className={cn(
              "flex-1 text-[14px]",
              density === "icons" && "hidden",
            )}
          >
            Operations map
          </span>
        </button>
        {skillRecorderEnabled(state.config) && (
          <button
            onClick={() => dispatch({ type: "showSkillRecorder" })}
            aria-label={density === "icons" ? "Record a method" : undefined}
            title={density === "icons" ? "Record a method" : undefined}
            className={cn(
              "flex min-h-10 w-full items-center rounded-md border-l-2 py-2 text-left transition-colors",
              density === "icons" ? "justify-center px-2" : "gap-3 px-3",
              state.activeView === "skill-recorder"
                ? "border-accent bg-raised text-ink"
                : "border-transparent text-ink hover:bg-raised/50",
            )}
          >
            <BookOpenCheck
              size={20}
              className={
                state.activeView === "skill-recorder"
                  ? "text-accent"
                  : "text-ink-secondary"
              }
            />
            <span
              className={cn(
                "flex-1 text-[14px]",
                density === "icons" && "hidden",
              )}
            >
              Record a method
            </span>
          </button>
        )}
        <button
          onClick={() => dispatch({ type: "showRoutines" })}
          aria-current={state.activeView === "routines" ? "page" : undefined}
          aria-label={density === "icons" ? "Runs and cadences" : undefined}
          title={density === "icons" ? "Runs and cadences" : undefined}
          className={cn(
            "flex min-h-10 w-full items-center rounded-md border-l-2 py-2 text-left transition-colors",
            density === "icons" ? "justify-center px-2" : "gap-3 px-3",
            state.activeView === "routines"
              ? "border-accent bg-raised text-ink"
              : "border-transparent text-ink hover:bg-raised/50",
          )}
        >
          <CalendarDays
            size={20}
            className={
              state.activeView === "routines"
                ? "text-accent"
                : "text-ink-secondary"
            }
          />
          <span
            className={cn(
              "flex-1 text-[14px]",
              density === "icons" && "hidden",
            )}
          >
            Runs &amp; cadences
          </span>
          {state.routineRuns.some(
            (run) => ["failed", "missed"].includes(run.status) && !run.seenAt,
          ) && <span className="size-2 rounded-full bg-danger" />}
        </button>
        <button
          onClick={() => dispatch({ type: "togglePlugins", open: true })}
          className={cn(
            "flex min-h-10 w-full items-center rounded-md border-l-2 border-transparent py-2 text-left hover:bg-raised/50",
            density === "icons" ? "justify-center px-2" : "gap-3 px-3",
          )}
          aria-label={density === "icons" ? "Capabilities" : undefined}
          title={density === "icons" ? "Capabilities" : undefined}
        >
          <Puzzle size={20} className="text-ink-secondary" />
          <span
            className={cn(
              "text-[14px] text-ink",
              density === "icons" && "hidden",
            )}
          >
            Capabilities
          </span>
        </button>
        {density === "icons" && (
          <SidebarPhoneButton
            density={density}
            onOpen={() => dispatch(phoneSettingsAction())}
          />
        )}
        <div
          className={cn(
            "flex items-center",
            density === "icons" && "justify-center",
          )}
        >
          <button
            onClick={() => dispatch({ type: "toggleAppSettings" })}
            data-helmryth-system-opener
            className={cn(
              "flex min-w-0 items-center rounded-md py-2 text-left hover:bg-raised/50",
              density === "icons" ? "justify-center px-2" : "flex-1 gap-3 px-3",
            )}
            aria-label={density === "icons" ? "System" : undefined}
            title={
              density === "icons"
                ? state.config?.profile?.name?.trim() || "System"
                : undefined
            }
          >
            <InitialsAvatar
              initials={profileInitials(state.config?.profile)}
              size={28}
            />
            <span
              className={cn(
                "truncate text-[14px] text-ink",
                density === "icons" && "hidden",
              )}
            >
              {/* No email fallback: the address is collected as a private,
                  local-only value, and this label sits in the app chrome on
                  every screen, in screenshots and in screen shares. A blank
                  name already has a designed "You" fallback — use it whether
                  or not an email happens to be set. */}
              {state.config?.profile?.name?.trim() || "You"}
            </span>
          </button>
          {density !== "icons" && (
            <SidebarPhoneButton
              density={density}
              onOpen={() => dispatch(phoneSettingsAction())}
            />
          )}
          {density !== "icons" && <UpdateButton />}
          {density !== "icons" && (
            <button
              onClick={() => dispatch({ type: "toggleAppSettings" })}
              data-helmryth-system-opener
              className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
              // At every other density the System launcher is this icon and its
              // only name came from `title`, which is not a reliable accessible
              // name — touch and several screen readers never expose it.
              aria-label="System"
              title="System"
            >
              <Settings size={18} />
            </button>
          )}
        </div>
      </div>

      {menu && (
        <BotContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onArchive={(bot) => void archiveBot(bot)}
          onRequestDelete={(bot, returnFocus) => {
            setPendingDeletion({
              subject: {
                kind: "operator",
                id: bot.id,
                name: bot.name,
                taskCount: bot.tasks?.length ?? 0,
              },
              returnFocus,
            });
          }}
          onMoveToSection={(botId) =>
            setSectionPicker({ botId, x: menu.x, y: menu.y, trigger: menu.trigger })
          }
        />
      )}
      {sectionPicker && (
        <SectionPicker
          current={
            state.bots.find((b) => b.id === sectionPicker.botId)?.section
          }
          anchor={sectionPicker}
          onClose={() => setSectionPicker(null)}
          onAssign={(section) =>
            dispatch({
              type: "updateBot",
              botId: sectionPicker.botId,
              patch: { section },
            })
          }
        />
      )}
      {roomMenu && (
        <RoomContextMenu
          key={roomMenu.groupId}
          menu={roomMenu}
          onClose={() => setRoomMenu(null)}
          onRequestDelete={(group, returnFocus) => {
            setPendingDeletion({
              subject: {
                kind: "crew",
                id: group.id,
                name: group.name,
                taskCount: group.tasks?.length ?? 0,
              },
              returnFocus,
            });
          }}
          onMoveToSection={(groupId) =>
            setRoomSectionPicker({ groupId, x: roomMenu.x, y: roomMenu.y })
          }
        />
      )}
      {roomSectionPicker && (
        <SectionPicker
          current={
            state.groups.find((g) => g.id === roomSectionPicker.groupId)
              ?.section
          }
          anchor={roomSectionPicker}
          onClose={() => setRoomSectionPicker(null)}
          onAssign={(section) =>
            dispatch({
              type: "patchGroup",
              groupId: roomSectionPicker.groupId,
              patch: { section },
            })
          }
        />
      )}
      {newRoom && (
        <NewRoomPanel
          onClose={() => setNewRoom(false)}
          returnFocusRef={importReturnRef}
        />
      )}
      {archivedBotsOpen && (
        <ArchivedBotsPanel
          bots={archivedBots}
          onClose={() => setArchivedBotsOpen(false)}
          onRestored={(message) =>
            setTeamFeedback({ error: false, text: message })
          }
        />
      )}
      {teamLibraryOpen && (
        <TeamLibraryPanel
          returnFocusRef={importReturnRef}
          initialUrl={teamInstallUrl ?? undefined}
          onClose={() => {
            setTeamLibraryOpen(false);
            setTeamInstallUrl(null);
          }}
          onImported={(result) => {
            setTeamLibraryOpen(false);
            setTeamInstallUrl(null);
            setTeamFeedback({
              error: false,
              text: `${result.name} loaded · ${result.members} ${result.members === 1 ? "operator" : "operators"}`,
              undo: result,
            });
          }}
        />
      )}
      {pendingDeletion && (
        <RosterDeletionDialog
          pending={pendingDeletion}
          onCancel={() => setPendingDeletion(null)}
          onDeleted={(subject) => {
            setPendingDeletion(null);
            setTeamFeedback({
              error: false,
              text: `${subject.name} deleted permanently`,
            });
          }}
          onRestoreFocus={(deleted) => {
            const preferred = pendingDeletion.returnFocus;
            if (!deleted && preferred?.isConnected) {
              preferred.focus();
              return;
            }
            const nextRosterItem = Array.from(
              panelRef.current?.querySelectorAll<HTMLElement>("[data-roster-item]") ?? [],
            ).find((item) => item.dataset.rosterId !== pendingDeletion.subject.id);
            (nextRosterItem ?? importReturnRef.current ?? closeButtonRef.current ?? panelRef.current)?.focus();
          }}
        />
      )}
      {createPortal(
        // The region has to outlive its messages. A role="status" node that is
        // inserted together with its text is not announced by most screen
        // readers, so archiving an operator changed the roster count in total
        // silence. Keep one empty region mounted and swap only its text.
        <div role="status" aria-live="polite" className="sr-only">
          {teamFeedback?.text ?? ""}
        </div>,
        document.body,
      )}
      {teamFeedback &&
        createPortal(
          <div
            className={cn(
              // Bottom-CENTRE, not bottom-left: at bottom-left this sat directly on
              // the sidebar's own utility bar, so a click aimed at System landed on
              // Undo and silently reverted the whole crew import. Pointer events are
              // re-enabled only on the toast's content, never on its margin.
              "pointer-events-none fixed bottom-5 left-1/2 z-[60] max-w-[300px] -translate-x-1/2 rounded-xl border px-3.5 py-2.5 text-[13px] shadow-xl [&>*]:pointer-events-auto",
              teamFeedback.error
                ? "border-danger/30 bg-card text-danger"
                : "border-hairline/50 bg-card text-ink",
            )}
          >
            <div className="flex items-center gap-3">
              <span>{teamFeedback.text}</span>
              {pendingTeamUndo && (
                <button
                  onClick={() => void undoTeamLoad(pendingTeamUndo)}
                  className="rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-raised"
                >
                  Undo
                </button>
              )}
              {pendingBotUndo && (
                <button
                  onClick={() => void undoBotArchive(pendingBotUndo)}
                  className="rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-raised"
                >
                  Undo
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
      </div>
    </SidebarShell>
  );
}
