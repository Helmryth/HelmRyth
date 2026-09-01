import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  BASE_IMAGE_DIGEST,
  CUA_DRIVER_VERSION,
  DRIVER_LABEL,
  IMAGE,
  IMAGE_LAYER_LABEL,
  MANAGED_LABEL,
  TARGET_LABEL,
  VM_WORKSPACE_GUEST,
  WORKSPACE_LABEL,
} from "./container-computer.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import type { JsonValue } from "./schema.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const RESPONSE_SECRET_SENTINEL = "workbench-handler-secret-must-not-leak";

const fakeContainerSchema = z.object({
  running: z.boolean(),
  managed: z.boolean(),
  unsafeNetwork: z.boolean(),
  workspaceDir: z.string(),
  targetLabel: z.string(),
  viewerPort: z.number(),
  viewerPassword: z.string(),
});
const fakeRuntimeStateSchema = z.object({
  image: z.boolean(),
  corruptPreview: z.boolean(),
  delayBuildMs: z.number(),
  delayRunMs: z.number(),
  containers: z.record(z.string(), fakeContainerSchema),
});
const responseBodySchema = z.record(z.string(), z.json());
const rosterSchema = z.object({
  bots: z.array(z.object({ id: z.string() }).passthrough()),
}).passthrough();

type FakeRuntimeState = z.output<typeof fakeRuntimeStateSchema>;
type ApiResponse = { status: number; body: z.output<typeof responseBodySchema> };

let child: ChildProcess | undefined;
let base = "";
let home = "";
let dataDir = "";
let statePath = "";
let callsPath = "";
let stderr = "";
let starterBotId = "";

const cleanState = (): FakeRuntimeState => ({
  image: false,
  corruptPreview: false,
  delayBuildMs: 0,
  delayRunMs: 0,
  containers: {},
});

function readState(): FakeRuntimeState {
  return fakeRuntimeStateSchema.parse(JSON.parse(readFileSync(statePath, "utf8")));
}

function writeState(state: FakeRuntimeState): void {
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
}

function mutateState(change: (state: FakeRuntimeState) => void): void {
  const state = readState();
  change(state);
  writeState(state);
}

const api = async (
  method: string,
  path: string,
  body?: JsonValue,
  headers: Record<string, string> = {},
): Promise<ApiResponse> => {
  const mutation = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  const requestHeaders = { ...headers };
  if (mutation && requestHeaders["content-type"] === undefined) requestHeaders["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: responseBodySchema.parse(await response.json()) };
};

async function waitForCall(fragment: string): Promise<void> {
  await expect.poll(
    () => {
      try {
        return readFileSync(callsPath, "utf8").includes(fragment);
      } catch {
        return false;
      }
    },
    { timeout: 5_000 },
  ).toBe(true);
}

function expectSanitized(response: ApiResponse): void {
  const serialized = JSON.stringify(response.body);
  expect(serialized).not.toContain(RESPONSE_SECRET_SENTINEL);
  expect(serialized).not.toContain(statePath);
  expect(serialized).not.toContain(callsPath);
  expect(serialized).not.toMatch(/authorization\s*[:=]\s*bearer/i);
}

function fakeDockerSource(): string {
  // This executable is placed first on HELMRYTH_EXTRA_PATH. The production
  // server therefore drives its real execFile-based adapter, while no Docker,
  // Podman, or Apple container daemon is contacted by this suite.
  return `#!${process.execPath}
const fs = require("node:fs");

const statePath = process.env.HELMRYTH_FAKE_RUNTIME_STATE;
const callsPath = process.env.HELMRYTH_FAKE_RUNTIME_CALLS;
const args = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message = "not found") => {
  if (message) process.stderr.write(message + "\\n");
  process.exit(1);
};
const read = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = (state) => fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
const pairValue = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const pairs = (name) => {
  const out = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === name) out.push(args[index + 1]);
  }
  return out;
};
const png = (corrupt) => {
  const bytes = Buffer.alloc(corrupt ? 80 : 640);
  bytes.set([0x89, 0x50, 0x4e, 0x47], 0);
  if (!corrupt) bytes.write("IEND", 628, "ascii");
  return bytes.toString("base64");
};

fs.appendFileSync(callsPath, JSON.stringify(args) + "\\n", { mode: 0o600 });
const state = read();

(async () => {
  if (args[0] === "info" && args[1] === "--format") {
    process.stdout.write("29.0.0\\n");
    return;
  }
  if (args[0] === "pull") return;
  if (args[0] === "build") {
    await sleep(state.delayBuildMs || 0);
    state.image = true;
    save(state);
    return;
  }
  if (args[0] === "image" && args[1] === "inspect") {
    if (!state.image) fail();
    process.stdout.write(JSON.stringify([{
      Id: "sha256:fixture-image-id",
      Config: { Labels: {
        ${JSON.stringify(MANAGED_LABEL)}: "1",
        ${JSON.stringify(DRIVER_LABEL)}: ${JSON.stringify(CUA_DRIVER_VERSION)},
        ${JSON.stringify("com.helmryth.cua-base")}: ${JSON.stringify(BASE_IMAGE_DIGEST)},
        ${JSON.stringify(IMAGE_LAYER_LABEL)}: ${JSON.stringify("4")}
      } }
    }]));
    return;
  }
  if (args[0] === "run") {
    await sleep(state.delayRunMs || 0);
    const name = pairValue("--name");
    const labels = Object.fromEntries(pairs("--label").map((entry) => {
      const at = entry.indexOf("=");
      return [entry.slice(0, at), entry.slice(at + 1)];
    }));
    const mount = pairValue("--mount") || "";
    const source = /(?:^|,)source=([^,]+)/.exec(mount)?.[1] || "";
    const published = pairValue("-p") || "";
    const middle = published.split(":")[1];
    const port = middle ? Number(middle) : 49152 + Object.keys(state.containers).length;
    const viewerPassword = (pairs("-e").find((entry) => entry.startsWith("VNC_PW=")) || "VNC_PW=").slice(7);
    state.containers[name] = {
      running: true,
      managed: true,
      unsafeNetwork: false,
      workspaceDir: source,
      targetLabel: labels[${JSON.stringify(TARGET_LABEL)}] || "",
      viewerPort: port,
      viewerPassword
    };
    save(state);
    process.stdout.write("fixture-container-id\\n");
    return;
  }
  if ((args[0] === "stop" || args[0] === "start") && args[1]) {
    const container = state.containers[args[1]];
    if (!container) fail();
    container.running = args[0] === "start";
    save(state);
    return;
  }
  if (args[0] === "rm") {
    const name = args.at(-1);
    if (!state.containers[name]) fail();
    delete state.containers[name];
    save(state);
    return;
  }
  if (args[0] === "inspect" && args[1]) {
    const container = state.containers[args[1]];
    if (!container) fail();
    const labels = {
      ${JSON.stringify(MANAGED_LABEL)}: "1",
      ${JSON.stringify(DRIVER_LABEL)}: ${JSON.stringify(CUA_DRIVER_VERSION)},
      ${JSON.stringify("com.helmryth.cua-base")}: ${JSON.stringify(BASE_IMAGE_DIGEST)},
      ${JSON.stringify(IMAGE_LAYER_LABEL)}: ${JSON.stringify("4")},
      ${JSON.stringify(WORKSPACE_LABEL)}: "1",
      ${JSON.stringify(TARGET_LABEL)}: container.managed ? container.targetLabel : "foreign-target"
    };
    const hostIp = container.unsafeNetwork ? "0.0.0.0" : "127.0.0.1";
    const ports = { "6901/tcp": [{ HostIp: hostIp, HostPort: String(container.viewerPort) }] };
    process.stdout.write(JSON.stringify([{
      Config: {
        Image: ${JSON.stringify(IMAGE)},
        Labels: labels,
        Env: ["VNC_PW=" + container.viewerPassword]
      },
      HostConfig: {
        PortBindings: ports,
        Memory: 4294967296,
        MemorySwap: 4294967296,
        NanoCpus: 2000000000,
        PidsLimit: 512,
        CapDrop: ["ALL"],
        CapAdd: ["SETUID", "SETGID"],
        Privileged: false,
        PidMode: "",
        IpcMode: "private",
        UTSMode: "",
        ShmSize: 536870912,
        Devices: [],
        DeviceRequests: null,
        SecurityOpt: [],
        UsernsMode: "",
        CgroupnsMode: "private",
        OomKillDisable: false,
        AutoRemove: false,
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 }
      },
      NetworkSettings: { Ports: ports },
      Mounts: [{
        Type: "bind",
        Source: container.workspaceDir,
        Destination: ${JSON.stringify(VM_WORKSPACE_GUEST)},
        RW: true
      }],
      State: { Running: container.running },
      Image: "sha256:fixture-image-id"
    }]));
    return;
  }
  if (args[0] === "exec") {
    const joined = args.join(" ");
    if (joined.includes(${JSON.stringify("/usr/local/libexec/helmryth/cua-driver --version")})) {
      process.stdout.write(${JSON.stringify(`cua-driver ${CUA_DRIVER_VERSION}\n`)});
      return;
    }
    if (joined.includes(${JSON.stringify("/usr/local/libexec/helmryth/cua-driver status")})) {
      process.stdout.write("running\\n");
      return;
    }
    if (joined.includes("call health_report")) {
      process.stdout.write(JSON.stringify({ schema_version: "1", overall: "ok", checks: [] }));
      return;
    }
    if (joined.includes("call get_desktop_state")) {
      process.stdout.write("{}\\n");
      return;
    }
    if (joined.includes("base64 -w0")) {
      const preview = args.at(-1) === "/tmp/helmryth-preview.png";
      process.stdout.write(png(preview && state.corruptPreview));
      return;
    }
    if (joined.includes("tail -n 4")) return;
  }
  fail("unsupported fake runtime call: " + args.join(" "));
})().catch((error) => fail(error instanceof Error ? error.message : String(error)));
`;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "helmryth-http-local-workbench-"));
  dataDir = join(home, "profile");
  const binDir = join(home, "fake-bin");
  statePath = join(home, "runtime-state.json");
  callsPath = join(home, "runtime-calls.ndjson");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  writeState(cleanState());
  writeFileSync(callsPath, "", { mode: 0o600 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      fixture: { driver: "not-a-real-driver", displayName: "Deterministic fixture" },
    },
    localVm: { mode: "shared", maxInstances: 2 },
  }), { mode: 0o600 });

  const dockerPath = join(binDir, "docker");
  writeFileSync(dockerPath, fakeDockerSource(), { mode: 0o700 });
  chmodSync(dockerPath, 0o700);
  for (const runtime of ["podman", "container"]) {
    const runtimePath = join(binDir, runtime);
    writeFileSync(runtimePath, `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
    chmodSync(runtimePath, 0o700);
  }

  const port = await freePortBlock([0, 1], 31_000, 3_000);
  base = `http://127.0.0.1:${port}`;
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    HELMRYTH_DATA_DIR: dataDir,
    HELMRYTH_PORT: String(port),
    HELMRYTH_WEBHOOK_PORT: String(port + 1),
    HELMRYTH_EXTRA_PATH: binDir,
    HELMRYTH_FAKE_RUNTIME_STATE: statePath,
    HELMRYTH_FAKE_RUNTIME_CALLS: callsPath,
    HELMRYTH_COMMS_TOKEN: RESPONSE_SECRET_SENTINEL,
    VITEST: "1",
  };
  if (process.env.PATH) environment.PATH = process.env.PATH;
  if (process.env.SystemRoot) environment.SystemRoot = process.env.SystemRoot;

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      // The actual server is still loading.
    }
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    if (Date.now() > deadline) throw new Error(`server did not start: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const roster = rosterSchema.parse((await api("GET", "/api/bots")).body);
  starterBotId = roster.bots[0]?.id ?? "";
  expect(starterBotId).not.toBe("");
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe.sequential("Local and Isolated Workbench public HTTP contracts", () => {
  beforeEach(async () => {
    writeState(cleanState());
    writeFileSync(callsPath, "", { mode: 0o600 });
    const configured = await api("PATCH", "/api/config", {
      localVm: { mode: "shared", maxInstances: 2 },
    });
    expect(configured.status).toBe(200);
  });

  it("drives every shared lifecycle handler and preserves its response schema", async () => {
    const initial = await api("GET", "/api/local-computer");
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({
      runtime: "docker",
      daemonUp: true,
      image: false,
      container: "missing",
      ready: false,
      mode: "shared",
      max_instances: 2,
      target_key: "shared",
      viewer_port: 6080,
      idle_timeout_ms: expect.any(Number),
      commands: expect.any(Object),
    });

    const pulled = await api("POST", "/api/local-computer/pull", {});
    expect(pulled.status).toBe(200);
    expect(pulled.body).toMatchObject({ image: true, container: "missing", mode: "shared" });

    const created = await api("POST", "/api/local-computer/run", {});
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      runtime: "docker",
      container: "running",
      managed: true,
      network: "loopback",
      security: "hardened",
      persistence: "durable",
      desktopReady: true,
      ready: true,
      mode: "shared",
    });
    expect(created.body.viewer_url).toMatch(/^http:\/\/127\.0\.0\.1:6080\/vnc\.html#/);

    const cannotResume = await api("POST", "/api/local-computer/start", {});
    expect(cannotResume.status).toBe(409);
    expect(cannotResume.body.error).toMatch(/cannot safely resume/i);

    const screenshot = await api("POST", "/api/local-computer/screenshot");
    expect(screenshot.status).toBe(200);
    expect(screenshot.body.image).toMatch(/^data:image\/png;base64,/);

    const stopped = await api("POST", "/api/local-computer/stop", {});
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ container: "stopped", ready: false });
    expect((await api("POST", "/api/local-computer/stop", {})).status).toBe(409);

    const removed = await api("POST", "/api/local-computer/remove", {});
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ container: "missing", ready: false });
    const repeatedRemove = await api("POST", "/api/local-computer/remove", {});
    expect(repeatedRemove.status).toBe(200);
    expect(repeatedRemove.body.container).toBe("missing");

    for (const response of [initial, pulled, created, cannotResume, screenshot, stopped, removed, repeatedRemove]) {
      expectSanitized(response);
    }
  }, 20_000);

  it("requires JSON on lifecycle mutations and keeps unknown operators closed", async () => {
    for (const action of ["pull", "run", "start", "stop", "remove"]) {
      const wrongType = await fetch(`${base}/api/local-computer/${action}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      });
      expect(wrongType.status, action).toBe(415);
      expect(await wrongType.json()).toEqual({ error: "content-type must be application/json" });
    }
    for (const action of ["run", "stop", "remove"]) {
      const wrongType = await fetch(`${base}/api/bots/${starterBotId}/local-computer/${action}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      });
      expect(wrongType.status, `operator ${action}`).toBe(415);
      expect(await wrongType.json()).toEqual({ error: "content-type must be application/json" });
    }

    const unknown = "operator-that-does-not-exist";
    expect((await api("GET", `/api/bots/${unknown}/local-computer`)).status).toBe(404);
    for (const action of ["run", "stop", "remove"]) {
      const response = await api("POST", `/api/bots/${unknown}/local-computer/${action}`, {});
      expect(response.status, action).toBe(404);
      expect(response.body).toEqual({ error: "No such operator" });
      expectSanitized(response);
    }
    const screenshot = await api("POST", `/api/bots/${unknown}/local-computer/screenshot`);
    expect(screenshot.status).toBe(404);
    expect(screenshot.body).toEqual({ error: "No such operator" });

    // The base per-operator resource is deliberately read-only; lifecycle
    // mutation must name an explicit action.
    const baseMutation = await api("POST", `/api/bots/${starterBotId}/local-computer`, {});
    expect(baseMutation.status).toBe(404);
    expect(baseMutation.body.error).toContain(`POST /api/bots/${starterBotId}/local-computer`);
    expectSanitized(baseMutation);
  });

  it("fences overlapping creates and keeps remove idempotent", async () => {
    mutateState((state) => {
      state.image = true;
      state.delayRunMs = 350;
    });

    const first = api("POST", "/api/local-computer/run", {});
    await waitForCall('"run"');
    const duplicate = await api("POST", "/api/local-computer/run", {});
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toMatch(/setup action is still running/i);
    expect((await first).status).toBe(200);

    const afterCompletion = await api("POST", "/api/local-computer/run", {});
    expect(afterCompletion.status).toBe(409);
    expect(afterCompletion.body.error).toMatch(/already exists/i);
    expect((await api("POST", "/api/local-computer/remove", {})).status).toBe(200);
    expect((await api("POST", "/api/local-computer/remove", {})).status).toBe(200);
  }, 15_000);

  it("fails closed for unmanaged or unsafe desktops and rejects corrupt preview bytes", async () => {
    mutateState((state) => { state.image = true; });
    expect((await api("POST", "/api/local-computer/run", {})).status).toBe(200);

    mutateState((state) => {
      const shared = Object.values(state.containers)[0];
      if (!shared) throw new Error("fixture desktop was not created");
      shared.managed = false;
      shared.unsafeNetwork = true;
    });
    const unsafe = await api("GET", "/api/local-computer");
    expect(unsafe.status).toBe(200);
    expect(unsafe.body).toMatchObject({ managed: false, network: "unsafe", ready: false });
    expect(unsafe.body.problem).toMatch(/not created by Helmryth/i);
    const unsafeShot = await api("POST", "/api/local-computer/screenshot");
    expect(unsafeShot.status).toBe(409);
    expect(unsafeShot.body.error).toMatch(/not created by Helmryth/i);
    for (const action of ["run", "start", "stop", "remove"]) {
      const refused = await api("POST", `/api/local-computer/${action}`, {});
      expect(refused.status, action).toBe(409);
      expect(refused.body.error).toMatch(/not created by Helmryth/i);
      expectSanitized(refused);
    }
    expect(Object.keys(readState().containers)).toHaveLength(1);

    mutateState((state) => {
      const shared = Object.values(state.containers)[0];
      if (!shared) throw new Error("fixture desktop disappeared");
      shared.managed = true;
      shared.unsafeNetwork = false;
      state.corruptPreview = true;
    });
    const corrupt = await api("POST", "/api/local-computer/screenshot");
    expect(corrupt.status).toBe(502);
    expect(corrupt.body.error).toMatch(/incomplete screenshot/i);
    for (const response of [unsafe, unsafeShot, corrupt]) expectSanitized(response);
  }, 15_000);

  it("isolates per-operator lifecycle routes and rejects shared-mode ownership mistakes", async () => {
    mutateState((state) => { state.image = true; });

    const sharedBotStatus = await api("GET", `/api/bots/${starterBotId}/local-computer`);
    expect(sharedBotStatus.status).toBe(200);
    expect(sharedBotStatus.body).toMatchObject({ target_key: "shared", mode: "shared" });
    for (const action of ["run", "stop", "remove"]) {
      const response = await api("POST", `/api/bots/${starterBotId}/local-computer/${action}`, {});
      expect(response.status, action).toBe(409);
      expect(response.body.error).toMatch(/Shared mode manages this desktop/i);
    }

    const configured = await api("PATCH", "/api/config", {
      localVm: { mode: "per-bot", maxInstances: 2 },
    });
    expect(configured.status).toBe(200);
    expect(configured.body.localVm).toEqual({ mode: "per-bot", maxInstances: 2 });
    const sharedCreate = await api("POST", "/api/local-computer/run", {});
    expect(sharedCreate.status).toBe(409);
    expect(sharedCreate.body.error).toMatch(/Per-operator mode/i);

    const initial = await api("GET", `/api/bots/${starterBotId}/local-computer`);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ mode: "per-bot", container: "missing", target_key: expect.stringMatching(/^bot:/) });
    expect(initial.body.container_name).not.toBe("helmryth-computer");

    const created = await api("POST", `/api/bots/${starterBotId}/local-computer/run`, {});
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      mode: "per-bot",
      container: "running",
      ready: true,
      target_key: initial.body.target_key,
      container_name: initial.body.container_name,
    });
    expect(created.body.viewer_port).toBeGreaterThanOrEqual(49_152);
    expect(created.body.viewer_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/vnc\.html#/);

    const screenshot = await api("POST", `/api/bots/${starterBotId}/local-computer/screenshot`);
    expect(screenshot.status).toBe(200);
    expect(screenshot.body.image).toMatch(/^data:image\/png;base64,/);
    expect((await api("POST", `/api/bots/${starterBotId}/local-computer/stop`, {})).status).toBe(200);
    const removed = await api("POST", `/api/bots/${starterBotId}/local-computer/remove`, {});
    expect(removed.status).toBe(200);
    expect(removed.body.container).toBe("missing");

    for (const response of [sharedBotStatus, configured, sharedCreate, initial, created, screenshot, removed]) {
      expectSanitized(response);
    }
  }, 20_000);
});
