import { describe, expect, it, vi } from "vitest";
import {
  ensureConduitCredentials,
  managedConduitAccess,
  managedConduitChildEnvironment,
  normalizeConduitUrl,
} from "./managed-composio.mjs";

const TOKEN = `hry_${"a".repeat(64)}`;

describe("Connected Apps conduit registration", () => {
  it("publishes only a complete conduit credential", () => {
    expect(managedConduitAccess("https://conduit.example/", { conduitToken: TOKEN })).toEqual({
      url: "https://conduit.example",
      token: TOKEN,
    });
    expect(managedConduitAccess("https://conduit.example", {})).toBeNull();
    expect(managedConduitAccess("", { conduitToken: TOKEN })).toBeNull();
    expect(managedConduitAccess("https://conduit.example", { conduitToken: "a".repeat(64) })).toBeNull();
  });

  it("accepts HTTPS and loopback development conduits but rejects insecure remote URLs", async () => {
    expect(normalizeConduitUrl("https://conduit.example/root/")).toBe(
      "https://conduit.example/root",
    );
    expect(normalizeConduitUrl("http://127.0.0.1:8787/")).toBe(
      "http://127.0.0.1:8787",
    );
    expect(normalizeConduitUrl("http://localhost:8787")).toBe(
      "http://localhost:8787",
    );
    expect(normalizeConduitUrl("http://[::1]:8787/")).toBe(
      "http://[::1]:8787",
    );
    expect(normalizeConduitUrl("http://conduit.example")).toBe("");
    expect(normalizeConduitUrl("https://user:secret@conduit.example")).toBe("");
    expect(normalizeConduitUrl("https://conduit.example?redirect=evil")).toBe("");

    const fetchImpl = vi.fn();
    const credentials = { conduitToken: TOKEN };
    await ensureConduitCredentials({
      conduitUrl: "http://conduit.example",
      credentials,
      fetchImpl,
      saveCredentials: vi.fn(),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(managedConduitAccess("http://conduit.example", credentials)).toBeNull();
    expect(
      managedConduitChildEnvironment("http://conduit.example", credentials, {
        PATH: "/usr/bin",
        HELMRYTH_CONDUIT_URL: "http://attacker.example",
        HELMRYTH_CONDUIT_TOKEN: "attacker-controlled",
      }),
    ).toEqual({ PATH: "/usr/bin" });
    expect(
      managedConduitChildEnvironment("http://[::1]:8787", credentials, { PATH: "/usr/bin" }),
    ).toEqual({
      PATH: "/usr/bin",
      HELMRYTH_CONDUIT_URL: "http://[::1]:8787",
      HELMRYTH_CONDUIT_TOKEN: TOKEN,
    });
  });

  it("enrolls a new Node through the exact Conduit contract and persists it", async () => {
    const credentials = {};
    const saveCredentials = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: TOKEN, nodeId: "11111111-1111-4111-8111-111111111111" }),
    }));

    await ensureConduitCredentials({
      conduitUrl: "https://conduit.example",
      credentials,
      fetchImpl,
      saveCredentials,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://conduit.example/v1/nodes",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
    expect(credentials).toEqual({
      conduitToken: TOKEN,
      conduitNodeId: "11111111-1111-4111-8111-111111111111",
    });
    expect(saveCredentials).toHaveBeenCalledWith(credentials);
  });

  it("settles a stalled optional registration without storing partial credentials", async () => {
    vi.useFakeTimers();
    try {
      const credentials = {};
      const saveCredentials = vi.fn(async () => {});
      const log = vi.fn();
      const fetchImpl = vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          }),
      );
      const operation = ensureConduitCredentials({
        conduitUrl: "https://conduit.example",
        credentials,
        fetchImpl,
        saveCredentials,
        log,
        registrationTimeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(25);
      await expect(operation).resolves.toBe(credentials);
      expect(credentials).toEqual({});
      expect(saveCredentials).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("enrollment failed"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks an existing Node through /v1/self and keeps it during a transient outage", async () => {
    const credentials = {
      conduitToken: TOKEN,
      conduitNodeId: "11111111-1111-4111-8111-111111111111",
    };
    const saveCredentials = vi.fn(async () => {});

    await ensureConduitCredentials({
      conduitUrl: "https://conduit.example",
      credentials,
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      }),
      saveCredentials,
    });

    expect(credentials).toEqual({
      conduitToken: TOKEN,
      conduitNodeId: "11111111-1111-4111-8111-111111111111",
    });
    expect(saveCredentials).not.toHaveBeenCalled();
  });

  it("migrates a valid legacy persisted identity from the /v1/self Node response", async () => {
    const credentials = {
      conduitToken: TOKEN,
      conduitInstallationId: "legacy-node-id",
    };
    const saveCredentials = vi.fn(async () => {});
    const fetchImpl = vi.fn(async (url) => {
      expect(url).toBe("https://conduit.example/v1/self");
      return {
        ok: true,
        status: 200,
        json: async () => ({ nodeId: "11111111-1111-4111-8111-111111111111" }),
      };
    });

    await ensureConduitCredentials({
      conduitUrl: "https://conduit.example",
      credentials,
      fetchImpl,
      saveCredentials,
    });

    expect(credentials).toEqual({
      conduitToken: TOKEN,
      conduitNodeId: "11111111-1111-4111-8111-111111111111",
    });
    expect(saveCredentials).toHaveBeenCalledWith(credentials);
  });
});
