import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Circle, Loader2, RotateCcw, ShieldCheck, Smartphone, Usb } from "lucide-react";
import { usePageVisible } from "@/lib/page-visible";
import type { AndroidDeviceInput, AndroidDeviceStatus, AndroidUsbDevice } from "@/types/helmryth";

type UnitPoint = { x: number; y: number };
type AndroidFrame = { serial: string; dataUrl: string };

interface AndroidWheelCaptureState {
  capturingInput: boolean;
  ownsFocus: boolean;
  dimensionsReady: boolean;
}

export interface AndroidStatusPollTimer {
  set: (callback: () => void, delayMs: number) => number;
  clear: (handle: number) => void;
}

const EMPTY_STATUS: AndroidDeviceStatus = { available: false, devices: [] };
const ANDROID_STATUS_ERROR = "Android device status could not be read. Reconnect the device and try again.";
const ANDROID_FRAME_ERROR = "Android Workbench could not refresh the device screen. Reconnect the device and try again.";
const ANDROID_INPUT_ERROR = "Android Workbench could not send that control. Check the USB connection and try again.";

/** Run one ADB-backed read at a time. Stopping advances ownership so a result
 * from a hidden/unmounted panel cannot commit into the next visible session. */
export function startNonOverlappingAndroidStatusPoll(
  poll: () => Promise<AndroidDeviceStatus>,
  commit: (status: AndroidDeviceStatus) => void,
  fail: () => void,
  intervalMs: number,
  timer: AndroidStatusPollTimer = {
    set: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clear: (handle) => window.clearTimeout(handle),
  },
): () => void {
  let stopped = false;
  let generation = 0;
  let handle: number | null = null;
  const refresh = async () => {
    const owner = ++generation;
    try {
      const next = await poll();
      if (!stopped && owner === generation) commit(next);
    } catch {
      if (!stopped && owner === generation) fail();
    } finally {
      if (!stopped && owner === generation) {
        handle = timer.set(() => void refresh(), intervalMs);
      }
    }
  };
  void refresh();
  return () => {
    stopped = true;
    generation += 1;
    if (handle !== null) timer.clear(handle);
  };
}

export function nextAndroidDeviceSerial(
  devices: readonly AndroidUsbDevice[],
  storedSerial: string,
): string {
  if (devices.some((device) => device.serial === storedSerial)) return storedSerial;
  return devices.find((device) => device.state === "device")?.serial ?? devices[0]?.serial ?? "";
}

export function androidFrameForSerial(frame: AndroidFrame | null, serial: string): AndroidFrame | null {
  return frame?.serial === serial ? frame : null;
}

export function shouldCaptureAndroidWheel(state: AndroidWheelCaptureState): boolean {
  return state.capturingInput && state.ownsFocus && state.dimensionsReady;
}

export function useAndroidUsbDevices() {
  const bridge = window.helmryth?.androidDevice;
  const [status, setStatus] = useState<AndroidDeviceStatus>(EMPTY_STATUS);
  const pageVisible = usePageVisible();

  useEffect(() => {
    // every tick is an adb subprocess — nothing to learn while hidden
    if (!bridge || !pageVisible) return;
    return startNonOverlappingAndroidStatusPoll(
      () => bridge.status(),
      setStatus,
      () => setStatus({
        available: false,
        devices: [],
        reasonCode: "adb-failed",
        message: ANDROID_STATUS_ERROR,
      }),
      2_000,
    );
  }, [bridge, pageVisible]);

  return status;
}

function deviceLabel(device: AndroidUsbDevice) {
  return device.model === "Android device" ? device.serial : device.model;
}

function deviceStateLabel(state: string): string {
  if (state === "device") return "Ready";
  if (state === "unauthorized") return "Authorization needed";
  if (state === "offline") return "Offline";
  return "Unavailable";
}

export function AndroidDevicePanel({ status }: { status: AndroidDeviceStatus }) {
  const bridge = window.helmryth?.androidDevice;
  const pageVisible = usePageVisible();
  const authorized = status.devices.filter((device) => device.state === "device");
  const [serial, setSerial] = useState(authorized[0]?.serial ?? status.devices[0]?.serial ?? "");
  const [frame, setFrame] = useState<AndroidFrame | null>(null);
  const [dimensions, setDimensions] = useState({ serial: "", width: 0, height: 0 });
  const [error, setError] = useState<string | null>(null);
  const [capturingInput, setCapturingInput] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const pointerRef = useRef<{ point: UnitPoint; at: number } | null>(null);
  const wheelRef = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> | null }>({
    x: 0,
    y: 0,
    timer: null,
  });
  const selected = status.devices.find((device) => device.serial === serial) ?? null;
  const selectedSerial = selected?.serial;
  const selectedState = selected?.state;

  useEffect(() => {
    const nextSerial = nextAndroidDeviceSerial(status.devices, serial);
    if (nextSerial !== serial) setSerial(nextSerial);
  }, [serial, status.devices]);

  useEffect(() => {
    // an adb screencap subprocess per tick — pause the mirror while hidden
    if (!bridge || !selectedSerial || selectedState !== "device" || !pageVisible) {
      if (!pageVisible) return;
      setFrame(null);
      setDimensions({ serial: "", width: 0, height: 0 });
      return;
    }
    setFrame(null);
    setError(null);
    setDimensions({ serial: selectedSerial, width: 0, height: 0 });
    pointerRef.current = null;
    if (wheelRef.current.timer) clearTimeout(wheelRef.current.timer);
    wheelRef.current = { x: 0, y: 0, timer: null };
    setCapturingInput(false);
    let alive = true;
    let timer: number | null = null;
    const capture = async () => {
      try {
        const result = await bridge.frame(selectedSerial);
        if (alive) {
          const nextFrame = androidFrameForSerial(result, selectedSerial);
          setFrame(nextFrame);
          setError(nextFrame ? null : ANDROID_FRAME_ERROR);
        }
      } catch {
        if (alive) setError(ANDROID_FRAME_ERROR);
      } finally {
        if (alive) timer = window.setTimeout(() => void capture(), 850);
      }
    };
    void capture();
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [bridge, selectedSerial, selectedState, pageVisible]);

  useEffect(
    () => () => {
      if (wheelRef.current.timer) clearTimeout(wheelRef.current.timer);
    },
    [],
  );

  const send = (payload: AndroidDeviceInput) => {
    if (!bridge || !selected || selected.state !== "device") return;
    void bridge.input(selected.serial, payload).catch(() => {
      setError(ANDROID_INPUT_ERROR);
    });
  };

  const unitPoint = (
    event: React.PointerEvent<HTMLDivElement>,
    clampToPhone = false,
  ): UnitPoint | null => {
    const image = imageRef.current;
    if (!image || dimensions.serial !== selectedSerial || !dimensions.width || !dimensions.height) return null;
    const bounds = event.currentTarget.getBoundingClientRect();
    const scale = Math.min(bounds.width / dimensions.width, bounds.height / dimensions.height);
    const fittedWidth = dimensions.width * scale;
    const fittedHeight = dimensions.height * scale;
    const left = bounds.left + (bounds.width - fittedWidth) / 2;
    const top = bounds.top + (bounds.height - fittedHeight) / 2;
    const x = (event.clientX - left) / fittedWidth;
    const y = (event.clientY - top) / fittedHeight;
    if (clampToPhone) {
      return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
    }
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  };

  const keyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && capturingInput) {
      event.preventDefault();
      setCapturingInput(false);
      return;
    }
    if (!capturingInput) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setCapturingInput(true);
      }
      return;
    }
    if (event.key === "Tab") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const named = (() => {
      switch (event.key) {
        case "ArrowDown": return "down";
        case "ArrowLeft": return "left";
        case "ArrowRight": return "right";
        case "ArrowUp": return "up";
        case "Backspace":
        case "Delete": return "delete";
        case "Enter": return "enter";
        default: return null;
      }
    })();
    if (named) {
      event.preventDefault();
      send({ type: "key", key: named });
    } else if (/^[A-Za-z0-9 _.,@-]$/.test(event.key)) {
      event.preventDefault();
      send({ type: "text", text: event.key });
    }
  };

  const wheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!shouldCaptureAndroidWheel({
      capturingInput,
      ownsFocus: document.activeElement === event.currentTarget,
      dimensionsReady:
        dimensions.serial === selectedSerial && Boolean(dimensions.width && dimensions.height),
    })) return;
    event.preventDefault();
    const gesture = wheelRef.current;
    gesture.x += event.deltaX;
    gesture.y += event.deltaY;
    if (gesture.timer) clearTimeout(gesture.timer);
    gesture.timer = setTimeout(() => {
      const horizontal = Math.abs(gesture.x) > Math.abs(gesture.y);
      const delta = horizontal ? gesture.x : gesture.y;
      gesture.x = 0;
      gesture.y = 0;
      gesture.timer = null;
      if (Math.abs(delta) < 2) return;
      const distance = Math.max(0.18, Math.min(0.45, Math.abs(delta) / 500));
      const direction = delta > 0 ? -1 : 1;
      const from = horizontal ? { x: 0.5, y: 0.5 } : { x: 0.5, y: 0.65 };
      const to = horizontal
        ? { x: from.x + direction * distance, y: from.y }
        : { x: from.x, y: from.y + direction * distance };
      send({
        type: "swipe",
        fromX: from.x,
        fromY: from.y,
        toX: to.x,
        toY: to.y,
        durationMs: 260,
        width: dimensions.width,
        height: dimensions.height,
      });
    }, 80);
  };

  if (!selected) return null;
  const ready = selected.state === "device";
  const visibleFrame = androidFrameForSerial(frame, selected.serial);

  return (
    <div className="space-y-4 pb-5" aria-label="Android workbench">
      <div className="border-b border-hairline/60 pb-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 font-display text-[16px] font-medium text-ink">
              <Smartphone size={16} className="text-success" /> {deviceLabel(selected)}
            </h3>
            <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
              Direct USB session. Screen data and controls stay on the host workbench.
            </div>
          </div>
          <span className="flex shrink-0 items-center gap-1 text-[12px] text-success">
            <ShieldCheck size={12} /> USB
          </span>
        </div>
        {status.devices.length > 1 && (
          <label className="mt-3 block">
            <span className="mb-1.5 block text-[12px] font-medium text-ink-secondary">Android device</span>
            <select
              value={selected.serial}
              onChange={(event) => setSerial(event.target.value)}
              className="w-full rounded-md border border-hairline/60 bg-inset px-3 py-2 text-[12px] text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
            >
              {status.devices.map((device) => (
                <option key={device.serial} value={device.serial}>
                  {deviceLabel(device)} · {deviceStateLabel(device.state)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {!ready ? (
        <div role="status" className="border-l-2 border-warning bg-warning/10 p-4 text-[12px] leading-relaxed text-warning">
          {selected.state === "unauthorized"
            ? "Unlock the Android device, accept “Allow USB debugging,” and optionally trust this host workbench."
            : "The Android device is unavailable. Reconnect its USB cable and keep USB debugging enabled."}
        </div>
      ) : (
        <>
          <div
            role="group"
            aria-label={`Interactive Android workbench for ${deviceLabel(selected)}`}
            aria-describedby="android-workbench-help"
            tabIndex={0}
            onKeyDown={keyDown}
            onBlur={() => setCapturingInput(false)}
            onWheel={wheel}
            onPointerDown={(event) => {
              const point = unitPoint(event);
              if (!point) return;
              setCapturingInput(true);
              event.currentTarget.setPointerCapture(event.pointerId);
              pointerRef.current = { point, at: performance.now() };
            }}
            onPointerUp={(event) => {
              const start = pointerRef.current;
              const end = unitPoint(event, true);
              pointerRef.current = null;
              if (!start || !end) return;
              const distance = Math.hypot(end.x - start.point.x, end.y - start.point.y);
              if (distance < 0.012) {
                send({ type: "tap", ...end, width: dimensions.width, height: dimensions.height });
              } else {
                send({
                  type: "swipe",
                  fromX: start.point.x,
                  fromY: start.point.y,
                  toX: end.x,
                  toY: end.y,
                  durationMs: performance.now() - start.at,
                  width: dimensions.width,
                  height: dimensions.height,
                });
              }
              event.currentTarget.focus();
            }}
            onPointerCancel={() => {
              pointerRef.current = null;
            }}
            className="mx-auto flex h-[520px] w-full touch-none cursor-pointer items-center justify-center overflow-hidden overscroll-none rounded-md bg-inset outline-none ring-1 ring-hairline focus:ring-2 focus:ring-accent"
          >
            {visibleFrame ? (
              <img
                ref={imageRef}
                src={visibleFrame.dataUrl}
                alt={`${deviceLabel(selected)} screen`}
                draggable={false}
                onLoad={(event) => {
                  setDimensions({
                    serial: selected.serial,
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  });
                }}
                className="pointer-events-none h-full w-full select-none object-contain"
              />
            ) : (
              <Loader2 size={20} className="motion-safe:animate-spin text-ink-secondary" />
            )}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => send({ type: "key", key: "back" })}
              className="flex min-h-9 items-center justify-center gap-1.5 rounded-md bg-raised px-2 text-[12px] text-ink hover:bg-raised-hover"
            >
              <ArrowLeft size={13} /> Back
            </button>
            <button
              onClick={() => send({ type: "key", key: "home" })}
              className="flex min-h-9 items-center justify-center gap-1.5 rounded-md bg-raised px-2 text-[12px] text-ink hover:bg-raised-hover"
            >
              <Circle size={12} /> Home
            </button>
            <button
              onClick={() => send({ type: "key", key: "recent" })}
              className="flex min-h-9 items-center justify-center gap-1.5 rounded-md bg-raised px-2 text-[12px] text-ink hover:bg-raised-hover"
            >
              <RotateCcw size={13} /> Recents
            </button>
          </div>
          <div id="android-workbench-help" className="text-center text-[12px] leading-relaxed text-ink-secondary">
            {capturingInput
              ? "Input captured. Press Escape to release keyboard input; Tab then leaves the workbench."
              : "Click the screen, or focus it and press Enter, to capture input. Drag or scroll to navigate."}
          </div>
        </>
      )}

      {error && (
        <div role="alert" className="border-l-2 border-danger bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}

      <div className="border-t border-hairline/60 pt-4">
        <h3 className="flex items-center gap-2 font-display text-[16px] font-medium text-ink">
          <Usb size={15} className="text-accent" /> Prepare an Android workbench
        </h3>
        <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-[12px] leading-relaxed text-ink-secondary">
          <li>Connect the Android device with a data-capable USB cable and keep it unlocked.</li>
          <li>
            Enable Developer options by tapping <span className="text-ink">Build number</span> seven times in
            <span className="text-ink">About phone</span> (the label varies by manufacturer), then turn on <span className="text-ink">USB debugging</span>.
          </li>
          <li>
            Accept <span className="text-ink">Allow USB debugging</span> on the device. You can choose Always allow
            for this trusted host.
          </li>
        </ol>
        <div className="mt-2 text-[12px] leading-relaxed text-ink-secondary">
          Operator control uses this authorized USB connection. Helmryth Mobile, a Relay account, Tailscale, and
          wireless pairing are not required.
        </div>
        <div className="mt-2 border-l-2 border-accent bg-inset px-3 py-2 text-[12px] leading-relaxed text-ink-secondary">
          Once connected, ask a compatible operator to open an Android app or complete a run on the device. The
          bundled Android Control method loads automatically when the workstream targets Android.
        </div>
      </div>
    </div>
  );
}
