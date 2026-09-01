// Main-server HTTP contract coverage for both Remote Workbench backends.
// Everything below is process-local: the Box provider, Docker-over-SSH, and
// native viewer tunnel are deterministic fakes, and no credential or network
// dependency can escape this test process.
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  CUA_DRIVER_VERSION,
  DRIVER_LABEL,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  MANAGED_LABEL,
} from "./container-computer.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import {
  VPS_CONTAINER_LABEL,
  VPS_IMAGE,
  VPS_MANAGED_LABEL,
  VPS_VIEWER_LABEL,
} from "./vps-computer.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const require = createRequire(import.meta.url);
// SAFETY: desktop-viewer.cjs is an owned CommonJS module whose exported
// contract is exercised by electron/desktop-viewer.node-test.mjs.
const { desktopViewerUrl } = require("../electron/desktop-viewer.cjs") as {
  desktopViewerUrl: (raw: string) => URL;
};
const posixOnly = describe.skipIf(process.platform === "win32");
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const CONTAINER_ID = "b".repeat(64);

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonBody = JsonValue;

async function unusedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  // SAFETY: an HTTP server explicitly listening on a TCP host returns
  // AddressInfo rather than a Unix-domain socket string.
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function fakeDockerSource(): string {
  return String.raw`#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } = require("node:fs");

const args = process.argv.slice(2);
const statePath = process.env.FAKE_VPS_STATE;
const logPath = process.env.FAKE_VPS_LOG;
const shotPath = process.env.FAKE_VPS_SHOT;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const save = () => writeFileSync(statePath, JSON.stringify(state));
const line = (...parts) => process.stdout.write(parts.join("") + "\n");
const fail = (message) => { process.stderr.write(message + "\n"); process.exitCode = 1; };
appendFileSync(logPath, JSON.stringify(args) + "\n");

async function main() {
  const command = args[2];
  if (command === "image") {
    return line(JSON.stringify([{ Id: process.env.FAKE_VPS_IMAGE_ID, Config: { Labels: {
      [process.env.FAKE_MANAGED_LABEL]: "1",
      [process.env.FAKE_DRIVER_LABEL]: process.env.FAKE_CUA_VERSION,
      [process.env.FAKE_BASE_IMAGE_LABEL]: process.env.FAKE_BASE_IMAGE_DIGEST,
      [process.env.FAKE_IMAGE_LAYER_LABEL]: process.env.FAKE_IMAGE_LAYER_VERSION,
    } } }]));
  }
  if (command === "inspect") {
    if (!state.container) return fail("Error: No such object: " + args[3]);
    const name = args[3];
    return line(JSON.stringify([{
      Id: process.env.FAKE_VPS_CONTAINER_ID,
      Image: process.env.FAKE_VPS_IMAGE_ID,
      Config: {
        Image: process.env.FAKE_VPS_IMAGE,
        Env: ["VNC_PW=fixture_viewer_password"],
        Labels: {
          [process.env.FAKE_VPS_MANAGED_LABEL]: "1",
          [process.env.FAKE_VPS_CONTAINER_LABEL]: name,
          [process.env.FAKE_VPS_VIEWER_LABEL]: "1",
          [process.env.FAKE_MANAGED_LABEL]: "1",
          [process.env.FAKE_DRIVER_LABEL]: process.env.FAKE_CUA_VERSION,
          [process.env.FAKE_BASE_IMAGE_LABEL]: process.env.FAKE_BASE_IMAGE_DIGEST,
          [process.env.FAKE_IMAGE_LAYER_LABEL]: process.env.FAKE_IMAGE_LAYER_VERSION,
        },
      },
      State: { Running: state.running },
      NetworkSettings: { Networks: { bridge: { IPAddress: state.privateIp } } },
      Mounts: [],
      HostConfig: {
        Binds: [], VolumesFrom: [], NetworkMode: "bridge", PortBindings: {}, PublishAllPorts: false,
        Memory: 4294967296, MemorySwap: 4294967296, NanoCpus: 2000000000, PidsLimit: 512,
        CapDrop: ["ALL"], CapAdd: ["CAP_SETUID", "CAP_SETGID"], Privileged: false,
        PidMode: "", IpcMode: "private", UTSMode: "", ShmSize: 536870912,
        Devices: [], DeviceRequests: [], SecurityOpt: [], UsernsMode: "", CgroupnsMode: "private",
        OomKillDisable: false, AutoRemove: false,
        RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      },
    }]));
  }
  if (command === "exec") {
    if (args.includes("base64")) return line(readFileSync(shotPath, "utf8").trim());
    if (args.at(-1) === "--version") return line("cua-driver " + process.env.FAKE_CUA_VERSION);
    if (args.includes("health_report")) return line('{"schema_version":"1","overall":"ok","checks":[]}');
    if (args.includes("get_desktop_state")) return line("{}");
    if (args.includes("status")) return line("running");
    return line("{}");
  }
  if (command === "stop") {
    if (existsSync(process.env.FAKE_VPS_SLOW_STOP)) {
      appendFileSync(logPath, "stop-enter\n");
      unlinkSync(process.env.FAKE_VPS_SLOW_STOP);
      await new Promise((resolve) => setTimeout(resolve, 6200));
    }
    state.running = false;
    save();
    return line(args.at(-1));
  }
  if (command === "start") {
    state.container = true;
    state.running = true;
    save();
    return line(args.at(-1));
  }
  if (command === "rm") {
    state.container = false;
    state.running = false;
    save();
    return line(args.at(-1));
  }
  return fail("unexpected fake Docker command: " + args.join(" "));
}

main().catch((error) => fail(error && error.message ? error.message : String(error)));
`;
}

function fakeSshSource(): string {
  return String.raw`#!/usr/bin/env node
const net = require("node:net");
const args = process.argv.slice(2);
const spec = args[args.indexOf("-L") + 1] || "";
const port = Number(spec.split(":")[1]);
if (!Number.isInteger(port)) process.exit(64);
const server = net.createServer((socket) => socket.destroy());
const close = () => server.close(() => process.exit(0));
process.on("SIGTERM", close);
process.on("SIGINT", close);
server.listen(port, "127.0.0.1");
`;
}

posixOnly.sequential("Remote Workbench main-server HTTP contracts", () => {
  let child: ChildProcess;
  let provider: Server;
  let home = "";
  let base = "";
  let stderr = "";
  let boxBotId = "";
  let cleanupBotId = "";
  let vpsBotId = "";
  let desktopMode: "safe" | "unsafe" | "none" = "safe";
  let artifactMode: "valid" | "corrupt" = "valid";
  let lastExecCommand = "";
  let createCount = 0;
  let deleteCount = 0;
  let vpsStatePath = "";
  let vpsLogPath = "";
  let vpsShotPath = "";
  let vpsSlowStopPath = "";
  const boxes = new Map<string, { id: string; name: string; state: string; desktopAvailable: boolean }>();

  const api = async (
    method: string,
    path: string,
    body?: JsonBody,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> => {
    const mutation = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
    const requestHeaders = { ...headers };
    if (mutation && requestHeaders["content-type"] === undefined) requestHeaders["content-type"] = "application/json";
    const response = await fetch(`${base}${path}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const rawPost = async (path: string, contentType?: string) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: contentType ? { "content-type": contentType } : undefined,
      body: "{}",
    });
    return { status: response.status, body: await response.json() };
  };

  const writeVpsState = (patch: Partial<{ container: boolean; running: boolean; privateIp: string }>) => {
    const current = JSON.parse(readFileSync(vpsStatePath, "utf8"));
    writeFileSync(vpsStatePath, JSON.stringify({ ...current, ...patch }));
  };

  const waitUntil = async (probe: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await probe())) {
      if (Date.now() > deadline) throw new Error(`${what} did not happen; server stderr: ${stderr.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "hry-http-remote-workbench-"));
    const helmrythHome = join(home, ".helmryth");
    const fakeBin = join(home, "fake-bin");
    mkdirSync(helmrythHome, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(helmrythHome, "config.json"), JSON.stringify({
      instances: { fixture: { driver: "not-a-real-driver", displayName: "Fixture" } },
    }));

    vpsStatePath = join(home, "vps-state.json");
    vpsLogPath = join(home, "vps.log");
    vpsShotPath = join(home, "vps-shot.b64");
    vpsSlowStopPath = join(home, "slow-stop");
    writeFileSync(vpsStatePath, JSON.stringify({ container: true, running: true, privateIp: "172.17.0.5" }));
    writeFileSync(vpsLogPath, "");
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(600),
      Buffer.from("IEND", "ascii"),
    ]);
    writeFileSync(vpsShotPath, png.toString("base64"));
    const fakeDocker = join(fakeBin, "docker");
    const fakeSsh = join(fakeBin, "ssh");
    writeFileSync(fakeDocker, fakeDockerSource());
    writeFileSync(fakeSsh, fakeSshSource());
    chmodSync(fakeDocker, 0o755);
    chmodSync(fakeSsh, 0o755);

    provider = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://box.fixture");
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const parsed = raw ? JSON.parse(raw) : {};
      const json = (status: number, value: JsonValue) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.method === "GET" && url.pathname === "/api/box/v1/boxes") {
        return json(200, { ok: true, boxes: [...boxes.values()] });
      }
      if (request.method === "POST" && url.pathname === "/api/box/v1/boxes") {
        const id = `box-fixture-${++createCount}`;
        const box = { id, name: "", state: "ready", desktopAvailable: true };
        boxes.set(id, box);
        return json(200, { ok: true, box });
      }
      const match = /^\/api\/box\/v1\/boxes\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (!match) return json(404, { ok: false, message: "fixture route not found" });
      const id = match[1]!;
      const suffix = match[2] ?? "";
      const box = boxes.get(id);
      if (!box) return json(404, { ok: false, message: "fixture box not found" });
      if (request.method === "GET" && !suffix) return json(200, { ok: true, box });
      if (request.method === "PATCH" && !suffix) {
        box.name = String(parsed.name ?? "");
        return json(200, { ok: true, box });
      }
      if (request.method === "DELETE" && !suffix) {
        deleteCount += 1;
        boxes.delete(id);
        return json(200, { ok: true });
      }
      if (request.method === "POST" && suffix === "/commands") {
        const command = String(parsed.command ?? "");
        if (/^x{4000}/.test(command)) lastExecCommand = command;
        const screenshot = command.includes("helmryth-panel.jpg");
        return json(200, {
          ok: true,
          exitCode: 0,
          stdout: screenshot ? "captured" : command.startsWith("x") ? `prefix-${"o".repeat(5000)}` : "",
          stderr: command.startsWith("x") ? `prefix-${"e".repeat(3000)}` : "",
        });
      }
      if (request.method === "POST" && suffix === "/desktop") {
        if (desktopMode === "safe") return json(200, { ok: true, desktopUrl: "https://desktop.example.test/vnc#session=fixture" });
        if (desktopMode === "unsafe") {
          return json(200, { ok: true, desktopUrl: "http://user:do-not-reflect@desktop.example.test/private?path=/tmp/private" });
        }
        return json(200, { ok: true });
      }
      if (request.method === "POST" && suffix === "/resume") {
        box.state = "ready";
        return json(200, { ok: true, box });
      }
      if (request.method === "POST" && suffix === "/stop") return json(200, { ok: true, box });
      if (request.method === "GET" && suffix === "/artifacts") {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        const bytes = artifactMode === "valid"
          ? Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(600), Buffer.from([0xff, 0xd9])])
          : Buffer.alloc(604, 0x41);
        return response.end(bytes);
      }
      return json(404, { ok: false, message: "fixture action not found" });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    // SAFETY: this fixture server is bound to an IPv4 TCP host above, so its
    // address is an AddressInfo object rather than a pipe name.
    const providerPort = (provider.address() as AddressInfo).port;
    const port = await unusedPort();
    const webhookPort = await unusedPort();
    base = `http://127.0.0.1:${port}`;

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      HELMRYTH_PORT: String(port),
      HELMRYTH_WEBHOOK_PORT: String(webhookPort),
      HELMRYTH_BOX_API: `http://127.0.0.1:${providerPort}/api/box/v1`,
      HELMRYTH_EXTRA_PATH: fakeBin,
      FAKE_VPS_STATE: vpsStatePath,
      FAKE_VPS_LOG: vpsLogPath,
      FAKE_VPS_SHOT: vpsShotPath,
      FAKE_VPS_SLOW_STOP: vpsSlowStopPath,
      FAKE_VPS_IMAGE: VPS_IMAGE,
      FAKE_VPS_IMAGE_ID: IMAGE_ID,
      FAKE_VPS_CONTAINER_ID: CONTAINER_ID,
      FAKE_CUA_VERSION: CUA_DRIVER_VERSION,
      FAKE_MANAGED_LABEL: MANAGED_LABEL,
      FAKE_DRIVER_LABEL: DRIVER_LABEL,
      FAKE_BASE_IMAGE_LABEL: BASE_IMAGE_LABEL,
      FAKE_BASE_IMAGE_DIGEST: BASE_IMAGE_DIGEST,
      FAKE_IMAGE_LAYER_LABEL: IMAGE_LAYER_LABEL,
      FAKE_IMAGE_LAYER_VERSION: IMAGE_LAYER_VERSION,
      FAKE_VPS_MANAGED_LABEL: VPS_MANAGED_LABEL,
      FAKE_VPS_CONTAINER_LABEL: VPS_CONTAINER_LABEL,
      FAKE_VPS_VIEWER_LABEL: VPS_VIEWER_LABEL,
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));

    await waitUntil(async () => {
      try {
        return (await fetch(`${base}/api/health`)).ok;
      } catch {
        return false;
      }
    }, "server startup", 20_000);

    boxBotId = (await api("POST", "/api/bots")).body.bot.id;
    cleanupBotId = (await api("POST", "/api/bots")).body.bot.id;
    vpsBotId = (await api("POST", "/api/bots")).body.bot.id;
    const patched = await api("PATCH", `/api/bots/${vpsBotId}`, {
      computer: "cloud",
      cloudBackend: "vps",
    });
    expect(patched.status).toBe(200);
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await removeTempDir(home);
  });

  it("rejects unknown operators, non-JSON mutations, and both unconfigured backends", async () => {
    const routes: Array<[string, string]> = [
      [vpsBotId, "viewer-close"],
      [vpsBotId, "provision"],
      [vpsBotId, "join"],
      [vpsBotId, "sleep"],
      [boxBotId, "exec"],
      [vpsBotId, "screenshot"],
      [vpsBotId, "remove"],
    ];
    for (const [botId, action] of routes) {
      const wrongType = await rawPost(`/api/bots/${botId}/computer/${action}`, "text/plain");
      expect(wrongType.status, action).toBe(415);
      expect(wrongType.body).toEqual({ error: "content-type must be application/json" });
      const unknown = await api("POST", `/api/bots/missing-operator/computer/${action}`, {});
      expect(unknown.status, action).toBe(404);
      expect(unknown.body).toEqual({ error: "No such operator" });
    }

    const unconfiguredBox = await api("POST", `/api/bots/${boxBotId}/computer/provision`, {});
    expect(unconfiguredBox.status).toBe(500);
    expect(unconfiguredBox.body.error).toMatch(/box provider not enabled/i);
    expect(JSON.stringify(unconfiguredBox.body)).not.toContain(home);

    const unconfiguredVps = await api("POST", `/api/bots/${vpsBotId}/computer/provision`, {});
    expect(unconfiguredVps.status).toBe(409);
    expect(unconfiguredVps.body.error).toMatch(/VPS is not configured/i);
    expect(JSON.stringify(unconfiguredVps.body)).not.toContain(home);

    const configured = await api("PUT", "/api/config", {
      box: { token: "box_fixture_token" },
      vps: { sshAlias: "fixture-vps" },
    });
    expect(configured.status).toBe(200);
    expect(configured.body.box).toEqual({ configured: true });
    expect(configured.body.vps).toEqual({ configured: true, sshAlias: "fixture-vps" });
    expect(JSON.stringify(configured.body)).not.toContain("box_fixture_token");
    expect(JSON.stringify(configured.body)).not.toContain(home);
  });

  it("drives every Box route, bounds the console, rejects unsafe viewers and corrupt frames, and cleans failed creates", async () => {
    const provision = await api("POST", `/api/bots/${boxBotId}/computer/provision`, {});
    expect(provision.status).toBe(200);
    expect(provision.body).toMatchObject({ boxId: "box-fixture-1", reused: false, state: "ready" });
    expect(desktopViewerUrl(provision.body.joinUrl).protocol).toBe("https:");

    const join = await api("POST", `/api/bots/${boxBotId}/computer/join`, {});
    expect(join.status).toBe(200);
    expect(desktopViewerUrl(join.body.joinUrl).hostname).toBe("desktop.example.test");

    const command = `${"x".repeat(5000)}do-not-forward`;
    const exec = await api("POST", `/api/bots/${boxBotId}/computer/exec`, { command });
    expect(exec.status).toBe(200);
    expect(lastExecCommand).toHaveLength(4000);
    expect(lastExecCommand).not.toContain("do-not-forward");
    expect(exec.body.stdout).toHaveLength(4000);
    expect(exec.body.stderr).toHaveLength(2000);
    expect(JSON.stringify(exec.body)).not.toContain(home);

    artifactMode = "valid";
    const screenshot = await api("POST", `/api/bots/${boxBotId}/computer/screenshot`, {});
    expect(screenshot.status).toBe(200);
    expect(screenshot.body.format).toBe("jpeg");
    expect(Buffer.from(screenshot.body.png, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    artifactMode = "corrupt";
    const corrupt = await api("POST", `/api/bots/${boxBotId}/computer/screenshot`, {});
    expect(corrupt.status).toBe(502);
    expect(corrupt.body.error).toMatch(/incomplete screenshot/i);
    expect(JSON.stringify(corrupt.body)).not.toContain(home);
    artifactMode = "valid";

    desktopMode = "unsafe";
    const unsafe = await api("POST", `/api/bots/${boxBotId}/computer/join`, {});
    expect(unsafe.status).toBe(500);
    expect(unsafe.body.error).toBe("box desktop link could not be created");
    expect(JSON.stringify(unsafe.body)).not.toMatch(/do-not-reflect|\/tmp\/private/);
    desktopMode = "safe";

    const sleep = await api("POST", `/api/bots/${boxBotId}/computer/sleep`, {});
    expect(sleep).toEqual({ status: 200, body: { ok: true } });
    const remove = await api("POST", `/api/bots/${boxBotId}/computer/remove`, {});
    expect(remove.status).toBe(409);
    expect(remove.body.error).toMatch(/has no container.*sleep instead/i);
    const close = await api("POST", `/api/bots/${boxBotId}/computer/viewer-close`, {});
    expect(close).toEqual({ status: 200, body: { closed: false } });

    const beforeCreates = createCount;
    const beforeDeletes = deleteCount;
    desktopMode = "none";
    const failedProvision = await api("POST", `/api/bots/${cleanupBotId}/computer/provision`, {});
    expect(failedProvision.status).toBe(500);
    expect(failedProvision.body.error).toBe("box desktop link could not be created");
    expect(createCount).toBe(beforeCreates + 1);
    expect(deleteCount).toBe(beforeDeletes + 1);
    expect([...boxes.values()].some((box) => box.name.includes(cleanupBotId.slice(0, 8)))).toBe(false);
    desktopMode = "safe";
  });

  it("drives the VPS lifecycle, native viewer cleanup, screenshot integrity, conflicts, and lock recovery", async () => {
    const provision = await api("POST", `/api/bots/${vpsBotId}/computer/provision`, {});
    expect(provision.status).toBe(200);
    expect(provision.body).toMatchObject({ configured: true, container: "running", ready: true });

    const exec = await api("POST", `/api/bots/${vpsBotId}/computer/exec`, { command: "id" });
    expect(exec.status).toBe(409);
    expect(exec.body.error).toMatch(/scoped Workbench tools/i);

    const screenshot = await api("POST", `/api/bots/${vpsBotId}/computer/screenshot`, {});
    expect(screenshot.status).toBe(200);
    expect(screenshot.body.format).toBe("png");
    expect(Buffer.from(screenshot.body.png, "base64").subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    writeFileSync(vpsShotPath, Buffer.alloc(604, 0x41).toString("base64"));
    const corrupt = await api("POST", `/api/bots/${vpsBotId}/computer/screenshot`, {});
    expect(corrupt.status).toBe(502);
    expect(corrupt.body.error).toMatch(/incomplete VPS screenshot/i);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(600),
      Buffer.from("IEND", "ascii"),
    ]);
    writeFileSync(vpsShotPath, png.toString("base64"));

    const firstJoin = await api("POST", `/api/bots/${vpsBotId}/computer/join`, {});
    expect(firstJoin.status).toBe(200);
    const viewer = desktopViewerUrl(firstJoin.body.joinUrl);
    expect(viewer.protocol).toBe("http:");
    expect(viewer.hostname).toBe("127.0.0.1");
    expect(viewer.hash).toContain("password=");
    const reusedJoin = await api("POST", `/api/bots/${vpsBotId}/computer/join`, {});
    expect(reusedJoin).toEqual(firstJoin);
    const firstClose = await api("POST", `/api/bots/${vpsBotId}/computer/viewer-close`, {});
    expect(firstClose).toEqual({ status: 200, body: { closed: true } });
    const idempotentClose = await api("POST", `/api/bots/${vpsBotId}/computer/viewer-close`, {});
    expect(idempotentClose).toEqual({ status: 200, body: { closed: false } });

    writeVpsState({ privateIp: "203.0.113.8" });
    const unsafeTunnel = await api("POST", `/api/bots/${vpsBotId}/computer/join`, {});
    expect(unsafeTunnel.status).toBe(409);
    expect(unsafeTunnel.body.error).toMatch(/predates secure live desktop access/i);
    expect(JSON.stringify(unsafeTunnel.body)).not.toContain("fixture_viewer_password");
    writeVpsState({ privateIp: "172.17.0.5" });

    const secondJoin = await api("POST", `/api/bots/${vpsBotId}/computer/join`, {});
    expect(secondJoin.status).toBe(200);
    expect(desktopViewerUrl(secondJoin.body.joinUrl).hostname).toBe("127.0.0.1");
    expect((await api("POST", `/api/bots/${vpsBotId}/computer/viewer-close`, {})).body.closed).toBe(true);

    writeFileSync(vpsSlowStopPath, "slow once");
    const firstSleep = api("POST", `/api/bots/${vpsBotId}/computer/sleep`, {});
    await waitUntil(() => existsSync(vpsLogPath) && readFileSync(vpsLogPath, "utf8").includes("stop-enter"), "slow stop entry");
    const conflictingSleep = await api("POST", `/api/bots/${vpsBotId}/computer/sleep`, {});
    expect(conflictingSleep.status).toBe(409);
    expect(conflictingSleep.body.error).toMatch(/being prepared/i);
    expect((await firstSleep).status).toBe(200);

    // The timed-out waiter must release its queued lock when the holder ends.
    const restart = await api("POST", `/api/bots/${vpsBotId}/computer/provision`, {});
    expect(restart.status).toBe(200);
    expect(restart.body).toMatchObject({ container: "running", ready: true });

    const remove = await api("POST", `/api/bots/${vpsBotId}/computer/remove`, {});
    expect(remove.status).toBe(200);
    expect(remove.body).toMatchObject({ container: "missing", ready: false });
    const afterRemove = await api("POST", `/api/bots/${vpsBotId}/computer/screenshot`, {});
    expect(afterRemove.status).toBe(409);
    expect(afterRemove.body.error).toMatch(/No Helmryth container exists/i);
    expect(JSON.stringify(afterRemove.body)).not.toMatch(/fixture_viewer_password|ssh:\/\/|hry-http-remote-workbench/);
  }, 30_000);
});
