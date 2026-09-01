// Voice line — one operator on a half-duplex local audio channel.
//
// The loop is deliberately HALF-DUPLEX: the microphone is live only when
// the operator is not speaking. The dictation helper is Apple's SFSpeechRecognizer
// running on raw AVAudioEngine input with no acoustic echo cancellation, so
// a mic left open through playback transcribes the operator's own voice back into
// the conversation and the two of them talk forever. Interrupting is a tap
// or Escape instead, which is honest and cannot feed back. (Full-duplex
// barge-in needs AEC on the capture path — a follow-up, not a footnote.)
//
// Turn-taking uses a small silence endpointer in the native helper. Apple's
// buffer-backed recognizer does not finalize on silence by itself: the helper
// has to end the audio stream, which then produces the final transcript.
//
// The other half of making a voice line bearable is narration. An operator run is
// 5-60 seconds of tool calls; silence that long reads as a dropped call. So
// every activity chip the harness narrates (`tool.spoken`) is read aloud as
// it happens, which is why waiting feels like listening to someone work
// rather than listening to nothing.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Loader2, Phone, PhoneOff, X } from "lucide-react";

import { useStore, visibleMessages, type Bot } from "@/state/store";
import { currentCall, deferCallCleanup, endCall, startCall, useOnCall } from "@/lib/call";
import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
import { usePushToTalk } from "@/lib/push-to-talk";
import { SigilAvatar } from "./Avatar";
import { isRoutineApproval, pendingApprovals, spokenApprovalPrompt } from "./PendingApproval";
import { cn } from "@/lib/cn";
import { track } from "@/lib/analytics";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { parseSpokenGateDecision } from "@/lib/voice-gate";

/** Spoken answers to a permission card. Anything else is read as a reply
 * to the operator, not as consent — a gate must never be granted by a
 * sentence that merely contained the word "sure". */
type Phase = "listening" | "sending" | "working" | "speaking";
const CALL_ENDPOINT_MS = 850;

export function trapVoiceLineFocus(event: KeyboardEvent, surface: HTMLElement | null): boolean {
  if (event.key !== "Tab" || !surface) return false;
  const controls = surface.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  if (!controls.length) return false;
  const first = controls[0];
  const last = controls[controls.length - 1];
  const active = document.activeElement;
  if (!(active instanceof Node) || active === surface || !surface.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return true;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

export function CallButton({ bot }: { bot: Bot }) {
  return (
    <CallTargetButton
      targetId={bot.id}
      targetName={bot.name}
      voices={[bot.voice]}
      setupBotId={bot.id}
      requireExplicitVoices={false}
      onStart={() => track("call_started", { driver: bot.modelSelection?.instanceId })}
    />
  );
}

export function CallTargetButton({
  targetId,
  targetName,
  voices,
  setupBotId,
  requireExplicitVoices,
  onStart,
}: {
  targetId: string;
  targetName: string;
  voices: Array<string | undefined>;
  /** Operator profile to open when voice setup is missing (Crews choose an operator). */
  setupBotId?: string;
  /** Crews cannot rely on one workspace fallback for multiple speakers. */
  requireExplicitVoices: boolean;
  onStart: () => void;
}) {
  const { state, dispatch } = useStore();
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const active = useOnCall() === targetId;
  const supported = capabilities.dictation.available && Boolean(window.helmryth?.speechStart);
  const configured = Boolean(state.config?.tts?.configured);
  const everyTargetHasVoice = voices.length > 0 && voices.every((voice) => Boolean(voice));
  const voiceReady =
    configured && (requireExplicitVoices ? everyTargetHasVoice : Boolean(state.config?.tts?.ready || everyTargetHasVoice));
  const unavailable = !active && (!capabilitiesReady || !supported || !voiceReady);
  const voiceSetupRequired = capabilitiesReady && supported && !voiceReady;
  const [helpOpen, setHelpOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const helpId = useId();
  const label = active
    ? `Close the voice line with ${targetName}`
    : !capabilitiesReady
      ? "Checking voice line availability"
      : !supported
        ? "Voice lines currently need Helmryth Desktop for macOS"
        : !configured
          ? "Set up a voice in an operator profile to open voice lines"
          : !voiceReady
            ? "Pick a voice in an operator profile to open voice lines"
            : `Open a voice line with ${targetName}`;

  const reason = !capabilitiesReady
    ? "Checking whether this device can open voice lines."
    : !capabilities.dictation.available
      ? "Voice lines require Helmryth for macOS because speech recognition runs on-device."
      : !window.helmryth?.speechStart
        ? "The speech service is unavailable in this app build. Restart or update Helmryth."
        : !configured
          ? "Add an ElevenLabs API key, or use the built-in Mac voices, so operators can speak on voice lines."
          : !voiceReady
            ? voices.length > 1
              ? "Give every crew operator a voice before opening a crew line."
              : "Choose a voice before opening a voice line."
            : "";

  useEffect(() => {
    if (!helpOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setHelpOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setHelpOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [helpOpen]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        onClick={() => {
          if (active) return endCall(targetId);
          if (unavailable) {
            setHelpOpen((open) => !open);
            return;
          }
          onStart();
          startCall(targetId);
        }}
        aria-expanded={unavailable ? helpOpen : undefined}
        aria-controls={unavailable ? helpId : undefined}
        aria-label={label}
        title={label}
        className={cn(
          "relative flex size-9 items-center justify-center rounded-md",
          active
            ? "bg-danger text-[var(--color-danger-ink)] hover:opacity-90"
            : unavailable
              ? "text-ink-secondary/50 hover:bg-raised hover:text-ink-secondary"
              : "text-ink-secondary hover:bg-raised hover:text-ink",
        )}
      >
        {active ? <PhoneOff size={17} /> : <Phone size={17} />}
        {unavailable && (
          <span className="absolute right-1 top-1 size-1.5 rounded-full bg-warning ring-2 ring-app" aria-hidden="true" />
        )}
      </button>

      {unavailable && helpOpen && (
        <div
          id={helpId}
          role="note"
          aria-label="Voice line unavailable"
          className="animate-pop-in absolute right-0 z-30 mt-1.5 w-[min(280px,calc(100vw-24px))] rounded-md border border-hairline bg-panel p-3 text-left"
        >
          <h3 className="text-[13px] font-medium text-ink">Voice line unavailable</h3>
          <div className="mt-1 text-[12px] leading-[1.45] text-ink-secondary">{reason}</div>
          {voiceSetupRequired && (
            <button
              type="button"
              onClick={() => {
                setHelpOpen(false);
                if (setupBotId && setupBotId !== targetId) dispatch({ type: "select", id: setupBotId });
                dispatch({ type: "toggleSettings", open: true });
              }}
              className="mt-2.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink hover:bg-accent-border"
            >
              Open operator settings
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function CallOverlay({ bot }: { bot: Bot }) {
  const active = useOnCall() === bot.id;
  if (!active) return null;
  return <Call bot={bot} />;
}

function Call({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const speech = useSpeech();
  const initialPhase: Phase = bot.busy ? "working" : "listening";
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [heard, setHeard] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const pushToTalk = usePushToTalk(bot.id, phase === "listening", () => {
    setNote("Push to talk couldn't start. Check Microphone and Speech Recognition access.");
  });

  const messages = visibleMessages(bot);
  const approval = pendingApprovals(messages)[0];
  const question = messages.find(
    (message) =>
      message.kind === "options" &&
      message.card?.requestId &&
      !message.card.tool &&
      !message.card.answered &&
      !message.card.dismissed,
  );
  const busyAtStart = useRef(bot.busy);
  const approvalAtStart = useRef(approval);
  const questionAtStart = useRef(question);

  // Everything already on screen when the call starts has been read or
  // ignored — a call must not open by reciting the backlog.
  const spokenIds = useRef<Set<string>>(new Set());
  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    for (const m of messages) spokenIds.current.add(m.id);
  }

  // the approval we last asked about aloud, so a card that stays open
  // while the user thinks is not re-read every render
  const askedApproval = useRef<{ requestId: string; routine: boolean; submitted: boolean } | null>(null);
  const askedQuestion = useRef<{ requestId: string; submitted: boolean } | null>(null);
  const phaseRef = useRef<Phase>(initialPhase);
  const alive = useRef(true);
  const sayGeneration = useRef(0);

  /** Change the rendered phase and the synchronous phase used by native
   * callbacks together. React state alone is too late: the helper can exit
   * in the same tick as a final transcript or an intentional mute. */
  const move = useCallback((next: Phase) => {
    phaseRef.current = next;
    if (alive.current) setPhase(next);
  }, []);

  const hush = useCallback(() => {
    void window.helmryth?.speechStop();
  }, []);

  const listen = useCallback(() => {
    if (!alive.current || currentCall() !== bot.id) return;
    move("listening");
    setHeard("");
    setNote(null);
    void window.helmryth?.speechStart({ endpointMs: CALL_ENDPOINT_MS }).catch(() => {
      if (alive.current && currentCall() === bot.id) {
        setNote("The microphone couldn't start. Check Microphone and Speech Recognition access.");
      }
    });
  }, [bot.id, move]);

  /** Speak, with the microphone closed for the duration (see the header
   * comment — an open mic during playback is a feedback loop). */
  const say = useCallback(
    async (text: string) => {
      if (!alive.current || currentCall() !== bot.id) return false;
      const mine = ++sayGeneration.current;
      // Move first. stopSpeech() finishes asynchronously, and its close must
      // never observe an old "listening" phase and reopen the mic.
      move("speaking");
      hush();
      await speaker.speak(text, { botId: bot.id, voiceId: bot.voice });
      return alive.current && currentCall() === bot.id && sayGeneration.current === mine;
    },
    [bot.id, bot.voice, hush, move],
  );

  const sayThenListen = useCallback(
    async (text: string) => {
      const stillMine = await say(text);
      if (stillMine && phaseRef.current === "speaking") listen();
    },
    [listen, say],
  );

  // Navigating away from this bot hangs up. Without ownership checking, the
  // overlay disappeared but `currentCall()` remained set and auto-speak was
  // permanently disabled for a call nobody could see.
  useEffect(() => {
    alive.current = true;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    surfaceRef.current?.focus();
    return () => {
      alive.current = false;
      sayGeneration.current += 1;
      // StrictMode immediately remounts effects once in development. A
      // microtask distinguishes that probe from real navigation: the probe
      // has set alive=true again before this runs; a genuine unmount has not.
      deferCallCleanup(bot.id, () => alive.current);
      returnFocusRef.current?.focus();
    };
  }, [bot.id]);

  // ── the microphone ───────────────────────────────────────────────────
  useEffect(() => {
    const bridge = window.helmryth;
    if (!bridge) return;
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (!alive.current || currentCall() !== bot.id || phaseRef.current !== "listening") return;
      if (line.error) {
        setNote("Dictation stopped unexpectedly. Check Microphone and Speech Recognition access.");
        return;
      }
      if (line.text === undefined) return;
      setHeard(line.text);
      if (line.partial !== false) return;
      // final result — Apple's recognizer decided the turn ended
      const said = line.text.trim();
      if (!said) return listen();

      const open = askedApproval.current;
      if (open) {
        if (open.submitted) {
          move("working");
          hush();
          return;
        }
        const decision = parseSpokenGateDecision(said);
        if (decision) {
          const allow = decision === "allow";
          // Keep this request claimed until the server's durable card patch
          // arrives. Clearing it here lets a render in that network gap read
          // and submit the same approval again.
          open.submitted = true;
          move("working");
          hush();
          setHeard("");
          dispatch({
            type: "decideRequest",
            threadId: bot.threadId,
            requestId: open.requestId,
            behavior: allow ? "allow" : "deny",
            message: allow ? undefined : "Denied by the user on a voice line.",
            onError: (error: string) => {
              const pending = askedApproval.current;
              if (
                !alive.current ||
                currentCall() !== bot.id ||
                pending?.requestId !== open.requestId ||
                !pending.submitted
              ) return;
              pending.submitted = false;
              const detail = error.trim().slice(0, 240);
              const decision = open.routine ? "cadence gate" : "gate";
              void sayThenListen(
                `I couldn't save that ${decision}${detail ? `: ${detail}` : "."} Please try again.`,
              );
            },
          });
          return;
        }
        // not a decision — leave the card up and say so rather than
        // guessing consent from an ambiguous sentence
        void sayThenListen("Sorry — is that a yes or a no?");
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
        move("working");
        hush();
        dispatch({
          type: "decideRequest",
          threadId: bot.threadId,
          requestId: openQuestion.requestId,
          behavior: "answer",
          message: said,
          onError: (requestError: string) => {
            const pendingQuestion = askedQuestion.current;
            if (!alive.current || pendingQuestion?.requestId !== openQuestion.requestId) return;
            pendingQuestion.submitted = false;
            const detail = requestError.trim().slice(0, 240);
            void sayThenListen(`I couldn't save that answer${detail ? `: ${detail}` : "."} Please try again.`);
          },
        });
        return;
      }

      move("sending");
      dispatch({ type: "send", botId: bot.id, text: said, threadId: bot.threadId });
    });
    const offEnd = bridge.onSpeechEnd(({ code, reason }) => {
      if (!alive.current || currentCall() !== bot.id) return;
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
      // the helper exits after every final result; if we are still meant
      // to be listening, that means the user's turn ended — start the next
      if (phaseRef.current === "listening") listen();
    });
    if (busyAtStart.current && !approvalAtStart.current && !questionAtStart.current) move("working");
    else listen();
    return () => {
      offTranscript();
      offEnd();
      void window.helmryth?.speechStop();
    };
  }, [bot.id, bot.threadId, dispatch, hush, listen, move, sayThenListen]);

  // ── narrate the work, speak the answer, read the approvals ───────────
  useEffect(() => {
    // The request may be resolved from the normal approval UI or by another
    // client while this call is open. Do not keep treating future speech as
    // an answer to a card that no longer exists.
    let resumeAfterRoutine = false;
    if (askedApproval.current && approval?.requestId !== askedApproval.current.requestId) {
      resumeAfterRoutine = askedApproval.current.routine && askedApproval.current.submitted;
      askedApproval.current = null;
    }
    if (askedQuestion.current && question?.card?.requestId !== askedQuestion.current.requestId) {
      askedQuestion.current = null;
    }
    if (!approval && !question && bot.busy && phaseRef.current === "listening") {
      move("working");
      hush();
    }
    if (resumeAfterRoutine && !approval && !question && !bot.busy) {
      listen();
      return;
    }
    // Nothing may reopen capture or narrate new work while the server is
    // durably settling this exact decision.
    if (askedApproval.current?.submitted) return;
    if (approval && askedApproval.current?.requestId !== approval.requestId && phase !== "speaking") {
      askedApproval.current = {
        requestId: approval.requestId,
        routine: isRoutineApproval(approval),
        submitted: false,
      };
      spokenIds.current.add(approval.message.id);
      void sayThenListen(spokenApprovalPrompt(approval, bot.name));
      return;
    }
    if (
      question?.card?.requestId &&
      askedQuestion.current?.requestId !== question.card.requestId &&
      phase !== "speaking"
    ) {
      askedQuestion.current = { requestId: question.card.requestId, submitted: false };
      spokenIds.current.add(question.id);
      const detail = question.card.subtitle.trim();
      const choices = question.card.options.length
        ? ` The options are ${question.card.options.join(", ")}.`
        : "";
      void sayThenListen(`${bot.name} asks: ${detail}${/[.!?]$/.test(detail) ? "" : "."}${choices}`);
      return;
    }
    const fresh = messages.filter((m) => !spokenIds.current.has(m.id));
    if (!fresh.length) return;
    // only the newest of each kind matters: a burst of tool chips should
    // not queue thirty seconds of narration behind the actual answer
    const reply = [...fresh].reverse().find((m) => m.role === "bot" && m.kind === "text" && m.text?.trim());
    const chip = [...fresh].reverse().find((m) => m.kind === "activity" && m.tool?.spoken);
    for (const m of fresh) spokenIds.current.add(m.id);

    if (reply?.text) {
      void sayThenListen(reply.text);
    } else if (chip?.tool?.spoken && phase === "working") {
      void say(chip.tool.spoken).then((stillMine) => {
        if (stillMine && phaseRef.current === "speaking") move("working");
      });
    }
  }, [messages, approval, question, phase, bot.busy, bot.name, hush, listen, move, say, sayThenListen]);

  // busy is the harness's word for "a turn is running"
  useEffect(() => {
    if (bot.busy) {
      // An open approval deliberately keeps the mic live for yes/no. Every
      // other busy phase is half-duplex and must close capture.
      if (phaseRef.current !== "speaking" && !askedApproval.current && !askedQuestion.current) {
        move("working");
        hush();
      }
    } else if (
      phaseRef.current === "working" &&
      !askedApproval.current &&
      !askedQuestion.current &&
      !speaker.isSpeaking()
    ) {
      // A failed/cancelled turn may have no reply to trigger the normal
      // speak-then-listen path. Recover the call instead of staying stuck.
      listen();
    }
  }, [bot.busy, hush, listen, move]);

  // Escape hangs up; space interrupts whatever is being said
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (trapVoiceLineFocus(e, surfaceRef.current)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        endCall(bot.id);
      } else if (
        e.code === "Space" &&
        speaker.isSpeaking() &&
        !(e.target instanceof HTMLElement && e.target.matches("button, input, textarea, select, [contenteditable='true']"))
      ) {
        e.preventDefault();
        sayGeneration.current += 1;
        speaker.stop();
        listen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bot.id, listen]);

  const sigilState =
    phase === "listening" ? "listening" : phase === "speaking" ? "sending" : phase === "sending" ? "thinking" : "working";
  const status =
    phase === "listening"
      ? pushToTalk
        ? "Push to talk"
        : "Listening"
      : phase === "sending"
        ? "Sending your direction"
        : phase === "speaking"
          ? `${bot.name} is speaking`
          : "Working";

  return (
    <div
      ref={surfaceRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="voice-line-title"
      tabIndex={-1}
      className="absolute inset-0 z-30 flex min-h-0 flex-col overflow-y-auto bg-app outline-none"
    >
      <header className="flex min-h-[64px] items-center justify-between border-b border-hairline/60 px-5 py-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-accent">Voice line</div>
          <h2 id="voice-line-title" className="font-display text-[20px] font-semibold text-ink">{bot.name}</h2>
        </div>
        <button type="button" onClick={() => endCall(bot.id)} aria-label="Close voice line" className="flex size-9 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink">
          <X size={18} />
        </button>
      </header>

      <div className="mx-auto grid w-full max-w-[760px] flex-1 content-center gap-6 px-6 py-8 sm:grid-cols-[128px_minmax(0,1fr)] sm:items-center">
        <div className="flex justify-center sm:justify-start">
          <SigilAvatar color={bot.color} state={sigilState} size={112} animated />
        </div>
        <div className="min-w-0 border-l-2 border-accent pl-5">
          <div className="flex items-center gap-2 text-[13px] font-medium text-ink-secondary" role="status" aria-live="polite">
            {(phase === "working" || phase === "sending") && <Loader2 size={13} className="motion-safe:animate-spin" />}
            {status}
          </div>
          <div className="mt-4 min-h-[4.5rem] text-[16px] leading-relaxed text-ink" aria-live={phase === "speaking" ? "polite" : undefined}>
            {phase === "listening" ? heard || (
              <span className="text-ink-secondary">{pushToTalk ? "Release Control + Option to send…" : "Speak when ready…"}</span>
            ) : phase === "speaking" ? speech.caption : (
              <span className="text-ink-secondary">
                {phase === "sending" ? "Your direction is being sent." : `${bot.name} is working.`}
              </span>
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
            {speaker.isSpeaking() && (
              <button type="button" onClick={() => { sayGeneration.current += 1; speaker.stop(); listen(); }} className="min-h-9 rounded-md border border-hairline/60 px-4 text-[13.5px] text-ink hover:bg-raised">Interrupt</button>
            )}
            <button type="button" onClick={() => endCall(bot.id)} className="flex min-h-9 items-center gap-2 rounded-md bg-danger px-5 text-[14px] font-medium text-[var(--color-danger-ink)] hover:opacity-90">
              <PhoneOff size={16} /> Close line
            </button>
          </div>
        </div>
      </div>
      <footer className="border-t border-hairline/60 px-5 py-3 text-center text-[12px] text-ink-secondary">
        Hold Control + Option to talk · Space interrupts · Esc closes the line
      </footer>
    </div>
  );
}
