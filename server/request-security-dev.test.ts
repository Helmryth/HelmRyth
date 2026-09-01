import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const PORT = 28_800 + Math.floor(Math.random() * 5_000);
const WEBHOOK_PORT = 38_800 + Math.floor(Math.random() * 5_000);
const UI_PORT = 48_800 + Math.floor(Math.random() * 5_000);
const BASE = `http://127.0.0.1:${PORT}`;
const UI_ORIGIN = `http://127.0.0.1:${UI_PORT}`;
const healthSchema = z.object({ static: z.boolean() });
const botsSchema = z.object({ bots: z.array(z.object({ id: z.string() })) });
const groupSchema = z.object({ group: z.object({ id: z.string() }) });

let child: ChildProcess;
let home: string;
let stderr = "";

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "hry-origin-dev-"));
  mkdirSync(join(home, ".helmryth"), { recursive: true });
  writeFileSync(join(home, ".helmryth", "config.json"), JSON.stringify({
    instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } },
  }));
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: process.env.PATH,
      HELMRYTH_PORT: String(PORT),
      HELMRYTH_WEBHOOK_PORT: String(WEBHOOK_PORT),
      HELMRYTH_UI_ORIGIN: UI_ORIGIN,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`development server exited ${child.exitCode}: ${stderr}`);
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      // wait for the real server boundary
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`development server did not start: ${stderr}`);
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("development renderer smoke", () => {
  it("accepts only the configured Vite origin through the exact core Host", async () => {
    const allowed = await fetch(`${BASE}/api/health`, { headers: { origin: UI_ORIGIN } });
    expect(allowed.status).toBe(200);
    expect(healthSchema.parse(await allowed.json()).static).toBe(false);

    expect((await fetch(`${BASE}/api/health`, { headers: { origin: BASE } })).status).toBe(403);
    expect((await fetch(`${BASE}/api/health`, { headers: { origin: `http://localhost:${UI_PORT}` } })).status).toBe(403);
  });

  it("passes a Vite-shaped JSON mutation and denies its simple-request form", async () => {
    const bot = botsSchema.parse(
      await (await fetch(`${BASE}/api/bots`, { headers: { origin: UI_ORIGIN } })).json(),
    ).bots[0]!;
    const denied = await fetch(`${BASE}/api/groups`, {
      method: "POST",
      headers: { origin: UI_ORIGIN, "content-type": "text/plain" },
      body: JSON.stringify({ name: "Simple request must not land", memberIds: [bot.id] }),
    });
    expect(denied.status).toBe(415);

    const created = await fetch(`${BASE}/api/groups`, {
      method: "POST",
      headers: { origin: UI_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "Vite renderer smoke", memberIds: [bot.id] }),
    });
    expect(created.status).toBe(201);
    const group = groupSchema.parse(await created.json()).group;

    const removed = await fetch(`${BASE}/api/groups/${group.id}`, {
      method: "DELETE",
      headers: { origin: UI_ORIGIN, "content-type": "application/json" },
    });
    expect(removed.status).toBe(200);
  });
});
