// A room: several bots + you in one shared thread. The sidebar and call view
// carry the personality; avatars inside the room stay still so a busy group
// does not become a wall of competing motion. Plain messages go to the room's
// default responder; @mentions override that routing.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, ArrowDown, ChevronDown, Folder, FolderOpen, Loader2, MessageSquareReply, Pin, PinOff, Plus, Search, X } from "lucide-react";
import {
  api,
  useStore,
  useStreaming,
  formatTime,
  openNotificationTarget,
  type Bot,
  type Group,
  type GroupDefaultResponder,
  type Message,
  type Action,
} from "@/state/store";
import { SigilAvatar } from "./Avatar";
import { TurnPresence } from "./TurnPresence";
import { showToolCallsEnabled } from "@/lib/feature-flags";
import { normalizeState, SIGIL_COLOR_NAMES } from "@/lib/sigil";
import { effectiveDefaultResponder } from "@/lib/group-routing";
import { ChatMarkdown } from "./ChatMarkdown";
import { Composer } from "./Composer";
import { ChatFindBar } from "./ChatFindBar";
import { GroupTaskPicker } from "./TaskPicker";
import { ReplyQuote } from "./ReplyQuote";
import { ConnectorCard } from "./ConnectorCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { hasRoutineExecutionTask, RoutineRunCard } from "./RoutineRunCard";
import { AttachedImageGallery } from "./AttachmentPreview";
import { GroupCallButton, GroupCallOverlay } from "./GroupCallView";
import { ReactionBar, ReactionChips } from "./Reactions";
import { ApprovalCard } from "./ApprovalCard";
import { ManageMembersPanel } from "./ManageMembersPanel";
import { groupActivityRuns } from "@/lib/activity-runs";
import { ActivityRun } from "./ActivityRun";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { cn } from "@/lib/cn";
import { useFocusMessage } from "@/lib/focus-message";
import { shortPath } from "@/lib/short-path";
import { BOTTOM_FOLLOW_THRESHOLD, shouldResumeBottomFollow } from "@/lib/bottom-follow";
import { useComposerDockPad } from "@/lib/composer-dock";
import { showWorkingDots } from "@/lib/turn-tail";
import { liveActivityLabel } from "@/lib/live-activity";
import { splitAttachedImages } from "@/lib/composer-attachments";
import {
  TRANSCRIPT_WINDOW_SIZE,
  expandWindowStart,
  focusWindowRange,
  resolveTranscriptWindow,
  tailWindowStart,
} from "@/lib/transcript-window";
import { useReplyDraft } from "@/lib/drafts";

type CrewQuestionDecision = Extract<Action, { type: "decideRequest" }>;

export function crewQuestionDecision(
  threadId: string,
  message: Message,
  answer: string,
): CrewQuestionDecision | null {
  const requestId = message.card?.requestId;
  const normalized = answer.trim();
  if (!requestId || !normalized) return null;
  return {
    type: "decideRequest",
    threadId,
    requestId,
    behavior: "answer",
    message: normalized,
  };
}

export function CrewQuestionCard({ threadId, message }: { threadId: string; message: Message }) {
  const { dispatch } = useStore();
  const [custom, setCustom] = useState("");
  const [answering, setAnswering] = useState(false);
  const answeringRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const card = message.card;
  if (!card?.requestId || card.tool) return null;
  const titleId = `crew-question-${message.id}-title`;
  const detailId = `crew-question-${message.id}-detail`;
  const customId = `crew-question-${message.id}-custom`;
  const requester = message.from?.name ?? "Active operator";
  const settled = Boolean(card.answered || card.dismissed);
  const answer = (value: string) => {
    if (answeringRef.current) return;
    const decision = crewQuestionDecision(threadId, message, value);
    if (!decision) return;
    answeringRef.current = true;
    setAnswering(true);
    setError(null);
    dispatch({
      ...decision,
      onError: () => {
        answeringRef.current = false;
        setAnswering(false);
        setError("That answer could not be delivered. Try again.");
      },
    });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    answer(custom);
  };

  return (
    <section
      aria-labelledby={titleId}
      aria-describedby={detailId}
      className="w-full max-w-[840px] border-y border-l-2 border-hairline border-l-accent bg-card px-4 py-4"
    >
      <span className="sr-only" role="status" aria-live="polite">
        {requester} is waiting for an answer in this crew workstream.
      </span>
      <p className="text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">
        Crew question · {settled ? "Answered" : answering ? "Answering" : "Answer required"}
      </p>
      <h3 id={titleId} className="mt-1 text-[16px] font-semibold text-ink">{requester} asks: {card.title}</h3>
      <p id={detailId} className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{card.subtitle}</p>
      {!settled && card.options.length > 0 && (
        <div role="group" aria-label="Answer choices" className="mt-3 grid gap-2 sm:grid-cols-2">
          {card.options.map((option) => (
            <button
              key={option}
              type="button"
              disabled={answering}
              onClick={() => answer(option)}
              className="min-h-10 rounded-md border border-hairline bg-inset px-3 py-2 text-left text-[13px] text-ink hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
            >
              {option}
            </button>
          ))}
        </div>
      )}
      {!settled && <form onSubmit={submit} className="mt-3 border-l-2 border-hairline pl-3">
        <label htmlFor={customId} className="text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">
          Answer in your own words
        </label>
        <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
          <input
            id={customId}
            value={custom}
            disabled={answering}
            onChange={(event) => setCustom(event.target.value)}
            className="min-h-10 min-w-0 flex-1 border border-hairline bg-inset px-3 py-2 text-[14px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-focus disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={answering || !custom.trim()}
            className="min-h-10 rounded-md bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
          >
            Send answer
          </button>
        </div>
      </form>}
      {settled && <p role="status" className="mt-3 text-[13px] text-success">Answer recorded. The crew run can continue.</p>}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </section>
  );
}

function groupScrollBehavior(): ScrollBehavior {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

function dayLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function DayMarker({ at }: { at: number }) {
  const label = `${dayLabel(at)} · ${formatTime(at)}`;
  return (
    <div role="separator" aria-label={label} className="flex items-center gap-3 py-4">
      <span aria-hidden="true" className="h-px flex-1 bg-hairline/70" />
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-secondary">{label}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-hairline/70" />
    </div>
  );
}

function crewResponseHint(group: Group, members: Bot[]): string {
  if (group.dm) return "Add the next entry to continue this operator exchange.";
  const route = effectiveDefaultResponder(group, members);
  if (route.kind === "everyone") return "An unaddressed entry mobilizes the full crew; name operators to narrow the route.";
  if (route.kind === "mentions") return "Name an operator with @ when the work is ready to move.";
  const lead = members.find((member) => member.id === route.botId)?.name ?? "The lead operator";
  return `${lead} holds the lead. Name another operator with @ to reroute the entry.`;
}

/** One finished tool step in a room. Same pill the 1:1 chat uses, minus the
 * status glyph — a room reads as a conversation, not a build log. */
function RoomToolChip({ message }: { message: Message }) {
  const tool = message.tool;
  if (!tool) return null;
  return (
    <div className="flex justify-start border-l border-hairline pl-3">
      <div
        className={cn(
          "flex min-w-0 items-baseline gap-2 border-y border-hairline/40 bg-panel px-3 py-2 text-[12px]",
          tool.ok === false ? "text-danger" : "text-ink-secondary",
        )}
      >
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em]">
          {tool.ok === false ? "Run fault" : "Method"}
        </span>
        <span className="max-w-[480px] truncate font-mono text-[12px]">{tool.name}</span>
      </div>
    </div>
  );
}

/** 16px sigil + name, shown once per sender cluster. */
function isSigilColor(value: string): value is Bot["color"] {
  return SIGIL_COLOR_NAMES.some((candidate) => candidate === value);
}

function ClusterLabel({ bot, name, color }: { bot?: Bot; name: string; color: string }) {
  const sigilColor = bot?.color ?? (isSigilColor(color) ? color : "petrol");
  return (
    <div className="mt-2 flex items-center gap-2 border-b border-hairline/60 pb-2">
      <SigilAvatar
        color={sigilColor}
        state={normalizeState(bot?.sigilExpression) ?? "happy"}
        size={20}
        motion="none"
        motionKey={0}
        animated={false}
        label={`${name}, operator`}
      />
      <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-secondary">Operator</span>
      <span className="text-[12px] font-semibold text-ink">{name}</span>
    </div>
  );
}

/** Pin toggle for one room message — one pin per room, patchGroup path. */
function PinToggle({ group, message }: { group: Group; message: Message }) {
  const { dispatch } = useStore();
  const pinned = group.pinnedMessageId === message.id;
  return (
    <button
      type="button"
      onClick={() =>
        dispatch({
          type: "patchGroup",
          groupId: group.id,
          patch: { pinnedMessageId: pinned ? "" : message.id },
        })
      }
      aria-label={pinned ? "Release held entry" : "Hold this entry"}
      className="flex size-7 items-center justify-center rounded-md text-ink-secondary opacity-100 transition-opacity hover:bg-raised hover:text-ink sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100"
      title={pinned ? "Release held entry" : "Hold this entry at the top of the workstream"}
    >
      {pinned ? <PinOff size={14} /> : <Pin size={14} />}
    </button>
  );
}

const Transcript = memo(function Transcript({
  group,
  members,
  messages,
  transcript,
  emergingId,
  onReply,
}: {
  group: Group;
  members: Bot[];
  /** The windowed suffix of group.messages — the boundary lives in GroupView. */
  messages: Message[];
  /** Full room transcript, used to resolve quoted messages outside the mounted window. */
  transcript: Message[];
  emergingId?: string | null;
  onReply: (message: Message) => void;
}) {
  const { state, dispatch } = useStore();
  const showToolCalls = showToolCallsEnabled(state.config);
  const memberOf = (id?: string) => members.find((b) => b.id === id);
  // Several bots working at once turn a room into a wall of chips; fold the
  // finished ones the same way a 1:1 chat does.
  const items = useMemo(() => groupActivityRuns(messages), [messages]);
  const focus = state.focusMessage;
  const focusedId = focus && !focus.consumed && focus.threadId === group.threadId ? focus.messageId : null;
  return (
    <>
      {items.map((item, i) => {
        const previous = items[i - 1];
        const prev = previous && (previous.kind === "run" ? previous.messages.at(-1) : previous.message);
        const first = item.kind === "run" ? item.messages[0] : item.message;
        const newDay = !prev || new Date(prev.at).toDateString() !== new Date(first.at).toDateString();
        if (item.kind === "run") {
          if (!showToolCalls) return null;
          const cluster = !prev || prev.role !== first.role || prev.from?.botId !== first.from?.botId || newDay;
          return (
            <div key={item.id} className="contents">
              {newDay && (
                <DayMarker at={first.at} />
              )}
              {first.from && cluster && (
                <ClusterLabel bot={memberOf(first.from.botId)} name={first.from.name} color={first.from.color} />
              )}
              <ActivityRun messages={item.messages} forceOpen={item.messages.some((step) => step.id === focusedId)}>
                {item.messages.map((step) => (
                  <div key={step.id} className="contents" data-mid={step.id}>
                    <RoomToolChip message={step} />
                  </div>
                ))}
              </ActivityRun>
            </div>
          );
        }
        const m = item.message;
        if (m.id === emergingId) return null;
        const user = m.role === "user";
        const attachedImages = user && m.text ? splitAttachedImages(m.text) : null;
        const newCluster = !prev || prev.role !== m.role || prev.from?.botId !== m.from?.botId || newDay;
        const routineOwner = m.kind === "routine.run" ? memberOf(m.from?.botId) : undefined;
        const routineExecutionThreadId = m.routineRun?.executionThreadId;
        const routineTarget = routineOwner && hasRoutineExecutionTask(routineOwner.tasks, routineExecutionThreadId)
          ? { botId: routineOwner.id, threadId: routineExecutionThreadId }
          : undefined;
        const row =
          // a member can hit a permission ask mid-turn; without this the
          // card never rendered here and the bot waited out its timeout.
          // `tool` distinguishes a permission from a QUESTION — a question
          // only accepts an "answer", so routing it here would offer an
          // Allow the broker rejects
          m.kind === "secret" && m.secret && m.from?.botId ? (
            <SecretRequestCard botId={m.from.botId} threadId={group.threadId} message={m} />
          ) : m.kind === "connector" && m.connector && m.from?.botId ? (
            <ConnectorCard botId={m.from.botId} threadId={group.threadId} message={m} />
          ) : m.kind === "options" && m.card?.requestId && m.card.tool ? (
            <div className="flex justify-start">
              <ApprovalCard bot={memberOf(m.from?.botId)} message={m} />
            </div>
          ) : m.kind === "options" && m.card?.requestId && !m.card.tool ? (
            <CrewQuestionCard threadId={group.threadId} message={m} />
          ) : m.kind === "routine.run" ? (
            <div className="flex justify-start">
              <RoutineRunCard
                message={m}
                onOpen={routineTarget
                  ? () => openNotificationTarget(dispatch, routineTarget, state)
                  : undefined}
              />
            </div>
          ) : m.kind === "activity" && m.tool ? (
            m.tool.ok === false || m.tool.name.startsWith("error:") || showToolCalls ? (
              <RoomToolChip message={m} />
            ) : null
          ) : m.kind === "text" && m.text ? (
            <div className={cn("group flex w-full flex-col", user ? "items-end" : "items-start")}>
              <div className={cn("flex w-full flex-wrap items-end gap-1.5", user ? "justify-end" : "justify-start")}>
                {user && <ReactionBar threadId={group.threadId} message={m} />}
                {user && (
                  <>
                    <button
                      type="button"
                      onClick={() => onReply(m)}
                      aria-label="Reply to workstream entry"
                      title="Reply to entry"
                      className="flex size-7 items-center justify-center rounded-md text-ink-secondary opacity-100 transition-opacity hover:bg-raised hover:text-ink sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100"
                    >
                      <MessageSquareReply size={14} />
                    </button>
                    <PinToggle group={group} message={m} />
                  </>
                )}
                <article
                  className={cn(
                    "w-fit max-w-[min(46rem,84%)] border-y px-4 py-3 text-[15px] leading-relaxed",
                    user
                      ? "border-hairline border-r-2 border-r-accent bg-raised whitespace-pre-wrap text-ink"
                      : "border-hairline border-l-2 bg-card text-ink",
                  )}
                  title={new Date(m.at).toLocaleString()}
                >
                  {m.replyToId && (() => {
                    const target = transcript.find((candidate) => candidate.id === m.replyToId);
                    return target ? (
                      <div className="mb-2">
                        <ReplyQuote
                          message={target}
                          fallbackName="Operator"
                          compact
                          onJump={() =>
                            dispatch({ type: "focusMessage", threadId: group.threadId, messageId: target.id })
                          }
                        />
                      </div>
                    ) : null;
                  })()}
                  {user ? (
                    <>
                      {attachedImages && attachedImages.images.length > 0 && (
                        <AttachedImageGallery paths={attachedImages.images} />
                      )}
                      {attachedImages?.display ?? m.text}
                    </>
                  ) : <ChatMarkdown text={m.text} />}
                </article>
                {!user && (
                  <>
                    <button
                      type="button"
                      onClick={() => onReply(m)}
                      aria-label="Reply to workstream entry"
                      title="Reply to entry"
                      className="flex size-7 items-center justify-center rounded-md text-ink-secondary opacity-100 transition-opacity hover:bg-raised hover:text-ink sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100"
                    >
                      <MessageSquareReply size={14} />
                    </button>
                    <PinToggle group={group} message={m} />
                    <ReactionBar threadId={group.threadId} message={m} />
                  </>
                )}
                <time
                  dateTime={new Date(m.at).toISOString()}
                  title={new Date(m.at).toLocaleString()}
                  className="self-end px-1 pb-1 text-[11px] tabular-nums text-ink-secondary/70 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100"
                >
                  {formatTime(m.at)}
                </time>
              </div>
              <ReactionChips threadId={group.threadId} message={m} members={members} align={user ? "right" : "left"} />
            </div>
          ) : null;
        if (!row) return null;
        return (
          <div key={m.id} className="contents" data-mid={m.id}>
            {newDay && (
              <DayMarker at={m.at} />
            )}
            {!user && m.from && newCluster && (
              <ClusterLabel bot={memberOf(m.from.botId)} name={m.from.name} color={m.from.color} />
            )}
            {row}
          </div>
        );
      })}
    </>
  );
});

function DefaultResponderSelect({ group, members }: { group: Group; members: Bot[] }) {
  const { dispatch } = useStore();
  const responder = effectiveDefaultResponder(group, members);
  const value = responder.kind === "member" ? `member:${responder.botId}` : responder.kind;
  const lead = responder.kind === "member" ? members.find((member) => member.id === responder.botId) : undefined;
  const title =
    responder.kind === "everyone"
      ? "Unaddressed entries mobilize the full crew; @mentions narrow the route"
      : responder.kind === "mentions"
        ? "Only explicitly @mentioned operators take the work"
        : `Unaddressed entries route to ${lead?.name ?? "the lead operator"}; @mentions override the route`;

  const change = (nextValue: string) => {
    let next: GroupDefaultResponder;
    if (nextValue === "everyone") next = { kind: "everyone" };
    else if (nextValue === "mentions") next = { kind: "mentions" };
    else next = { kind: "member", botId: nextValue.slice("member:".length) };
    dispatch({ type: "patchGroup", groupId: group.id, patch: { defaultResponder: next } });
  };

  return (
    <div className="relative shrink-0" title={title}>
      <select
        aria-label="Crew routing"
        value={value}
        onChange={(event) => change(event.target.value)}
        className="h-8 max-w-[210px] appearance-none truncate border border-hairline bg-raised py-1 pl-3 pr-7 text-[12px] font-semibold text-ink outline-none hover:bg-raised-hover focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25"
      >
        <optgroup label="Lead operator">
          {members.map((member) => (
            <option key={member.id} value={`member:${member.id}`}>
              Lead operator · {member.name}
            </option>
          ))}
        </optgroup>
        <optgroup label="Crew routing">
          <option value="everyone">Full crew mobilizes</option>
          <option value="mentions">Named operators only</option>
        </optgroup>
      </select>
      <ChevronDown
        size={13}
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-secondary"
      />
    </div>
  );
}

/** The room's shared desk: where every member's shell and file tools run,
 * overriding each bot's own folder for room turns. The room pins its own
 * copy on its first turn (the server does the pinning — engines key their
 * sessions to the folder a thread starts in, so a folder must not move
 * under a room that already worked somewhere). The PATCH is made directly
 * rather than through patchGroup: the server validates the path and a
 * rejected folder must not stick in local state. */
function RoomWorkingFolder({ group }: { group: Group }) {
  const { dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host.homeDir;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canPick = Boolean(window.helmryth?.pickFolder);
  const pinned = group.pinnedCwd; // undefined = not yet, null = each bot's own, string = folder
  const locked = pinned !== undefined;
  const shownCwd = locked ? (pinned ?? undefined) : group.cwd;

  const save = async (cwd: string | null) => {
    setSaving(true);
    setError(null);
    try {
      // Apply the group the server actually returned. Discarding it left the chip
      // and the field showing the old folder until a reload — so clearing the
      // crew's shared folder looked like it had not happened, while every
      // operator's shell and file tools had already moved to their own.
      // SAFETY: PATCH /api/groups/:id answers { group } (server/index.ts:5570); the
      // dispatch below tolerates a partial group and ignores a missing one.
      const response = (await api(`/api/groups/${group.id}`, {
        method: "PATCH",
        body: JSON.stringify({ cwd }),
      })) as { group?: Partial<Group> & { id: string } };
      if (response.group) dispatch({ type: "groupPatched", group: response.group });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const pick = async () => {
    const chosen = await window.helmryth?.pickFolder?.(group.cwd);
    if (chosen) void save(chosen);
  };

  return (
    <section aria-labelledby="crew-workbench-title" className="border-y border-hairline bg-card px-4 py-4">
      <div className="flex items-baseline justify-between gap-4 border-b border-hairline/60 pb-3">
        <div>
          <h2 id="crew-workbench-title" className="text-[14px] font-semibold text-ink">Crew workbench</h2>
          <p className="mt-0.5 text-[12px] text-ink-secondary">Shared file and shell ground for every operator in this workstream.</p>
        </div>
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-secondary">
          {locked ? "Bound" : "Ready to bind"}
        </span>
      </div>
      {locked ? (
        <div className="mt-3">
          <div className="truncate border-l-2 border-accent bg-inset px-3 py-2 font-mono text-[12px] text-ink" title={shownCwd}>
            {shownCwd ? shortPath(shownCwd, home) : <span className="text-ink-secondary">Each operator’s own workbench</span>}
          </div>
          <div className="mt-2 text-[12px] text-ink-secondary">
            Bound after the run begins. Start a new run to move the workbench.
          </div>
        </div>
      ) : canPick ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate border border-hairline bg-inset px-3 py-2 font-mono text-[12px] text-ink" title={group.cwd}>
            {group.cwd ? shortPath(group.cwd, home) : <span className="text-ink-secondary">Each operator’s own workbench</span>}
          </div>
          <button type="button" onClick={() => void pick()} disabled={saving} className="flex shrink-0 items-center gap-1.5 border border-hairline bg-raised px-3 py-2 text-[12px] font-semibold text-ink hover:bg-raised-hover disabled:opacity-50">
            <FolderOpen size={14} /> Set ground…
          </button>
          {group.cwd && (
            <button type="button" onClick={() => void save(null)} disabled={saving} className="shrink-0 px-2 py-2 text-[12px] font-semibold text-ink-secondary hover:text-ink disabled:opacity-50">
              Use operator grounds
            </button>
          )}
        </div>
      ) : (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            // an emptied field clears the folder — the server wants null
            void save((draft ?? group.cwd ?? "").trim() || null);
          }}
        >
          <input
            aria-label="Crew workbench path"
            className="w-full border border-hairline bg-inset px-3 py-2.5 font-mono text-[12px] text-ink placeholder:text-ink-secondary focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
            placeholder="Each operator’s own ground — or an absolute path"
            value={draft ?? group.cwd ?? ""}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" disabled={saving || draft === null} className="shrink-0 border border-hairline bg-raised px-3 py-2 text-[12px] font-semibold text-ink hover:bg-raised-hover disabled:opacity-50">
            Bind
          </button>
        </form>
      )}
      {error && <div role="alert" className="mt-2 border-l-2 border-danger bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
    </section>
  );
}

/** The folder this room's turns run in — the pinned folder once a turn ran,
 * else the room folder a first turn would pin. Always present so the desk
 * is settable before any folder exists; quiet (icon only) until then. */
function RoomWorkingFolderChip({ group, onToggle }: { group: Group; onToggle: () => void }) {
  const folder = group.pinnedCwd === undefined ? group.cwd : (group.pinnedCwd ?? undefined);
  if (!folder) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-label="Set crew workbench"
        className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
        title="Set crew workbench"
      >
        <Folder size={14} />
      </button>
    );
  }
  const name = folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={`Crew workbench: ${folder}`}
      className="flex max-w-[180px] items-center gap-1.5 border border-hairline bg-raised px-2.5 py-1 text-[12px] text-ink-secondary hover:bg-raised-hover hover:text-ink"
      title={`Crew workbench: ${folder}`}
    >
      <Folder size={12} />
      <span className="truncate font-mono">{name}</span>
    </button>
  );
}


type RoomSetupFields = {
  setupPending?: boolean;
  setupRequired?: boolean;
  setupState?: "required" | "completed" | "skipped";
  setupCompletedAt?: number | string | null;
  setupSkippedAt?: number | string | null;
};

type RoomResponderMode = "lead" | "everyone" | "mentions";

function setupResponderMode(responder: GroupDefaultResponder): RoomResponderMode {
  return responder.kind === "member" ? "lead" : responder.kind;
}

function roomNeedsSetup(group: Group): boolean {
  if (group.dm || group.messages.length > 0) return false;
  // SAFETY: setup fields are additive server metadata; the existing Group shape remains valid when absent.
  const marker = group as Group & RoomSetupFields;
  const hasSetupMarker =
    Object.prototype.hasOwnProperty.call(marker, "setupCompletedAt") ||
    Object.prototype.hasOwnProperty.call(marker, "setupSkippedAt");
  // Legacy empty rooms omit both keys and remain immediately usable.
  if (!hasSetupMarker) return false;
  if (
    marker.setupPending === false ||
    marker.setupRequired === false ||
    marker.setupState === "completed" ||
    marker.setupState === "skipped" ||
    marker.setupCompletedAt != null ||
    marker.setupSkippedAt != null
  ) {
    return false;
  }
  return true;
}

function RoomSetup({ group, members }: { group: Group; members: Bot[] }) {
  const { dispatch } = useStore();
  const [folder, setFolder] = useState(group.cwd ?? "");
  const [behavior, setBehavior] = useState<RoomResponderMode>(setupResponderMode(group.defaultResponder));
  const [leadId, setLeadId] = useState(
    group.defaultResponder.kind === "member" ? group.defaultResponder.botId : members[0]?.id ?? "",
  );
  const [instructions, setInstructions] = useState(group.bulletin);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const responder = (): GroupDefaultResponder => {
    if (behavior === "everyone") return { kind: "everyone" };
    if (behavior === "mentions") return { kind: "mentions" };
    return members.some((member) => member.id === leadId)
      ? { kind: "member", botId: leadId }
      : group.defaultResponder;
  };

  const finish = async (action: "complete" | "skip") => {
    setSaving(true);
    setError(null);
    try {
      const payload =
        action === "skip"
          ? { action }
          : {
              action,
              cwd: folder.trim() || null,
              defaultResponder: responder(),
              bulletin: instructions,
            };
      const result = await api(`/api/groups/${group.id}/setup`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      const now = Date.now();
      const nextGroup = {
        ...(result.group ?? group),
        id: group.id,
        setupPending: false,
        ...(action === "skip" ? { setupSkippedAt: now } : { setupCompletedAt: now }),
      };
      dispatch({ type: "groupPatched", group: nextGroup });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const pickFolder = async () => {
    const chosen = await window.helmryth?.pickFolder?.(folder || group.cwd);
    if (chosen) setFolder(chosen);
  };

  return (
    <section
      data-testid="crew-setup"
      aria-labelledby="crew-setup-title"
      className="relative z-20 mx-auto w-full max-w-5xl border-y border-hairline bg-card"
    >
      <header className="grid gap-4 border-b border-hairline bg-panel px-5 py-5 sm:grid-cols-[8rem_1fr] sm:px-7 sm:py-7">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-accent">01 / Crew bearing</div>
        <div>
          <h1 id="crew-setup-title" className="text-2xl font-semibold tracking-tight text-ink">Compose {group.name}</h1>
          <p className="mt-2 max-w-[620px] text-[13px] leading-relaxed text-ink-secondary">
            Set the workbench, route unaddressed work, and write the standing brief before the first run moves.
          </p>
        </div>
      </header>
      <form
        className="grid gap-6 px-5 py-6 sm:grid-cols-[8rem_1fr] sm:px-7 sm:py-7"
        onSubmit={(event) => {
          event.preventDefault();
          void finish("complete");
        }}
      >
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-secondary">Ground</div>
        <label className="block">
          <span className="text-[13px] font-semibold text-ink">Workbench root</span>
          <span className="mt-1 block text-[12px] text-ink-secondary">The shared file and shell ground used by this crew.</span>
          <div className="mt-3 flex gap-2">
            <input
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              placeholder="Use each operator’s own ground"
              className="min-w-0 flex-1 border border-hairline bg-inset px-3 py-2.5 text-[12px] text-ink placeholder:text-ink-secondary focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
            />
            {window.helmryth?.pickFolder && (
              <button
                type="button"
                onClick={() => void pickFolder()}
                disabled={saving}
                className="flex shrink-0 items-center gap-1.5 border border-hairline bg-raised px-3 py-2 text-[12px] font-semibold text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                <FolderOpen size={14} /> Set ground
              </button>
            )}
          </div>
        </label>

        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-secondary">Routing</div>
        <fieldset disabled={saving}>
          <legend className="text-[13px] font-semibold text-ink">Unaddressed work</legend>
          <p className="mt-1 text-[12px] text-ink-secondary">Choose who takes an entry when no operator is named.</p>
          <div className="mt-3 grid gap-px overflow-hidden border border-hairline bg-hairline sm:grid-cols-3">
            {([
              ["lead", "Lead operator", "One accountable owner"],
              ["everyone", "Full crew", "Every operator mobilizes"],
              ["mentions", "Named only", "Wait for an @mention"],
            ] as const).map(([value, label, note]) => (
              <label
                key={value}
                className={cn(
                  "flex cursor-pointer gap-3 bg-card px-3 py-3 text-left",
                  behavior === value ? "border-t-2 border-accent bg-accent/10" : "border-t-2 border-transparent hover:bg-raised",
                )}
              >
                <input
                  type="radio"
                  name="crew-routing"
                  value={value}
                  checked={behavior === value}
                  onChange={() => setBehavior(value)}
                  className="mt-0.5 size-4 rounded-sm accent-[var(--color-accent)] outline-none focus:ring-2 focus:ring-focus focus:ring-offset-2"
                />
                <span>
                  <span className="block text-[12px] font-semibold text-ink">{label}</span>
                  <span className="mt-1 block text-[11px] leading-snug text-ink-secondary">{note}</span>
                </span>
              </label>
            ))}
          </div>
          {behavior === "lead" && (
            <label className="mt-3 grid gap-2 border-l-2 border-accent bg-inset px-3 py-3 sm:grid-cols-[8rem_1fr] sm:items-center">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">Lead operator</span>
              <select
                value={leadId}
                onChange={(event) => setLeadId(event.target.value)}
                disabled={members.length === 0}
                className="min-w-0 border border-hairline bg-raised px-3 py-2 text-[12px] font-semibold text-ink focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:opacity-50"
              >
                {members.length === 0 && <option value="">No operator assigned</option>}
                {members.map((member) => (
                  <option key={member.id} value={member.id}>{member.name} · {member.title || "Operator"}</option>
                ))}
              </select>
            </label>
          )}
        </fieldset>

        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-secondary">Standing brief</div>
        <label className="block">
          <span className="text-[13px] font-semibold text-ink">Crew directive</span>
          <span className="mt-1 block text-[12px] text-ink-secondary">Every operator reads this before taking a turn. It remains editable.</span>
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={5}
            placeholder="Outcome, ownership, constraints, evidence standard…"
            className="mt-3 w-full resize-y border border-hairline bg-inset px-3 py-2.5 text-[13px] leading-relaxed text-ink placeholder:text-ink-secondary focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
          />
        </label>

        <div aria-hidden="true" />
        <div>
          {error && <div role="alert" className="mb-4 border-l-2 border-danger bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
          <div className="flex flex-col-reverse gap-2 border-t border-hairline pt-4 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={() => void finish("skip")}
            disabled={saving}
            className="px-3 py-2 text-left text-[12px] font-semibold text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
          >
            Open without a bearing
          </button>
          <button
            type="submit"
            disabled={saving}
            className="flex items-center justify-center gap-2 bg-accent px-4 py-2.5 text-[12px] font-semibold hover:brightness-95 disabled:opacity-50"
          >
            {saving && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />}
            Set bearing
          </button>
          </div>
        </div>
      </form>
    </section>
  );
}
export function GroupView({ group }: { group: Group }) {
  const { state, dispatch } = useStore();
  const stream = useStreaming();
  const streaming = stream.streaming[group.threadId];
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerDock = useComposerDockPad(composerDockRef);
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  const previousScrollTop = useRef(0);
  const touchY = useRef(0);
  const [bulletinOpen, setBulletinOpen] = useState(false);
  const [bulletinDraft, setBulletinDraft] = useState(group.bulletin);
  const [folderOpen, setFolderOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const findTriggerRef = useRef<HTMLButtonElement>(null);
  const { replyTo, selectReply, clearReply, consumeReply, restoreReply } = useReplyDraft(
    group.threadId,
    `group:${group.id}:${group.threadId}`,
    group.messages,
  );
  const membersTriggerRef = useRef<HTMLButtonElement>(null);
  const closeMembers = useCallback(() => setMembersOpen(false), []);
  useEffect(() => setFindOpen(false), [group.threadId]);
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

  const members = useMemo(
    () => group.memberIds.map((id) => state.bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b)),
    [group.memberIds, state.bots],
  );
  const speaker = members.find((b) => b.id === group.busyBotId);
  const setupPending = roomNeedsSetup(group);

  // Sigil stays while a member works; the finished reply pops in above it.
  const lastGroupMessage = group.messages.at(-1);
  const toolInFlight = lastGroupMessage?.kind === "activity" && lastGroupMessage.tool?.ok === undefined;
  const activityLabel = liveActivityLabel(lastGroupMessage);
  const waiting = Boolean(
    speaker && showWorkingDots(true, undefined, group.messages.at(-1), speaker.id),
  );
  const wasWaiting = useRef(false);
  const [popping, setPopping] = useState<{ id: string; text: string; botId?: string } | null>(null);
  useEffect(() => {
    wasWaiting.current = false;
    setPopping(null);
  }, [group.id, group.threadId]);
  useEffect(() => {
    if (waiting) wasWaiting.current = true;
  }, [waiting]);
  useEffect(() => {
    if (lastGroupMessage?.role !== "bot" || lastGroupMessage.kind !== "text" || !wasWaiting.current) return;
    wasWaiting.current = false;
    if (groupScrollBehavior() === "auto") {
      setPopping(null);
      return;
    }
    setPopping({
      id: lastGroupMessage.id,
      text: lastGroupMessage.text ?? "",
      botId: lastGroupMessage.from?.botId,
    });
    const timer = setTimeout(() => setPopping(null), 520);
    return () => clearTimeout(timer);
  }, [
    lastGroupMessage?.id,
    lastGroupMessage?.role,
    lastGroupMessage?.kind,
    lastGroupMessage?.text,
    lastGroupMessage?.from?.botId,
  ]);
  const presenceVisible = waiting || popping !== null;
  const presenceSpeaker = speaker ?? members.find((member) => member.id === popping?.botId) ?? members[0];

  // Windowed transcript, mirroring ChatView: only a tail of the room mounts;
  // the anchored boundary re-tails on a render-phase reset when the room (or
  // its thread) changes. Working dots below stay on the FULL list's tail.
  const transcriptKey = `${group.id}:${group.threadId}`;
  const [transcriptWindow, setTranscriptWindow] = useState<{
    key: string;
    start: number;
    end: number | null;
  }>(() => ({
    key: transcriptKey,
    start: tailWindowStart(group.messages.length),
    end: null,
  }));
  if (transcriptWindow.key !== transcriptKey) {
    setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(group.messages.length), end: null });
  }
  const {
    visible: windowedMessages,
    hiddenCount,
    laterCount,
    startIndex,
    endIndex,
  } = useMemo(
    () => resolveTranscriptWindow(group.messages, transcriptWindow.start, TRANSCRIPT_WINDOW_SIZE, transcriptWindow.end),
    [group.messages, transcriptWindow.start, transcriptWindow.end],
  );

  const setBottomFollow = useCallback((next: boolean) => {
    followRef.current = next;
    setFollow(next);
  }, []);

  useEffect(() => setBottomFollow(true), [group.id, setBottomFollow]);

  const appliedFocus = useRef<number | null>(null);
  useEffect(() => {
    const focus = state.focusMessage;
    if (!focus || focus.consumed || focus.threadId !== group.threadId || appliedFocus.current === focus.nonce) return;
    const targetIndex = group.messages.findIndex((message) => message.id === focus.messageId);
    if (targetIndex < 0) return;
    appliedFocus.current = focus.nonce;
    const range = focusWindowRange(group.messages.length, targetIndex);
    setBottomFollow(false);
    setTranscriptWindow({ key: transcriptKey, start: range.start, end: range.end });
  }, [group.messages, group.threadId, setBottomFollow, state.focusMessage, transcriptKey]);
  useFocusMessage(group.threadId, group.messages.length > 0);

  useEffect(() => setBulletinDraft(group.bulletin), [group.id, group.bulletin]);
  // an open folder editor belongs to the room it was opened in
  useEffect(() => setFolderOpen(false), [group.id]);
  useEffect(() => setMembersOpen(false), [group.id]);
  // deps track the FULL messages.length, so expanding the window (which only
  // changes windowedMessages) can never re-trigger this bottom scrollTo.
  // `follow` is intentionally omitted — see ChatView.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    el.scrollTo({ top: el.scrollHeight });
    previousScrollTop.current = el.scrollTop;
  }, [group.id, group.messages.length, streaming, group.busyBotId, composerDock.pad]);

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
    const nextEnd = Math.min(group.messages.length, endIndex + TRANSCRIPT_WINDOW_SIZE);
    setTranscriptWindow((w) => ({ ...w, end: nextEnd >= group.messages.length ? null : nextEnd }));
  };

  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_FOLLOW_THRESHOLD;
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === "PageUp"
        || (event.key === "Home" && !(event.target instanceof HTMLTextAreaElement))
      ) {
        setBottomFollow(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setBottomFollow]);

  const saveBulletin = () => {
    setBulletinOpen(false);
    if (bulletinDraft !== group.bulletin) {
      dispatch({ type: "patchGroup", groupId: group.id, patch: { bulletin: bulletinDraft } });
    }
  };

  // Static sigils: one per operator, with a command notch on whoever is moving the run.
  const memberSigiles = members.map((b) => (
    <span
      key={b.id}
      title={`${b.name}${group.busyBotId === b.id ? " — moving the run" : " — standing by"}`}
      className={cn(
        "relative inline-flex border bg-raised p-0.5",
        group.busyBotId === b.id ? "border-accent" : "border-hairline",
      )}
    >
      <SigilAvatar
        color={b.color}
        state={normalizeState(b.sigilExpression) ?? "happy"}
        size={24}
        animated={false}
        label={`${b.name}, ${group.busyBotId === b.id ? "moving the run" : "standing by"}`}
      />
      {group.busyBotId === b.id && (
        <span aria-hidden="true" className="absolute -right-px -top-px h-2 w-3 bg-accent" />
      )}
    </span>
  ));

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <GroupCallOverlay group={group} members={members} />
      {membersOpen && !group.dm && (
        <ManageMembersPanel group={group} onClose={closeMembers} triggerRef={membersTriggerRef} />
      )}
      {/* Crew masthead: title, workstream controls, and the live operator roster. */}
      <header
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 border-b border-hairline bg-panel px-5 py-3",
          // Room for the drawer button, which overlays this corner below md.
          "pl-11 md:pl-5",
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="h-8 w-1 shrink-0 bg-accent" />
          <div className="min-w-0">
            <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">
              {group.dm ? "Operator exchange" : "Crew workstream"}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2">
              <h1 className="truncate text-[16px] font-semibold text-ink">{group.name}</h1>
              {!setupPending && !group.dm && <GroupTaskPicker group={group} />}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <button
            ref={findTriggerRef}
            type="button"
            onClick={() => setFindOpen((open) => !open)}
            aria-label="Find in workstream"
            aria-pressed={findOpen}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              findOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title="Find in workstream (⌘F)"
          >
            <Search size={18} />
          </button>
          <GroupCallButton group={group} members={members} />
          {!setupPending && !group.dm && <RoomWorkingFolderChip group={group} onToggle={() => setFolderOpen((open) => !open)} />}
          {!setupPending && !group.dm && <DefaultResponderSelect group={group} members={members} />}
          {group.dm ? (
            memberSigiles
          ) : (
            // The roster stays in the masthead so ownership is always legible.
            <button
              ref={membersTriggerRef}
              type="button"
              onClick={() => setMembersOpen(true)}
              title="Edit crew roster"
              aria-label={`Edit crew roster — ${members.length} ${members.length === 1 ? "operator" : "operators"}`}
              className="flex items-center gap-1 border border-transparent p-0.5 hover:border-hairline hover:bg-raised"
            >
              {memberSigiles}
              <span className="flex size-6 items-center justify-center border-l border-dashed border-hairline text-ink-secondary">
                <Plus size={11} />
              </span>
            </button>
          )}
        </div>
      </header>

      {findOpen && (
        <ChatFindBar
          threadId={group.threadId}
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

      {/* Standing brief: a ruled directive every operator receives. */}
      {!setupPending && <div className="w-full px-5">
        {bulletinOpen ? (
          <div className="mb-2 border-y border-hairline bg-panel px-3 py-3">
            <label htmlFor="crew-standing-brief" className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.12em] text-accent">
              Standing brief
            </label>
            <textarea
              id="crew-standing-brief"
              autoFocus
              value={bulletinDraft}
              onChange={(e) => setBulletinDraft(e.target.value)}
              onBlur={saveBulletin}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveBulletin();
                if (e.key === "Escape") {
                  setBulletinDraft(group.bulletin);
                  setBulletinOpen(false);
                }
              }}
              placeholder="Outcome, ownership, constraints, evidence standard…"
              rows={4}
              className="w-full resize-none border-l-2 border-hairline bg-transparent pl-3 text-[13px] leading-relaxed text-ink placeholder:text-ink-secondary focus-visible:border-accent focus-visible:outline-none"
            />
          </div>
        ) : (
          <button
            onClick={() => setBulletinOpen(true)}
            className="mb-2 grid w-full grid-cols-[auto_1fr] items-center gap-3 border-b border-hairline px-2 py-2 text-left hover:bg-raised/50"
            title="Edit the standing brief shared by every operator"
          >
            <span className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-accent">
              <Pin size={11} aria-hidden="true" /> Brief
            </span>
            <span className={cn("truncate text-[12px]", group.bulletin ? "text-ink-secondary" : "text-ink-secondary/70")}>
              {group.bulletin.split("\n")[0] || "Write the crew’s standing directive"}
            </span>
          </button>
        )}
      </div>}

      {/* Working folder card — the chip in the header toggles it */}
      {!setupPending && folderOpen && !group.dm && (
        <div className="w-full px-5">
          <div className="mb-1">
            <RoomWorkingFolder group={group} />
          </div>
        </div>
      )}

      {/* Held entry — resolves against the crew's full workstream. */}
      {(() => {
        const pinned = group.messages.find((m) => m.id === group.pinnedMessageId && m.kind === "text");
        const text = pinned ? (pinned.text ?? "").replace(/\s+/g, " ").trim() : "";
        if (!pinned || !text) return null;
        const sender = pinned.role === "user" ? "You" : (pinned.from?.name ?? "An operator");
        return (
          <div className="w-full px-5">
            <div className="mb-2 grid grid-cols-[auto_1fr_auto] items-center gap-3 border-y border-accent/40 bg-accent/[0.07] px-3 py-2">
              <Pin size={12} className="shrink-0 text-accent" />
              <button
                onClick={() => dispatch({ type: "focusMessage", threadId: group.threadId, messageId: pinned.id })}
                className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
                title="Jump to the held entry"
              >
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.1em] text-accent">Held · {sender}</span>
                <span className="truncate text-[12px] text-ink-secondary">{text}</span>
              </button>
              <button
                onClick={() => dispatch({ type: "patchGroup", groupId: group.id, patch: { pinnedMessageId: "" } })}
                aria-label="Release held entry"
                title="Release held entry"
                className="flex size-7 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"
              >
                <X size={13} />
              </button>
            </div>
          </div>
        );
      })()}

      <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        className="h-full overflow-x-hidden overflow-y-auto px-5 [overflow-anchor:none]"
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
        {setupPending ? (
          <div className="flex min-h-full w-full items-center py-8">
            <RoomSetup group={group} members={members} />
          </div>
        ) : (
        <div
          className="flex w-full flex-col gap-3"
          style={{ paddingBottom: composerDock.pad }}
          role="log"
          aria-live="polite"
          aria-label={`${group.name} crew workstream`}
        >
          {group.messages.length === 0 && (
            <section aria-labelledby="empty-workstream-title" className="mx-auto my-auto grid w-full max-w-3xl gap-6 border-y border-hairline bg-card px-5 py-8 sm:grid-cols-[9rem_1fr] sm:px-7">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-accent">Workstream / Ready</div>
                <div className="mt-4 flex flex-wrap gap-1.5" aria-label={`${members.length} operators assigned`}>
                  {members.slice(0, 4).map((b) => (
                    <span key={b.id} className="border border-hairline bg-raised p-0.5">
                      <SigilAvatar
                        color={b.color}
                        state="happy"
                        size={28}
                        motion="none"
                        motionKey={0}
                        animated={false}
                        label={`${b.name}, operator`}
                      />
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <h2 id="empty-workstream-title" className="text-xl font-semibold tracking-tight text-ink">Set the first run in motion.</h2>
                <p className="mt-2 max-w-[520px] text-[13px] leading-relaxed text-ink-secondary">
                  {crewResponseHint(group, members)}
                </p>
                <div className="mt-5 border-l-2 border-hairline pl-3 text-[12px] text-ink-secondary">
                  State the outcome, name the evidence you expect, and make any gate explicit.
                </div>
              </div>
            </section>
          )}
          {hiddenCount > 0 && (
            <div className="flex justify-center pt-2">
              <button
                onClick={showEarlier}
                className="border-b border-hairline bg-panel px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                Reveal earlier entries · {hiddenCount}
              </button>
            </div>
          )}
          <Transcript
            group={group}
            members={members}
            messages={windowedMessages}
            transcript={group.messages}
            emergingId={popping?.id}
            onReply={selectReply}
          />
          {laterCount > 0 && (
            <div className="flex justify-center">
              <button
                onClick={showLater}
                className="border-t border-hairline bg-panel px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                Reveal later entries · {laterCount}
              </button>
            </div>
          )}
          {(speaker || presenceVisible) && (
            <TurnPresence
              avatar={
                <SigilAvatar
                  color={presenceSpeaker?.color ?? "green"}
                  state={toolInFlight ? "working" : "thinking"}
                  size={36}
                  forward={false}
                  lookAround={1}
                  trackPointer={false}
                />
              }
              visible={presenceVisible}
              label={activityLabel}
              answering={popping !== null}
            >
              {popping ? (
                <div className="w-fit max-w-[min(46rem,84%)] border border-l-2 border-hairline bg-card px-4 py-3 text-[15px] leading-relaxed text-ink">
                  <ChatMarkdown text={popping.text} />
                </div>
              ) : null}
            </TurnPresence>
          )}
        </div>
        )}
      </div>

      {!follow && (
        <button
          onClick={() => {
            setBottomFollow(true);
            setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(group.messages.length), end: null });
            requestAnimationFrame(() => {
              scrollRef.current?.scrollTo({
                top: scrollRef.current.scrollHeight,
                behavior: groupScrollBehavior(),
              });
            });
          }}
          aria-label="Jump to latest workstream entry"
          className="motion-safe:animate-pop-in absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 border border-hairline bg-raised px-3 py-1.5 text-[12px] font-semibold text-ink shadow-sm hover:bg-raised-hover"
          style={{ bottom: composerDock.height }}
        >
          <ArrowDown size={13} /> Latest entry
        </button>
      )}

      <div ref={composerDockRef} className="absolute inset-x-0 bottom-0 z-[2]">
      <Composer
        key={group.threadId}
        group={group}
        members={members}
        locked={setupPending}
        replyTo={replyTo}
        onClearReply={clearReply}
        onConsumeReply={consumeReply}
        onRestoreReply={restoreReply}
      />
      </div>
      </div>
    </main>
  );
}
