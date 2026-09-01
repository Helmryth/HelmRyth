import { Component, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Folder,
  ListTree,
  Loader2,
  Monitor,
  MessageSquareReply,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  Webhook,
  X,
} from "lucide-react";
import { cachedInput, costCaption, formatTokens, formatUsd, hasFiniteCost, usageChip, usageDetail } from "@/lib/usage";
import {
  useStore,
  useStreaming,
  formatTime,
  messageVersions,
  openNotificationTarget,
  visibleMessages,
  type Bot,
  type InstanceInfo,
  type Message,
} from "@/state/store";
import { EngineSetup } from "./EngineSetup";
import { BotAvatar, SigilAvatar } from "./Avatar";
import { TurnPresence } from "./TurnPresence";
import { showToolCallsEnabled } from "@/lib/feature-flags";
import { stateForBot } from "@/lib/sigil";
import { showWorkingDots } from "@/lib/turn-tail";
import { liveActivityLabel } from "@/lib/live-activity";
import { ChatMarkdown } from "./ChatMarkdown";
import { OptionCard, shouldHideOnboardingCard } from "./OptionCard";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { ChatFindBar } from "./ChatFindBar";
import { ReplyQuote } from "./ReplyQuote";
import { ConnectorCard } from "./ConnectorCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { hasRoutineExecutionTask, RoutineRunCard } from "./RoutineRunCard";
import { AttachedImageGallery } from "./AttachmentPreview";
import { ModelPicker } from "./ModelPicker";
import { RenameTitle } from "./RenameTitle";
import { TaskPicker } from "./TaskPicker";
import { ReactionBar, ReactionChips } from "./Reactions";
import { SpeakButton } from "./SpeakButton";
import { CallButton, CallOverlay } from "./CallView";
import { cn } from "@/lib/cn";
import { COMPACT_BUBBLE, COMPACT_SQUARE } from "@/lib/compact-chip";
import { useFocusMessage } from "@/lib/focus-message";
import { groupActivityRuns } from "@/lib/activity-runs";
import { ActivityRun } from "./ActivityRun";
import { webhookMessageView } from "@/lib/webhook-message";
import { splitAttachedImages } from "@/lib/composer-attachments";
import { BOTTOM_FOLLOW_THRESHOLD, shouldResumeBottomFollow } from "@/lib/bottom-follow";
import { useComposerDockPad } from "@/lib/composer-dock";
import {
  TRANSCRIPT_WINDOW_SIZE,
  expandWindowStart,
  focusWindowRange,
  resolveTranscriptWindow,
  tailWindowStart,
} from "@/lib/transcript-window";
import { timelineEvents } from "@/lib/taskTimeline";
import { useReplyDraft } from "@/lib/drafts";
import { presentRuntimeActivityLabel } from "../../shared/runtime-error";

/** Long user messages collapse behind a fade so pasted walls of text don't
 * bury the conversation; bots get full markdown. */
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;

export interface ClipboardWriter {
  writeText: (text: string) => Promise<void>;
}

export interface ReducedMotionPreference {
  matches: boolean;
}

export async function writeWorkstreamClipboard(
  text: string,
  clipboard: ClipboardWriter | null = globalThis.navigator?.clipboard ?? null,
): Promise<"copied" | "failed"> {
  if (!clipboard) return "failed";
  try {
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}

export function workstreamScrollBehavior(
  preference: ReducedMotionPreference = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")
    ?? { matches: false },
): ScrollBehavior {
  return preference.matches ? "auto" : "smooth";
}

/** Translate raw runtime labels into Helmryth's product language without
 * touching persisted identifiers or user-authored workstream content. */
export function runtimeLabel(label: string): string {
  return presentRuntimeActivityLabel(label)
    .replace(/chief[ _-]of[ _-]staff/gi, "lead operator")
    .replace(/ask[ _-]bot/gi, "consult operator")
    .replace(/delegate[ _-]bot/gi, "delegate to operator")
    .replace(/\bbots\b/gi, "operators")
    .replace(/\bbot\b/gi, "operator")
    .replace(/\bapprovals\b/gi, "gates")
    .replace(/\bapproval\b/gi, "gate")
    .replace(/\btasks\b/gi, "runs")
    .replace(/\btask\b/gi, "run")
    .replace(/\broutines\b/gi, "cadences")
    .replace(/\broutine\b/gi, "cadence")
    .replace(/\bplugins\b/gi, "capabilities")
    .replace(/\bplugin\b/gi, "capability")
    .replace(/\bcomputer\b/gi, "workbench")
    .replace(/\binspector\b/gi, "trace")
    .replace(/_/g, " ");
}

/** The compact masthead keeps a stable visible prefix and exposes the full
 * current context to assistive technology even when a very long user title is
 * visually clipped. */
export interface WorkstreamContextLabel {
  visible: string;
  accessible: string;
}

export function workstreamContextLabel(title?: string): WorkstreamContextLabel {
  const normalized = runtimeLabel(title ?? "Untitled workstream");
  return {
    visible: `Workstream · ${normalized}`,
    accessible: `Current workstream: ${normalized}`,
  };
}

/** Primary icon actions are 44px on touch-sized layouts and retain the
 * established compact desktop geometry at md and above. */
export const MOBILE_PRIMARY_ACTION_CLASS =
  "flex size-11 items-center justify-center rounded-sm hover:bg-raised md:size-auto md:p-2";

/** The operator name in the workstream header is a control — it opens the
 * profile. At 15px on a 1.5 line box it measured 39x23 CSS px, one pixel under
 * the WCAG 2.5.8 target floor, so the height is pinned rather than inherited. */
export const WORKSTREAM_TITLE_CLASS =
  "inline-block min-h-6 truncate text-[15px] font-semibold text-ink";

/** "Today" / "Yesterday" / "Mon, Aug 11" — real dates, not a hardcoded label. */
function dayLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function DaySeparator({ at }: { at: number }) {
  return (
    <div className="flex items-center gap-3 py-4" role="separator" aria-label={`Entries from ${dayLabel(at)}`}>
      <span className="h-px flex-1 bg-hairline/70" aria-hidden="true" />
      <time
        dateTime={new Date(at).toISOString()}
        className="shrink-0 text-[11px] font-semibold tracking-[0.075em] text-ink-secondary uppercase"
      >
        {dayLabel(at)} · {formatTime(at)}
      </time>
      <span className="h-px flex-1 bg-hairline/70" aria-hidden="true" />
    </div>
  );
}

function RunLedger({ messages, busy }: { messages: Message[]; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const events = useMemo(() => timelineEvents(messages), [messages]);
  if (events.length === 0) return null;
  const recent = events.slice(-8);
  return (
    <section className="w-full border-y border-hairline/60 bg-panel/60 px-5" aria-label="Run ledger">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex min-h-10 w-full items-center justify-between gap-3 px-1 text-left text-[12.5px] text-ink-secondary hover:text-ink"
      >
        <span className="flex items-center gap-2">
          <ListTree size={14} aria-hidden="true" />
          <span className="font-semibold tracking-[0.055em] uppercase">Run ledger</span>
          <span className="font-normal tracking-normal normal-case">{recent.length} recorded steps</span>
          {busy ? <span className="text-accent-text">· live</span> : null}
        </span>
        <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ol className="border-t border-hairline/50 pb-2">
          {recent.map((event) => (
            <li key={event.id} className="grid grid-cols-[80px_minmax(0,1fr)_auto] items-center gap-3 border-b border-hairline/35 py-2 text-[12px] text-ink-secondary last:border-b-0">
              <span
                className={cn(
                  "inline-flex w-fit items-center gap-1.5 font-semibold",
                  event.state === "failed"
                    ? "text-danger"
                    : event.state === "complete"
                      ? "text-success"
                      : event.state === "running"
                        ? "text-accent-text"
                        : "text-ink-secondary",
                )}
              >
                <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
                {event.state}
              </span>
              <span className="truncate">{event.label}</span>
              <time className="ml-auto shrink-0 text-[11px] text-ink-secondary/70">{formatTime(event.at)}</time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Hover/focus-revealed copy control shared by workstream entries. */
function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);
  const copy = async () => {
    const result = await writeWorkstreamClipboard(text);
    if (!mounted.current) return;
    setCopyState(result);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopyState("idle"), 1_600);
  };
  return (
    <>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copyState === "copied" ? "Entry copied" : copyState === "failed" ? "Entry could not be copied" : "Copy entry"}
        title={copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy entry"}
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-md text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100",
          className,
        )}
      >
        {copyState === "copied" ? <Check size={14} className="text-success" /> : <Copy size={14} />}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {copyState === "copied"
          ? "Entry copied to clipboard."
          : copyState === "failed"
            ? "Entry could not be copied. Check clipboard permissions."
            : ""}
      </span>
    </>
  );
}

/** A failed turn: a real error block with a retry, not a truncated pill.
 *
 * A `setup` error — CLI missing, or installed but not signed in — shows what
 * to do instead of a Retry, because retrying hits the same wall every time.
 * Once the engine reports itself fixed the card flips back to Retry, which
 * (with the on-focus re-probe) happens by itself when the user returns from
 * the terminal. */
function ErrorRow({
  message,
  onRetry,
  setupInstance,
}: {
  message: string;
  onRetry?: () => void;
  setupInstance?: InstanceInfo;
}) {
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[min(48rem,88%)] border-l-2 border-danger bg-danger/10 px-4 py-3 text-[13.5px] text-ink" role="alert">
        <div className="mb-1 text-[11px] font-semibold tracking-[0.075em] text-danger uppercase">Run interrupted</div>
        <div className="flex items-start gap-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
          <span className="min-w-0 break-words">{runtimeLabel(message)}</span>
        </div>
        {setupInstance &&
        !(setupInstance.snapshot.state === "available" && setupInstance.snapshot.authenticated !== false) ? (
          <EngineSetup instance={setupInstance} className="mt-2 text-ink-secondary" />
        ) : (
          onRetry && (
            <button
              onClick={onRetry}
              className="mt-2 flex min-h-9 items-center gap-1.5 rounded-sm border border-danger/50 bg-raised px-3 py-1 text-[12.5px] font-medium text-danger hover:bg-danger/10"
            >
              <RefreshCw size={12} aria-hidden="true" /> Try run again
            </button>
          )
        )}
      </div>
    </div>
  );
}

/** One bad markdown node must not white-screen the app — the transcript
 * degrades to a plain-text record instead. */
class MessageBoundary extends Component<{ children: ReactNode; fallbackText: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="w-full max-w-[min(48rem,88%)] border-l-2 border-warning bg-warning/10 px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap text-ink">
          <div className="mb-1 text-[11px] font-semibold tracking-[0.075em] text-warning uppercase">Plain-text recovery</div>
          {this.props.fallbackText}
        </div>
      );
    }
    return this.props.children;
  }
}

/** Inline editor for a user's record entry. */
export function BubbleEditor({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = () => {
    if (draft.trim()) onSubmit(draft.trim());
  };
  return (
    <div className="w-full max-w-[min(48rem,88%)] border-l-2 border-accent bg-raised-hover/50 px-4 py-3">
      <label htmlFor="workstream-entry-editor" className="mb-2 block text-[11px] font-semibold tracking-[0.075em] text-accent-text uppercase">
        Revise your entry
      </label>
      <textarea
        id="workstream-entry-editor"
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // isComposing: an IME confirm-Enter must not submit the edit
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") onCancel();
        }}
        rows={Math.min(10, Math.max(2, draft.split("\n").length))}
        aria-describedby="workstream-entry-editor-hint"
        className="w-full resize-none rounded-sm border border-transparent bg-transparent px-1 text-[15px] leading-relaxed text-ink outline-none focus:border-accent focus:ring-2 focus:ring-focus"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span id="workstream-entry-editor-hint" className="text-[11px] text-ink-secondary">
          Enter commits · Shift+Enter adds a line · Esc keeps the original
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="min-h-9 rounded-sm px-3 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            Keep original
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim()}
            className="min-h-9 rounded-sm bg-accent px-3 py-1 text-[13px] font-medium text-[var(--color-accent-ink)] hover:bg-accent/90 disabled:opacity-40"
          >
            Commit revision
          </button>
        </div>
      </div>
    </div>
  );
}

function Bubble({
  bot,
  message,
  editing,
  isLastBotText,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  replyTarget,
  onReply,
}: {
  bot: Bot;
  message: Message;
  editing: boolean;
  isLastBotText: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (text: string) => void;
  onRegenerate?: () => void;
  replyTarget?: Message;
  onReply: () => void;
}) {
  const { dispatch } = useStore();
  const user = message.role === "user";
  const [expanded, setExpanded] = useState(false);
  const text = message.text ?? "";
  const webhookView = user ? webhookMessageView(text) : null;
  const attachedImages = user && !webhookView ? splitAttachedImages(text) : null;
  const visibleText = webhookView?.task ?? attachedImages?.display ?? text;
  const collapsible =
    user && !webhookView && !expanded && (visibleText.length > USER_COLLAPSE_CHARS || visibleText.split("\n").length > USER_COLLAPSE_LINES);

  if (user && editing && !webhookView) {
    return (
      <div className="flex w-full justify-end">
        <BubbleEditor initial={text} onCancel={onCancelEdit} onSubmit={onSubmitEdit} />
      </div>
    );
  }

  // "‹ 2/3 ›" under an edited message — every fork it belongs to
  const versions = user ? messageVersions(bot, message) : [message];
  const versionIndex = versions.findIndex((v) => v.id === message.id);
  const switchTo = (v: Message | undefined) => {
    if (v && !bot.busy) dispatch({ type: "switchBranch", botId: bot.id, messageId: v.id });
  };

  return (
    <div className={cn("group flex w-full flex-col", user ? "animate-msg-in items-end" : "items-start")}>
      <div className={cn("flex w-full min-w-0 items-start gap-2", user ? "justify-end" : "justify-start")}>
        {!user && (
          <span className="shrink-0 pt-1" aria-hidden="true">
            <BotAvatar bot={bot} state="idle" size={24} motion="none" motionKey={0} />
          </span>
        )}
        <div
          className={cn(
            "flex min-w-0 flex-1 flex-col gap-1 sm:flex-initial sm:max-w-[min(48rem,88%)] sm:items-center sm:gap-1.5",
            user ? "items-end sm:flex-row-reverse" : "items-start sm:flex-row",
          )}
        >
        <article
          className={cn(
            "min-w-0 w-full text-[15px] leading-relaxed sm:w-fit",
            user && webhookView
              ? "overflow-hidden border-l-2 border-accent bg-panel text-ink"
              : user
                ? "border-l-2 border-accent bg-raised-hover/45 px-4 py-3 whitespace-pre-wrap text-ink"
                : "border-l border-hairline bg-transparent px-4 py-3 text-ink",
          )}
          aria-label={user ? "Your workstream entry" : `${bot.name}, operator record`}
          title={new Date(message.at).toLocaleString()}
        >
          {!webhookView && (
            <div className={cn(
              "mb-1.5 text-[11px] font-semibold tracking-[0.075em] uppercase",
              user ? "text-accent-text" : "text-ink-secondary",
            )}>
              {user ? "Your direction" : `${bot.name} · operator record`}
            </div>
          )}
          {replyTarget && (
            <div className="mb-2">
              <ReplyQuote
                message={replyTarget}
                fallbackName={bot.name}
                compact
                onJump={() =>
                  dispatch({ type: "focusMessage", threadId: bot.threadId, messageId: replyTarget.id })
                }
              />
            </div>
          )}
          {user && webhookView ? (
            <div className="min-w-0 w-full max-w-[520px] sm:min-w-[300px]">
              <div className="flex items-center gap-2 border-b border-accent/15 bg-accent/[0.055] px-4 py-2.5 text-[11.5px] font-medium text-accent">
                <Webhook size={13} />
                <span className="tracking-[0.055em] uppercase">Inbound run</span>
              </div>
              <div className="px-4 py-3 whitespace-pre-wrap">{webhookView.task}</div>
              {webhookView.payload && (
                <details className="border-t border-hairline/30 bg-inset/25 px-4 py-2.5 text-[11.5px] text-ink-secondary">
                  <summary className="cursor-pointer select-none hover:text-ink">Inspect event record</summary>
                  <pre className="mt-2 max-h-48 overflow-auto rounded-sm border border-hairline/60 bg-inset p-3 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-secondary">{webhookView.payload}</pre>
                </details>
              )}
            </div>
          ) : user ? (
            <>
              {attachedImages && attachedImages.images.length > 0 && (
                <AttachedImageGallery paths={attachedImages.images} />
              )}
              <div
                className={cn(collapsible && "max-h-40 overflow-hidden border-b border-hairline/70 pb-2")}
              >
                {visibleText}
              </div>
              {message.steered && (
                <div className="mt-1 text-[11px] text-ink-secondary/70" title="Added while the operator was working; this direction entered the same active run.">
                  steered into active run
                </div>
              )}
              {collapsible && (
                <button onClick={() => setExpanded(true)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  Show full entry
                </button>
              )}
              {expanded && (
                <button onClick={() => setExpanded(false)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  Show less
                </button>
              )}
            </>
          ) : (
            <MessageBoundary fallbackText={text}>
              <ChatMarkdown text={text} />
            </MessageBoundary>
          )}
        </article>
          <div
            className={cn(
              "flex min-w-0 max-w-full flex-wrap items-center gap-1 max-sm:w-full",
              user ? "justify-end" : "justify-start",
            )}
            aria-label={user ? "Entry actions" : `${bot.name} record actions`}
          >
            {/* Editing rewinds the workstream, so it waits for the active run to finish. */}
            {user && message.kind === "text" && !webhookView && !bot.busy && (
              <button
                type="button"
                onClick={onStartEdit}
                data-edit-trigger={message.id}
                aria-label="Revise entry"
                className="flex size-9 shrink-0 items-center justify-center rounded-md text-ink-secondary opacity-100 transition-opacity hover:bg-raised hover:text-ink sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100"
                title="Revise entry"
              >
                <Pencil size={14} aria-hidden="true" />
              </button>
            )}
            {message.kind === "text" && <ReactionBar threadId={bot.threadId} message={message} />}
            <CopyButton
              text={user ? visibleText : text}
              className="flex size-9 shrink-0 items-center justify-center p-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100"
            />
            {!user && message.kind === "text" && (
              <SpeakButton text={text} botId={bot.id} messageId={message.id} voiceId={bot.voice} />
            )}
            {!user && isLastBotText && !bot.busy && onRegenerate && (
              <button
                type="button"
                onClick={onRegenerate}
                aria-label="Run again from this point"
                title="Run again from this point"
                className="flex size-9 shrink-0 items-center justify-center rounded-md text-ink-secondary opacity-100 transition-opacity hover:bg-raised hover:text-ink sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100"
              >
                <RefreshCw size={14} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              onClick={onReply}
              aria-label="Respond to entry"
              className="flex size-9 shrink-0 items-center justify-center rounded-md text-ink-secondary opacity-100 transition-opacity hover:bg-raised hover:text-ink sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100"
              title="Respond to entry"
            >
              <MessageSquareReply size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() =>
                dispatch({
                  type: "updateBot",
                  botId: bot.id,
                  patch: { pinnedMessageId: bot.pinnedMessageId === message.id ? "" : message.id },
                })
              }
              aria-label={bot.pinnedMessageId === message.id ? "Unpin entry" : "Pin entry"}
              className="flex size-9 shrink-0 items-center justify-center rounded-md text-ink-secondary opacity-100 transition-opacity hover:bg-raised hover:text-ink sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100"
              title={
                bot.pinnedMessageId === message.id
                  ? "Remove this entry from the workstream header"
                  : "Pin this entry to the workstream header"
              }
            >
              {bot.pinnedMessageId === message.id ? (
                <PinOff size={14} aria-hidden="true" />
              ) : (
                <Pin size={14} aria-hidden="true" />
              )}
            </button>
            <time className="px-1 text-[11px] tabular-nums text-ink-secondary" dateTime={new Date(message.at).toISOString()}>
              {formatTime(message.at)}
            </time>
          </div>
        </div>
      </div>
      {/* busy-gated so a flag stranded by a server restart shows nothing */}
      {user && message.queued && bot.busy && (
        <div className="mt-1 flex items-center gap-1 pr-1 text-[11px] text-ink-secondary/70">
          <Clock size={11} aria-hidden="true" />
          <span>Queued · begins after the active run</span>
          <button
            type="button"
            onClick={() => dispatch({ type: "cancelQueued", botId: bot.id, queueId: message.queueId ?? message.id })}
            aria-label="Remove queued direction"
            title="Remove queued direction"
            className="ml-0.5 flex size-9 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={11} strokeWidth={2.5} />
          </button>
        </div>
      )}
      <ReactionChips threadId={bot.threadId} message={message} align={user ? "right" : "left"} />
      {versions.length > 1 && (
        <div className="mt-1 flex items-center gap-0.5 pr-1 text-[12px] text-ink-secondary">
          <button
            onClick={() => switchTo(versions[versionIndex - 1])}
            disabled={versionIndex <= 0 || bot.busy}
            className="flex size-9 items-center justify-center rounded hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Previous revision"
            title="Previous revision"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="tabular-nums">
            {versionIndex + 1}/{versions.length}
          </span>
          <button
            onClick={() => switchTo(versions[versionIndex + 1])}
            disabled={versionIndex >= versions.length - 1 || bot.busy}
            className="flex size-9 items-center justify-center rounded hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Next revision"
            title="Next revision"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/** A capability record with an explicit, non-color-only state. */
function ActivityChip({ message }: { message: Message }) {
  const { dispatch } = useStore();
  const tool = message.tool;
  if (!tool) return null;
  // Operator-to-operator coordination opens the crew workstream it belongs to.
  const comm = message.comm;
  if (comm) {
    return (
      <div className="flex justify-start">
        <button
          onClick={() => dispatch({ type: "select", id: comm.groupId })}
          title={`Open ${comm.withName}'s crew workstream`}
          className="flex min-h-10 max-w-[min(48rem,88%)] items-center gap-3 border-l-2 bg-panel px-3 py-2 text-left text-[13px] text-ink-secondary [border-color:var(--color-signal,var(--color-accent))] hover:bg-raised hover:text-ink"
        >
          <SigilAvatar color={comm.withColor} state="idle" size={18} label={`${comm.withName}, operator`} />
          <span className="min-w-0">
            <span className="block text-[10.5px] font-semibold tracking-[0.075em] uppercase [color:var(--color-signal,var(--color-accent-text))]">Operator handoff</span>
            <span className="block max-w-[480px] truncate">{runtimeLabel(tool.name)}</span>
          </span>
          <ChevronRight size={13} className="ml-auto shrink-0" aria-hidden="true" />
        </button>
      </div>
    );
  }
  const failed = tool.ok === false;
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "grid min-h-10 max-w-[min(48rem,88%)] grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 border-l-2 bg-panel px-3 py-2 text-[13px]",
          failed ? "border-danger" : tool.ok === undefined ? "border-accent" : "border-success",
          failed ? "text-danger" : "text-ink-secondary",
        )}
        role={tool.ok === undefined ? "status" : undefined}
        aria-label={`${tool.ok === undefined ? "Capability running" : failed ? "Capability failed" : "Capability complete"}: ${runtimeLabel(tool.name)}`}
      >
        {tool.ok === undefined ? (
          <Loader2 size={13} className="animate-spin motion-reduce:animate-none" />
        ) : failed ? (
          <X size={13} />
        ) : (
          <Check size={13} className="text-success" />
        )}
        <span className="min-w-0">
          <span className="block text-[10.5px] font-semibold tracking-[0.075em] uppercase">
            {tool.ok === undefined ? "Capability running" : failed ? "Capability failed" : "Capability complete"}
          </span>
          <span className="block max-w-[480px] truncate">{runtimeLabel(tool.name)}</span>
        </span>
      </div>
    </div>
  );
}

function ScreenFrame({ png, mime }: { png: string; mime?: string }) {
  return (
    <div className="flex justify-start">
      <img
        src={`data:${mime ?? "image/png"};base64,${png}`}
        alt="Operator workbench capture"
        className="w-fit max-w-[min(48rem,88%)] rounded-sm border border-hairline"
      />
    </div>
  );
}

/** The settled transcript, memoized as one unit: during streaming every
 * frame re-renders ChatView, but all of these props keep their identity
 * (bot/messages only change on real message events), so the whole list —
 * every markdown tree, every code block — bails out of React work and only
 * the streaming tail below it commits. This is the t3code structural-sharing
 * idea at component granularity. */
const MessagesList = memo(function MessagesList({
  bot,
  messages,
  transcript,
  editingId,
  lastBotTextId,
  emergingId,
  canRetryLast,
  engine,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  onReply,
}: {
  bot: Bot;
  messages: Message[];
  /** Active-branch messages, including ones outside the mounted window. */
  transcript: Message[];
  editingId: string | null;
  lastBotTextId: string | undefined;
  emergingId?: string | null;
  canRetryLast: boolean;
  /** This bot's engine, for rendering setup help on a `setup` error. */
  engine: InstanceInfo | undefined;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (id: string, text: string) => void;
  onRegenerate: () => void;
  onReply: (message: Message) => void;
}) {
  const { state, dispatch } = useStore();
  const showToolCalls = showToolCallsEnabled(state.config);
  // Fold finished tool chips into runs, so a stretch of them cannot bury
  // what the bot actually said. Hidden unless Settings → Tool calls is on.
  const items = useMemo(() => groupActivityRuns(messages), [messages]);
  // A search hit inside a folded run has to open it: the fold keeps the
  // row out of the DOM, and there is nothing for the scroll to land on.
  const focus = state.focusMessage;
  const focusedId = focus && !focus.consumed && focus.threadId === bot.threadId ? focus.messageId : null;
  return (
    <>
      {messages.length === 0 && !bot.busy && (
        <section className="mx-auto flex w-full max-w-[44rem] flex-1 flex-col justify-center py-20" aria-label="Empty workstream">
          <div className="flex items-start gap-4 border-y border-hairline py-6">
            <BotAvatar bot={bot} state="idle" size={52} motion="none" motionKey={0} />
            <div className="min-w-0 flex-1">
              <div className="mb-1 text-[11px] font-semibold tracking-[0.075em] text-accent-text uppercase">Workstream ready</div>
              <RenameTitle
                value={bot.name}
                onCommit={(name) => dispatch({ type: "updateBot", botId: bot.id, patch: { name } })}
                className="text-[19px] font-semibold text-ink"
                inputClassName="rounded-sm bg-inset px-1.5 py-0.5 text-[19px] font-semibold"
              />
              <p className="mt-2 max-w-[38rem] text-[14px] leading-relaxed text-ink-secondary">
                {bot.description || `${bot.name} is standing by to own a concrete outcome, report decisions, and surface every gate.`}
              </p>
            </div>
          </div>
          <div className="grid gap-2 border-b border-hairline py-5 sm:grid-cols-[9rem_1fr]">
            <span className="text-[11px] font-semibold tracking-[0.075em] text-ink-secondary uppercase">First direction</span>
            <p className="text-[14px] leading-relaxed text-ink">
              State the outcome and boundaries below. For example: “Audit this release and flag every deployment risk.”
            </p>
          </div>
        </section>
      )}
      {items.map((item, i) => {
        const previous = items[i - 1];
        const prev = previous && (previous.kind === "run" ? previous.messages.at(-1) : previous.message);
        const first = item.kind === "run" ? item.messages[0] : item.message;
        const newDay = !prev || new Date(prev.at).toDateString() !== new Date(first.at).toDateString();
        if (item.kind === "run") {
          if (!showToolCalls) return null;
          return (
            <div key={item.id} className="contents">
              {newDay && <DaySeparator at={first.at} />}
              <ActivityRun messages={item.messages} forceOpen={item.messages.some((step) => step.id === focusedId)}>
                {item.messages.map((step) => (
                  <div key={step.id} className="contents" data-mid={step.id}>
                    <ActivityChip message={step} />
                  </div>
                ))}
              </ActivityRun>
            </div>
          );
        }
        const m = item.message;
        if (m.id === emergingId) return null;
        const row = (() => {
          switch (m.kind) {
            case "secret":
              return m.secret ? <SecretRequestCard botId={bot.id} threadId={bot.threadId} message={m} /> : null;
            case "connector":
              return m.connector ? <ConnectorCard botId={bot.id} threadId={bot.threadId} message={m} /> : null;
            case "options":
              // a live permission ask gets the approval box; questions keep
              // the list card. The first-run quiz drops out once they talk.
              if (m.card?.requestId && m.card.tool) {
                return <ApprovalCard bot={bot} message={m} />;
              }
              if (shouldHideOnboardingCard(m, transcript)) return null;
              return <OptionCard botId={bot.id} message={m} />;
            case "routine.run": {
              const executionThreadId = m.routineRun?.executionThreadId;
              const canOpen = hasRoutineExecutionTask(bot.tasks, executionThreadId);
              return (
                <RoutineRunCard
                  message={m}
                  onOpen={canOpen
                    ? () => openNotificationTarget(
                        dispatch,
                        { botId: bot.id, threadId: executionThreadId },
                        state,
                      )
                    : undefined}
                />
              );
            }
            case "activity": {
              // a failed turn is an error, not a tool run — render it as one.
              // bot⇄bot comm chips stay because they link to another conversation.
              // plain tool runs stay out unless Settings → Tool calls is on.
              if (m.tool?.name.startsWith("error:")) {
                const errorLabel = presentRuntimeActivityLabel(
                  m.tool.name,
                  m.tool.setup,
                  m.tool.runtimeError,
                );
                return (
                  <ErrorRow
                    message={errorLabel.slice(6).trim()}
                    onRetry={m.id === messages.at(-1)?.id && canRetryLast ? onRegenerate : undefined}
                    setupInstance={m.tool.setup ? engine : undefined}
                  />
                );
              }
              if (!showToolCalls && !m.comm) return null;
              return <ActivityChip message={m} />;
            }
            case "screen":
              return m.png ? <ScreenFrame png={m.png} mime={m.mime} /> : null;
            default:
              return (
                <Bubble
                  bot={bot}
                  message={m}
                  editing={editingId === m.id}
                  isLastBotText={m.id === lastBotTextId}
                  onStartEdit={() => onStartEdit(m.id)}
                  onCancelEdit={onCancelEdit}
                  onSubmitEdit={(text) => onSubmitEdit(m.id, text)}
                  onRegenerate={onRegenerate}
                  replyTarget={m.replyToId ? bot.messages.find((candidate) => candidate.id === m.replyToId) : undefined}
                  onReply={() => onReply(m)}
                />
              );
          }
        })();
        if (!row) return null;
        return (
          <div key={m.id} className="contents" data-mid={m.id}>
            {newDay && <DaySeparator at={m.at} />}
            {row}
          </div>
        );
      })}
    </>
  );
});

/** The one pinned entry, above the workstream: sender, one line, click to
 * jump, X to unpin. Resolves the pin id against the full message list; a
 * pin that no longer resolves renders nothing (edited away or deleted). */
function PinnedBanner({
  bot,
  pinnedId,
  messages,
  onJump,
  onUnpin,
}: {
  bot: Bot;
  pinnedId?: string;
  messages: Message[];
  onJump: (messageId: string) => void;
  onUnpin: () => void;
}) {
  const pinned = messages.find((m) => m.id === pinnedId);
  if (!pinned || pinned.kind !== "text") return null;
  const sender =
    pinned.role === "user" ? "You" : (pinned.from?.name ?? bot.name);
  const text = (pinned.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return (
    <aside className="w-full border-b border-hairline/60 bg-panel/55 px-5" aria-label="Pinned workstream entry">
      <div className="mx-auto flex min-h-10 max-w-[64rem] items-center gap-3">
        <span className="flex shrink-0 items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.075em] text-accent-text uppercase">
          <Pin size={12} aria-hidden="true" /> Pinned record
        </span>
        <button
          onClick={() => onJump(pinned.id)}
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
          title="Jump to the pinned entry"
        >
          <span className="shrink-0 text-[11.5px] font-medium text-accent-text">{sender}</span>
          <span className="truncate text-[12.5px] text-ink-secondary">{text}</span>
        </button>
        <button
          onClick={onUnpin}
          aria-label="Unpin entry"
          title="Unpin entry"
          className="shrink-0 rounded-sm p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={13} />
        </button>
      </div>
    </aside>
  );
}

export function ChatView({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerDock = useComposerDockPad(composerDockRef);

  const stream = useStreaming();
  const streaming = stream.streaming[bot.threadId];
  const reasoning = stream.reasoning[bot.threadId];
  const provisioning = state.provisioning[bot.id];
  const sigilMotion = state.sigilMotion?.botId === bot.id ? state.sigilMotion : null;
  const [findOpen, setFindOpen] = useState(false);
  const findTriggerRef = useRef<HTMLButtonElement>(null);
  const editReturnFocus = useRef<string | null>(null);
  const { replyTo, selectReply, clearReply, consumeReply, restoreReply } = useReplyDraft(
    bot.threadId,
    `bot:${bot.id}:${bot.threadId}`,
    bot.messages,
  );
  useEffect(() => setFindOpen(false), [bot.threadId]);
  useEffect(() => {
    const onFind = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, []);

  // only the active branch is rendered; forks stay reachable via ‹ › nav
  const messages = useMemo(() => visibleMessages(bot), [bot]);

  // Windowed transcript: only a tail of the thread mounts (screenshots make
  // full threads DOM-heavy). The boundary is anchored per bot+task; a
  // render-phase reset re-tails it on switch so the old thread's boundary
  // never flashes into the new one. Everything derived below (lastBotTextId,
  // lastUserMessage, working dots) stays computed from the FULL list.
  const transcriptKey = `${bot.id}:${bot.threadId}`;
  const [transcriptWindow, setTranscriptWindow] = useState<{
    key: string;
    start: number;
    end: number | null;
  }>(() => ({
    key: transcriptKey,
    start: tailWindowStart(messages.length),
    end: null,
  }));
  if (transcriptWindow.key !== transcriptKey) {
    setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(messages.length), end: null });
  }
  const {
    visible: windowedMessages,
    hiddenCount,
    laterCount,
    startIndex,
    endIndex,
  } = useMemo(
    () => resolveTranscriptWindow(messages, transcriptWindow.start, TRANSCRIPT_WINDOW_SIZE, transcriptWindow.end),
    [messages, transcriptWindow.start, transcriptWindow.end],
  );

  const lastBotTextId = useMemo(
    () => [...messages].reverse().find((m) => m.role === "bot" && m.kind === "text")?.id,
    [messages],
  );

  // one message at a time may be in edit mode
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => setEditingId(null), [bot.id, bot.threadId]);
  // stable handler identities — MessagesList is memo'd on them
  const restoreEditFocus = useCallback(() => {
    const target = editReturnFocus.current;
    editReturnFocus.current = null;
    requestAnimationFrame(() => {
      if (!target) return;
      for (const trigger of document.querySelectorAll<HTMLButtonElement>("[data-edit-trigger]")) {
        if (trigger.dataset.editTrigger === target) {
          trigger.focus();
          break;
        }
      }
    });
  }, []);
  const startEdit = useCallback((id: string) => {
    editReturnFocus.current = id;
    setEditingId(id);
  }, []);
  const cancelEdit = useCallback(() => {
    setEditingId(null);
    restoreEditFocus();
  }, [restoreEditFocus]);
  const submitEdit = useCallback(
    (messageId: string, text: string) => {
      setEditingId(null); // closes the editor first — a double Enter can't fork twice
      dispatch({ type: "editMessage", botId: bot.id, messageId, text });
      restoreEditFocus();
    },
    [bot.id, dispatch, restoreEditFocus],
  );
  const lastUserMessage = useMemo(
    () => [...messages].reverse().find((m) => m.role === "user" && m.kind === "text"),
    [messages],
  );

  // Sigil while the turn works. Streaming stays invisible — when the reply
  // is finished, the whole bubble pops in above the sigil.
  const lastMessage = messages.at(-1);
  const toolInFlight = lastMessage?.kind === "activity" && lastMessage.tool?.ok === undefined;
  const activityLabel = runtimeLabel(liveActivityLabel(lastMessage));
  const waiting = Boolean(
    bot.busy &&
      bot.activity !== "waiting-on-you" &&
      showWorkingDots(bot.busy, undefined, lastMessage),
  );
  const wasWaiting = useRef(false);
  const [popping, setPopping] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => {
    wasWaiting.current = false;
    setPopping(null);
  }, [bot.id]);
  useEffect(() => {
    if (waiting) wasWaiting.current = true;
  }, [waiting]);
  useEffect(() => {
    if (lastMessage?.role !== "bot" || lastMessage.kind !== "text" || !wasWaiting.current) return;
    wasWaiting.current = false;
    if (workstreamScrollBehavior() === "auto") {
      setPopping(null);
      return;
    }
    setPopping({ id: lastMessage.id, text: lastMessage.text ?? "" });
    const timer = setTimeout(() => setPopping(null), 520);
    return () => clearTimeout(timer);
  }, [lastMessage?.id, lastMessage?.role, lastMessage?.kind, lastMessage?.text]);
  const presenceVisible = waiting || popping !== null;

  // regenerate = fork the last user message with the same text — reuses the
  // existing branch machinery, so the old answer stays reachable via ‹ ›
  const regenerate = useCallback(() => {
    if (lastUserMessage?.text && !bot.busy) {
      dispatch({ type: "editMessage", botId: bot.id, messageId: lastUserMessage.id, text: lastUserMessage.text });
    }
  }, [lastUserMessage, bot.busy, bot.id, dispatch]);

  // Scroll pinning: follow the bottom while the user hasn't scrolled away.
  // Follow breaks ONLY on an upward user gesture (wheel/touch), never on
  // scroll position checks — streamed content growth flickers "at bottom"
  // false for a frame, and breaking there kills follow permanently
  // (upstream-verified failure). Scrolling back to the end re-arms it.
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  const previousScrollTop = useRef(0);
  const touchY = useRef(0);

  const setBottomFollow = useCallback((next: boolean) => {
    followRef.current = next;
    setFollow(next);
  }, []);

  useEffect(() => setBottomFollow(true), [bot.id, setBottomFollow]);

  // A search result may be hundreds of rows before the mounted tail. Open a
  // bounded window around it first; useFocusMessage then scrolls and flashes
  // the row after React commits that window.
  const appliedFocus = useRef<number | null>(null);
  useEffect(() => {
    const focus = state.focusMessage;
    if (!focus || focus.consumed || focus.threadId !== bot.threadId || appliedFocus.current === focus.nonce) return;
    const targetIndex = messages.findIndex((message) => message.id === focus.messageId);
    if (targetIndex < 0) return;
    appliedFocus.current = focus.nonce;
    const range = focusWindowRange(messages.length, targetIndex);
    setBottomFollow(false);
    setTranscriptWindow({ key: transcriptKey, start: range.start, end: range.end });
  }, [bot.threadId, messages, setBottomFollow, state.focusMessage, transcriptKey]);
  useFocusMessage(bot.threadId, messages.length > 0);

  // deps track the FULL messages.length, so expanding the window (which only
  // changes windowedMessages) can never re-trigger this bottom scrollTo.
  // `follow` is intentionally omitted: flipping it true used to yank the
  // viewport to the end. Re-pinning only arms future content; Jump to latest
  // and this effect on new rows do the scrolling.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    el.scrollTo({ top: el.scrollHeight });
    previousScrollTop.current = el.scrollTop;
  }, [bot.id, messages.length, streaming, reasoning, bot.busy, composerDock.pad]);

  // Expanding prepends rows: capture the height first, then after the commit
  // shift scrollTop by the growth so the message under the cursor stays put
  // (browser scroll anchoring is disabled on this container).
  const preExpandHeight = useRef<number | null>(null);
  const showEarlier = () => {
    preExpandHeight.current = scrollRef.current?.scrollHeight ?? null;
    // expanding means reading scrollback — never let a mid-expand stream
    // event pin the viewport back to the bottom
    setBottomFollow(false);
    const start = expandWindowStart(startIndex);
    setTranscriptWindow((w) => ({ ...w, start }));
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (preExpandHeight.current === null || !el) return;
    el.scrollTop += el.scrollHeight - preExpandHeight.current;
    preExpandHeight.current = null;
    // keep the resume-follow heuristic from reading the restore as a
    // downward user scroll
    previousScrollTop.current = el.scrollTop;
  }, [transcriptWindow.start]);

  const showLater = () => {
    setBottomFollow(false);
    const nextEnd = Math.min(messages.length, endIndex + TRANSCRIPT_WINDOW_SIZE);
    setTranscriptWindow((w) => ({ ...w, end: nextEnd >= messages.length ? null : nextEnd }));
  };

  // keyboard is a scroll gesture too (upstream lesson): PageUp/Home break
  // follow like an upward wheel; the at-end onScroll check re-arms it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "PageUp" || (e.key === "Home" && !(e.target instanceof HTMLTextAreaElement))) {
        setBottomFollow(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setBottomFollow]);

  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_FOLLOW_THRESHOLD;
  };
  const jumpToLatest = () => {
    setBottomFollow(true);
    setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(messages.length), end: null });
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: workstreamScrollBehavior(),
      });
    });
  };
  const activeWorkstream = bot.tasks?.find((task) => task.threadId === bot.threadId);
  const workstreamContext = workstreamContextLabel(activeWorkstream?.title);

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app" aria-label={`${bot.name} workstream`}>
      {/* Call mode covers the workstream while the operator is on the line */}
      <CallOverlay bot={bot} />
      <header
        className={cn(
          // @container so the chips on the right can fold to icon bubbles
          // when the column is narrow (side panel open, small window)
          "@container/chathead flex min-h-[68px] flex-col items-stretch justify-center gap-1.5 border-b border-hairline/70 bg-panel/65 px-2 py-2 md:flex-row md:items-center md:justify-between md:gap-0 md:px-5 md:py-2.5",
        )}
      >
        <div className="flex min-h-11 min-w-0 items-center gap-2 pl-14 pr-1 md:min-h-0 md:gap-3 md:px-1 md:py-1">
          <button
            onClick={() => dispatch({ type: "toggleSettings", open: true })}
            className="flex size-11 shrink-0 items-center justify-center rounded-sm border border-transparent hover:border-hairline hover:bg-raised/70 md:size-10"
            title="Open operator profile"
            aria-label={`Open ${bot.name}'s operator profile`}
          >
            <BotAvatar
              bot={bot}
              state={stateForBot({ ...bot, messages })}
              size={28}
              motion={sigilMotion?.kind ?? "none"}
              motionKey={sigilMotion?.nonce ?? 0}
            />
          </button>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="sr-only">Operator:</span>
              <RenameTitle
                value={bot.name}
                onCommit={(name) => dispatch({ type: "updateBot", botId: bot.id, patch: { name } })}
                onActivate={() => dispatch({ type: "toggleSettings", open: true })}
                showEditButton
                className={WORKSTREAM_TITLE_CLASS}
                inputClassName="max-w-[220px] rounded-sm bg-inset px-1.5 py-0.5 text-[15px] font-semibold"
              />
              {bot.chiefOfStaff && (
                <span className="flex shrink-0 items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10.5px] font-semibold text-accent-text">
                  <ShieldCheck size={11} aria-hidden="true" /> Section helm
                </span>
              )}
              {bot.busy && (
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-accent-text" role="status">
                  <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> Run active
                </span>
              )}
            </div>
            <div
              className="mt-0.5 truncate text-[11px] text-ink-secondary"
              title={workstreamContext.visible}
            >
              <span className="sr-only">{workstreamContext.accessible}</span>
              <span aria-hidden="true">{workstreamContext.visible}</span>
            </div>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-1 md:shrink-0 md:flex-nowrap md:justify-start md:gap-2">
          <button
            ref={findTriggerRef}
            onClick={() => setFindOpen((open) => !open)}
            aria-label="Find in workstream"
            aria-pressed={findOpen}
            className={cn(
              MOBILE_PRIMARY_ACTION_CLASS,
              findOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title="Find in workstream (⌘F)"
          >
            <Search size={18} />
          </button>
          {bot.busy && (
            <button
              onClick={() => dispatch({ type: "interrupt", botId: bot.id, threadId: bot.threadId })}
              className={cn(
                "flex min-h-9 items-center gap-1.5 rounded-sm border border-hairline bg-raised/60 px-2.5 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink",
                COMPACT_BUBBLE,
              )}
              title="Stop active run"
              aria-label="Stop active run"
            >
              <Square size={12} className="fill-current" />
              <span className="@max-4xl/chathead:hidden">Stop</span>
            </button>
          )}
          <TaskPicker bot={bot} />
          <UsageChip bot={bot} />
          <WorkingFolderChip bot={bot} />
          <ModelPicker bot={bot} />
          <CallButton bot={bot} />
          <button
            onClick={() => dispatch({ type: "toggleComputer" })}
            data-helmryth-workbench-opener
            className={cn(
              MOBILE_PRIMARY_ACTION_CLASS,
              state.computerOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title="Open operator workbench"
            aria-label="Open operator workbench"
          >
            <Monitor size={18} />
          </button>
          <button
            onClick={() => dispatch({ type: "toggleInspector" })}
            data-helmryth-trace-opener
            aria-label="Open trace"
            aria-pressed={state.inspectorOpen}
            className={cn(
              MOBILE_PRIMARY_ACTION_CLASS,
              state.inspectorOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title="Trace — runtime events and protocol records for this workstream"
          >
            <Search size={18} />
          </button>
        </div>
      </header>

      {findOpen && (
        <ChatFindBar
          threadId={bot.threadId}
          onClose={() => setFindOpen(false)}
          returnFocusRef={findTriggerRef}
        />
      )}

      {state.notice && (
        <div
          className={cn(
            "w-full border-b px-5",
            state.notice.level === "warning"
              ? "border-warning/30 bg-warning/10"
              : "border-accent/20 bg-accent/10",
          )}
          role="status"
          aria-live="polite"
        >
          <div
            className={cn(
              "mx-auto flex min-h-10 max-w-[64rem] items-center gap-2 text-[13px]",
              state.notice.level === "warning" ? "text-warning" : "text-ink",
            )}
          >
            <AlertTriangle size={14} aria-hidden="true" />
            <span className="font-semibold">
              {state.notice.level === "warning" ? "Cleanup pending:" : "Workstream notice:"}
            </span>
            {state.notice.message}
          </div>
        </div>
      )}

      {/* System notice */}
      {state.error && (
        <div className="w-full border-b border-danger/30 bg-danger/10 px-5" role="alert">
          <div className="mx-auto flex min-h-10 max-w-[64rem] items-center gap-2 text-[13px] text-danger">
            <AlertTriangle size={14} aria-hidden="true" />
            <span className="font-semibold">System notice:</span> {runtimeLabel(state.error)}
          </div>
        </div>
      )}

      {/* Pinned workstream entry */}
      <PinnedBanner
        bot={bot}
        pinnedId={bot.pinnedMessageId}
        messages={messages}
        onJump={(messageId) =>
          dispatch({ type: "focusMessage", threadId: bot.threadId, messageId })
        }
        onUnpin={() =>
          dispatch({ type: "updateBot", botId: bot.id, patch: { pinnedMessageId: "" } })
        }
      />

      {showToolCallsEnabled(state.config) && <RunLedger messages={messages} busy={bot.busy ?? false} />}

      {/* Workstream records and composer share one continuous reading surface. */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="h-full overflow-x-hidden overflow-y-auto px-3 [overflow-anchor:none] sm:px-5"
          onWheel={(e) => {
            if (e.deltaY < 0) setBottomFollow(false);
            else if (atEnd()) setBottomFollow(true);
          }}
          onTouchStart={(e) => (touchY.current = e.touches[0]?.clientY ?? 0)}
          onTouchMove={(e) => {
            const y = e.touches[0]?.clientY ?? 0;
            if (y > touchY.current + 4) setBottomFollow(false);
            else if (atEnd()) setBottomFollow(true);
          }}
          onScroll={() => {
            const el = scrollRef.current;
            if (!el) return;
            const scrollTop = el.scrollTop;
            const resume = shouldResumeBottomFollow({
              following: followRef.current,
              previousScrollTop: previousScrollTop.current,
              scrollTop,
              distanceFromBottom: el.scrollHeight - scrollTop - el.clientHeight,
            });
            previousScrollTop.current = scrollTop;
            if (resume) setBottomFollow(true);
          }}
        >
          <div
            className="mx-auto flex w-full max-w-[64rem] flex-col gap-3"
            style={{ paddingBottom: `calc(${composerDock.pad} + 1rem)` }}
            role="log"
            aria-live="polite"
            aria-label={`Workstream record with ${bot.name}`}
          >
          {hiddenCount > 0 && (
            <div className="flex justify-center pt-2">
              <button
                onClick={showEarlier}
                className="min-h-9 rounded-sm border border-hairline bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                Load earlier records ({hiddenCount} remaining)
              </button>
            </div>
          )}
          <MessagesList
            bot={bot}
            messages={windowedMessages}
            transcript={messages}
            editingId={editingId}
            lastBotTextId={lastBotTextId}
            emergingId={popping?.id}
            canRetryLast={!bot.busy && Boolean(lastUserMessage)}
            engine={state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSubmitEdit={submitEdit}
            onRegenerate={regenerate}
            onReply={selectReply}
          />
          {laterCount > 0 && (
            <div className="flex justify-center">
              <button
                onClick={showLater}
                className="min-h-9 rounded-sm border border-hairline bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                Load later records ({laterCount} remaining)
              </button>
            </div>
          )}
          {provisioning && (
            <div className="flex justify-start">
              <div className="flex min-h-10 items-center gap-2 border-l-2 border-accent bg-panel px-3 py-2 text-[13px] text-ink-secondary" role="status">
                <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                Preparing {bot.name}&apos;s workbench…
              </div>
            </div>
          )}
          <TurnPresence
            avatar={
              <BotAvatar
                bot={bot}
                state={toolInFlight ? "working" : "thinking"}
                size={32}
                motion="none"
                motionKey={0}
              />
            }
            visible={presenceVisible}
            label={activityLabel}
            answering={popping !== null}
          >
            {popping ? (
              <div className="w-fit max-w-[min(48rem,88%)] border-l border-hairline bg-transparent px-4 py-3 text-[15px] leading-relaxed text-ink">
                <div className="mb-1.5 text-[11px] font-semibold tracking-[0.075em] text-ink-secondary uppercase">
                  {bot.name} · operator record
                </div>
                <MessageBoundary fallbackText={popping.text}>
                  <ChatMarkdown text={popping.text} />
                </MessageBoundary>
              </div>
            ) : null}
          </TurnPresence>
          </div>
        </div>

      {/* Reading scrollback — one tap back to the end, streaming or not */}
      {!follow && (
        <button
          onClick={jumpToLatest}
          aria-label="Jump to latest workstream entry"
          className="motion-safe:animate-pop-in absolute left-1/2 z-10 flex min-h-9 -translate-x-1/2 items-center gap-1.5 rounded-sm border border-hairline bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-sm hover:bg-raised-hover"
          style={{ bottom: composerDock.height }}
        >
          <ArrowDown size={13} aria-hidden="true" /> Latest entry
        </button>
      )}

      {/* Keyed by task: each conversation keeps its own draft and a failed
          request can restore the old task without spilling into the newly
          selected one. ArrowUp-to-edit stays gated on busy because editing
          rewinds the thread, which a live turn forbids (the server 409s it). */}
        <div ref={composerDockRef} className="absolute inset-x-0 bottom-0 z-[2]">
          <Composer
            key={bot.threadId}
            bot={bot}
            replyTo={replyTo}
            onClearReply={clearReply}
            onConsumeReply={consumeReply}
            onRestoreReply={restoreReply}
            onEditLast={lastUserMessage && !bot.busy ? () => setEditingId(lastUserMessage.id) : undefined}
          />
        </div>
      </div>
    </main>
  );
}

/** What the open workstream has spent, shown after the first settled pass. */
function UsageChip({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const usage = bot.tasks?.find((t) => t.threadId === bot.threadId)?.usage;
  const text = usage ? usageChip(usage) : "";
  if (!usage || !text) return null;
  const billing = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)?.snapshot.billing;
  const detail = [
    `${usage.turns} operator pass${usage.turns === 1 ? "" : "es"}`,
    usageDetail(usage),
    // the whole thread rides along on every turn, so most of "in" is the
    // model re-reading what it already saw — say so, or the figure reads as
    // a bug (issue #527)
    cachedInput(usage) > 0 ? "cached = context carried forward, not new text" : null,
    hasFiniteCost(usage.costUsd) ? `${formatUsd(usage.costUsd)} ${costCaption(billing)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  // folded: one figure — cost when the engine reports one, else tokens
  const short = usage.costUsd !== null ? formatUsd(usage.costUsd) : formatTokens(usage.input + usage.output);
  return (
    <button
      onClick={() => dispatch({ type: "toggleSettings", open: true })}
      className="min-h-9 whitespace-nowrap rounded-sm border border-hairline bg-raised/60 px-2.5 py-1 text-[12px] tabular-nums text-ink-secondary hover:bg-raised hover:text-ink @max-4xl/chathead:px-2"
      title={`Workstream usage\n${detail}`}
      aria-label={`Open workstream usage: ${text}`}
    >
      <span className="@max-4xl/chathead:hidden">{text}</span>
      <span className="hidden @max-4xl/chathead:inline">{short}</span>
    </button>
  );
}

/** The folder this workstream's capabilities use in the operator workbench. */
function WorkingFolderChip({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const task = bot.tasks?.find((t) => t.threadId === bot.threadId);
  const folder = task?.cwd === undefined ? bot.cwd : (task.cwd ?? undefined);
  if (!folder) return null;
  const name = folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder;
  return (
    <button
      onClick={() => dispatch({ type: "toggleSettings", open: true })}
      className={cn(
        "flex min-h-9 max-w-[180px] items-center gap-1.5 rounded-sm border border-hairline bg-raised/60 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink",
        COMPACT_SQUARE,
      )}
      title={`Workbench folder: ${folder}`}
      aria-label={`Open workbench folder settings for ${name}`}
    >
      <Folder size={12} className="@max-4xl/chathead:size-[14px]" />
      <span className="truncate @max-4xl/chathead:hidden">{name}</span>
    </button>
  );
}
