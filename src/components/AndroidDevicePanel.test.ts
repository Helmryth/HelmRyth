import { describe, expect, it, vi } from "vitest";

import type { AndroidDeviceStatus, AndroidUsbDevice } from "@/types/helmryth";
import {
  androidFrameForSerial,
  nextAndroidDeviceSerial,
  shouldCaptureAndroidWheel,
  startNonOverlappingAndroidStatusPoll,
} from "./AndroidDevicePanel";

const device = (serial: string, state = "device"): AndroidUsbDevice => ({
  serial,
  state,
  connection: "usb",
  model: "Android device",
});

const status = (devices: AndroidUsbDevice[]): AndroidDeviceStatus => ({
  available: true,
  devices,
});

describe("Android workbench audit contracts", () => {
  it("keeps one status request in flight and schedules only after it settles", async () => {
    let resolveRead = (_value: AndroidDeviceStatus) => {};
    const pending = new Promise<AndroidDeviceStatus>((resolve) => {
      resolveRead = resolve;
    });
    const poll = vi.fn(() => pending);
    const commit = vi.fn();
    const scheduled: Array<() => void> = [];

    const stop = startNonOverlappingAndroidStatusPoll(poll, commit, vi.fn(), 2_000, {
      set: (callback) => {
        scheduled.push(callback);
        return 1;
      },
      clear: vi.fn(),
    });

    expect(poll).toHaveBeenCalledOnce();
    expect(scheduled).toHaveLength(0);
    resolveRead(status([device("phone-1")]));
    await pending;
    await Promise.resolve();

    expect(commit).toHaveBeenCalledOnce();
    expect(scheduled).toHaveLength(1);
    stop();
  });

  it("drops an old status result after its owner stops", async () => {
    let resolveRead = (_value: AndroidDeviceStatus) => {};
    const pending = new Promise<AndroidDeviceStatus>((resolve) => {
      resolveRead = resolve;
    });
    const commit = vi.fn();
    const scheduled: Array<() => void> = [];
    const stop = startNonOverlappingAndroidStatusPoll(
      () => pending,
      commit,
      vi.fn(),
      2_000,
      {
        set: (callback) => {
          scheduled.push(callback);
          return 1;
        },
        clear: vi.fn(),
      },
    );

    stop();
    resolveRead(status([device("stale-phone")]));
    await pending;
    await Promise.resolve();

    expect(commit).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(0);
  });

  it("validates the stored serial itself and prefers an authorized replacement", () => {
    const devices = [device("offline", "offline"), device("ready", "device")];

    expect(nextAndroidDeviceSerial(devices, "missing")).toBe("ready");
    expect(nextAndroidDeviceSerial(devices, "offline")).toBe("offline");
    expect(nextAndroidDeviceSerial([], "offline")).toBe("");
  });

  it("never relabels an old frame as the newly selected device", () => {
    const oldFrame = { serial: "phone-a", dataUrl: "data:image/png;base64,old" };

    expect(androidFrameForSerial(oldFrame, "phone-b")).toBeNull();
    expect(androidFrameForSerial(oldFrame, "phone-a")).toBe(oldFrame);
  });

  it("captures wheel gestures only while input capture and focus ownership are active", () => {
    expect(shouldCaptureAndroidWheel({
      capturingInput: true,
      ownsFocus: true,
      dimensionsReady: true,
    })).toBe(true);
    expect(shouldCaptureAndroidWheel({
      capturingInput: false,
      ownsFocus: true,
      dimensionsReady: true,
    })).toBe(false);
    expect(shouldCaptureAndroidWheel({
      capturingInput: true,
      ownsFocus: false,
      dimensionsReady: true,
    })).toBe(false);
  });
});
