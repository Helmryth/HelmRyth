import { afterEach, describe, expect, it, vi } from "vitest";

import type { InstanceInfo } from "@/state/store";

import {
  createInstancesLoader,
  loadValidatedInstances,
  resetSharedInstancesLoaderForTests,
} from "./instances-loader";

const sampleInstances = [
  {
    instanceId: "openai-compatible",
    driverKind: "openaiCompatible",
    displayName: "OpenAI-compatible",
    snapshot: { state: "available", authenticated: true, version: "1.0.0" },
    models: { default: "gpt-4.1-mini", options: [{ id: "gpt-4.1-mini", label: "GPT-4.1 mini" }] },
    capabilities: { composioMcp: true, browserMcp: true, computerMcp: true, images: true },
    access: "custom",
    install: { docsUrl: "https://example.test/openai" },
  },
  {
    instanceId: "codex",
    driverKind: "codex",
    displayName: "Codex",
    snapshot: { state: "unavailable", authenticated: false, reason: "Sign in required" },
    models: { default: "codex-mini", options: [{ id: "codex-mini", label: "Codex mini" }] },
    capabilities: { browserMcp: true },
    access: "subscription",
    install: { signInCommand: "codex login" },
  },
] satisfies InstanceInfo[];

afterEach(() => {
  resetSharedInstancesLoaderForTests();
});

describe("loadValidatedInstances", () => {
  it("returns the validated engine inventory from /api/instances", async () => {
    const fetchInstances = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ instances: sampleInstances }),
    });

    await expect(loadValidatedInstances(fetchInstances)).resolves.toStrictEqual(sampleInstances);
    expect(fetchInstances).toHaveBeenCalledOnce();
    expect(fetchInstances).toHaveBeenCalledWith("/api/instances");
  });

  it.each([
    ["HTTP failure", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "offline" }) })],
    ["network failure", vi.fn().mockRejectedValue(new Error("offline"))],
    ["malformed JSON", vi.fn().mockResolvedValue({ ok: true, json: async () => Promise.reject(new Error("bad json")) })],
    ["invalid shape", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ instances: null }) })],
    ["missing instances", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })],
  ])("falls back to [] after %s", async (_label, fetchInstances) => {
    await expect(loadValidatedInstances(fetchInstances)).resolves.toStrictEqual([]);
  });
});

describe("createInstancesLoader", () => {
  it("coalesces concurrent requests and reuses a fresh cached result", async () => {
    let resolveResponse!: (value: { ok: true; json: () => Promise<{ instances: InstanceInfo[] }> }) => void;
    const fetchInstances = vi.fn(
      () =>
        new Promise<{ ok: true; json: () => Promise<{ instances: InstanceInfo[] }> }>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    let now = 1_000;
    const loader = createInstancesLoader(fetchInstances, { now: () => now, cacheMs: 3_000 });

    const initial = loader.load();
    const concurrent = loader.load();

    expect(concurrent).toBe(initial);
    expect(fetchInstances).toHaveBeenCalledOnce();

    resolveResponse({ ok: true, json: async () => ({ instances: sampleInstances }) });
    await expect(initial).resolves.toStrictEqual(sampleInstances);

    now += 1_000;
    await expect(loader.load()).resolves.toStrictEqual(sampleInstances);
    expect(fetchInstances).toHaveBeenCalledOnce();
  });

  it("refreshes after the cache window expires", async () => {
    const fetchInstances = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ instances: sampleInstances }),
    });
    let now = 1_000;
    const loader = createInstancesLoader(fetchInstances, { now: () => now, cacheMs: 3_000 });

    await loader.load();
    now += 3_001;
    await loader.load();

    expect(fetchInstances).toHaveBeenCalledTimes(2);
  });

  it("forces a fresh request after invalidation even when a cached result exists", async () => {
    const fetchInstances = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ instances: sampleInstances }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ instances: [] }),
      });
    const loader = createInstancesLoader(fetchInstances, { cacheMs: 60_000 });

    await expect(loader.load()).resolves.toStrictEqual(sampleInstances);
    loader.invalidate();
    await expect(loader.load({ force: true })).resolves.toStrictEqual([]);

    expect(fetchInstances).toHaveBeenCalledTimes(2);
  });
});
