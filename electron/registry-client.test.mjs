import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  RegistryError,
  createRegistryClient,
  normalizeAccountEmail,
  normalizeRegistryOrigin,
} from "./registry-client.mjs";

const ACCOUNT = `signed.${"a".repeat(40)}`;
const NODE_CREDENTIAL = `hry_node_${"a".repeat(22)}.${"b".repeat(43)}`;
const NODE_ID = "11111111-1111-4111-8111-111111111111";
const jsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });

describe("registry desktop client", () => {
  it("accepts exact HTTPS and loopback development origins only", () => {
    expect(normalizeRegistryOrigin("https://accounts.example.com/")).toBe(
      "https://accounts.example.com",
    );
    expect(normalizeRegistryOrigin("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(normalizeRegistryOrigin("http://accounts.example.com")).toBe("");
    expect(normalizeRegistryOrigin("https://accounts.example.com/api")).toBe("");
    expect(normalizeRegistryOrigin("https://user:secret@accounts.example.com")).toBe("");
  });

  it("normalizes an email without accepting malformed input", () => {
    expect(normalizeAccountEmail(" Ada@Example.COM ")).toBe("ada@example.com");
    expect(normalizeAccountEmail("not-an-email")).toBe("");
    expect(normalizeAccountEmail(new String("ada@example.com"))).toBe("");
    expect(normalizeRegistryOrigin({ toString: () => "https://accounts.example.com" })).toBe("");
  });

  it("accepts plain cross-realm response records", async () => {
    const payload = runInNewContext(
      "({ user: { id: 'user-1', email: 'ada@example.com' } })",
    );
    const client = createRegistryClient({
      registryOrigin: "https://accounts.example.com",
      fetchImpl: vi.fn(async () => ({
        status: 200,
        ok: true,
        headers: new Headers({ "set-auth-token": ACCOUNT }),
        json: async () => payload,
      })),
    });

    await expect(client.verifyOTP("ada@example.com", "12345678")).resolves.toEqual({
      accountToken: ACCOUNT,
      user: { id: "user-1", email: "ada@example.com" },
    });
  });

  it("rejects non-plain response records instead of coercing them", async () => {
    class Payload {
      constructor() {
        this.account = { id: "user-1", email: "ada@example.com" };
      }
    }
    const client = createRegistryClient({
      registryOrigin: "https://accounts.example.com",
      fetchImpl: vi.fn(async () => ({
        status: 200,
        ok: true,
        headers: new Headers(),
        json: async () => new Payload(),
      })),
    });

    await expect(client.me(ACCOUNT)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("loads the signed-in account from the Registry account route", async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(url).toBe("https://accounts.example.com/v1/account");
      return jsonResponse({ account: { id: "user-1", email: "ada@example.com" } });
    });
    const client = createRegistryClient({ registryOrigin: "https://accounts.example.com", fetchImpl });

    await expect(client.me(ACCOUNT)).resolves.toEqual({ id: "user-1", email: "ada@example.com" });
  });

  it("requires the exact healthy registry identity before onboarding", async () => {
    const timeoutSignal = vi.fn(() => new AbortController().signal);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, service: "helmryth-registry" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, service: "some-other-service" }));
    const client = createRegistryClient({
      registryOrigin: "https://accounts.example.com",
      fetchImpl,
      timeoutSignal,
    });

    await expect(client.health()).resolves.toBe(true);
    await expect(client.health()).rejects.toMatchObject({
      code: "registry_unavailable",
    });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://accounts.example.com/healthz");
    expect(fetchImpl.mock.calls[0][1].redirect).toBe("error");
    expect(fetchImpl.mock.calls[0][1].headers.get("origin")).toBeNull();
    expect(timeoutSignal).toHaveBeenNthCalledWith(1, 3_000);
  });

  it("uses the signed Better Auth bearer header, never its raw JSON token", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(JSON.parse(init.body)).toEqual({
        email: "ada@example.com",
        otp: "12345678",
        name: "ada",
      });
      return jsonResponse(
        { token: "raw-database-token-must-not-be-used", user: { id: "user-1", email: "ada@example.com" } },
        { headers: { "set-auth-token": ACCOUNT } },
      );
    });
    const client = createRegistryClient({
      registryOrigin: "https://accounts.example.com",
      fetchImpl,
    });

    await expect(client.verifyOTP("Ada@Example.com", "1234-5678")).resolves.toEqual({
      accountToken: ACCOUNT,
      user: { id: "user-1", email: "ada@example.com" },
    });
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain("raw-database-token-must-not-be-used");
  });

  it("identifies native Better Auth mutations with the trusted registry origin", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      // Undici adds Fetch Metadata after our request wrapper hands off the
      // init object. Model Better Auth 1.7's form-CSRF decision here: a
      // browser-shaped request without a trusted Origin is forbidden.
      const wireHeaders = new Headers(init.headers);
      wireHeaders.set("sec-fetch-mode", "cors");
      if (wireHeaders.has("sec-fetch-mode") && wireHeaders.get("origin") !== "https://accounts.example.com") {
        return jsonResponse({ error: "forbidden" }, { status: 403 });
      }
      return jsonResponse({ success: true });
    });
    const client = createRegistryClient({
      registryOrigin: "https://accounts.example.com",
      fetchImpl,
    });

    await expect(client.requestOTP("ada@example.com")).resolves.toEqual({
      email: "ada@example.com",
    });
    expect(fetchImpl.mock.calls[0][1].headers.get("origin")).toBe(
      "https://accounts.example.com",
    );
  });

  it("keeps a valid Node credential without rotating it", async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(url).toBe("https://accounts.example.com/v1/nodes/self");
      return jsonResponse({
        node: {
          id: NODE_ID,
          clientInstanceId: "client-1",
          name: "Mac",
          platform: "darwin",
          appVersion: "1.0.0",
        },
        credentialExpiresAt: Date.now() + 10_000,
      });
    });
    const client = createRegistryClient({ registryOrigin: "https://accounts.example.com", fetchImpl });
    const result = await client.ensureInstallation({
      accountToken: ACCOUNT,
      currentCredential: NODE_CREDENTIAL,
      clientInstanceId: "client-1",
      name: "Mac",
      platform: "darwin",
      appVersion: "1.0.0",
    });
    expect(result.credential).toBe(NODE_CREDENTIAL);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("recovers a lost Node credential by rotating the matching identity", async () => {
    const rotated = `hry_node_${"c".repeat(22)}.${"d".repeat(43)}`;
    const fetchImpl = vi.fn(async (url, init) => {
      if (url.endsWith("/v1/nodes")) {
        return jsonResponse({
          nodes: [{ id: NODE_ID, clientInstanceId: "client-1", name: "Mac", platform: "darwin" }],
        });
      }
      expect(url).toContain(`/v1/nodes/${NODE_ID}/credentials/rotate`);
      expect(init.method).toBe("POST");
      return jsonResponse({ credential: rotated, credentialExpiresAt: Date.now() + 10_000 }, { status: 201 });
    });
    const client = createRegistryClient({ registryOrigin: "https://accounts.example.com", fetchImpl });
    await expect(client.ensureInstallation({
      accountToken: ACCOUNT,
      clientInstanceId: "client-1",
      name: "Mac",
      platform: "darwin",
      appVersion: "1.0.0",
    })).resolves.toMatchObject({ credential: rotated, installation: { id: NODE_ID } });
  });

  it("lists validated active Nodes for response-loss cleanup", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe("https://accounts.example.com/v1/nodes");
      expect(init.headers.get("authorization")).toBe(`Bearer ${ACCOUNT}`);
      return jsonResponse({
        nodes: [{
          id: NODE_ID,
          clientInstanceId: "client-1",
          name: "Mac",
          platform: "darwin",
          appVersion: "1.0.0",
        }],
      });
    });
    const client = createRegistryClient({
      registryOrigin: "https://accounts.example.com",
      fetchImpl,
    });

    await expect(client.listInstallations(ACCOUNT)).resolves.toEqual([{
      id: NODE_ID,
      clientInstanceId: "client-1",
      name: "Mac",
      platform: "darwin",
      appVersion: "1.0.0",
    }]);
  });

  it("rejects malformed Node lists instead of skipping cleanup targets", async () => {
    const client = createRegistryClient({
      registryOrigin: "https://accounts.example.com",
      fetchImpl: vi.fn(async () => jsonResponse({
        nodes: [{ id: "not-a-node", clientInstanceId: "client-1" }],
      })),
    });

    await expect(client.listInstallations(ACCOUNT)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("creates a Node through the exact Registry route and translates its wire payload", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe("https://accounts.example.com/v1/nodes");
      if (init.method === "GET") return jsonResponse({ nodes: [] });
      expect(init.method).toBe("POST");
      return jsonResponse({
        node: { id: NODE_ID, clientInstanceId: "client-2", name: "Desk", platform: "linux" },
        credential: NODE_CREDENTIAL,
        credentialExpiresAt: Date.now() + 10_000,
      }, { status: 201 });
    });
    const client = createRegistryClient({ registryOrigin: "https://accounts.example.com", fetchImpl });

    await expect(client.ensureInstallation({
      accountToken: ACCOUNT,
      clientInstanceId: "client-2",
      name: "Desk",
      platform: "linux",
      appVersion: "1.0.0",
    })).resolves.toMatchObject({
      installation: { id: NODE_ID, clientInstanceId: "client-2" },
      credential: NODE_CREDENTIAL,
    });
  });

  it("validates Reach material without leaking the connector token into the URL", async () => {
    const connectorToken = `eyJ${"x".repeat(80)}`;
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe("https://accounts.example.com/v1/nodes/self/reach");
      expect(init.headers.get("authorization")).toBe(`Bearer ${NODE_CREDENTIAL}`);
      expect(url).not.toContain(connectorToken);
      return jsonResponse({ reach: { url: "https://r-opaque.example.com" }, connectorToken });
    });
    const client = createRegistryClient({ registryOrigin: "https://accounts.example.com", fetchImpl });
    await expect(client.ensureEndpoint(NODE_CREDENTIAL)).resolves.toEqual({
      endpoint: { url: "https://r-opaque.example.com" },
      connectorToken,
    });
  });

  it("deletes Reach and revokes Node through their exact Registry routes", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push([url, init.method, init.headers.get("authorization")]);
      return new Response(null, { status: 204 });
    });
    const client = createRegistryClient({ registryOrigin: "https://accounts.example.com", fetchImpl });

    await client.deleteEndpoint(NODE_CREDENTIAL);
    await client.revokeInstallation(ACCOUNT, NODE_ID);

    expect(calls).toEqual([
      ["https://accounts.example.com/v1/nodes/self/reach", "DELETE", `Bearer ${NODE_CREDENTIAL}`],
      [`https://accounts.example.com/v1/nodes/${NODE_ID}`, "DELETE", `Bearer ${ACCOUNT}`],
    ]);
  });

  it("maps bounded server error codes and hides arbitrary response text", async () => {
    const client = createRegistryClient({
      registryOrigin: "https://accounts.example.com",
      fetchImpl: vi.fn(async () => jsonResponse({ error: "rate_limited", detail: "secret detail" }, { status: 429 })),
    });
    await expect(client.requestOTP("ada@example.com")).rejects.toMatchObject({
      name: "RegistryError",
      code: "rate_limited",
      status: 429,
    });
  });

  it("falls back from Better Auth's message-only 429 without exposing its prose", async () => {
    const requestId = "44444444-4444-4444-8444-444444444444";
    const client = createRegistryClient({
      registryOrigin: "https://accounts.example.com",
      fetchImpl: vi.fn(async () => jsonResponse(
        { message: "Too many requests. Please try again later." },
        { status: 429, headers: { "x-request-id": requestId } },
      )),
    });

    await expect(client.requestOTP("ada@example.com")).rejects.toMatchObject({
      name: "RegistryError",
      code: "rate_limited",
      status: 429,
      requestId,
    });
  });

  it("uses stable status errors when a response has no public error contract", async () => {
    const client = createRegistryClient({
      registryOrigin: "https://accounts.example.com",
      fetchImpl: vi.fn(async () => jsonResponse(
        { code: "INTERNAL_DEPENDENCY_DETAIL", message: "do not expose this" },
        { status: 400, headers: { "x-request-id": "not-a-safe-request-id" } },
      )),
    });

    await expect(client.requestOTP("ada@example.com")).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
      requestId: "",
    });
  });

  it("fails closed on redirects and network errors", async () => {
    const client = createRegistryClient({
      registryOrigin: "https://accounts.example.com",
      fetchImpl: vi.fn(async () => {
        throw new TypeError("redirect blocked");
      }),
    });
    await expect(client.requestOTP("ada@example.com")).rejects.toEqual(
      expect.objectContaining({ code: "network_unavailable" }),
    );
    expect(() => createRegistryClient({ registryOrigin: "http://remote.example" })).toThrow(
      RegistryError,
    );
  });
});
