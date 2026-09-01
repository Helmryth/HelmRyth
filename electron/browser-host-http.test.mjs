import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { OPERATIONS, createBrowserHost } = require("./browser-host.cjs");

const TOKEN = "a".repeat(64);
const WRONG_TOKEN = "b".repeat(64);
const BOT_ID = "bot_A-17";
const MAX_BODY_BYTES = 64 * 1024;

const DISPATCH_CASES = [
  { operation: "state", body: { profile: "ignored" }, method: "state", args: [BOT_ID] },
  { operation: "navigate", body: { url: "https://example.test/catalog", profile: "work" }, method: "navigate", args: [BOT_ID, "https://example.test/catalog", "work"] },
  { operation: "back", body: { profile: "" }, method: "back", args: [BOT_ID, ""] },
  { operation: "forward", body: { profile: "guest" }, method: "forward", args: [BOT_ID, "guest"] },
  { operation: "snapshot", body: { profile: "work" }, method: "snapshot", args: [BOT_ID, "work"] },
  { operation: "click", body: { ref: "e4", button: "right", double: true, profile: "work" }, method: "click", args: [BOT_ID, "e4", { button: "right", clickCount: 2, profile: "work" }] },
  { operation: "hover", body: { ref: "e5", profile: "work" }, method: "hover", args: [BOT_ID, "e5", "work"] },
  { operation: "drag", body: { from: "e6", to: "e7", profile: "work" }, method: "drag", args: [BOT_ID, "e6", "e7", "work"] },
  { operation: "fill", body: { ref: "e8", text: "Helmryth", profile: "work" }, method: "fill", args: [BOT_ID, "e8", "Helmryth", "work"] },
  { operation: "type", body: { text: " moves", profile: "work" }, method: "type", args: [BOT_ID, " moves", "work"] },
  { operation: "press", body: { key: "Enter", profile: "work" }, method: "press", args: [BOT_ID, "Enter", "work"] },
  { operation: "scroll", body: { direction: "down", amount: 420, profile: "work" }, method: "scroll", args: [BOT_ID, "down", 420, "work"] },
  { operation: "select", body: { ref: "e9", values: ["one", "two"], profile: "work" }, method: "select", args: [BOT_ID, "e9", ["one", "two"], "work"] },
  { operation: "wait", body: { text: "Ready", url: "**/done", timeoutMs: 2_500, profile: "work" }, method: "waitFor", args: [BOT_ID, { text: "Ready", url: "**/done", timeoutMs: 2_500 }, "work"] },
  { operation: "read", body: { profile: "work" }, method: "read", args: [BOT_ID, "work"] },
  { operation: "screenshot", body: { profile: "work" }, method: "screenshot", args: [BOT_ID, "work"] },
];

function fakeSurface({ size = 3, behavior } = {}) {
  const calls = [];
  const surface = { size: () => size, calls };
  for (const method of new Set(DISPATCH_CASES.map((entry) => entry.method))) {
    surface[method] = async (...args) => {
      calls.push([method, ...args]);
      if (behavior) return behavior(method, args);
      return { ok: true, method };
    };
  }
  return surface;
}

async function request(baseUrl, path, {
  token = TOKEN,
  method = path === "/v1/health" ? "GET" : "POST",
  body = method === "POST" ? {} : undefined,
  rawBody,
  contentType = method === "POST" ? "application/json" : undefined,
} = {}) {
  const headers = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (contentType !== null && contentType !== undefined) headers["content-type"] = contentType;
  const init = { method, headers };
  const payload = rawBody === undefined ? (body === undefined ? undefined : JSON.stringify(body)) : rawBody;
  if (payload !== undefined) init.body = payload;
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
    raw: text,
  };
}

async function withHost(surfaceOrGetter, run) {
  const host = createBrowserHost({ manager: surfaceOrGetter, token: TOKEN });
  const baseUrl = await host.start();
  try {
    return await run({ host, baseUrl });
  } finally {
    await host.stop();
  }
}

describe("native browser-host HTTP boundary", () => {
  it("binds only to IPv4 loopback and owns a restartable, idempotent lifecycle", async () => {
    expect(() => createBrowserHost({ manager: null, token: TOKEN })).toThrow(/manager is required/i);
    for (const invalid of ["", "a".repeat(63), "A".repeat(64), "g".repeat(64)]) {
      expect(() => createBrowserHost({ manager: fakeSurface(), token: invalid })).toThrow(/64 hex/i);
    }

    let activeSurface = fakeSurface({ size: 4 });
    const host = createBrowserHost({ manager: () => activeSurface, token: TOKEN });
    expect(host.url).toBeNull();
    expect(() => host.descriptor()).toThrow(/not listening/i);

    const firstUrl = await host.start();
    expect(await host.start()).toBe(firstUrl);
    expect(new URL(firstUrl)).toMatchObject({ protocol: "http:", hostname: "127.0.0.1", pathname: "/" });
    expect(Number(new URL(firstUrl).port)).toBeGreaterThan(0);
    expect(host.descriptor()).toEqual({ version: 1, url: firstUrl, token: TOKEN, pid: process.pid });

    const healthy = await request(firstUrl, "/v1/health");
    expect(healthy.status).toBe(200);
    expect(healthy.body).toEqual({ ok: true, views: 4, window: true });
    expect(healthy.headers.get("content-type")).toBe("application/json");
    expect(Number(healthy.headers.get("content-length"))).toBe(Buffer.byteLength(healthy.raw));

    activeSurface = null;
    await expect(request(firstUrl, "/v1/health")).resolves.toMatchObject({ status: 200, body: { ok: true, views: 0, window: false } });
    await host.stop();
    expect(host.url).toBeNull();
    expect(() => host.descriptor()).toThrow(/not listening/i);
    await expect(fetch(`${firstUrl}/v1/health`)).rejects.toThrow();
    await expect(host.stop()).resolves.toBeUndefined();

    activeSurface = fakeSurface({ size: 1 });
    const restartedUrl = await host.start();
    expect(new URL(restartedUrl).hostname).toBe("127.0.0.1");
    await expect(request(restartedUrl, "/v1/health")).resolves.toMatchObject({ status: 200, body: { views: 1 } });
    await host.stop();
  });

  it("requires the exact per-boot bearer on health and every operation without reflecting credentials", async () => {
    const surface = fakeSurface();
    await withHost(surface, async ({ baseUrl }) => {
      const paths = ["/v1/health", ...DISPATCH_CASES.map(({ operation }) => `/v1/bots/${BOT_ID}/${operation}`)];
      for (const path of paths) {
        for (const token of [null, WRONG_TOKEN]) {
          const outcome = await request(baseUrl, path, { token });
          expect(outcome).toMatchObject({ status: 401, body: { error: "unauthorized" } });
          expect(outcome.raw).not.toContain(WRONG_TOKEN);
          expect(outcome.raw).not.toContain(TOKEN);
        }
      }
      expect(surface.calls).toEqual([]);
    });
  });

  it("enforces method-exact routes and JSON media types before dispatch", async () => {
    const surface = fakeSurface();
    await withHost(surface, async ({ baseUrl }) => {
      await expect(request(baseUrl, "/v1/health", { method: "POST" })).resolves.toMatchObject({ status: 404, body: { error: "not found" } });
      await expect(request(baseUrl, `/v1/bots/${BOT_ID}/unknown`)).resolves.toMatchObject({ status: 404, body: { error: "unknown browser operation" } });

      for (const { operation } of DISPATCH_CASES) {
        const path = `/v1/bots/${BOT_ID}/${operation}`;
        await expect(request(baseUrl, path, { method: "GET", body: undefined, contentType: null })).resolves.toMatchObject({ status: 404, body: { error: "not found" } });
        for (const contentType of [null, "text/plain", "application/x-www-form-urlencoded"]) {
          await expect(request(baseUrl, path, { rawBody: "{}", contentType })).resolves.toMatchObject({
            status: 415,
            body: { error: "content-type must be application/json" },
          });
        }
      }
      expect(surface.calls).toEqual([]);

      await expect(request(baseUrl, `/v1/bots/${BOT_ID}/state`, { contentType: "application/json; charset=utf-8" })).resolves.toMatchObject({ status: 200 });
      expect(surface.calls).toEqual([["state", BOT_ID]]);
    });
  });

  it("rejects invalid bot routes and malformed or non-object JSON without dispatch", async () => {
    const surface = fakeSurface();
    await withHost(surface, async ({ baseUrl }) => {
      for (const invalidPath of [
        "/v1/bots//state",
        "/v1/bots/bot.name/state",
        "/v1/bots/bot%20name/state",
        "/v1/bots/bot%2Fname/state",
        `/v1/bots/${"x".repeat(121)}/state`,
        "/v1/bots/bot/state/extra",
      ]) {
        await expect(request(baseUrl, invalidPath)).resolves.toMatchObject({ status: 404, body: { error: "not found" } });
      }

      await expect(request(baseUrl, `/v1/bots/${BOT_ID}/state`, { rawBody: "{" })).resolves.toMatchObject({ status: 400, body: { error: "invalid JSON body" } });
      for (const rawBody of ["null", "[]", '"text"', "42", "true"]) {
        await expect(request(baseUrl, `/v1/bots/${BOT_ID}/state`, { rawBody })).resolves.toMatchObject({
          status: 400,
          body: { error: "JSON body must be an object" },
        });
      }
      expect(surface.calls).toEqual([]);
    });
  });

  it("accepts the body-size boundary and rejects the next byte with a controlled response", async () => {
    const surface = fakeSurface();
    await withHost(surface, async ({ baseUrl }) => {
      const prefix = '{"padding":"';
      const suffix = '"}';
      const atLimit = `${prefix}${"x".repeat(MAX_BODY_BYTES - prefix.length - suffix.length)}${suffix}`;
      expect(Buffer.byteLength(atLimit)).toBe(MAX_BODY_BYTES);
      await expect(request(baseUrl, `/v1/bots/${BOT_ID}/state`, { rawBody: atLimit })).resolves.toMatchObject({ status: 200 });

      const tooLarge = `${prefix}${"x".repeat(MAX_BODY_BYTES + 1 - prefix.length - suffix.length)}${suffix}`;
      expect(Buffer.byteLength(tooLarge)).toBe(MAX_BODY_BYTES + 1);
      const outcome = await request(baseUrl, `/v1/bots/${BOT_ID}/state`, { rawBody: tooLarge });
      expect(outcome).toMatchObject({ status: 413, body: { error: "request body too large" } });
      expect(outcome.raw.length).toBeLessThan(128);
      expect(outcome.raw).not.toContain("padding");
      expect(surface.calls).toEqual([["state", BOT_ID]]);
    });
  });

  it("dispatches all 16 operation contracts exactly once with profile semantics intact", async () => {
    expect([...OPERATIONS]).toEqual(DISPATCH_CASES.map(({ operation }) => operation));
    const surface = fakeSurface();
    await withHost(surface, async ({ baseUrl }) => {
      for (const { operation, body, method } of DISPATCH_CASES) {
        const outcome = await request(baseUrl, `/v1/bots/${BOT_ID}/${operation}`, { body });
        expect(outcome).toMatchObject({ status: 200, body: { ok: true, method } });
      }
    });
    expect(surface.calls).toEqual(DISPATCH_CASES.map(({ method, args }) => [method, ...args]));
  });

  it("returns controlled closed-window and safe bounded operation errors", async () => {
    await withHost(() => null, async ({ baseUrl }) => {
      await expect(request(baseUrl, `/v1/bots/${BOT_ID}/state`)).resolves.toMatchObject({
        status: 503,
        body: { error: "the Helmryth window is closed — open it to use the browser" },
      });
    });

    const reflectedUrl = `https://private.example.test/work?access_token=${"z".repeat(48)}`;
    const bearer = `Bearer ${"q".repeat(40)}`;
    const longTail = "x".repeat(600);
    const surface = fakeSurface({
      behavior(method) {
        if (method === "navigate") throw new Error(`invalid navigation ${reflectedUrl} ${bearer} ${TOKEN} ${longTail}`);
        if (method === "read") throw new Error(`native failure at ${reflectedUrl} using ${TOKEN}`);
        if (method === "screenshot") return undefined;
        return { ok: true };
      },
    });
    await withHost(surface, async ({ baseUrl }) => {
      const correctable = await request(baseUrl, `/v1/bots/${BOT_ID}/navigate`, { body: { url: reflectedUrl } });
      expect(correctable.status).toBe(400);
      expect(correctable.body.error.length).toBeLessThanOrEqual(240);
      expect(correctable.body.error).toContain("invalid navigation");
      expect(correctable.raw).not.toContain(reflectedUrl);
      expect(correctable.raw).not.toContain(TOKEN);
      expect(correctable.raw).not.toContain("q".repeat(40));
      expect(correctable.raw).not.toContain("z".repeat(48));

      const internal = await request(baseUrl, `/v1/bots/${BOT_ID}/read`);
      expect(internal).toMatchObject({ status: 500, body: { error: "browser operation failed" } });
      expect(internal.raw).not.toContain("private.example.test");
      expect(internal.raw).not.toContain(TOKEN);

      await expect(request(baseUrl, `/v1/bots/${BOT_ID}/screenshot`)).resolves.toMatchObject({ status: 200, body: {} });
    });
  });
});
