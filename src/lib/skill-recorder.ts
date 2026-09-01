export type RecordedSkillEvent = {
  id: string;
  type: "app" | "click" | "scroll" | "shortcut" | "typing" | "clipboard" | "download";
  atMs: number;
  app?: string;
  windowTitle?: string;
  direction?: "up" | "down";
  shortcut?: string;
  screenshot?: string;
  keyCount?: number;
  role?: string;
  name?: string;
  identifier?: string;
  ancestry?: string[];
  op?: "copy" | "cut" | "paste";
  filename?: string;
  whereFroms?: string[];
};

export type AppendNativeEventResult = {
  events: RecordedSkillEvent[];
  addedId: string | null;
  /** Set only when the cap refused the moment. `addedId: null` alone cannot
   * say so — it also means "folded into the previous step" — and without a
   * sentence the timeline simply stops moving while the person keeps
   * demonstrating into a recording that is no longer taking anything. */
  notice: string | null;
};

type CaptureCleanup = () => void | Promise<void>;

export class CaptureCancelled extends Error {
  constructor() {
    super("Recorded method capture was cancelled");
    this.name = "CaptureCancelled";
  }
}

/** Owns every resource acquired by one recorder startup. A late await result
 * can be offered to `keep`; if navigation already cancelled the lease, that
 * resource is released immediately instead of leaking into an unmounted UI. */
export class CaptureLease {
  private cleanups: CaptureCleanup[] = [];
  private releasePromise: Promise<void> | null = null;
  private live = true;

  get active(): boolean {
    return this.live;
  }

  async keep<Resource>(
    resource: Resource,
    cleanup: (resource: Resource) => void | Promise<void>,
  ): Promise<boolean> {
    let pending = true;
    const release = async () => {
      if (!pending) return;
      pending = false;
      await cleanup(resource);
    };
    if (!this.live) {
      await release();
      return false;
    }
    this.cleanups.push(release);
    return true;
  }

  release(): Promise<void> {
    if (this.releasePromise) return this.releasePromise;
    this.live = false;
    const cleanups = this.cleanups.splice(0).reverse();
    this.releasePromise = Promise.allSettled(cleanups.map((cleanup) => cleanup()))
      .then(() => undefined);
    return this.releasePromise;
  }
}

/** A synchronous lock for the idle → starting transition. React state does
 * not commit soon enough to prevent a same-tick double activation. */
export class CaptureStartGate {
  private current: CaptureLease | null = null;

  get starting(): boolean {
    return this.current !== null;
  }

  begin(): CaptureLease | null {
    if (this.current) return null;
    const lease = new CaptureLease();
    this.current = lease;
    return lease;
  }

  finish(lease: CaptureLease): boolean {
    if (this.current !== lease || !lease.active) return false;
    this.current = null;
    return true;
  }

  async cancel(lease: CaptureLease): Promise<void> {
    if (this.current === lease) this.current = null;
    await lease.release();
  }
}

type CaptureSourceTrack = {
  addEventListener(
    name: "ended",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(name: "ended", listener: () => void): void;
};

type CaptureSource = { getTracks(): CaptureSourceTrack[] };

export async function watchCaptureSource(
  source: CaptureSource,
  lease: CaptureLease,
  onEnded: () => void,
): Promise<void> {
  for (const track of source.getTracks()) {
    const ended = () => onEnded();
    track.addEventListener("ended", ended, { once: true });
    const kept = await lease.keep({ track, ended }, ({ track: ownedTrack, ended: ownedEnded }) => {
      ownedTrack.removeEventListener("ended", ownedEnded);
    });
    if (!kept) throw new CaptureCancelled();
  }
}

export type RecordedMethodCaptureStartupDependencies<
  Screen,
  Microphone,
  Recorder,
  Transcription,
> = {
  permission(): Promise<void>;
  screen(): Promise<Screen>;
  releaseScreen(screen: Screen): void | Promise<void>;
  watchScreen(screen: Screen, lease: CaptureLease): Promise<void>;
  preview(screen: Screen): Promise<void>;
  microphone(): Promise<Microphone>;
  releaseMicrophone(microphone: Microphone): void | Promise<void>;
  watchMicrophone(microphone: Microphone, lease: CaptureLease): Promise<void>;
  recorder(microphone: Microphone): Recorder;
  releaseRecorder(recorder: Recorder): void | Promise<void>;
  beforeNativeStart(): void;
  native(): Promise<void>;
  stopNative(): void | Promise<void>;
  transcription(microphone: Microphone): Promise<Transcription>;
  stopTranscription(transcription: Transcription): void | Promise<void>;
};

/** The complete ordered startup transaction used by SkillRecorderPage. Every
 * awaited boundary is followed by a lease check, and every acquired resource
 * is owned before the next boundary can begin. */
export async function runRecordedMethodCaptureStartup<
  Screen,
  Microphone,
  Recorder,
  Transcription,
>(
  lease: CaptureLease,
  dependencies: RecordedMethodCaptureStartupDependencies<
    Screen,
    Microphone,
    Recorder,
    Transcription
  >,
): Promise<{
  screen: Screen;
  microphone: Microphone;
  recorder: Recorder;
  transcription: Transcription;
}> {
  const assertActive = () => {
    if (!lease.active) throw new CaptureCancelled();
  };
  try {
    await dependencies.permission();
    assertActive();

    const screen = await dependencies.screen();
    if (!await lease.keep(screen, dependencies.releaseScreen)) throw new CaptureCancelled();
    await dependencies.watchScreen(screen, lease);
    assertActive();
    await dependencies.preview(screen);
    assertActive();

    const microphone = await dependencies.microphone();
    if (!await lease.keep(microphone, dependencies.releaseMicrophone)) throw new CaptureCancelled();
    await dependencies.watchMicrophone(microphone, lease);
    assertActive();

    const recorder = dependencies.recorder(microphone);
    if (!await lease.keep(recorder, dependencies.releaseRecorder)) throw new CaptureCancelled();

    dependencies.beforeNativeStart();
    await dependencies.native();
    if (!await lease.keep(true, () => dependencies.stopNative())) throw new CaptureCancelled();

    const transcription = await dependencies.transcription(microphone);
    if (!await lease.keep(transcription, dependencies.stopTranscription)) {
      throw new CaptureCancelled();
    }
    return { screen, microphone, recorder, transcription };
  } catch (error) {
    await lease.release();
    throw error;
  }
}

/** A clean helper exit is expected only after this capture lease requested
 * stop. An unrequested code-0 exit still means the action source vanished. */
export function recorderExitRequiresCaptureStop(
  phase: string,
  stopWasPending: boolean,
  code: number | null,
): boolean {
  if (phase !== "starting" && phase !== "recording") return false;
  return stopWasPending || code !== 0;
}

// Cap the timeline but preserve the START of a long demo: once we hold this
// many events we stop taking new ones rather than dropping the head.
const MAX_EVENTS = 600;

/** Said out loud the moment the cap starts refusing steps, so a recording
 * that has stopped taking anything never looks like one that is still going. */
export const RECORDING_FULL_NOTICE =
  `This recording is full at ${MAX_EVENTS} steps — nothing you do now is being captured. ` +
  "Stop and save it, then record the rest as a second method.";

function commit(events: RecordedSkillEvent[], next: RecordedSkillEvent): AppendNativeEventResult {
  if (events.length >= MAX_EVENTS) return { events, addedId: null, notice: RECORDING_FULL_NOTICE };
  return { events: [...events, next], addedId: next.id, notice: null };
}

const MAC_KEYS = new Map<number, string>([
  [0, "A"], [1, "S"], [2, "D"], [3, "F"], [4, "H"], [5, "G"], [6, "Z"], [7, "X"], [8, "C"], [9, "V"],
  [11, "B"], [12, "Q"], [13, "W"], [14, "E"], [15, "R"], [16, "Y"], [17, "T"], [18, "1"], [19, "2"],
  [20, "3"], [21, "4"], [22, "6"], [23, "5"], [24, "="], [25, "9"], [26, "7"], [27, "-"], [28, "8"],
  [29, "0"], [30, "]"], [31, "O"], [32, "U"], [33, "["], [34, "I"], [35, "P"], [36, "Return"],
  [37, "L"], [38, "J"], [39, "'"], [40, "K"], [41, ";"], [42, "\\"], [43, ","], [44, "/"], [45, "N"],
  [46, "M"], [47, "."], [48, "Tab"], [49, "Space"], [50, "`"], [51, "Delete"], [53, "Escape"],
  [115, "Home"], [116, "Page Up"], [117, "Forward Delete"], [119, "End"], [121, "Page Down"],
  [123, "Left"], [124, "Right"], [125, "Down"], [126, "Up"],
]);

function contextMatches(a: RecordedSkillEvent, event: NativeSkillRecordingEvent): boolean {
  return a.app === event.app && a.windowTitle === event.windowTitle;
}

let eventSequence = 0;

function idFor(event: NativeSkillRecordingEvent, suffix = ""): string {
  eventSequence += 1;
  return `${event.atMs}-${event.type}${suffix}-${eventSequence}`;
}

export function shortcutLabel(event: NativeSkillRecordingEvent): string {
  const parts = [
    event.control ? "⌃" : "",
    event.option ? "⌥" : "",
    event.shift ? "⇧" : "",
    event.meta ? "⌘" : "",
    MAC_KEYS.get(event.keycode ?? -1) ?? `Key ${event.keycode ?? "?"}`,
  ];
  return parts.join("");
}

export function appendNativeEvent(
  current: readonly RecordedSkillEvent[],
  event: NativeSkillRecordingEvent,
): AppendNativeEventResult {
  const events = [...current];
  const last = events.at(-1);
  if (event.type === "app") {
    if (last?.type === "app" && contextMatches(last, event)) return { events, addedId: null, notice: null };
    return commit(events, {
      id: idFor(event), type: "app", atMs: event.atMs, app: event.app, windowTitle: event.windowTitle,
    });
  }
  if (event.type === "click") {
    return commit(events, {
      id: idFor(event), type: "click", atMs: event.atMs, app: event.app, windowTitle: event.windowTitle,
      role: event.role, name: event.name, identifier: event.identifier, ancestry: event.ancestry,
    });
  }
  if (event.type === "scroll") {
    const direction = (event.deltaY ?? 0) > 0 ? "up" : "down";
    if (last?.type === "scroll" && last.direction === direction && contextMatches(last, event) && event.atMs - last.atMs < 800) {
      return { events, addedId: null, notice: null };
    }
    return commit(events, {
      id: idFor(event), type: "scroll", direction, atMs: event.atMs, app: event.app, windowTitle: event.windowTitle,
    });
  }
  if (event.type === "clipboard") {
    // The helper emits the underlying ⌘C/⌘X/⌘V both as a `key` chord (already
    // committed a beat earlier as a shortcut) and as this richer clipboard
    // event. Collapse the duplicate so one keystroke is one step.
    const prev = events.at(-1);
    const collapsible =
      prev?.type === "shortcut" &&
      // Exactly ⌘C/⌘X/⌘V — not ⌥⌘C or other chords that merely end in the letter.
      /^⌘[CXV]$/.test(prev.shortcut ?? "") &&
      contextMatches(prev, event) &&
      Math.abs(event.atMs - prev.atMs) < 1_500;
    return commit(collapsible ? events.slice(0, -1) : events, {
      id: idFor(event), type: "clipboard", atMs: event.atMs, app: event.app,
      windowTitle: event.windowTitle, op: event.op,
    });
  }
  if (event.type === "download") {
    return commit(events, {
      id: idFor(event), type: "download", atMs: event.atMs,
      filename: event.filename, whereFroms: event.whereFroms,
    });
  }
  if (event.type === "typing") {
    // The helper pre-aggregates plain typing into a keyCount; keep the timeline
    // tidy by folding a follow-up burst in the same context into the last one.
    if (last?.type === "typing" && contextMatches(last, event) && event.atMs - last.atMs < 1_200) {
      events[events.length - 1] = { ...last, atMs: event.atMs, keyCount: (last.keyCount ?? 0) + (event.keyCount ?? 0) };
      return { events, addedId: null, notice: null };
    }
    return commit(events, {
      id: idFor(event), type: "typing", atMs: event.atMs, app: event.app,
      windowTitle: event.windowTitle, keyCount: event.keyCount ?? 0,
    });
  }
  // A "key" event now always carries a modifier — map it to a readable shortcut.
  return commit(events, {
    id: idFor(event), type: "shortcut", shortcut: shortcutLabel(event), atMs: event.atMs,
    app: event.app, windowTitle: event.windowTitle,
  });
}

export function eventLabel(event: RecordedSkillEvent): string {
  switch (event.type) {
    case "app": return `Opened ${event.app || "an app"}`;
    case "click": return event.name ? `Clicked "${event.name}"` : "Clicked a control";
    case "scroll": return `Scrolled ${event.direction ?? "the page"}`;
    case "shortcut": return `Pressed ${event.shortcut ?? "a shortcut"}`;
    case "typing": return `Typed ${event.keyCount ?? 1} character${event.keyCount === 1 ? "" : "s"}`;
    case "clipboard": return event.op === "cut" ? "Cut" : event.op === "paste" ? "Pasted" : "Copied";
    case "download": return `Downloaded ${event.filename ?? "a file"}`;
  }
}

export function formatRecordingTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
