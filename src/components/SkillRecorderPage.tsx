import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Circle,
  Clipboard,
  Cloud,
  Download,
  EyeOff,
  FileText,
  Keyboard,
  Mic,
  MonitorUp,
  MousePointer2,
  ScrollText,
  ShieldCheck,
  Square,
  Trash2,
  Volume2,
  X,
} from "lucide-react";

import {
  mergeAssemblyAITurn,
  startAssemblyAITranscription,
  type AssemblyAITranscript,
  type AssemblyAITranscriptionSession,
} from "@/lib/assemblyai-transcription";
import {
  CaptureCancelled,
  CaptureLease,
  CaptureStartGate,
  appendNativeEvent,
  eventLabel,
  formatRecordingTime,
  recorderExitRequiresCaptureStop,
  runRecordedMethodCaptureStartup,
  watchCaptureSource,
  type RecordedSkillEvent,
} from "@/lib/skill-recorder";
import { requestScreenPreview, stopScreenPreview } from "@/lib/screen-preview";
import { TRANSCRIPTION_STATUS_EVENT } from "@/lib/transcription-status";
import { useStore } from "@/state/store";

type Phase = "idle" | "starting" | "recording" | "review" | "saving" | "saved";
export type TranscriptionReadiness = "loading" | "ready" | "unavailable";
type CaptureStopControls = { nativePending: boolean; transcriptionPending: boolean };

export function RecorderTranscriptionStatus({
  status,
  openSettings,
}: {
  status: TranscriptionReadiness;
  openSettings: () => void;
}) {
  const loading = status === "loading";
  const ready = status === "ready";
  return (
    <div className="mt-4 flex items-center gap-3 rounded-md border border-hairline bg-card p-4">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent/12 text-accent-text"><Cloud size={17} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          Cloud transcription
          {ready && <span className="text-[10px] font-medium text-success">Saved</span>}
        </div>
        <p className="mt-0.5 text-[11px] leading-4 text-ink-secondary" role={loading ? "status" : undefined}>
          {loading
            ? "Checking transcription status…"
            : ready
              ? "AssemblyAI is ready for live narration."
              : "Add an AssemblyAI key in Settings before recording."}
        </p>
      </div>
      {!loading && (
        <button
          type="button"
          onClick={openSettings}
          className="shrink-0 rounded-xl bg-control px-3 py-2 text-[12px] font-medium text-ink hover:bg-raised-hover"
        >
          {ready ? "Manage" : "Open Settings"}
        </button>
      )}
    </div>
  );
}

const iconFor = (type: RecordedSkillEvent["type"]) => {
  if (type === "click") return MousePointer2;
  if (type === "scroll") return ScrollText;
  if (type === "typing" || type === "shortcut") return Keyboard;
  if (type === "clipboard") return Clipboard;
  if (type === "download") return Download;
  return MonitorUp;
};

const originHost = (url?: string): string | undefined => {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the microphone recording"));
    reader.readAsDataURL(blob);
  });
}

export function SkillRecorderPage() {
  const { dispatch } = useStore();
  const bridge = window.helmryth?.skillRecorder;
  const [phase, setPhase] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const [events, setEvents] = useState<RecordedSkillEvent[]>([]);
  const eventsRef = useRef<RecordedSkillEvent[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState("");
  const transcriptRef = useRef("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [transcriptionReadiness, setTranscriptionReadiness] = useState<TranscriptionReadiness>("loading");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<{ id: string; path: string; events: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const screenRef = useRef<MediaStream | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const transcriptionSessionRef = useRef<AssemblyAITranscriptionSession | null>(null);
  const cloudTranscriptRef = useRef<AssemblyAITranscript>({ turns: new Map(), finalText: "", partialText: "" });
  const audioChunksRef = useRef<Blob[]>([]);
  const audioDataRef = useRef("");
  const startedRef = useRef(0);
  const stoppingRef = useRef(false);
  const aliveRef = useRef(true);
  const startGateRef = useRef<CaptureStartGate | null>(null);
  const startupLeaseRef = useRef<CaptureLease | null>(null);
  const captureLeaseRef = useRef<CaptureLease | null>(null);
  const startupControlsRef = useRef<CaptureStopControls | null>(null);
  const captureControlsRef = useRef<CaptureStopControls | null>(null);
  const savingRef = useRef(false);
  if (!startGateRef.current) startGateRef.current = new CaptureStartGate();

  const updatePhase = (next: Phase) => {
    if (!aliveRef.current) return;
    phaseRef.current = next;
    setPhase(next);
  };

  const showError = (message: string) => {
    if (aliveRef.current) setError(message);
  };

  const takeScreenshot = useCallback((): string | undefined => {
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight) return undefined;
    const width = Math.min(1120, video.videoWidth);
    const height = Math.round(video.videoHeight * (width / video.videoWidth));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL("image/webp", 0.68);
  }, []);

  useEffect(() => {
    if (!bridge) return;
    const offEvent = bridge.onEvent((native) => {
      if (phaseRef.current !== "recording" && phaseRef.current !== "starting") return;
      const result = appendNativeEvent(eventsRef.current, native);
      // At the event ceiling the recorder keeps running but stops keeping
      // anything, and without this the only symptom is a moment counter that
      // silently stops climbing — the user goes on performing a workflow that
      // is no longer being captured.
      if (result.notice) showError(result.notice);
      if (result.addedId) {
        // A frame is worth keeping for visual/context-changing moments (clicks,
        // app switches, scrolls, downloads) but not for typing bursts or
        // clipboard ops — those add no visual evidence and a typing frame can
        // catch field contents. Secure-field typing never reaches here (the
        // native helper suppresses it), but skip typing frames regardless.
        const noFrame = native.type === "typing" || native.type === "clipboard";
        const screenshot = noFrame ? undefined : takeScreenshot();
        if (screenshot) {
          const index = result.events.findIndex((event) => event.id === result.addedId);
          if (index >= 0) result.events[index] = { ...result.events[index]!, screenshot };
        }
      }
      eventsRef.current = result.events;
      setEvents(result.events);
    });
    const offEnd = bridge.onEnd((info) => {
      const controls = phaseRef.current === "starting"
        ? startupControlsRef.current
        : captureControlsRef.current;
      const stopWasPending = controls?.nativePending === true;
      if (controls) controls.nativePending = false;
      if (recorderExitRequiresCaptureStop(phaseRef.current, stopWasPending, info.code)) {
        showError("Action recording ended unexpectedly. The captured material is still available for review.");
        if (phaseRef.current === "recording") void stop("Action recording ended unexpectedly.");
        else void cancelStartup(startupLeaseRef.current);
      }
    });
    return () => { offEvent(); offEnd(); };
  }, [bridge, takeScreenshot]);

  useEffect(() => {
    let alive = true;
    const onStatus = (event: CustomEvent<{ configured: boolean }>) => {
      if (aliveRef.current) {
        setTranscriptionReadiness(event.detail.configured ? "ready" : "unavailable");
      }
    };
    window.addEventListener(TRANSCRIPTION_STATUS_EVENT, onStatus);
    // Resolve the missing-bridge case before calling, rather than relying on
    // optional chaining to carry it. `a?.b?.c().then().catch()` short-circuits
    // the WHOLE chain when `a` is nullish, so neither handler runs and the
    // readiness state never leaves "loading" — the page then shows "Checking
    // transcription status…" forever, with recording disabled and no way out.
    // window.helmryth exists only behind the Electron preload bridge, so every
    // browser dev shell hits exactly that dead end.
    const transcription = window.helmryth?.transcription;
    if (!transcription) {
      setTranscriptionReadiness("unavailable");
    } else {
      transcription.status()
        .then((status) => alive && setTranscriptionReadiness(status.configured ? "ready" : "unavailable"))
        .catch(() => alive && setTranscriptionReadiness("unavailable"));
    }
    return () => {
      alive = false;
      window.removeEventListener(TRANSCRIPTION_STATUS_EVENT, onStatus);
    };
  }, []);

  useEffect(() => {
    if (phase !== "recording") return;
    const tick = () => setElapsed(Date.now() - startedRef.current);
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [phase]);

  useEffect(() => () => {
    aliveRef.current = false;
    const startup = startupLeaseRef.current;
    startupLeaseRef.current = null;
    if (startup) void startGateRef.current?.cancel(startup);
    const capture = captureLeaseRef.current;
    captureLeaseRef.current = null;
    if (capture) void capture.release();
  }, []);

  const cancelStartup = async (lease: CaptureLease | null, message?: string) => {
    if (!lease) return;
    if (startupLeaseRef.current === lease) {
      startupLeaseRef.current = null;
      startupControlsRef.current = null;
    }
    await startGateRef.current?.cancel(lease);
    if (aliveRef.current && phaseRef.current === "starting") {
      updatePhase("idle");
      if (message) showError(message);
    }
  };

  const stopNative = async (controls: CaptureStopControls) => {
    if (!controls.nativePending) return;
    controls.nativePending = false;
    await bridge?.stop().catch(() => {});
  };

  const stopTranscription = async (
    controls: CaptureStopControls,
    session = transcriptionSessionRef.current,
  ) => {
    if (!controls.transcriptionPending) return;
    controls.transcriptionPending = false;
    await session?.stop();
  };

  const sourceEnded = (kind: "screen" | "microphone", lease: CaptureLease) => {
    if (!lease.active) return;
    const message = kind === "screen"
      ? "Screen capture ended. The recording was moved to review."
      : "Microphone capture ended. The recording was moved to review.";
    if (startupLeaseRef.current === lease) {
      void cancelStartup(lease, message);
    } else if (captureLeaseRef.current === lease) {
      void stop(message);
    }
  };

  const start = async () => {
    const gate = startGateRef.current!;
    const lease = gate.begin();
    if (!lease) return;
    const controls: CaptureStopControls = { nativePending: false, transcriptionPending: false };
    startupLeaseRef.current = lease;
    startupControlsRef.current = controls;
    setError("");
    updatePhase("starting");
    try {
      if (!bridge || !window.helmryth?.beginScreenPreviewIntent || !navigator.mediaDevices?.getDisplayMedia) {
        throw new Error("Method capture requires the Helmryth desktop app on macOS.");
      }
      if (transcriptionReadiness !== "ready" || !window.helmryth.transcription) {
        throw new Error("Add your AssemblyAI key under Cloud transcription before recording.");
      }
      const resources = await runRecordedMethodCaptureStartup(lease, {
        permission: async () => {
          const nextPermission = await bridge.permissions();
          if (!nextPermission.supported) {
            throw new Error("Method capture is currently available in the macOS desktop app.");
          }
        },
        screen: async () => {
          const selected = await requestScreenPreview({
            beginIntent: () => window.helmryth!.beginScreenPreviewIntent(),
            getDisplayMedia: (constraints) => navigator.mediaDevices.getDisplayMedia(constraints),
          });
          if (!selected.ok) throw new Error(selected.message);
          return selected.stream;
        },
        releaseScreen: (stream) => {
          stopScreenPreview(stream);
          if (videoRef.current?.srcObject === stream) videoRef.current.srcObject = null;
          if (screenRef.current === stream) screenRef.current = null;
        },
        watchScreen: async (stream, ownedLease) => {
          screenRef.current = stream;
          await watchCaptureSource(stream, ownedLease, () => sourceEnded("screen", ownedLease));
        },
        preview: async (stream) => {
          const video = videoRef.current;
          if (!video) throw new Error("The recorder preview is unavailable");
          video.srcObject = stream;
          await video.play();
        },
        microphone: () => navigator.mediaDevices.getUserMedia({ audio: true, video: false }),
        releaseMicrophone: (stream) => {
          stream.getTracks().forEach((track) => track.stop());
          if (micRef.current === stream) micRef.current = null;
        },
        watchMicrophone: async (stream, ownedLease) => {
          micRef.current = stream;
          await watchCaptureSource(stream, ownedLease, () => sourceEnded("microphone", ownedLease));
        },
        recorder: (microphone) => {
          audioChunksRef.current = [];
          const preferredAudio = "audio/webm;codecs=opus";
          const recorder = new MediaRecorder(
            microphone,
            MediaRecorder.isTypeSupported(preferredAudio) ? { mimeType: preferredAudio } : undefined,
          );
          recorder.ondataavailable = (event) => {
            if (event.data.size) audioChunksRef.current.push(event.data);
          };
          recorder.start(1_000);
          mediaRecorderRef.current = recorder;
          return recorder;
        },
        releaseRecorder: (recorder) => {
          if (recorder.state !== "inactive") recorder.stop();
          if (mediaRecorderRef.current === recorder) mediaRecorderRef.current = null;
        },
        beforeNativeStart: () => {
          eventsRef.current = [];
          transcriptRef.current = "";
          cloudTranscriptRef.current = { turns: new Map(), finalText: "", partialText: "" };
          if (aliveRef.current) {
            setEvents([]);
            setTranscript("");
            setPartialTranscript("");
          }
        },
        native: async () => {
          controls.nativePending = true;
          await bridge.start();
        },
        stopNative: () => stopNative(controls),
        transcription: async (microphone) => {
          const transcription = await startAssemblyAITranscription({
            stream: microphone,
            getToken: () => window.helmryth!.transcription!.streamingToken(),
            onTurn: (turn) => {
              if (!lease.active || !aliveRef.current) return;
              const next = mergeAssemblyAITurn(cloudTranscriptRef.current, turn);
              cloudTranscriptRef.current = next;
              transcriptRef.current = next.finalText;
              setTranscript(next.finalText);
              setPartialTranscript(next.partialText);
            },
            onError: (message) => {
              if (lease.active) showError(message);
            },
          });
          controls.transcriptionPending = true;
          return transcription;
        },
        stopTranscription: (transcription) => stopTranscription(controls, transcription),
      });
      transcriptionSessionRef.current = resources.transcription;
      if (!gate.finish(lease)) throw new CaptureCancelled();
      startupLeaseRef.current = null;
      startupControlsRef.current = null;
      captureLeaseRef.current = lease;
      captureControlsRef.current = controls;
      audioDataRef.current = "";
      startedRef.current = Date.now();
      if (aliveRef.current) setElapsed(0);
      updatePhase("recording");
    } catch (caught) {
      await cancelStartup(lease);
      if (caught instanceof CaptureCancelled) return;
      updatePhase("idle");
      showError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const stop = async (reason?: string) => {
    if (stoppingRef.current || phaseRef.current !== "recording") return;
    stoppingRef.current = true;
    if (reason) showError(reason);
    if (aliveRef.current) setElapsed(Date.now() - startedRef.current);
    const lease = captureLeaseRef.current;
    const controls = captureControlsRef.current;
    try {
      if (controls) await stopNative(controls);
      if (controls) {
        await stopTranscription(controls).catch(() => {
          showError("Cloud transcription did not close cleanly; the original audio is still available.");
        });
      }
      transcriptionSessionRef.current = null;
      const capturedTranscript = [
        cloudTranscriptRef.current.finalText,
        cloudTranscriptRef.current.partialText,
      ].filter(Boolean).join(" ");
      transcriptRef.current = capturedTranscript;
      if (aliveRef.current) {
        setTranscript(capturedTranscript);
        setPartialTranscript("");
      }
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        const stopped = new Promise<void>((resolve) => recorder.addEventListener("stop", () => resolve(), { once: true }));
        recorder.stop();
        await stopped;
      }
      mediaRecorderRef.current = null;
      if (audioChunksRef.current.length) {
        const mime = recorder?.mimeType.split(";")[0] || "audio/webm";
        audioDataRef.current = await blobDataUrl(new Blob(audioChunksRef.current, { type: mime }));
      }
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      await lease?.release();
      if (captureLeaseRef.current === lease) captureLeaseRef.current = null;
      if (captureControlsRef.current === controls) captureControlsRef.current = null;
      transcriptionSessionRef.current = null;
      mediaRecorderRef.current = null;
      updatePhase("review");
      stoppingRef.current = false;
    }
  };

  const discard = async () => {
    const startup = startupLeaseRef.current;
    if (startup) await cancelStartup(startup);
    const capture = captureLeaseRef.current;
    captureLeaseRef.current = null;
    captureControlsRef.current = null;
    await capture?.release();
    transcriptionSessionRef.current = null;
    mediaRecorderRef.current = null;
    eventsRef.current = [];
    if (aliveRef.current) {
      setEvents([]);
      setTranscript("");
      setPartialTranscript("");
      setName("");
      setDescription("");
      setSaved(null);
      setError("");
    }
    updatePhase("idle");
  };

  const removeEvent = (id: string) => {
    const next = eventsRef.current.filter((event) => event.id !== id);
    eventsRef.current = next;
    setEvents(next);
  };

  const save = async () => {
    if (!bridge || !name.trim() || savingRef.current) return;
    savingRef.current = true;
    updatePhase("saving");
    setError("");
    try {
      const result = await bridge.save({
        name,
        description,
        durationMs: elapsed,
        transcript: transcriptRef.current,
        transcription: { provider: "assemblyai", model: "u3-rt-pro" },
        audio: audioDataRef.current || undefined,
        events: eventsRef.current,
      });
      if (aliveRef.current) {
        setSaved(result);
        updatePhase("saved");
      }
    } catch (caught) {
      if (aliveRef.current) {
        updatePhase("review");
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      savingRef.current = false;
    }
  };

  const restart = () => void discard();
  const recording = phase === "recording";

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink">
      <video ref={videoRef} muted playsInline className="pointer-events-none absolute size-px opacity-0" />
      <header className="flex h-[60px] shrink-0 items-center justify-between border-b border-hairline px-6">
        <div>
          <h1 className="text-[15px] font-semibold">Capture a method</h1>
          <p className="text-[11px] text-ink-secondary">Demonstrate once. Give every operator a repeatable procedure.</p>
        </div>
        {recording && (
          <button type="button" onClick={() => void stop()} className="flex items-center gap-2 rounded-md bg-danger px-4 py-2 text-[12px] font-semibold text-white shadow-sm">
            <Square size={11} fill="currentColor" /> Stop · {formatRecordingTime(elapsed)}
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-6 py-8">
          {phase === "idle" || phase === "starting" ? (
            <div className="mx-auto max-w-2xl">
              <div className="rounded-md border border-hairline bg-panel p-8">
                <div className="flex size-12 items-center justify-center rounded-sm border border-accent/25 bg-accent/10 text-accent-text">
                  <ScrollText size={24} />
                </div>
                <h2 className="mt-5 text-[25px] font-semibold tracking-[-0.02em]">Demonstrate the procedure</h2>
                <p className="mt-2 max-w-xl text-[14px] leading-6 text-ink-secondary">
                  Speak naturally while you work. Helmryth aligns your actions, screenshots, and narration, then turns the reviewed demonstration into a reusable local method.
                </p>

                <div className="mt-7 grid border-y border-hairline sm:grid-cols-3 sm:divide-x sm:divide-hairline">
                  {[
                    { Icon: MousePointer2, label: "Actions", copy: "Clicks, scrolling, app changes" },
                    { Icon: MonitorUp, label: "Visuals", copy: "A frame at each useful moment" },
                    { Icon: Mic, label: "Narration", copy: "Live transcript plus original audio" },
                  ].map(({ Icon, label, copy }) => (
                    <div key={label} className="border-b border-hairline p-4 last:border-b-0 sm:border-b-0">
                      <Icon size={18} className="text-ink-secondary" />
                      <div className="mt-3 text-[13px] font-medium">{label}</div>
                      <div className="mt-1 text-[11px] leading-4 text-ink-secondary">{copy}</div>
                    </div>
                  ))}
                </div>

                <div className="mt-6 flex items-start gap-3 rounded-md bg-inset px-4 py-3">
                  <EyeOff size={17} className="mt-0.5 shrink-0 text-success" />
                  <p className="text-[12px] leading-5 text-ink-secondary">
                    Raw keystrokes and clipboard contents are never stored. Screen frames can contain visible text and stay on this workbench; microphone audio is streamed to AssemblyAI for transcription. You review everything before creating the method.
                  </p>
                </div>

                <RecorderTranscriptionStatus
                  status={transcriptionReadiness}
                  openSettings={() => dispatch({ type: "toggleAppSettings", open: true, section: "connections" })}
                />

                <button type="button" disabled={phase === "starting" || transcriptionReadiness !== "ready"} onClick={() => void start()} className="mt-6 flex w-full items-center justify-center gap-2 rounded-md bg-accent px-5 py-3.5 text-[14px] font-semibold text-white hover:bg-accent/90 disabled:opacity-40">
                  {phase === "starting" ? <><Circle size={15} className="animate-pulse" /> Getting ready…</> : <><Circle size={14} fill="currentColor" /> Start recording</>}
                </button>
                <p className="mt-3 text-center text-[11px] text-ink-secondary">macOS will ask for screen, microphone, and action-recording access the first time.</p>
              </div>
            </div>
          ) : recording ? (
            <div className="mx-auto max-w-2xl">
              <div className="rounded-md border border-danger/30 bg-panel p-8 text-center">
                <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-danger/12">
                  <span className="size-4 animate-pulse rounded-full bg-danger" />
                </div>
                <h2 className="mt-5 text-[25px] font-semibold">Method capture is live</h2>
                <p className="mt-2 text-[14px] text-ink-secondary">Move through the procedure and explain each decision as you go.</p>
                <div className="mx-auto mt-6 max-w-lg rounded-md bg-inset p-4 text-left">
                  <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.12em] text-ink-secondary">
                    <span className="flex items-center gap-2"><Volume2 size={14} /> Live narration · AssemblyAI</span>
                    <span>{events.length} moments</span>
                  </div>
                  <p className="mt-3 min-h-12 text-[13px] leading-5 text-ink">
                    {[transcript, partialTranscript].filter(Boolean).join(" ") || "Start speaking — your transcript will appear here."}
                  </p>
                </div>
                <button type="button" onClick={() => void stop()} className="mx-auto mt-7 flex items-center gap-2 rounded-md bg-danger px-6 py-3 text-[14px] font-semibold text-white">
                  <Square size={12} fill="currentColor" /> Stop and review
                </button>
              </div>
            </div>
          ) : phase === "review" || phase === "saving" ? (
            <div>
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-success">Recording complete</div>
                  <h2 className="mt-1 text-[24px] font-semibold tracking-[-0.02em]">Review the captured method</h2>
                  <p className="mt-1 text-[13px] text-ink-secondary">Remove anything private or irrelevant, then name the procedure.</p>
                </div>
                <button type="button" onClick={() => void discard()} className="flex items-center gap-2 rounded-xl px-3 py-2 text-[12px] text-ink-secondary hover:bg-raised"><Trash2 size={15} /> Discard recording</button>
              </div>

              <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
                <section className="min-w-0 space-y-3">
                  {events.map((event, index) => {
                    const Icon = iconFor(event.type);
                    const context = [
                      event.name,
                      event.app,
                      event.windowTitle,
                      event.type === "download" ? originHost(event.whereFroms?.[0]) : undefined,
                    ].filter(Boolean).join(" · ") || formatRecordingTime(event.atMs);
                    return (
                      <article key={event.id} className="group overflow-hidden rounded-md border border-hairline bg-panel">
                        {event.screenshot && <img src={event.screenshot} alt={`Recorded screen at step ${index + 1}`} className="aspect-[16/9] w-full bg-inset object-cover object-top" />}
                        <div className="flex items-center gap-3 px-4 py-3">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-card text-ink-secondary"><Icon size={15} /></span>
                          <div className="min-w-0 flex-1">
                            <div className="text-[12px] font-medium">{index + 1}. {eventLabel(event)}</div>
                            <div className="truncate text-[10.5px] text-ink-secondary">{context}</div>
                          </div>
                          <button type="button" aria-label={`Remove step ${index + 1}`} onClick={() => removeEvent(event.id)} className="rounded-lg p-2 text-ink-secondary opacity-60 hover:bg-raised hover:text-danger group-hover:opacity-100"><X size={14} /></button>
                        </div>
                      </article>
                    );
                  })}
                  {!events.length && <div className="border-y border-hairline p-8 text-center text-[12px] text-ink-secondary">No action steps remain. The narration can still become a method; review it before saving.</div>}
                </section>

                <aside className="h-fit rounded-md border border-hairline bg-panel p-5 lg:sticky lg:top-0">
                  <label className="block text-[11px] font-medium text-ink-secondary" htmlFor="skill-name">Method name</label>
                  <input id="skill-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. File an expense report" maxLength={100} className="mt-2 w-full rounded-xl border border-hairline bg-inset px-3 py-2.5 text-[13px] outline-none placeholder:text-ink-secondary/60 focus:border-accent" />
                  <label className="mt-4 block text-[11px] font-medium text-ink-secondary" htmlFor="skill-description">When should operators use it?</label>
                  <textarea id="skill-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Use when I ask to submit a company expense…" maxLength={300} rows={4} className="mt-2 w-full resize-none rounded-xl border border-hairline bg-inset px-3 py-2.5 text-[12px] leading-5 outline-none placeholder:text-ink-secondary/60 focus:border-accent" />
                  <div className="mt-4 space-y-2 rounded-xl bg-inset p-3 text-[11px] text-ink-secondary">
                    <div className="flex items-center justify-between"><span className="flex items-center gap-2"><FileText size={13} /> Steps</span><span>{events.length}</span></div>
                    <div className="flex items-center justify-between"><span className="flex items-center gap-2"><Mic size={13} /> Narration</span><span>{transcript ? "Included" : "Audio only"}</span></div>
                    <div className="flex items-center justify-between"><span className="flex items-center gap-2"><ShieldCheck size={13} /> Storage</span><span>Local</span></div>
                  </div>
                  <button type="button" disabled={!name.trim() || phase === "saving"} onClick={() => void save()} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-[13px] font-semibold text-white disabled:opacity-40">
                    <ScrollText size={15} /> {phase === "saving" ? "Creating method…" : "Create method"}
                  </button>
                </aside>
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-xl rounded-md border border-hairline bg-panel p-9 text-center">
              <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-success/15 text-success"><Check size={27} /></div>
              <h2 className="mt-5 text-[25px] font-semibold">Method ready</h2>
              <p className="mt-2 text-[13px] leading-5 text-ink-secondary">Operators will load <span className="text-ink">{name}</span> when a matching run calls for it.</p>
              <div className="mt-5 rounded-md bg-inset p-4 text-left">
                <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-ink-secondary">Saved locally</div>
                <div className="mt-1 break-all text-[11px] text-ink">{saved?.path}</div>
              </div>
              <button type="button" onClick={restart} className="mt-6 rounded-md bg-raised px-5 py-2.5 text-[13px] font-medium hover:bg-raised-hover">Capture another method</button>
            </div>
          )}

          {error && <div role="alert" className="mx-auto mt-4 max-w-2xl rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-[12px] text-danger">{error}</div>}
        </div>
      </div>
    </main>
  );
}
