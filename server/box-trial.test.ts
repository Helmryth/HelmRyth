import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.ts";

describe("Box trial provisioning", () => {
  let api: Server;
  let provisionBox: typeof import("./box.ts").provisionBox;
  const createBodies: Array<{ ttlSeconds: number; noEnv: boolean }> = [];

  beforeAll(async () => {
    api = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://box.test");
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (url.pathname === "/api/box/v1/boxes" && req.method === "GET") {
          return res.end(JSON.stringify({ ok: true, boxes: [] }));
        }
        if (url.pathname === "/api/box/v1/boxes" && req.method === "POST") {
          const body = JSON.parse(raw);
          createBodies.push(body);
          if (createBodies.length === 1) {
            res.writeHead(400);
            return res.end(JSON.stringify({
              ok: false,
              error: { code: "trial_auto_stop_required", details: { maxTtlSeconds: 7200 } },
            }));
          }
          res.writeHead(201);
          return res.end(JSON.stringify({ ok: true, box: { id: "trial-box", state: "ready" } }));
        }
        if (url.pathname === "/api/box/v1/boxes/trial-box" && req.method === "PATCH") {
          return res.end(JSON.stringify({ ok: true }));
        }
        if (url.pathname === "/api/box/v1/boxes/trial-box" && req.method === "GET") {
          return res.end(JSON.stringify({ ok: true, box: { id: "trial-box", state: "ready" } }));
        }
        if (url.pathname.endsWith("/commands")) {
          return res.end(JSON.stringify({ ok: true, exitCode: 0, stdout: "", stderr: "" }));
        }
        if (url.pathname.endsWith("/desktop")) {
          return res.end(JSON.stringify({ ok: true, desktopUrl: "https://desktop.example/vnc" }));
        }
        res.writeHead(404).end(JSON.stringify({ ok: false, message: "unexpected request" }));
      });
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const address = api.address();
    if (!address) throw new Error("box stub did not bind a TCP port");
    // SAFETY: this server was explicitly bound to an IPv4 address above.
    const port = (address as AddressInfo).port;
    vi.stubEnv("HELMRYTH_BOX_API", `http://127.0.0.1:${port}/api/box/v1`);
    vi.resetModules();
    ({ provisionBox } = await import("./box.ts"));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  it("retries the structured trial TTL refusal exactly once at the allowed ceiling", async () => {
    const config: AppConfig = { box: { token: "box_trial" } };
    const result = await provisionBox(config, "trial-bot", "Trial Bot");
    expect(result.boxId).toBe("trial-box");
    expect(createBodies).toEqual([
      { ttlSeconds: 8 * 60 * 60, noEnv: true },
      { ttlSeconds: 2 * 60 * 60, noEnv: true },
    ]);
  });
});
