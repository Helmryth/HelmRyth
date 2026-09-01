// Crew voice line — one microphone, several operators.
//
// Capture stays half-duplex for the same reason as one-to-one calls: the
// native recognizer has no acoustic echo cancellation. Bot replies are
// explicitly queued so a fast second member never cuts off the first.
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, PhoneOff, X } from "lucide-react";

import { currentCall, deferCallCleanup, endCall, useOnCall } from "@/lib/call";
import { routeSpokenGroupMessage } from "@/lib/group-call";
import { track } from "@/lib/analytics";
import { normalizeState } from "@/lib/sigil";
import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
import { usePushToTalk } from "@/lib/push-to-talk";
import { useStore, type Bot, type Group, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { SigilAvatar } from "./Avatar";
import { CallTargetButton, trapVoiceLineFocus } from "./CallView";
import { parseSpokenGateDecision } from "@/lib/voice-gate";
import { isRoutineApproval, pendingApprovals, spokenApprovalPrompt } from "./PendingApproval";

const CALL_ENDPOINT_MS = 850;

type Phase = "listening" | "sending" | "working" | "speaking";

export function GroupCallButton({ group, members }: { group: Group; members: Bot[] }) {
  if (group.dm) return null;
  return (
    <CallTargetButton
      targetId={group.id}
      targetName={group.name}
      voices={members.map((member) => member.voice)}
      setupBotId={members.find((member) => !member.voice)?.id ?? members[0]?.id}
      requireExplicitVoices
      onStart={() => track("group_call_started", { memberCount: members.length })}
    />
  );
}

export function GroupCallOverlay({ group, members }: { group: Group; members: Bot[] }) {
  const active = useOnCall() === group.id;
  if (!active) return null;
  return <GroupCall group={group} members={members} />;
}

function questionIn(messages: Message[]): Message | undefined {
  return messages.find(
    (message) =>
      message.kind === "options" &&
      message.card?.requestId &&
      !message.card.tool &&
      !message.card.answered &&
      !message.card.dismissed,
  );
}

function GroupCall({ group, members }: { group: Group; members: Bot[] }) {
  const { dispatch } = useStore();
  const speech = useSpeech();
  const initialPhase: Phase = group.busyBotId ? "working" : "listening";
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [heard, setHeard] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [speakingMemberId, setSpeakingMemberId] = useState<string | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const pushToTalk = usePushToTalk(group.id, phase === "listening", () => {
    setNote("Push to talk couldn't start. Check Microphone and Speech Recognition access.");
  });

  const messages = group.messages;
  const approval = pendingApprovals(messages)[0];
  const question = questionIn(messages);
  const busyAtStart = useRef(group.busyBotId);
  const approvalAtStart = useRef(approval);
  const questionAtStart = useRef(question);
  const membersRef = useRef(members);
  const busyRef = useRef(Boolean(group.busyBotId));
  const defaultResponderRef = useRef(group.defaultResponder);
  membersRef.current = members;
  busyRef.current = Boolean(group.busyBotId);
  defaultResponderRef.current = group.defaultResponder;

  const spokenIds = useRef<Set<string>>(new Set());
  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    for (const message of messages) spokenIds.current.add(message.id);
  }

  const askedApproval = useRef<{
    requestId: string;
    member?: Bot;
    routine: boolean;
    submitted: boolean;
  } | null>(null);
  const askedQuestion = useRef<{ requestId: string; member?: Bot; submitted: boolean } | null>(null);
  const phaseRef = useRef<Phase>(initialPhase);
  const alive = useRef(true);
  const sayGeneration = useRef(0);
  const queueGeneration = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const queuedJobs = useRef(new Set<number>());
  const nextJobId = useRef(0);
  const listenWhenDrained = useRef(false);
  const listenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const allowBargeIn = useRef(false);

  const move = useCallback((next: Phase) => {
    phaseRef.current = next;
    if (alive.current) setPhase(next);
  }, []);

  const hush = useCallback(() => {
    void window.helmryth?.speechStop();
  }, []);

  const listen = useCallback(() => {
    if (!alive.current || currentCall() !== group.id) return;
    move("listening");
    setSpeakingMemberId(null);
    setHeard("");
    setNote(null);
    void window.helmryth?.speechStart({ endpointMs: CALL_ENDPOINT_MS }).catch(() => {
      if (alive.current && currentCall() === group.id) {
        setNote("The microphone couldn't start. Check Microphone and Speech Recognition access.");
      }
    });
  }, [group.id, move]);

  const scheduleListen = useCallback(
    (force = false, delay = 140) => {
      if (listenTimer.current) clearTimeout(listenTimer.current);
      listenTimer.current = setTimeout(() => {
        listenTimer.current = null;
        if (!alive.current || currentCall() !== group.id || queuedJobs.current.size) return;
        if (force || allowBargeIn.current || !busyRef.current) listen();
      }, delay);
    },
    [group.id, listen],
  );

  const say = useCallback(
    async (text: string, member?: Bot) => {
      if (!alive.current || currentCall() !== group.id) return false;
      const mine = ++sayGeneration.current;
      move("speaking");
      setSpeakingMemberId(member?.id ?? null);
      hush();
      await speaker.speak(text, { botId: member?.id, voiceId: member?.voice });
      return alive.current && currentCall() === group.id && sayGeneration.current === mine;
    },
    [group.id, hush, move],
  );

  const enqueueSpeech = useCallback(
    (text: string, member?: Bot, answerAfter = false) => {
      const generation = queueGeneration.current;
      const jobId = ++nextJobId.current;
      queuedJobs.current.add(jobId);
      if (answerAfter) listenWhenDrained.current = true;
      queue.current = queue.current
        .catch(() => {})
        .then(async () => {
          if (generation !== queueGeneration.current) return;
          await say(text, member);
        })
        .finally(() => {
          if (generation !== queueGeneration.current) return;
          queuedJobs.current.delete(jobId);
          if (queuedJobs.current.size) return;
          setSpeakingMemberId(null);
          const force = listenWhenDrained.current;
          listenWhenDrained.current = false;
          scheduleListen(force);
        });
    },
    [say, scheduleListen],
  );

  const stopVoice = useCallback(() => {
    queueGeneration.current += 1;
    queue.current = Promise.resolve();
    queuedJobs.current.clear();
    listenWhenDrained.current = false;
    sayGeneration.current += 1;
    speaker.stop();
    setSpeakingMemberId(null);
    allowBargeIn.current = false;
    if (busyRef.current) move("working");
    else listen();
  }, [listen, move]);

  useEffect(() => {
    alive.current = true;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    surfaceRef.current?.focus();
    return () => {
      alive.current = false;
      queueGeneration.current += 1;
      sayGeneration.current += 1;
      if (listenTimer.current) clearTimeout(listenTimer.current);
      deferCallCleanup(group.id, () => alive.current);
      returnFocusRef.current?.focus();
    };
  }, [group.id]);

  useEffect(() => {
    const bridge = window.helmryth;
    if (!bridge) return;
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (!alive.current || currentCall() !== group.id || phaseRef.current !== "listening") return;
      if (line.error) {
        setNote("Dictation stopped unexpectedly. Check Microphone and Speech Recognition access.");
        return;
      }
      if (line.text === undefined) return;
      setHeard(line.text);
      if (line.partial !== false) return;
      const said = line.text.trim();
      if (!said) return listen();

      const openApproval = askedApproval.current;
      if (openApproval) {
        if (openApproval.submitted) {
          move("working");
          hush();
          return;
        }
        const decision = parseSpokenGateDecision(said);
        if (decision) {
          const allow = decision === "allow";
          // Hold this approval in-flight until its server patch arrives so a
          // slow response cannot reopen the microphone and submit it twice.
          openApproval.submitted = true;
          allowBargeIn.current = false;
          move("working");
          hush();
          setHeard("");
          dispatch({
            type: "decideRequest",
            threadId: group.threadId,
            requestId: openApproval.requestId,
            behavior: allow ? "allow" : "deny",
            message: allow ? undefined : "Denied by the user on a crew voice line.",
            onError: (error: string) => {
              const pending = askedApproval.current;
              if (
                !alive.current ||
                currentCall() !== group.id ||
                pending?.requestId !== openApproval.requestId ||
                !pending.submitted
              ) return;
              pending.submitted = false;
              const detail = error.trim().slice(0, 240);
              const decision = openApproval.routine ? "cadence gate" : "gate";
              enqueueSpeech(
                `I couldn't save that ${decision}${detail ? `: ${detail}` : "."} Please try again.`,
                openApproval.member,
                true,
              );
            },
          });
          return;
        }
        enqueueSpeech("Sorry — is that a yes or a no?", openApproval.member, true);
        return;
      }

      const openQuestion = askedQuestion.current;
      if (openQuestion) {
        if (openQuestion.submitted) {
          move("working");
          hush();
          return;
        }
        openQuestion.submitted = true;
        allowBargeIn.current = false;
        dispatch({
          type: "decideRequest",
          threadId: group.threadId,
          requestId: openQuestion.requestId,
          behavior: "answer",
          message: said,
          onError: (requestError: string) => {
            const pendingQuestion = askedQuestion.current;
            if (!alive.current || pendingQuestion?.requestId !== openQuestion.requestId) return;
            pendingQuestion.submitted = false;
            const detail = requestError.trim().slice(0, 240);
            enqueueSpeech(
              `I couldn't save that answer${detail ? `: ${detail}` : "."} Please try again.`,
              openQuestion.member,
              true,
            );
          },
        });
        move("working");
        return;
      }

      const routed = routeSpokenGroupMessage(said, membersRef.current);
      if (defaultResponderRef.current.kind === "mentions" && !routed.addressed) {
        listen();
        const names = membersRef.current.map((member) => member.name).join(", ");
        setNote("Say an operator's name" + (names ? " — " + names : "") + " — or say everyone.");
        return;
      }

      allowBargeIn.current = false;
      move(busyRef.current ? "working" : "sending");
      dispatch({ type: "sendGroup", groupId: group.id, text: routed.text, threadId: group.threadId });
      scheduleListen(false, 600);
    });
    const offEnd = bridge.onSpeechEnd(({ code, reason }) => {
      if (!alive.current || currentCall() !== group.id) return;
      if (code === 2) {
        setNote("Voice lines need macOS dictation, which isn't available here yet.");
        return;
      }
      if (code === 1) {
        setNote(
          reason === "helper-build-failed"
            ? "The dictation helper couldn't be built. Install Apple's Command Line Tools and try again."
            : "Dictation needs Microphone + Speech Recognition access in System Settings.",
        );
        return;
      }
      if (phaseRef.current === "listening") listen();
    });
    if (busyAtStart.current && !approvalAtStart.current && !questionAtStart.current) move("working");
    else listen();
    return () => {
      offTranscript();
      offEnd();
      void window.helmryth?.speechStop();
    };
  }, [dispatch, enqueueSpeech, group.id, group.threadId, hush, listen, move, scheduleListen]);

  useEffect(() => {
    let resumeAfterRoutine = false;
    if (askedApproval.current && approval?.requestId !== askedApproval.current.requestId) {
      resumeAfterRoutine = askedApproval.current.routine && askedApproval.current.submitted;
      askedApproval.current = null;
    }
    if (askedQuestion.current && question?.card?.requestId !== askedQuestion.current.requestId) {
      askedQuestion.current = null;
    }

    if (resumeAfterRoutine && !approval && !question && !group.busyBotId) {
      scheduleListen(true);
      return;
    }
    // Keep the voice queue and microphone closed until this exact decision
    // is settled or its request reports an error.
    if (askedApproval.current?.submitted) return;

    if (approval && askedApproval.current?.requestId !== approval.requestId) {
      const member = members.find((candidate) => candidate.id === approval.message.from?.botId);
      askedApproval.current = {
        requestId: approval.requestId,
        member,
        routine: isRoutineApproval(approval),
        submitted: false,
      };
      spokenIds.current.add(approval.message.id);
      const name = member?.name ?? approval.message.from?.name ?? "A crew operator";
      enqueueSpeech(spokenApprovalPrompt(approval, name), member, true);
    }

    if (question?.card?.requestId && askedQuestion.current?.requestId !== question.card.requestId) {
      const member = members.find((candidate) => candidate.id === question.from?.botId);
      askedQuestion.current = { requestId: question.card.requestId, member, submitted: false };
      spokenIds.current.add(question.id);
      const name = member?.name ?? question.from?.name ?? "A crew operator";
      const detail = question.card.subtitle.trim();
      const choices = question.card.options.length
        ? " The options are " + question.card.options.join(", ") + "."
        : "";
      enqueueSpeech(
        name + " asks: " + detail + (/[.!?]$/.test(detail) ? "" : ".") + choices,
        member,
        true,
      );
    }

    const fresh = messages.filter((message) => !spokenIds.current.has(message.id));
    if (!fresh.length) return;
    for (const message of fresh) spokenIds.current.add(message.id);

    const replies = fresh.filter(
      (message) => message.role === "bot" && message.kind === "text" && message.text?.trim(),
    );
    for (const reply of replies) {
      const member = members.find((candidate) => candidate.id === reply.from?.botId);
      enqueueSpeech(reply.text!, member);
    }
    if (!replies.length) {
      const chip = [...fresh].reverse().find((message) => message.kind === "activity" && message.tool?.spoken);
      if (chip?.tool?.spoken) {
        const member = members.find((candidate) => candidate.id === chip.from?.botId);
        enqueueSpeech(chip.tool.spoken, member);
      }
    }
  }, [approval, enqueueSpeech, group.busyBotId, members, messages, question, scheduleListen]);

  useEffect(() => {
    const busy = Boolean(group.busyBotId);
    busyRef.current = busy;
    if (busy) {
      if (
        (phaseRef.current === "listening" || phaseRef.current === "sending") &&
        !askedApproval.current &&
        !askedQuestion.current &&
        !allowBargeIn.current
      ) {
        move("working");
        hush();
      }
      return;
    }
    allowBargeIn.current = false;
    if (
      (phaseRef.current === "working" || phaseRef.current === "sending") &&
      !askedApproval.current &&
      !askedQuestion.current
    ) {
      scheduleListen();
    }
  }, [group.busyBotId, hush, move, scheduleListen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (trapVoiceLineFocus(event, surfaceRef.current)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        endCall(group.id);
      } else if (
        event.code === "Space" &&
        speaker.isSpeaking() &&
        !(event.target instanceof HTMLElement && event.target.matches("button, input, textarea, select, [contenteditable='true']"))
      ) {
        event.preventDefault();
        stopVoice();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [group.id, stopVoice]);

  const speakingMember = members.find((member) => member.id === speakingMemberId);
  const workingMember = members.find((member) => member.id === group.busyBotId);
  const focusId = speakingMember?.id ?? workingMember?.id;
  const status =
    phase === "listening"
      ? pushToTalk
        ? "Push to talk"
        : "Listening"
      : phase === "sending"
        ? "Routing your direction to the crew"
        : phase === "speaking"
          ? (speakingMember?.name ?? "Crew operator") + " is speaking"
          : workingMember
            ? workingMember.name + " is working"
            : "Working";

  return (
    <div
      ref={surfaceRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="crew-line-title"
      tabIndex={-1}
      className="absolute inset-0 z-30 flex min-h-0 flex-col overflow-y-auto bg-app outline-none"
    >
      <header className="flex min-h-[64px] items-center justify-between border-b border-hairline/60 px-5 py-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-accent">Crew voice line</div>
          <h2 id="crew-line-title" className="font-display text-[20px] font-semibold text-ink">{group.name}</h2>
        </div>
        <button type="button" onClick={() => endCall(group.id)} aria-label="Close crew line" className="flex size-9 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink">
          <X size={18} />
        </button>
      </header>

      <div className="mx-auto grid w-full max-w-[920px] flex-1 content-center gap-8 px-6 py-8 lg:grid-cols-[280px_minmax(0,1fr)]">
        <section aria-labelledby="crew-line-roster-title">
          <h3 id="crew-line-roster-title" className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">Operators on line</h3>
          <ul className="mt-3 border-y border-hairline/60">
            {members.map((member) => {
              const focused = member.id === focusId;
              const state = speakingMember?.id === member.id
                ? "sending"
                : workingMember?.id === member.id
                  ? "working"
                  : phase === "listening"
                    ? "listening"
                    : normalizeState(member.sigilExpression) ?? "listening";
              const operatorStatus = speakingMember?.id === member.id
                ? "Speaking"
                : workingMember?.id === member.id
                  ? "Working"
                  : "Waiting";
              return (
                <li key={member.id} className={cn("grid grid-cols-[52px_1fr] items-center gap-3 border-b border-hairline/60 py-3 last:border-b-0", focused && "border-l-2 border-l-accent pl-3")}>
                  <SigilAvatar color={member.color} state={state} size={48} animated motion={workingMember?.id === member.id ? "working" : "none"} motionKey={workingMember?.id === member.id ? 1 : 0} />
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-ink">{member.name}</div>
                    <div className="text-[11.5px] text-ink-secondary">{operatorStatus}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="border-l-2 border-accent pl-5" aria-labelledby="crew-line-state-title">
          <h3 id="crew-line-state-title" className="flex items-center gap-2 text-[13px] font-medium text-ink-secondary" role="status" aria-live="polite">
            {(phase === "working" || phase === "sending") && <Loader2 size={13} className="motion-safe:animate-spin" />}
            {status}
          </h3>
          <div className="mt-4 min-h-[5rem] text-[16px] leading-relaxed text-ink" aria-live={phase === "speaking" ? "polite" : undefined}>
            {phase === "listening" ? heard || (
              <span className="text-ink-secondary">{pushToTalk ? "Release Control + Option to send…" : "Say an operator’s name, say “everyone,” or speak to the crew…"}</span>
            ) : phase === "speaking" ? speech.caption : (
              <span className="text-ink-secondary">{workingMember ? "Each response will be read in turn." : ""}</span>
            )}
          </div>
          {note && (
            <div role="alert" className="mt-4 border-l-2 border-warning bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
              <span>{note}</span>
              <button type="button" onClick={listen} className="ml-3 min-h-9 rounded-md border border-warning/40 px-3 text-[12px] hover:bg-warning/10">Retry microphone</button>
            </div>
          )}
          {speech.error && <div role="alert" className="mt-4 border-l-2 border-danger pl-3 text-[12.5px] text-danger">{speech.error}</div>}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {speaker.isSpeaking() && <button type="button" onClick={stopVoice} className="min-h-9 rounded-md border border-hairline/60 px-4 text-[13.5px] text-ink hover:bg-raised">Stop voice</button>}
            <button type="button" onClick={() => endCall(group.id)} className="flex min-h-9 items-center gap-2 rounded-md bg-danger px-5 text-[14px] font-medium text-[var(--color-danger-ink)] hover:opacity-90"><PhoneOff size={16} /> Close line</button>
          </div>
        </section>
      </div>
      <footer className="border-t border-hairline/60 px-5 py-3 text-center text-[12px] text-ink-secondary">
        Hold Control + Option to talk · Name an operator to direct the turn · Space stops voice · Esc closes the line
      </footer>
    </div>
  );
}
