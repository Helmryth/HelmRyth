import { track } from "@/lib/analytics";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type SetStateAction } from "react";
import { ArrowUp, Check, Clock, Hand, Mic, Paperclip, ShieldCheck, Square, Users, X } from "lucide-react";
import { useStore, visibleMessages, type Bot, type Group, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import {
  draftRevision,
  forgetFailedComposerSend,
  markDraftEdited,
  recoverFailedComposerSend,
  rememberFailedComposerSend,
  restoredSendId,
  useComposerDraft,
  useFailedComposerSends,
  type ComposerSendSnapshot,
  type FailedComposerSend,
} from "@/lib/drafts";
import { SigilAvatar } from "./Avatar";
import { ComposerAttachments, pathForFile } from "./ComposerAttachments";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import {
  appendPastedText,
  composeMessage,
  imageAttachmentFromFile,
  intakeFiles,
  isImageFile,
  isLongPaste,
  pasteAttachment,
  type Attachment,
  type PasteAttachment,
} from "@/lib/composer-attachments";
import { normalizeState } from "@/lib/sigil";
import { defaultResponderName, effectiveDefaultResponder, roomRespondersForComposer } from "@/lib/group-routing";
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals } from "./PendingApproval";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { ReplyQuote } from "./ReplyQuote";

/** Extend the composer backdrop to the viewport edge without making the 12px
 * mobile gutter contribute overflow; the 20px desktop gutter begins at sm. */
export const COMPOSER_BACKDROP_CLASS =
  "absolute -left-3 -right-3 top-[calc(100%-0.25rem)] h-[50vh] bg-app sm:-left-5 sm:-right-5";

/** The active @mention query at the caret: the text between an `@` that
 * starts a word and the caret. null = no mention being typed. */
function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null; // user@host, not a tag
  const query = upto.slice(at + 1);
  if (query.length > 24 || query.includes("@") || query.includes("\n")) return null;
  return { start: at, query };
}

type MentionChoice = { id: string; name: string; bot?: Bot };

/**
 * A 1:1 workstream routes an @mention through the operator's own delegation
 * tools, and the harness only ever resolves the tag against operators in the
 * SAME section that are not archived (server/index.ts, `sectionPeers`), and
 * only when the operator's engine actually mounts those tools. Pooling the
 * whole roster offered names the server then dropped without a word: the tag
 * rendered, the teammate was never asked, and nothing said so.
 */
export function directMentionPool<T extends { id: string; name: string; section?: string; hidden?: boolean }>(
  self: T | undefined,
  roster: readonly T[],
  canDelegate: boolean,
): T[] {
  if (!self || !canDelegate) return [];
  const section = self.section?.trim() || "";
  return roster.filter(
    (member) =>
      member.id !== self.id && !member.hidden && (member.section?.trim() || "") === section,
  );
}

interface ComposerDraftSnapshot extends ComposerSendSnapshot {
  reply: Message | null;
}

interface QueuedGroupSend {
  text: string;
  replyToId?: string;
  draft: ComposerDraftSnapshot;
}

export interface HeldDirectionRecovery {
  restore: () => void;
  clear: () => void;
}

export function recoverHeldGroupDirection(recovery: HeldDirectionRecovery): void {
  recovery.restore();
  recovery.clear();
}

function crewComposerHint(group: Group, members: Bot[]): string {
  if (group.dm) return "continue the private workstream";
  const responder = effectiveDefaultResponder(group, members);
  if (responder.kind === "everyone") return "all operators are called";
  if (responder.kind === "mentions") return "use @ to call an operator";
  return `${defaultResponderName(group, members) ?? "Lead operator"} leads`;
}

/** Permission policy editor. The historical `autoApprove` bit remains the
 * storage contract; the surface describes the actual gate behavior. */
function PermissionModeSelector({ bot, onSetAuto }: { bot: Bot; onSetAuto: (auto: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const on = Boolean(bot.autoApprove);

  const focusPolicy = (index: number) => {
    const choices = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    choices?.[index]?.focus();
  };

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !e.composedPath().includes(wrapperRef.current)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <div className="relative flex items-center" ref={wrapperRef}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${on ? "Within limits" : "Gate each action"} permission policy for ${bot.name}`}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          if (!open) setOpen(true);
          requestAnimationFrame(() => focusPolicy(event.key === "ArrowDown" ? 0 : 1));
        }}
        className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-sm border border-hairline/60 bg-raised px-2.5 text-[12px] text-ink-secondary hover:bg-control hover:text-ink"
      >
        {on ? <ShieldCheck size={14} className="opacity-70" aria-hidden="true" /> : <Hand size={14} className="opacity-70" aria-hidden="true" />}
        {on ? "Within limits" : "Gate each action"}
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Permission policy for ${bot.name}`}
          onKeyDown={(event) => {
            const choices = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
            const index = choices.findIndex((choice) => choice === document.activeElement);
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const delta = event.key === "ArrowDown" ? 1 : -1;
              choices[(index + delta + choices.length) % choices.length]?.focus();
            }
            if (event.key === "Home") {
              event.preventDefault();
              choices[0]?.focus();
            }
            if (event.key === "End") {
              event.preventDefault();
              choices.at(-1)?.focus();
            }
          }}
          className="absolute bottom-full left-0 z-30 mb-2 w-80 overflow-hidden rounded-md border border-hairline/70 bg-panel shadow-lg"
        >
          <div className="border-b border-hairline/50 bg-raised px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">Permission gates</div>
            <div className="mt-1 text-[13px] font-medium text-ink">How should {bot.name} cross them?</div>
          </div>
          <div className="flex flex-col">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!on}
              onClick={() => {
                onSetAuto(false);
                setOpen(false);
              }}
              className="flex items-start gap-3 border-b border-hairline/30 px-4 py-3 text-left hover:bg-raised-hover/50"
            >
              <Hand size={16} className="mt-0.5 shrink-0 opacity-70" aria-hidden="true" />
              <div className="flex w-full flex-col gap-0.5">
                <div className="flex items-center justify-between text-[14px] text-ink">
                  Gate each action
                  {!on && <Check size={14} aria-hidden="true" />}
                </div>
                <div className="text-[12px] leading-5 text-ink-secondary">
                  Pause whenever an action requires your permission.
                </div>
              </div>
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={on}
              onClick={() => {
                onSetAuto(true);
                setOpen(false);
              }}
              className="flex items-start gap-3 px-4 py-3 text-left hover:bg-raised-hover/50"
            >
              <ShieldCheck size={16} className="mt-0.5 shrink-0 opacity-70" aria-hidden="true" />
              <div className="flex w-full flex-col gap-0.5">
                <div className="flex items-center justify-between text-[14px] text-ink">
                  Continue within limits
                  {on && <Check size={14} aria-hidden="true" />}
                </div>
                <div className="text-[12px] leading-5 text-ink-secondary">
                  Proceed automatically; sensitive and destructive actions still open a gate.
                </div>
              </div>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Renders the editable message composer and its pending attachments. */
export function Composer({
  bot,
  group,
  members,
  onEditLast,
  replyTo,
  onClearReply,
  onConsumeReply,
  onRestoreReply,
  locked = false,
}: {
  bot?: Bot;
  group?: Group;
  members?: Bot[];
  onEditLast?: () => void;
  replyTo?: Message | null;
  onClearReply?: () => void;
  onConsumeReply?: () => void;
  onRestoreReply?: (message: Message, threadId: string) => void;
  /** A new crew keeps the composer inert until setup is saved or skipped. */
  locked?: boolean;
}) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  // Unified target: a direct workstream or a crew. In a crew the @ picker
  // offers operators plus @everyone; explicit mentions override the crew's
  // configured default responder.
  const busy = group ? Boolean(group.busyBotId) : Boolean(bot?.busy);
  // an engine with a live session takes a message INTO the running turn;
  // for those the composer never locks — the server steers instead of 409
  const canSteer =
    !group && Boolean(bot) && state.instances.find((i) => i.instanceId === bot!.modelSelection.instanceId)?.capabilities?.queueing === true;
  // a pending approval blocks the prompt until it is answered
  const threadId = group?.threadId ?? bot?.threadId ?? "";
  // the VISIBLE branch only — an approval left on a branch you edited away
  // from must not keep blocking the composer
  const approvals = pendingApprovals(group ? group.messages : bot ? visibleMessages(bot) : []);
  const approval = approvals[0];
  const approvalBot = group
    ? members?.find((member) => member.id === approval?.message.from?.botId) ??
      members?.find((member) => member.id === group.busyBotId)
    : bot;
  const busyName = group
    ? (members?.find((b) => b.id === group.busyBotId)?.name ?? "An operator")
    : (bot?.name ?? "The operator");
  // Per-workstream draft: switching operators unmounts this component, so both the
  // text and its attachment chips have to outlive it (see lib/drafts).
  const draftId = group
    ? `group:${group.id}:${group.threadId}`
    : `bot:${bot?.id ?? ""}:${bot?.threadId ?? ""}`;
  const [text, setText, attachments, setAttachments] = useComposerDraft(
    draftId,
    !group && bot ? `bot:${bot.id}` : undefined,
  );
  const failedSends = useFailedComposerSends(draftId);
  const editText = useCallback(
    (next: string) => {
      markDraftEdited(draftId);
      setText(next);
    },
    [draftId, setText],
  );
  const editAttachments = useCallback(
    (next: SetStateAction<Attachment[]>) => {
      markDraftEdited(draftId);
      setAttachments(next);
    },
    [draftId, setAttachments],
  );
  const restoreDraft = useCallback(
    (sent: ComposerDraftSnapshot) => {
      // Shared recovery reaches a newly mounted view after navigation and
      // falls back to a separate retry item when a newer draft already exists.
      if (recoverFailedComposerSend(sent) === "restored" && sent.reply) {
        onRestoreReply?.(sent.reply, sent.threadId);
      }
    },
    [onRestoreReply],
  );
  const addAttachments = useCallback(
    (next: Attachment[]) => editAttachments((prev) => [...prev, ...next]),
    [editAttachments],
  );
  const removeAttachment = useCallback(
    (id: string) => editAttachments((prev) => prev.filter((a) => a.id !== id)),
    [editAttachments],
  );
  const displayPasteInChatBox = useCallback(
    /** Moves one pasted attachment into the editable draft and restores focus. */
    function displayPasteInChatBox(attachment: PasteAttachment) {
      const nextText = appendPastedText(text, attachment.text);
      editText(nextText);
      editAttachments((prev) => prev.filter((a) => a.id !== attachment.id));
      setCaret(nextText.length);
      setDismissedAt(null);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(nextText.length, nextText.length);
      });
    },
    [text, editText, editAttachments],
  );
  const [recording, setRecording] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null); // Esc'd this @
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mentionListId = useId();
  // what was typed before the mic went on — partials append after it
  const baseText = useRef("");

  // Tagging a teammate in a 1:1 is a delegation request; the harness only wires
  // it up on engines that mount the collaboration tools.
  const canDelegate =
    state.instances.find((i) => i.instanceId === bot?.modelSelection.instanceId)?.capabilities
      ?.agentsMcp === true;

  // Image paste is offered only when every responding operator can inspect it.
  const botSupportsImages = (candidate?: Bot) =>
    Boolean(
      candidate &&
        state.instances.find((i) => i.instanceId === candidate.modelSelection.instanceId)?.capabilities?.images,
    );
  const imageTargetsSupport = (message: string) => {
    if (!group) return botSupportsImages(bot);
    const responders = roomRespondersForComposer(message, members ?? [], group);
    return responders.length > 0 && responders.every(botSupportsImages);
  };
  const engineSupportsImages = imageTargetsSupport(text);

  // ── @mention picker ──
  const mention = mentionQueryAt(text, caret);
  const candidates = useMemo(() => {
    if (!mention || mention.start === dismissedAt) return [];
    const pool: MentionChoice[] = group
      ? [
          { id: "__everyone__", name: "everyone" },
          ...(members ?? []).map((member) => ({ id: member.id, name: member.name, bot: member })),
        ]
      : directMentionPool(bot, state.bots, canDelegate).map((member) => ({
          id: member.id,
          name: member.name,
          bot: member,
        }));
    const q = mention.query.trim().toLowerCase();
    // "@Scout " — the full name plus a space — is a COMPLETED tag, not a
    // search: keep the picker closed so Enter sends instead of re-picking
    if (mention.query.endsWith(" ") && pool.some((b) => b.name.toLowerCase() === q)) return [];
    return pool.filter((b) => !q || b.name.toLowerCase().includes(q)).slice(0, 6);
  }, [mention, dismissedAt, state.bots, bot, canDelegate, group, members]);
  const pickerOpen = candidates.length > 0;

  useEffect(() => setHighlight(0), [mention?.start, mention?.query]);

  // one line at rest, then grow with the draft — hard cap at six lines
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const line = parseFloat(getComputedStyle(el).lineHeight) || 24;
    const cap = line * 6;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
  }, [text]);

  const pickMention = (peer: MentionChoice) => {
    if (!mention) return;
    const after = text.slice(caret);
    const next = `${text.slice(0, mention.start)}@${peer.name} ${after}`;
    editText(next);
    const newCaret = mention.start + peer.name.length + 2;
    setCaret(newCaret);
    // picking completes this tag — close the popup so the next Enter sends
    setDismissedAt(mention.start);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(newCaret, newCaret);
    });
  };

  // Crews hold one direction client-side while an operator works; it auto-sends
  // the moment the crew settles. Direct mid-turn sends still POST (the harness
  // queue), but stay off the transcript until drain — the chip here is the
  // pending row so they cannot become the active leaf mid-turn.
  const [queued, setQueued] = useState<QueuedGroupSend | null>(null);
  const [discardHeldOpen, setDiscardHeldOpen] = useState(false);
  const queuedRef = useRef(queued);
  const clearQueued = useCallback(() => {
    queuedRef.current = null;
    setQueued(null);
    setDiscardHeldOpen(false);
  }, []);
  useEffect(
    () => () => {
      const unsent = queuedRef.current;
      if (unsent) restoreDraft(unsent.draft);
    },
    [draftId, restoreDraft],
  );
  const pendingChip = group
    ? queued?.text
    : bot
      ? state.pendingQueued?.[bot.threadId]?.map((entry) => entry.text).join("\n")
      : undefined;
  // a chip on its own is a message: the send control has to appear for it
  const fileInput = useRef<HTMLInputElement>(null);
  const [autoWarn, setAutoWarn] = useState(false);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  // Permission policy belongs to one operator; a crew has several.
  const autoBot = group ? undefined : bot;
  const pickFiles = async (picked: FileList | null) => {
    if (!picked?.length) return;
    const { attachments: added, notice } = await intakeFiles(Array.from(picked), {
      allowImages: engineSupportsImages,
      getPath: pathForFile,
      uploadImage: imageAttachmentFromFile,
    });
    if (added.length) addAttachments(added);
    // Keep file-specific failures beside the attachments. A successful
    // overlapping intake must not erase an earlier failure before it is read.
    if (notice) setAttachmentNotice(notice);
  };
  const setAuto = (auto: boolean) => {
    if (!autoBot) return;
    // Enabling continuous execution for an operator on this device needs acknowledgement.
    // has to be acknowledged first. The flag the dialog sends is stripped by
    // the reducer rather than stored, so — exactly like the settings panel —
    // the warning is shown on every switch-on, not just the first.
    if (auto && !autoBot.autoApprove && autoBot.computer === "local") {
      setAutoWarn(true);
      return;
    }
    dispatch({ type: "updateBot", botId: autoBot.id, patch: { autoApprove: auto } });
  };

  const hasContent = Boolean(text.trim()) || attachments.length > 0;
  const retryFailedSend = (failed: FailedComposerSend) => {
    if (failed.requestText.includes("<attached-image ") && !imageTargetsSupport(failed.requestText)) {
      dispatch({ type: "error", message: "The selected operator cannot inspect image artifacts." });
      return;
    }
    forgetFailedComposerSend(draftId, failed.id);
    const retry = {
      sendId: failed.sendId,
      text: failed.requestText,
      replyToId: failed.replyToId,
      threadId: failed.threadId,
      onError: () => {
        rememberFailedComposerSend(draftId, {
          sendId: failed.sendId,
          text: failed.text,
          requestText: failed.requestText,
          replyToId: failed.replyToId,
          threadId: failed.threadId,
        });
      },
    };
    if (group) {
      dispatch({ type: "sendGroup", groupId: group.id, ...retry });
    } else if (bot) {
      dispatch({ type: "send", botId: bot.id, ...retry });
    }
  };
  const send = () => {
    // A busy channel already has one locally held send. Keep any newer text
    // as an editable draft until that send is dispatched; replacing the slot
    // here would silently lose the first message.
    if (locked || (group && queued)) return;
    if (attachments.some((attachment) => attachment.kind === "image") && !imageTargetsSupport(text)) {
      dispatch({ type: "error", message: "The selected operator cannot inspect image artifacts." });
      return;
    }
    const t = composeMessage(text, attachments);
    if (!t) return;
    const sentDraft: ComposerDraftSnapshot = {
      draftId,
      revision: draftRevision(draftId),
      sendId: restoredSendId(draftId) ?? crypto.randomUUID(),
      text,
      requestText: t,
      attachments: [...attachments],
      reply: replyTo ?? null,
      replyToId: replyTo?.id,
      threadId,
    };
    if (busy && group) {
      const pending = { text: t, replyToId: replyTo?.id, draft: sentDraft };
      queuedRef.current = pending;
      setQueued(pending);
      setText("");
      setAttachments([]);
      onConsumeReply?.();
      return;
    }
    if (group) {
      dispatch({
        type: "sendGroup",
        groupId: group.id,
        text: t,
        sendId: sentDraft.sendId,
        replyToId: replyTo?.id,
        threadId,
        onError: () => restoreDraft(sentDraft),
      });
      track("message_sent", { room: true });
    } else if (bot) {
      dispatch({
        type: "send",
        botId: bot.id,
        text: t,
        sendId: sentDraft.sendId,
        replyToId: replyTo?.id,
        threadId,
        onError: () => restoreDraft(sentDraft),
      });
      track("message_sent", { driver: bot.modelSelection?.instanceId, queued: busy && !canSteer });
    }
    setText("");
    setAttachments([]);
    onConsumeReply?.();
  };
  useEffect(() => {
    if (busy || !queued) return;
    if (group) {
      if (queued.text.includes("<attached-image ") && !imageTargetsSupport(queued.text)) {
        dispatch({ type: "error", message: "The selected operator cannot inspect image artifacts." });
        clearQueued();
        restoreDraft(queued.draft);
        return;
      }
      clearQueued();
      dispatch({
        type: "sendGroup",
        groupId: group.id,
        text: queued.text,
        sendId: queued.draft.sendId,
        replyToId: queued.replyToId,
        threadId: queued.draft.threadId,
        onError: () => restoreDraft(queued.draft),
      });
      track("message_sent", { room: true, queued: true });
    }
  }, [busy, queued, group, members, state.instances, dispatch, clearQueued, restoreDraft]);

  // native dictation: partials stream into the input while the Swift
  // helper runs; the final transcript stays in the box, ready to edit/send
  useEffect(() => {
    if (!recording) return;
    const bridge = window.helmryth;
    if (!bridge) {
      setRecording(false);
      return;
    }
    setSpeechError(null);
    const offTranscript = bridge.onSpeechTranscript((line) => {
      const transcript = line.text;
      if (transcript === undefined) return;
      const base = baseText.current;
      editText(base ? `${base} ${transcript}` : transcript);
    });
    const offEnd = bridge.onSpeechEnd(({ code }) => {
      setRecording(false);
      if (code === 2) {
        setSpeechError("Dictation is only available on macOS for now.");
      } else if (code === 1) {
        setSpeechError(
          "Dictation needs Microphone + Speech Recognition access — System Settings → Privacy & Security.",
        );
      }
    });
    void bridge.speechStart();
    return () => {
      offTranscript();
      offEnd();
      void bridge.speechStop();
    };
  }, [recording, editText]);

  const toggleMic = () => {
    if (!capabilities.dictation.available || !window.helmryth) {
      setSpeechError("Dictation isn't available in this build.");
      return;
    }
    baseText.current = text.trim();
    setRecording((r) => !r);
  };

  return (
    <div className="pointer-events-none relative px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:px-5 sm:pb-3">
      {speechError && (
        <div
          className="pointer-events-auto mb-2 flex w-full items-start gap-2 rounded-sm border-l-2 border-warning bg-raised px-3 py-2 text-[12px] text-ink"
          role="alert"
        >
          <span className="min-w-0 flex-1">{speechError}</span>
          <button
            type="button"
            onClick={() => setSpeechError(null)}
            aria-label="Dismiss dictation notice"
            className="flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-secondary hover:bg-control hover:text-ink"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="pointer-events-auto relative w-full">
        {failedSends.map((failed) => (
          <div
            key={failed.id}
            className="mb-2 flex items-center gap-2 rounded-sm border-l-2 border-danger bg-raised px-3 py-2 text-[12.5px] text-ink"
            role="alert"
          >
            <span className="min-w-0 flex-1 truncate">
              Direction not sent: “{failed.text.trim() || "artifact"}”
            </span>
            <button
              type="button"
              onClick={() => retryFailedSend(failed)}
              aria-label="Retry this direction"
              className="shrink-0 rounded-sm border border-danger/40 px-2 py-1 font-medium text-danger hover:bg-danger/10"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => forgetFailedComposerSend(draftId, failed.id)}
              aria-label="Dismiss failed direction"
              title="Dismiss"
              className="flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-secondary hover:bg-danger/10 hover:text-danger"
            >
              <X size={13} strokeWidth={2.5} aria-hidden="true" />
            </button>
          </div>
        ))}
        {pendingChip && (
          <div
            className="mb-2 flex items-center gap-2 rounded-sm border-l-2 border-hairline bg-raised px-3 py-2 text-[12.5px] text-ink-secondary"
            role="status"
            aria-live="polite"
          >
            <Clock size={13} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">
              Held next · begins when {busyName} clears the current step: “{pendingChip}”
            </span>
            <button
              type="button"
              onClick={() => {
                if (group) {
                  setDiscardHeldOpen(true);
                  return;
                }
                if (!bot) return;
                for (const entry of state.pendingQueued?.[bot.threadId] ?? []) {
                  dispatch({ type: "cancelQueued", botId: bot.id, queueId: entry.queueId });
                }
              }}
              aria-label={group ? "Review held direction removal" : "Remove held direction"}
              aria-expanded={group ? discardHeldOpen : undefined}
              title="Remove held direction"
              className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-secondary hover:bg-control hover:text-ink"
            >
              <X size={13} strokeWidth={2.5} aria-hidden="true" />
            </button>
          </div>
        )}
        {group && queued && discardHeldOpen && (
          <div
            role="alert"
            className="mb-2 border-l-2 border-warning bg-raised px-3 py-2 text-[12px] leading-relaxed text-ink"
          >
            <p>
              Remove this unsent held direction? It will return to the editor. If a newer draft exists,
              it remains recoverable under failed directions instead.
            </p>
            <div className="mt-2 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setDiscardHeldOpen(false)}
                className="min-h-9 rounded-md px-3 text-ink-secondary hover:bg-control hover:text-ink"
              >
                Keep held
              </button>
              <button
                type="button"
                onClick={() => {
                  recoverHeldGroupDirection({
                    restore: () => restoreDraft(queued.draft),
                    clear: clearQueued,
                  });
                  requestAnimationFrame(() => inputRef.current?.focus());
                }}
                className="min-h-9 rounded-md border border-warning px-3 font-medium text-warning hover:bg-warning/10"
              >
                Remove and recover
              </button>
            </div>
          </div>
        )}
        {pickerOpen && (
          <div
            id={mentionListId}
            role="listbox"
            aria-label="Call an operator into this workstream"
            className="absolute bottom-full left-2 z-20 mb-2 w-72 overflow-hidden rounded-md border border-hairline/70 bg-panel shadow-lg"
          >
            {candidates.map((peer, i) => (
              <button
                key={peer.id}
                id={`${mentionListId}-option-${i}`}
                type="button"
                role="option"
                aria-selected={i === highlight}
                tabIndex={-1}
                onClick={() => pickMention(peer)}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full items-center gap-2.5 border-b border-hairline/30 px-3 py-2 text-left last:border-b-0",
                  i === highlight ? "bg-raised-hover/60" : "",
                )}
              >
                {peer.bot ? (
                  <SigilAvatar
                    color={peer.bot.color}
                    state={normalizeState(peer.bot.sigilExpression) ?? "happy"}
                    size={24}
                  />
                ) : (
                  <span className="flex size-6 items-center justify-center rounded-sm border border-hairline/60 bg-raised text-ink-secondary">
                    <Users size={14} aria-hidden="true" />
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{peer.name}</span>
                <span className="shrink-0 text-[11px] text-ink-secondary">
                  {peer.bot ? "Operator" : "Crew call"}
                </span>
              </button>
            ))}
          </div>
        )}
        {/* A gate takes over the composer so waiting work stays unmistakable. */}
        {approval && (
          <div className="mb-2 overflow-hidden rounded-md border border-warning/60 bg-panel">
            <PendingApprovalPanel pending={approval} count={approvals.length} index={0} />
            <PendingApprovalActions
              pending={approval}
              threadId={threadId}
              bot={approvalBot}
              onCancelTurn={() => {
                if (group) dispatch({ type: "interruptGroup", groupId: group.id, threadId });
                else if (bot) dispatch({ type: "interrupt", botId: bot.id, threadId });
              }}
            />
          </div>
        )}
        {replyTo && (
          <div className="mb-2 px-1">
            <ReplyQuote
              message={replyTo}
              fallbackName={bot?.name}
              onClear={onClearReply}
            />
          </div>
        )}
        <ComposerAttachments
          items={attachments}
          onAdd={addAttachments}
          onRemove={removeAttachment}
          onDisplayInChatBox={displayPasteInChatBox}
          allowImages={engineSupportsImages}
          notice={attachmentNotice}
          onNotice={setAttachmentNotice}
        />
        <div className="relative">
          <div
            aria-hidden
            className={COMPOSER_BACKDROP_CLASS}
          />
          <div className="relative grid grid-cols-[auto_1fr_auto] items-center gap-x-2 rounded-md border border-hairline/70 bg-panel px-3 pb-2 pt-2 shadow-sm focus-within:border-accent">
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                void pickFiles(e.target.files);
                // Selecting the same file twice still emits a change.
                e.target.value = "";
              }}
            />
            {!locked && (
              <div className="col-start-1 row-start-2 mt-1 flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  aria-label="Add an artifact to this run"
                  title="Add artifact"
                  className="flex size-9 shrink-0 items-center justify-center rounded-sm text-ink-secondary hover:bg-control hover:text-ink"
                >
                  <Paperclip size={17} aria-hidden="true" />
                </button>
                {autoBot && <PermissionModeSelector bot={autoBot} onSetAuto={setAuto} />}
              </div>
            )}
            <textarea
              ref={inputRef}
              // The roster skip control lands here — it is the one stop worth
              // jumping 40+ Tab presses for.
              data-helmryth-composer-input
              rows={1}
              value={text}
              onChange={(e) => {
                editText(e.target.value);
                setCaret(e.target.selectionStart ?? e.target.value.length);
                setDismissedAt(null);
              }}
              onPaste={(e) => {
                const imageFiles = Array.from(e.clipboardData.files).filter(isImageFile);
                if (imageFiles.length && engineSupportsImages) {
                  e.preventDefault();
                  void (async () => {
                    for (const file of imageFiles) {
                      try {
                        const attachment = await imageAttachmentFromFile(file);
                        if (attachment) editAttachments((prev) => [...prev, attachment]);
                      } catch (err) {
                        dispatch({
                          type: "error",
                          message: err instanceof Error ? err.message : "The image artifact could not be prepared.",
                        });
                      }
                    }
                  })();
                  return;
                }
                const pasted = e.clipboardData.getData("text/plain");
                if (!isLongPaste(pasted)) return;
                e.preventDefault();
                const start = e.currentTarget.selectionStart;
                const end = e.currentTarget.selectionEnd;
                if (start !== end) {
                  editText(`${text.slice(0, start)}${text.slice(end)}`);
                  setCaret(start);
                }
                editAttachments((prev) => [...prev, pasteAttachment(pasted)]);
              }}
              onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
              onClick={(e) => setCaret(e.currentTarget.selectionStart)}
              onKeyDown={(e) => {
                if (pickerOpen) {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    const delta = e.key === "ArrowDown" ? 1 : -1;
                    setHighlight((h) => (h + delta + candidates.length) % candidates.length);
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    pickMention(candidates[highlight]);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setDismissedAt(mention?.start ?? null);
                    return;
                  }
                }
                if (e.key === "ArrowUp" && !hasContent && onEditLast) {
                  e.preventDefault();
                  onEditLast();
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
                if (e.key === "Escape" && recording) setRecording(false);
              }}
              disabled={Boolean(approval) || locked}
              placeholder={
                locked
                  ? "Complete crew setup to open this workstream"
                  : approval
                    ? "Resolve the gate above to continue"
                    : recording
                      ? "Listening…"
                      : busy && canSteer
                        ? `${busyName} is running — Enter adds direction now`
                        : busy
                          ? group
                            ? `${busyName} is running — Enter holds this direction next`
                            : `${busyName} is running — direction follows the current step`
                          : group
                            ? `Direct ${group.name} — ${crewComposerHint(group, members ?? [])}`
                            : `Brief ${bot?.name ?? "this operator"}`
              }
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={pickerOpen}
              aria-controls={pickerOpen ? mentionListId : undefined}
              aria-activedescendant={pickerOpen ? `${mentionListId}-option-${highlight}` : undefined}
              aria-label={`Direct ${group ? group.name : (bot?.name ?? "this operator")}`}
              className="col-span-full row-start-1 max-h-[9rem] min-h-7 w-full resize-none overflow-y-auto self-center bg-transparent px-1 py-1 text-[15px] leading-6 text-ink placeholder:text-ink-secondary focus:outline-none"
            />
            <div className="col-start-3 row-start-2 mt-1 flex items-center gap-1">
              {busy && !locked && (
                <button
                  type="button"
                  onClick={() => {
                    if (group) dispatch({ type: "interruptGroup", groupId: group.id, threadId });
                    else if (bot) dispatch({ type: "interrupt", botId: bot.id, threadId });
                  }}
                  aria-label="Stop the active step"
                  className="flex size-9 shrink-0 items-center justify-center rounded-sm text-ink-secondary hover:bg-control hover:text-ink"
                  title="Stop active step"
                >
                  <Square size={14} className="fill-current" aria-hidden="true" />
                </button>
              )}
              {!locked && !busy && !hasContent && capabilities.dictation.available && (
                <button
                  type="button"
                  onClick={toggleMic}
                  aria-label={recording ? "Stop dictation" : "Start dictation"}
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-sm",
                    recording
                      ? "motion-safe:animate-pulse bg-danger/10 text-danger"
                      : "text-ink-secondary hover:bg-control hover:text-ink",
                  )}
                  title={recording ? "Stop dictation (Esc)" : "Dictate direction"}
                >
                  <Mic size={18} aria-hidden="true" />
                </button>
              )}
              {hasContent && !locked && (
                <button
                  type="button"
                  onClick={send}
                  disabled={Boolean(group && queued)}
                  aria-label={
                    group && queued
                      ? "A direction is already held for this crew"
                      : busy && canSteer
                        ? "Add direction to the active step"
                        : busy
                          ? "Hold this direction next"
                          : "Send direction"
                  }
                  title={
                    group && queued
                      ? "The held direction begins when the current step clears"
                      : busy && canSteer
                        ? "Add to the active step"
                        : busy
                          ? "Hold until the current step clears"
                          : "Send direction"
                  }
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-sm",
                    group && queued
                      ? "cursor-not-allowed bg-control text-ink-secondary"
                      : busy && !canSteer
                        ? "border border-hairline/60 bg-control text-ink-secondary hover:bg-raised-hover"
                        : "bg-accent text-[var(--color-accent-ink)] hover:bg-accent-border",
                  )}
                >
                  {busy && !canSteer ? (
                    <Clock size={15} aria-hidden="true" />
                  ) : (
                    <ArrowUp size={17} aria-hidden="true" />
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="pointer-events-auto">
      <LocalComputerAutoWarning
        open={autoWarn}
        onCancel={() => setAutoWarn(false)}
        onConfirm={() => {
          if (autoBot) {
            dispatch({
              type: "updateBot",
              botId: autoBot.id,
              patch: { autoApprove: true, acknowledgeLocalAuto: true },
            });
          }
          setAutoWarn(false);
        }}
      />
      </div>
    </div>
  );
}
