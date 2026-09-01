import { describe, expect, it, vi } from "vitest";
import {
  CaptureLease,
  CaptureCancelled,
  CaptureStartGate,
  RECORDING_FULL_NOTICE,
  appendNativeEvent,
  recorderExitRequiresCaptureStop,
  runRecordedMethodCaptureStartup,
  shortcutLabel,
  watchCaptureSource,
  type RecordedSkillEvent,
} from "./skill-recorder";

const event = (patch: Partial<NativeSkillRecordingEvent>): NativeSkillRecordingEvent => ({
  type: "key", atMs: 100, app: "Notes", windowTitle: "Ideas", ...patch,
});

type EndedListenerState = { ended: (() => void) | null };

describe("skill recording events", () => {
  it("collapses a ⌘C key chord into the clipboard event so one keystroke is one step", () => {
    // The helper emits both a `key` chord and a `clipboard` event for ⌘C.
    const afterChord = appendNativeEvent([], event({ keycode: 8, meta: true }));
    expect(afterChord.events).toEqual([expect.objectContaining({ type: "shortcut", shortcut: "⌘C" })]);
    const afterClip = appendNativeEvent(afterChord.events, event({ type: "clipboard", atMs: 220, op: "copy" }));
    expect(afterClip.events).toEqual([expect.objectContaining({ type: "clipboard", op: "copy" })]);
    expect(afterClip.events).toHaveLength(1);
  });

  it("keeps a non-clipboard chord (⌥⌘C) as its own shortcut step", () => {
    const afterChord = appendNativeEvent([], event({ keycode: 8, meta: true, option: true }));
    const afterClip = appendNativeEvent(afterChord.events, event({ type: "clipboard", atMs: 220, op: "copy" }));
    expect(afterClip.events).toHaveLength(2);
    expect(afterClip.events[0]).toMatchObject({ type: "shortcut" });
    expect(afterClip.events[1]).toMatchObject({ type: "clipboard" });
  });

  it("stores a pre-aggregated typing burst as a keyCount, never characters", () => {
    const result = appendNativeEvent([], event({ type: "typing", keyCount: 7 }));
    expect(result.events).toEqual([expect.objectContaining({ type: "typing", keyCount: 7 })]);
    const json = JSON.stringify(result.events);
    expect(json).not.toContain("keycode");
    expect(json).not.toContain("A");
    expect(result.events[0]).not.toHaveProperty("shortcut");
  });

  it("folds consecutive typing bursts in the same context into one keyCount", () => {
    const first = appendNativeEvent([], event({ type: "typing", keyCount: 3 }));
    const second = appendNativeEvent(first.events, event({ type: "typing", atMs: 400, keyCount: 4 }));
    expect(second.events).toEqual([expect.objectContaining({ type: "typing", keyCount: 7 })]);
    expect(JSON.stringify(second.events)).not.toContain("keycode");
  });

  it("keeps modified keys as readable shortcuts", () => {
    const native = event({ keycode: 35, meta: true, shift: true });
    expect(shortcutLabel(native)).toBe("⇧⌘P");
    expect(appendNativeEvent([], native).events[0]).toMatchObject({ type: "shortcut", shortcut: "⇧⌘P" });
  });

  it("carries a click's element identity into the compiled event", () => {
    const native = event({
      type: "click", x: 10, y: 20, button: "left",
      role: "AXButton", name: "Submit", identifier: "submit-btn", ancestry: ["Window", "Toolbar"],
    });
    expect(appendNativeEvent([], native).events[0]).toMatchObject({
      type: "click", role: "AXButton", name: "Submit", identifier: "submit-btn", ancestry: ["Window", "Toolbar"],
    });
  });

  it("records a clipboard action with its op", () => {
    const result = appendNativeEvent([], event({ type: "clipboard", op: "copy" }));
    expect(result.events[0]).toMatchObject({ type: "clipboard", op: "copy" });
  });

  it("records a download with its filename and origins", () => {
    const native = event({ type: "download", filename: "invoice.pdf", whereFroms: ["https://acme.example/invoice.pdf"] });
    expect(appendNativeEvent([], native).events[0]).toMatchObject({
      type: "download", filename: "invoice.pdf", whereFroms: ["https://acme.example/invoice.pdf"],
    });
  });

  it("coalesces repeated scrolling in the same window", () => {
    const first = appendNativeEvent([], event({ type: "scroll", deltaY: -2 }));
    const second = appendNativeEvent(first.events, event({ type: "scroll", atMs: 600, deltaY: -7 }));
    expect(second.events).toHaveLength(1);
  });

  it("gives same-millisecond events distinct ids", () => {
    const first = appendNativeEvent([], event({ type: "click", atMs: 100 }));
    const second = appendNativeEvent(first.events, event({ type: "click", atMs: 100 }));
    expect(second.events[0]?.id).not.toBe(second.events[1]?.id);
  });

  it("caps the timeline at 600 events and keeps the first ones", () => {
    let events: RecordedSkillEvent[] = [];
    for (let i = 0; i < 650; i += 1) {
      events = appendNativeEvent(events, event({ type: "click", atMs: i })).events;
    }
    expect(events).toHaveLength(600);
    expect(events[0]?.atMs).toBe(0);
    expect(events.at(-1)?.atMs).toBe(599);

    // Once at the cap, a new event is refused rather than dropping the head.
    const atCap = appendNativeEvent(events, event({ type: "click", atMs: 999 }));
    expect(atCap.addedId).toBeNull();
    expect(atCap.events).toHaveLength(600);
    expect(atCap.events[0]?.atMs).toBe(0);
  });

  it("says the recording is full instead of going quiet at the cap", () => {
    let events: RecordedSkillEvent[] = [];
    for (let i = 0; i < 600; i += 1) {
      events = appendNativeEvent(events, event({ type: "click", atMs: i })).events;
    }
    const atCap = appendNativeEvent(events, event({ type: "click", atMs: 999 }));
    expect(atCap.notice).toBe(RECORDING_FULL_NOTICE);
    expect(atCap.notice).toMatch(/600 steps/);

    // A step merely folded into the previous one is not a full recording,
    // so the same null addedId must not raise the notice.
    const folded = appendNativeEvent(
      [{ id: "typed", type: "typing", atMs: 10, app: "Notes", windowTitle: "Ideas", keyCount: 3 }],
      event({ type: "typing", atMs: 400, keyCount: 4, app: "Notes" }),
    );
    expect(folded.addedId).toBeNull();
    expect(folded.notice).toBeNull();
  });
});

describe("recorded-method startup ownership", () => {
  it("grants one synchronous start lease and rejects same-tick re-entry", () => {
    const gate = new CaptureStartGate();
    const first = gate.begin();

    expect(first).toBeInstanceOf(CaptureLease);
    expect(gate.begin()).toBeNull();
    expect(gate.starting).toBe(true);
    expect(gate.finish(first!)).toBe(true);
    expect(gate.starting).toBe(false);
  });

  it("releases acquired resources once and immediately rejects late await results", async () => {
    const lease = new CaptureLease();
    const released: string[] = [];

    expect(await lease.keep("screen", (resource) => { released.push(resource); })).toBe(true);
    await lease.release();
    await lease.release();
    expect(released).toEqual(["screen"]);

    expect(await lease.keep("microphone", (resource) => { released.push(resource); })).toBe(false);
    expect(released).toEqual(["screen", "microphone"]);
  });

  it("cancels the current startup lease without clearing a newer attempt", async () => {
    const gate = new CaptureStartGate();
    const first = gate.begin()!;
    await gate.cancel(first);
    const second = gate.begin()!;

    await gate.cancel(first);
    expect(gate.starting).toBe(true);
    expect(second.active).toBe(true);
  });
});

describe("native recorder exit classification", () => {
  it("treats an unrequested clean helper exit as capture loss", () => {
    expect(recorderExitRequiresCaptureStop("recording", true, 0)).toBe(true);
    expect(recorderExitRequiresCaptureStop("starting", true, 0)).toBe(true);
  });

  it("ignores an expected clean stop but surfaces a failed stop", () => {
    expect(recorderExitRequiresCaptureStop("recording", false, 0)).toBe(false);
    expect(recorderExitRequiresCaptureStop("recording", false, 1)).toBe(true);
    expect(recorderExitRequiresCaptureStop("review", true, 1)).toBe(false);
  });
});

describe("recorded-method startup orchestration", () => {
  const stages = [
    "permission",
    "screen",
    "watch-screen",
    "preview",
    "microphone",
    "watch-microphone",
    "native",
    "transcription",
  ] as const;

  it.each(stages)("releases every owned resource when cancelled at %s", async (cancelStage) => {
    const lease = new CaptureLease();
    const released: string[] = [];
    const reached: string[] = [];
    const stage = async <Value>(name: string, value: Value): Promise<Value> => {
      reached.push(name);
      if (name === cancelStage) await lease.release();
      return value;
    };

    await expect(runRecordedMethodCaptureStartup(lease, {
      permission: () => stage("permission", undefined),
      screen: () => stage("screen", "screen"),
      releaseScreen: (value) => { released.push(value); },
      watchScreen: () => stage("watch-screen", undefined),
      preview: () => stage("preview", undefined),
      microphone: () => stage("microphone", "microphone"),
      releaseMicrophone: (value) => { released.push(value); },
      watchMicrophone: () => stage("watch-microphone", undefined),
      recorder: () => "audio",
      releaseRecorder: (value) => { released.push(value); },
      beforeNativeStart: () => {},
      native: () => stage("native", undefined),
      stopNative: () => { released.push("native"); },
      transcription: () => stage("transcription", "transcription"),
      stopTranscription: (value) => { released.push(value); },
    })).rejects.toBeInstanceOf(CaptureCancelled);

    expect(reached).toContain(cancelStage);
    const stageIndex = stages.indexOf(cancelStage);
    for (const later of stages.slice(stageIndex + 1)) expect(reached).not.toContain(later);
    if (stageIndex >= stages.indexOf("screen")) expect(released).toContain("screen");
    if (stageIndex >= stages.indexOf("microphone")) expect(released).toContain("microphone");
    if (stageIndex >= stages.indexOf("native")) expect(released).toContain("native");
    if (stageIndex >= stages.indexOf("transcription")) expect(released).toContain("transcription");
  });

  it("detaches source-ended listeners when the capture lease releases", async () => {
    const lease = new CaptureLease();
    const listenerState: EndedListenerState = { ended: null };
    const onEnded = vi.fn();
    const track = {
      addEventListener: (_name: "ended", listener: () => void) => { listenerState.ended = listener; },
      removeEventListener: (_name: "ended", listener: () => void) => {
        if (listenerState.ended === listener) listenerState.ended = null;
      },
    };

    await watchCaptureSource({ getTracks: () => [track] }, lease, onEnded);
    listenerState.ended?.();
    expect(onEnded).toHaveBeenCalledOnce();
    await lease.release();
    expect(listenerState.ended).toBeNull();
  });
});
