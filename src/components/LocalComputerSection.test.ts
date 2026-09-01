import { describe, expect, it } from "vitest";
import {
  workbenchNeedsRecreation,
  workbenchReadiness,
  type LocalWorkbenchStatus,
  type WorkbenchReadinessIssue,
} from "./LocalComputerSection";

const readyStatus: LocalWorkbenchStatus = {
  platform: "darwin",
  runtime: "docker",
  available: ["docker"],
  daemonUp: true,
  image: true,
  imageMatches: true,
  managed: true,
  container: "running",
  network: "loopback",
  security: "hardened",
  persistence: "durable",
  desktopReady: true,
  ready: true,
  problem: null,
  image_ref: "example.invalid/helmryth/workbench:test",
  base_image_ref: "example.invalid/helmryth/base:test",
  driver_version: "test",
  container_name: "helmryth-test",
  workspace_path: "/tmp/helmryth-test",
  workspace_guest_path: "/home/cua/helmryth",
  viewer_url: "http://127.0.0.1:3000/vnc.html",
  idle_timeout_ms: 1,
  mode: "shared",
  max_instances: 2,
  commands: {
    install: null,
    runtimeStart: null,
    pull: null,
    run: null,
    start: null,
    stop: null,
    remove: null,
    view: "http://127.0.0.1:3000/vnc.html",
  },
};

function status(overrides: Partial<LocalWorkbenchStatus>): LocalWorkbenchStatus {
  return { ...readyStatus, ready: false, ...overrides };
}

describe("Local Workbench readiness priority", () => {
  it.each<{
    name: string;
    value: LocalWorkbenchStatus | null;
    issue: WorkbenchReadinessIssue;
    message: string;
  }>([
    {
      name: "unavailable status",
      value: null,
      issue: "status-unavailable",
      message: "Workbench status is unavailable",
    },
    {
      name: "missing runtime before every default downstream failure",
      value: status({
        runtime: null,
        daemonUp: false,
        image: false,
        imageMatches: false,
        managed: false,
        container: "missing",
        network: "unknown",
        security: "unknown",
        persistence: "unknown",
        problem: "Start docker first",
      }),
      issue: "runtime-missing",
      message: "Install a supported container runtime first",
    },
    {
      name: "stopped Docker before image compatibility",
      value: status({ daemonUp: false, image: false, imageMatches: false, managed: false }),
      issue: "runtime-stopped",
      message: "Start Docker first",
    },
    {
      name: "stopped Podman",
      value: status({ runtime: "podman", daemonUp: false }),
      issue: "runtime-stopped",
      message: "Start Podman first",
    },
    {
      name: "unknown runtime uses bounded copy",
      value: status({ runtime: "untrusted runtime detail", daemonUp: false }),
      issue: "runtime-stopped",
      message: "Start the container runtime first",
    },
    {
      name: "missing image before missing or mismatched workbench",
      value: status({ image: false, imageMatches: false, managed: false, container: "missing" }),
      issue: "image-missing",
      message: "Prepare the Workbench image",
    },
    {
      name: "missing workbench before the default false image match",
      value: status({ container: "missing", imageMatches: false, managed: false }),
      issue: "workbench-missing",
      message: "Create the Isolated Workbench",
    },
    {
      name: "mismatched existing image before ownership and boundaries",
      value: status({ imageMatches: false, managed: false, network: "unsafe", security: "unsafe", persistence: "unsafe" }),
      issue: "image-mismatch",
      message: "The Workbench image needs replacement",
    },
    {
      name: "unmanaged workbench before boundaries",
      value: status({ managed: false, network: "unsafe", security: "unsafe", persistence: "unsafe" }),
      issue: "unmanaged",
      message: "This Workbench is not managed by the current Helmryth installation",
    },
    {
      name: "unsafe network before security and persistence",
      value: status({ network: "unsafe", security: "unsafe", persistence: "unsafe" }),
      issue: "network-unsafe",
      message: "The viewer network boundary is unsafe",
    },
    {
      name: "unsafe security before persistence",
      value: status({ security: "unsafe", persistence: "unsafe" }),
      issue: "security-unsafe",
      message: "The Workbench security boundary is unsafe",
    },
    {
      name: "unsafe persistence",
      value: status({ persistence: "unsafe" }),
      issue: "persistence-unsafe",
      message: "The durable workspace boundary is unsafe",
    },
    {
      name: "stopped workbench after verified boundaries",
      value: status({ container: "stopped", desktopReady: false }),
      issue: "workbench-stopped",
      message: "The Isolated Workbench is stopped",
    },
    {
      name: "running desktop startup",
      value: status({ desktopReady: false }),
      issue: "desktop-starting",
      message: "The Isolated Workbench is starting",
    },
    {
      name: "unclassified not-ready state",
      value: status({}),
      issue: "not-ready",
      message: "The Isolated Workbench is not ready",
    },
  ])("reports $name", ({ value, issue, message }) => {
    expect(workbenchReadiness(value)).toEqual({ issue, message });
  });

  it.each([
    ["no status", null, false],
    ["runtime missing", status({ runtime: null, daemonUp: false, image: false, container: "missing" }), false],
    ["runtime stopped", status({ daemonUp: false }), false],
    ["image missing", status({ image: false }), false],
    ["workbench missing", status({ container: "missing", imageMatches: false, managed: false }), false],
    ["image mismatch", status({ imageMatches: false }), true],
    ["unmanaged", status({ managed: false }), true],
    ["unsafe network", status({ network: "unsafe" }), true],
    ["unsafe security", status({ security: "unsafe" }), true],
    ["unsafe persistence", status({ persistence: "unsafe" }), true],
    ["workbench stopped", status({ container: "stopped", desktopReady: false }), true],
    ["desktop starting", status({ desktopReady: false }), false],
    ["ready", readyStatus, false],
  ] as const)("recreation for %s is %s", (_name, value, expected) => {
    expect(workbenchNeedsRecreation(value)).toBe(expected);
  });
});
