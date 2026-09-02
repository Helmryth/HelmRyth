/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, typescript/no-this-alias -- This provider-contract test intentionally models malformed external payloads and receiver binding with wider values than production schemas accept. */
import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { CloudflareAPI, CloudflareAPIError, type CloudflareFetch } from "../src/cloudflare-api";
import { createAuth } from "../src/auth";
import { readConfig } from "../src/config";
import { createRegistry } from "../src/index";

const BASE_URL = "https://registry.helmryth.test";
const CONNECTOR_TOKEN = "eyJhbGciOiJIUzI1NiJ9.test-only-connector-token.signature";

interface CallOptions {
  body?: unknown;
  method?: string;
  rawBody?: string;
  token?: string;
}

type TestWorker = ReturnType<typeof createRegistry>;

async function call(worker: TestWorker, path: string, options: CallOptions = {}) {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body !== undefined) headers.set("content-type", "application/json");
  const request = new Request(`${BASE_URL}${path}`, {
    body,
    headers,
    method: options.method ?? "GET",
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function runScheduledCleanup(worker: TestWorker): Promise<void> {
  const controller = createScheduledController({
    cron: "*/5 * * * *",
    scheduledTime: Date.now(),
  });
  const ctx = createExecutionContext();
  await worker.scheduled(controller, env, ctx);
  await waitOnExecutionContext(ctx);
}

async function signIn(worker: TestWorker, email: string) {
  const ctx = createExecutionContext();
  const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
  const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
  await waitOnExecutionContext(ctx);
  const response = await call(worker, "/api/auth/sign-in/email-otp", {
    body: { email, name: "Reach owner", otp },
    method: "POST",
  });
  expect(response.status).toBe(200);
  const token = response.headers.get("set-auth-token");
  if (!token) throw new Error("missing account bearer");
  const body = await response.json<{ user: { id: string } }>();
  return { token, userId: body.user.id };
}

async function createNode(worker: TestWorker, accountToken: string, clientInstanceId: string) {
  const response = await call(worker, "/v1/nodes", {
    body: { clientInstanceId, name: "Managed Mac", platform: "darwin" },
    method: "POST",
    token: accountToken,
  });
  expect(response.status).toBe(201);
  return response.json<{
    credential: string;
    node: { id: string };
  }>();
}

interface FakeTunnel {
  id: string;
  name: string;
}

interface FakeDNSRecord {
  content: string;
  id: string;
  name: string;
  proxied: boolean;
  type: string;
}

interface Gate {
  entered: Promise<void>;
  operation: string;
  release: () => void;
  wait: Promise<void>;
}

function jsonResult(result: unknown, status = 200): Response {
  return Response.json({ errors: [], messages: [], result, success: true }, { status });
}

function jsonNotFound(): Response {
  return Response.json({
    errors: [{ code: 1_003, message: "not found" }],
    messages: [],
    result: null,
    success: false,
  }, { status: 404 });
}

class FakeCloudflare {
  readonly calls: Array<{ authorization: string | null; body: unknown; method: string; url: string }> = [];
  readonly configurations = new Map<string, unknown>();
  readonly dns = new Map<string, FakeDNSRecord>();
  readonly failures = new Set<string>();
  readonly failuresAfterApply = new Set<string>();
  readonly tunnels = new Map<string, FakeTunnel>();
  private counter = 1;
  private gate: Gate | null = null;

  pauseNext(operation: string): { entered: Promise<void>; release: () => void } {
    let markEntered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.gate = { entered, operation, release, wait };
    this.markGateEntered = markEntered;
    return { entered, release };
  }

  private markGateEntered: () => void = () => undefined;

  private async before(operation: string): Promise<Response | null> {
    if (this.gate?.operation === operation) {
      const gate = this.gate;
      this.gate = null;
      this.markGateEntered();
      await gate.wait;
    }
    if (this.failures.has(operation)) {
      return Response.json({
        errors: [{ code: 10_000, message: `${CONNECTOR_TOKEN} must stay redacted` }],
        messages: [],
        result: null,
        success: false,
      }, { status: 500 });
    }
    return null;
  }

  private nextTunnelId(): string {
    const tail = this.counter.toString(16).padStart(12, "0");
    this.counter += 1;
    return `10000000-0000-4000-8000-${tail}`;
  }

  private after(operation: string): void {
    if (this.failuresAfterApply.has(operation)) {
      throw new Error(`simulated ambiguous ${operation} result`);
    }
  }

  readonly fetch: CloudflareFetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    let body: unknown = null;
    if (typeof init.body === "string") body = JSON.parse(init.body) as unknown;
    this.calls.push({
      authorization: headers.get("authorization"),
      body,
      method,
      url: url.toString(),
    });

    if (method === "GET" && url.pathname.endsWith("/cfd_tunnel")) {
      const failed = await this.before("list_tunnels");
      if (failed) return failed;
      const tunnel = this.tunnels.get(url.searchParams.get("name") ?? "");
      return jsonResult(tunnel
        ? [{ ...tunnel, config_src: "cloudflare", deleted_at: null }]
        : []);
    }
    if (method === "GET" && /\/cfd_tunnel\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/").at(-1);
      const tunnel = [...this.tunnels.values()].find((candidate) => candidate.id === id);
      return tunnel
        ? jsonResult({ ...tunnel, config_src: "cloudflare", deleted_at: null })
        : jsonNotFound();
    }
    if (method === "POST" && url.pathname.endsWith("/cfd_tunnel")) {
      const failed = await this.before("create_tunnel");
      if (failed) return failed;
      if (!body || typeof body !== "object" || !("name" in body) || typeof body.name !== "string") {
        throw new Error("unexpected tunnel body");
      }
      const tunnel = { id: this.nextTunnelId(), name: body.name };
      this.tunnels.set(tunnel.name, tunnel);
      this.after("create_tunnel");
      return jsonResult({ ...tunnel, config_src: "cloudflare", deleted_at: null });
    }
    if (method === "PUT" && url.pathname.endsWith("/configurations")) {
      const failed = await this.before("configure_tunnel");
      if (failed) return failed;
      const tunnelId = url.pathname.split("/").at(-2) ?? "";
      this.configurations.set(tunnelId, body);
      if (!body || typeof body !== "object" || !("config" in body)) throw new Error("unexpected config body");
      return jsonResult({ config: body.config });
    }
    if (method === "GET" && url.pathname.endsWith("/dns_records")) {
      const failed = await this.before("list_dns");
      if (failed) return failed;
      const record = this.dns.get(url.searchParams.get("name.exact") ?? "");
      return jsonResult(record ? [record] : []);
    }
    if (method === "GET" && url.pathname.includes("/dns_records/")) {
      const id = url.pathname.split("/").at(-1);
      const record = [...this.dns.values()].find((candidate) => candidate.id === id);
      return record ? jsonResult(record) : jsonNotFound();
    }
    if (method === "POST" && url.pathname.endsWith("/dns_records")) {
      const failed = await this.before("create_dns");
      if (failed) return failed;
      if (
        !body
        || typeof body !== "object"
        || !("name" in body)
        || !("content" in body)
        || typeof body.name !== "string"
        || typeof body.content !== "string"
      ) throw new Error("unexpected DNS body");
      const record: FakeDNSRecord = {
        content: body.content,
        id: `dns-${this.counter++}`,
        name: body.name,
        proxied: true,
        type: "CNAME",
      };
      this.dns.set(record.name, record);
      this.after("create_dns");
      return jsonResult(record);
    }
    if (method === "PATCH" && url.pathname.includes("/dns_records/")) {
      const failed = await this.before("update_dns");
      if (failed) return failed;
      if (
        !body
        || typeof body !== "object"
        || !("name" in body)
        || !("content" in body)
        || typeof body.name !== "string"
        || typeof body.content !== "string"
      ) throw new Error("unexpected DNS update body");
      const record: FakeDNSRecord = {
        content: body.content,
        id: url.pathname.split("/").at(-1) ?? "dns-missing",
        name: body.name,
        proxied: true,
        type: "CNAME",
      };
      this.dns.set(record.name, record);
      this.after("update_dns");
      return jsonResult(record);
    }
    if (method === "GET" && url.pathname.endsWith("/token")) {
      const failed = await this.before("get_token");
      if (failed) return failed;
      return jsonResult(CONNECTOR_TOKEN);
    }
    if (method === "DELETE" && url.pathname.includes("/dns_records/")) {
      const failed = await this.before("delete_dns");
      if (failed) return failed;
      const id = url.pathname.split("/").at(-1);
      for (const [name, record] of this.dns) {
        if (record.id === id) this.dns.delete(name);
      }
      return Response.json({ result: { id } });
    }
    if (method === "DELETE" && url.pathname.includes("/cfd_tunnel/")) {
      const failed = await this.before("delete_tunnel");
      if (failed) return failed;
      const id = url.pathname.split("/").at(-1);
      for (const [name, tunnel] of this.tunnels) {
        if (tunnel.id === id) this.tunnels.delete(name);
      }
      return jsonResult({ id });
    }
    throw new Error(`unexpected Cloudflare request: ${method} ${url.pathname}`);
  };
}

describe("Cloudflare API response contracts", () => {
  it("does not rebind the Worker fetch receiver", async () => {
    let receiver: unknown = "not-called";
    const fetcher: CloudflareFetch = function (this: unknown) {
      receiver = this;
      return Promise.resolve(jsonResult([]));
    };
    const api = new CloudflareAPI(readConfig(env).cloudflare, fetcher);

    await expect(api.listTunnels("receiver-probe")).resolves.toEqual([]);
    expect(receiver).toBeUndefined();
  });

  it("keeps redirects manual and rejects them without forwarding credentials", async () => {
    const fetcher = vi.fn<CloudflareFetch>(async (_input, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        headers: { location: "https://redirect.invalid/capture-token" },
        status: 302,
      });
    });
    const api = new CloudflareAPI(readConfig(env).cloudflare, fetcher);

    await expect(api.listTunnels("redirect-probe")).rejects.toMatchObject({
      code: "cf_http_302",
      status: 302,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("preserves the network error contract for genuine fetch rejection", async () => {
    const api = new CloudflareAPI(readConfig(env).cloudflare, async () => {
      throw new TypeError("simulated connection failure");
    });

    await expect(api.listTunnels("network-probe")).rejects.toMatchObject({
      code: "cf_network",
      status: null,
    });
  });

  it("accepts the documented result-only DNS delete response and validates its ID", async () => {
    const api = new CloudflareAPI(readConfig(env).cloudflare, async () => (
      Response.json({ result: { id: "dns-record-1" } })
    ));
    await expect(api.deleteDNSRecord("dns-record-1")).resolves.toBeUndefined();

    const mismatched = new CloudflareAPI(readConfig(env).cloudflare, async () => (
      Response.json({ result: { id: "other-record" } })
    ));
    const mismatchError = await mismatched.deleteDNSRecord("dns-record-1")
      .then(() => null, (error: unknown) => error);
    expect(mismatchError).toBeInstanceOf(CloudflareAPIError);
    expect(mismatchError).toMatchObject({
      code: "cf_invalid_response",
    });
  });

  it("keeps result-only success narrow and preserves provider error parsing", async () => {
    const resultOnly = new CloudflareAPI(readConfig(env).cloudflare, async () => (
      Response.json({ result: { id: "10000000-0000-4000-8000-000000000001" } })
    ));
    await expect(resultOnly.deleteTunnel("10000000-0000-4000-8000-000000000001"))
      .rejects.toMatchObject({ code: "cf_http_200" });

    const failed = new CloudflareAPI(readConfig(env).cloudflare, async () => Response.json({
      errors: [{ code: 10_000 }],
      result: null,
    }, { status: 500 }));
    await expect(failed.deleteDNSRecord("dns-record-1")).rejects.toMatchObject({
      code: "cf_api_10000",
      status: 500,
    });
  });
});

describe("managed Reaches", () => {
  it("allocates an opaque one-label reach, returns a raw connector token, and reconciles idempotently", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createRegistry(cloudflare.fetch);
    const owner = await signIn(worker, "managed-success@example.com");
    const node = await createNode(worker, owner.token, "managed-success");

    const first = await call(worker, "/v1/nodes/self/reach", {
      method: "POST",
      token: node.credential,
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("access-control-allow-origin")).toBeNull();
    const firstPayload = await first.json<{
      connectorToken: string;
      reach: { generation: number; hostname: string; status: string; url: string };
    }>();
    expect(firstPayload.connectorToken).toBe(CONNECTOR_TOKEN);
    expect(firstPayload.reach).toMatchObject({ status: "ready" });
    const [opaqueLabel, ...suffixLabels] = firstPayload.reach.hostname.split(".");
    expect(opaqueLabel).toMatch(/^r-[0-9a-f]{32}$/);
    expect(suffixLabels.join(".")).toBe(readConfig(env).cloudflare.reachHostSuffix);
    expect(firstPayload.reach.url).toBe(`https://${firstPayload.reach.hostname}`);

    const tunnel = [...cloudflare.tunnels.values()][0];
    if (!tunnel) throw new Error("fake tunnel missing");
    expect(cloudflare.configurations.get(tunnel.id)).toEqual({
      config: {
        ingress: [
          { hostname: firstPayload.reach.hostname, service: "http://127.0.0.1:8812" },
          { service: "http_status:404" },
        ],
      },
    });
    expect(cloudflare.dns.get(firstPayload.reach.hostname)).toMatchObject({
      content: `${tunnel.id}.cfargotunnel.com`,
      proxied: true,
      type: "CNAME",
    });

    const stored = await env.REGISTRY_DB.prepare(
      "SELECT * FROM node_reaches WHERE node_id = ?",
    ).bind(node.node.id).first<Record<string, unknown>>();
    expect(stored).toMatchObject({
      status: "ready",
      tunnel_id: tunnel.id,
      last_error_code: null,
    });
    expect(JSON.stringify(stored)).not.toContain(CONNECTOR_TOKEN);
    expect(JSON.stringify(stored)).not.toContain("managed-success@example.com");

    const createCallsBefore = cloudflare.calls.filter((entry) => entry.method === "POST").length;
    const second = await call(worker, "/v1/nodes/self/reach", {
      method: "POST",
      token: node.credential,
    });
    expect(second.status).toBe(200);
    const secondPayload = await second.json<{
      connectorToken: string;
      reach: { generation: number; url: string };
    }>();
    expect(secondPayload.reach.url).toBe(firstPayload.reach.url);
    expect(secondPayload.reach.generation).toBe(firstPayload.reach.generation + 1);
    expect(secondPayload.connectorToken).toBe(CONNECTOR_TOKEN);
    expect(cloudflare.calls.filter((entry) => entry.method === "POST").length).toBe(createCallsBefore);

    const get = await call(worker, "/v1/nodes/self/reach", {
      token: node.credential,
    });
    const getText = await get.text();
    expect(get.status).toBe(200);
    expect(getText).toContain(firstPayload.reach.url);
    expect(getText).not.toContain(CONNECTOR_TOKEN);
  });

  it("keeps account and node bearer boundaries separate and isolates nodes", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createRegistry(cloudflare.fetch);
    const firstOwner = await signIn(worker, "managed-first@example.com");
    const secondOwner = await signIn(worker, "managed-second@example.com");
    const first = await createNode(worker, firstOwner.token, "managed-boundary-first");
    const second = await createNode(worker, secondOwner.token, "managed-boundary-second");

    expect((await call(worker, "/v1/nodes/self/reach", {
      method: "POST",
      token: firstOwner.token,
    })).status).toBe(401);
    expect((await call(worker, "/v1/nodes/self/reach", { token: "invalid" })).status).toBe(401);

    const firstResponse = await call(worker, "/v1/nodes/self/reach", {
      method: "POST",
      token: first.credential,
    });
    const secondResponse = await call(worker, "/v1/nodes/self/reach", {
      method: "POST",
      token: second.credential,
    });
    const firstURL = (await firstResponse.json<{ reach: { url: string } }>()).reach.url;
    const secondURL = (await secondResponse.json<{ reach: { url: string } }>()).reach.url;
    expect(firstURL).not.toBe(secondURL);
  });

  it("adopts matching resources after an interrupted allocation without creating duplicates", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createRegistry(cloudflare.fetch);
    const owner = await signIn(worker, "managed-adopt@example.com");
    const node = await createNode(worker, owner.token, "managed-adopt");
    const tunnelName = "hry-r-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const hostname = "r-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.reach.helmryth.test";
    const tunnel: FakeTunnel = {
      id: "20000000-0000-4000-8000-000000000001",
      name: tunnelName,
    };
    cloudflare.tunnels.set(tunnelName, tunnel);
    cloudflare.dns.set(hostname, {
      content: `${tunnel.id}.cfargotunnel.com`,
      id: "dns-adopted",
      name: hostname,
      proxied: true,
      type: "CNAME",
    });
    const now = Date.now();
    await env.REGISTRY_DB.prepare(
      `INSERT INTO node_reaches
        (node_id, hostname, tunnel_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    ).bind(node.node.id, hostname, tunnelName, now, now).run();

    const response = await call(worker, "/v1/nodes/self/reach", {
      method: "POST",
      token: node.credential,
    });
    expect(response.status).toBe(200);
    expect(cloudflare.calls.some((entry) => entry.method === "POST")).toBe(false);
    const row = await env.REGISTRY_DB.prepare(
      "SELECT tunnel_id, dns_record_id, status FROM node_reaches WHERE node_id = ?",
    ).bind(node.node.id).first<{
      dns_record_id: string | null;
      status: string;
      tunnel_id: string | null;
    }>();
    expect(row).toEqual({ dns_record_id: "dns-adopted", status: "ready", tunnel_id: tunnel.id });
  });

  it("serializes concurrent provisioning with a D1 lease", async () => {
    const cloudflare = new FakeCloudflare();
    const gate = cloudflare.pauseNext("list_tunnels");
    const worker = createRegistry(cloudflare.fetch);
    const owner = await signIn(worker, "managed-concurrency@example.com");
    const node = await createNode(worker, owner.token, "managed-concurrency");

    const firstPromise = call(worker, "/v1/nodes/self/reach", {
      method: "POST",
      token: node.credential,
    });
    await gate.entered;
    const second = await call(worker, "/v1/nodes/self/reach", {
      method: "POST",
      token: node.credential,
    });
    expect(second.status).toBe(409);
    expect(second.headers.get("retry-after")).toBe("2");
    await expect(second.json()).resolves.toEqual({ error: "reach_busy" });
    gate.release();
    const first = await firstPromise;
    expect(first.status).toBe(200);
    expect(cloudflare.tunnels.size).toBe(1);
    expect(cloudflare.dns.size).toBe(1);
  });

  it("never rolls back resources after an expired lease is taken over", async () => {
    const cloudflare = new FakeCloudflare();
    const gate = cloudflare.pauseNext("get_token");
    const worker = createRegistry(cloudflare.fetch);
    const owner = await signIn(worker, "managed-takeover@example.com");
    const node = await createNode(worker, owner.token, "managed-takeover");

    const staleRequest = call(worker, "/v1/nodes/self/reach", {
      method: "POST",
      token: node.credential,
    });
    await gate.entered;
    await env.REGISTRY_DB.prepare(
      `UPDATE node_reaches
          SET lease_expires_at = ?
        WHERE node_id = ?`,
    ).bind(Date.now() - 1, node.node.id).run();

    const successor = await call(worker, "/v1/nodes/self/reach", {
      method: "POST",
      token: node.credential,
    });
    expect(successor.status).toBe(200);
    gate.release();
    expect((await staleRequest).status).toBe(502);

    const row = await env.REGISTRY_DB.prepare(
      `SELECT generation, lease_owner, status, tunnel_id, dns_record_id
         FROM node_reaches WHERE node_id = ?`,
    ).bind(node.node.id).first<{
      dns_record_id: string | null;
      generation: number;
      lease_owner: string | null;
      status: string;
      tunnel_id: string | null;
    }>();
    expect(row).toMatchObject({
      dns_record_id: expect.any(String),
      generation: 2,
      lease_owner: null,
      status: "ready",
      tunnel_id: expect.any(String),
    });
    expect(cloudflare.tunnels.size).toBe(1);
    expect(cloudflare.dns.size).toBe(1);
    expect(cloudflare.calls.some((entry) => entry.method === "DELETE")).toBe(false);
  });

  it("retains and adopts a DNS create that committed before its response failed", async () => {
    const cloudflare = new FakeCloudflare();
    cloudflare.failuresAfterApply.add("create_dns");
    cloudflare.failures.add("get_token");
    const worker = createRegistry(cloudflare.fetch);
    const owner = await signIn(worker, "managed-ambiguous-create@example.com");
    const node = await createNode(worker, owner.token, "managed-ambiguous-create");

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await call(worker, "/v1/nodes/self/reach", {
      method: "POST",
      token: node.credential,
    });
    expect(response.status).toBe(502);
    expect(cloudflare.tunnels.size).toBe(1);
    expect(cloudflare.dns.size).toBe(1);
    expect(cloudflare.calls.filter((entry) => (
      entry.method === "POST" && new URL(entry.url).pathname.endsWith("/dns_records")
    ))).toHaveLength(1);
    const row = await env.REGISTRY_DB.prepare(
      "SELECT dns_record_id, tunnel_id, status FROM node_reaches WHERE node_id = ?",
    ).bind(node.node.id).first<{
      dns_record_id: string | null;
      status: string;
      tunnel_id: string | null;
    }>();
    expect(row).toMatchObject({
      dns_record_id: expect.any(String),
      status: "error",
      tunnel_id: expect.any(String),
    });

    cloudflare.failures.clear();
    cloudflare.failuresAfterApply.clear();
    const retried = await call(worker, "/v1/nodes/self/reach", {
      method: "POST",
      token: node.credential,
    });
    expect(retried.status).toBe(200);
    expect(cloudflare.tunnels.size).toBe(1);
    expect(cloudflare.dns.size).toBe(1);
    expect(cloudflare.calls.filter((entry) => (
      entry.method === "POST" && new URL(entry.url).pathname.endsWith("/dns_records")
    ))).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("adopts a DNS update that committed before its response failed", async () => {
    const cloudflare = new FakeCloudflare();
    cloudflare.failuresAfterApply.add("update_dns");
    const worker = createRegistry(cloudflare.fetch);
    const owner = await signIn(worker, "managed-ambiguous-update@example.com");
    const node = await createNode(worker, owner.token, "managed-ambiguous-update");
    const hostname = "r-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.reach.helmryth.test";
    const tunnel: FakeTunnel = {
      id: "30000000-0000-4000-8000-000000000001",
      name: "hry-r-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };
    cloudflare.tunnels.set(tunnel.name, tunnel);
    cloudflare.dns.set(hostname, {
      content: "old-target.example.test",
      id: "dns-ambiguous-update",
      name: hostname,
      proxied: false,
      type: "CNAME",
    });
    const now = Date.now();
    await env.REGISTRY_DB.prepare(
      `INSERT INTO node_reaches
        (node_id, hostname, tunnel_name, tunnel_id, dns_record_id,
         status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(
      node.node.id,
      hostname,
      tunnel.name,
      tunnel.id,
      "dns-ambiguous-update",
      now,
      now,
    ).run();

    const response = await call(worker, "/v1/nodes/self/reach", {
      method: "POST",
      token: node.credential,
    });
    expect(response.status).toBe(200);
    expect(cloudflare.dns.get(hostname)).toMatchObject({
      content: `${tunnel.id}.cfargotunnel.com`,
      id: "dns-ambiguous-update",
      proxied: true,
    });
  });

  it("rolls back resources created by a failed attempt and redacts provider details", async () => {
    const cloudflare = new FakeCloudflare();
    cloudflare.failures.add("get_token");
    const worker = createRegistry(cloudflare.fetch);
    const owner = await signIn(worker, "managed-rollback@example.com");
    const node = await createNode(worker, owner.token, "managed-rollback");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const failed = await call(worker, "/v1/nodes/self/reach", {
      method: "POST",
      token: node.credential,
    });
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toEqual({ error: "reach_unavailable" });
    expect(cloudflare.tunnels.size).toBe(0);
    expect(cloudflare.dns.size).toBe(0);
    const failedRow = await env.REGISTRY_DB.prepare(
      `SELECT tunnel_id, dns_record_id, status, last_error_code
         FROM node_reaches WHERE node_id = ?`,
    ).bind(node.node.id).first<{
      dns_record_id: string | null;
      last_error_code: string | null;
      status: string;
      tunnel_id: string | null;
    }>();
    expect(failedRow).toEqual({
      dns_record_id: null,
      last_error_code: "cf_api_10000",
      status: "error",
      tunnel_id: null,
    });
    const logText = logged.mock.calls.flat().join(" ");
    expect(logText).toContain("cf_api_10000");
    expect(logText).not.toContain(CONNECTOR_TOKEN);
    expect(logText).not.toContain(env.CLOUDFLARE_API_TOKEN);
    expect(logText).not.toContain("managed-rollback@example.com");
    logged.mockRestore();

    cloudflare.failures.clear();
    const retried = await call(worker, "/v1/nodes/self/reach", {
      method: "POST",
      token: node.credential,
    });
    expect(retried.status).toBe(200);
  });

  it("preserves partial cleanup state for an idempotent DELETE retry", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createRegistry(cloudflare.fetch);
    const owner = await signIn(worker, "managed-delete@example.com");
    const node = await createNode(worker, owner.token, "managed-delete");
    expect((await call(worker, "/v1/nodes/self/reach", {
      method: "POST",
      token: node.credential,
    })).status).toBe(200);

    cloudflare.failures.add("delete_tunnel");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = await call(worker, "/v1/nodes/self/reach", {
      method: "DELETE",
      token: node.credential,
    });
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toEqual({ error: "reach_cleanup_pending" });
    const partial = await env.REGISTRY_DB.prepare(
      `SELECT dns_record_id, tunnel_id, status, last_error_code
         FROM node_reaches WHERE node_id = ?`,
    ).bind(node.node.id).first<{
      dns_record_id: string | null;
      last_error_code: string | null;
      status: string;
      tunnel_id: string | null;
    }>();
    expect(partial).toMatchObject({
      dns_record_id: null,
      last_error_code: "cf_api_10000",
      status: "deleting",
      tunnel_id: expect.any(String),
    });

    cloudflare.failures.clear();
    expect((await call(worker, "/v1/nodes/self/reach", {
      method: "DELETE",
      token: node.credential,
    })).status).toBe(204);
    const callsBeforeIdempotentDelete = cloudflare.calls.length;
    expect((await call(worker, "/v1/nodes/self/reach", {
      method: "DELETE",
      token: node.credential,
    })).status).toBe(204);
    expect(cloudflare.calls.length).toBe(callsBeforeIdempotentDelete);
    await expect((await call(worker, "/v1/nodes/self/reach", {
      token: node.credential,
    })).json()).resolves.toEqual({ reach: null });
    vi.restoreAllMocks();
  });

  it("retains metadata and refuses to delete a repurposed DNS record", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createRegistry(cloudflare.fetch);
    const owner = await signIn(worker, "managed-repurposed-dns@example.com");
    const node = await createNode(worker, owner.token, "managed-repurposed-dns");
    expect((await call(worker, "/v1/nodes/self/reach", {
      method: "POST",
      token: node.credential,
    })).status).toBe(200);

    const [hostname, record] = [...cloudflare.dns.entries()][0] ?? [];
    if (!hostname || !record) throw new Error("fake DNS record missing");
    cloudflare.dns.set(hostname, {
      ...record,
      content: "203.0.113.50",
      name: "repurposed.helmryth.test",
      proxied: false,
      type: "A",
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await call(worker, "/v1/nodes/self/reach", {
      method: "DELETE",
      token: node.credential,
    });
    expect(response.status).toBe(503);
    expect(cloudflare.calls.some((entry) => entry.method === "DELETE")).toBe(false);
    expect(cloudflare.dns.get(hostname)).toMatchObject({
      content: "203.0.113.50",
      name: "repurposed.helmryth.test",
      type: "A",
    });
    const retained = await env.REGISTRY_DB.prepare(
      `SELECT dns_record_id, tunnel_id, status, last_error_code
         FROM node_reaches WHERE node_id = ?`,
    ).bind(node.node.id).first<{
      dns_record_id: string | null;
      last_error_code: string | null;
      status: string;
      tunnel_id: string | null;
    }>();
    expect(retained).toMatchObject({
      dns_record_id: record.id,
      last_error_code: "dns_record_identity_conflict",
      status: "deleting",
      tunnel_id: expect.any(String),
    });
    vi.restoreAllMocks();
  });

  it("retains metadata and refuses to delete a repurposed tunnel", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createRegistry(cloudflare.fetch);
    const owner = await signIn(worker, "managed-repurposed-tunnel@example.com");
    const node = await createNode(worker, owner.token, "managed-repurposed-tunnel");
    expect((await call(worker, "/v1/nodes/self/reach", {
      method: "POST",
      token: node.credential,
    })).status).toBe(200);

    const [stableName, tunnel] = [...cloudflare.tunnels.entries()][0] ?? [];
    if (!stableName || !tunnel) throw new Error("fake tunnel missing");
    tunnel.name = "repurposed-tunnel";
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await call(worker, "/v1/nodes/self/reach", {
      method: "DELETE",
      token: node.credential,
    });
    expect(response.status).toBe(503);
    expect(cloudflare.calls.some((entry) => entry.method === "DELETE")).toBe(false);
    expect(cloudflare.tunnels.get(stableName)).toEqual({
      id: tunnel.id,
      name: "repurposed-tunnel",
    });
    expect(cloudflare.dns.size).toBe(1);
    const retained = await env.REGISTRY_DB.prepare(
      `SELECT dns_record_id, tunnel_id, status, last_error_code
         FROM node_reaches WHERE node_id = ?`,
    ).bind(node.node.id).first<{
      dns_record_id: string | null;
      last_error_code: string | null;
      status: string;
      tunnel_id: string | null;
    }>();
    expect(retained).toMatchObject({
      dns_record_id: expect.any(String),
      last_error_code: "tunnel_identity_conflict",
      status: "deleting",
      tunnel_id: tunnel.id,
    });
    vi.restoreAllMocks();
  });

  it("revokes credentials before cloud cleanup and lets the scheduled sweep retry retained state", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createRegistry(cloudflare.fetch);
    const owner = await signIn(worker, "managed-revoke@example.com");
    const node = await createNode(worker, owner.token, "managed-revoke");
    expect((await call(worker, "/v1/nodes/self/reach", {
      method: "POST",
      token: node.credential,
    })).status).toBe(200);

    cloudflare.failures.add("delete_dns");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const revoked = await call(worker, `/v1/nodes/${node.node.id}`, {
      method: "DELETE",
      token: owner.token,
    });
    expect(revoked.status).toBe(204);
    expect((await call(worker, "/v1/nodes/self", { token: node.credential })).status).toBe(401);
    const retained = await env.REGISTRY_DB.prepare(
      "SELECT dns_record_id, status FROM node_reaches WHERE node_id = ?",
    ).bind(node.node.id).first<{ dns_record_id: string | null; status: string }>();
    expect(retained).toMatchObject({ dns_record_id: expect.any(String), status: "deleting" });

    cloudflare.failures.clear();
    await env.REGISTRY_DB.prepare(
      `UPDATE node_reaches
          SET last_cleanup_attempt_at = ?
        WHERE node_id = ?`,
    ).bind(Date.now() - 6 * 60 * 1_000, node.node.id).run();
    await runScheduledCleanup(worker);
    const cleaned = await env.REGISTRY_DB.prepare(
      "SELECT dns_record_id, tunnel_id, status FROM node_reaches WHERE node_id = ?",
    ).bind(node.node.id).first<{
      dns_record_id: string | null;
      status: string;
      tunnel_id: string | null;
    }>();
    expect(cleaned).toEqual({ dns_record_id: null, status: "deleted", tunnel_id: null });
    vi.restoreAllMocks();
  });

  it("bounds each scheduled cleanup sweep beneath the free-plan external subrequest limit", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createRegistry(cloudflare.fetch);
    const now = Date.now();
    await env.REGISTRY_DB.batch(Array.from({ length: 5 }, (_, index) => {
      const opaque = index.toString(16).padStart(32, "0");
      const hostname = `r-${opaque}.reach.helmryth.test`;
      const tunnelName = `hry-r-${opaque}`;
      const tunnelId = `10000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`;
      cloudflare.tunnels.set(tunnelName, { id: tunnelId, name: tunnelName });
      cloudflare.dns.set(hostname, {
        content: `${tunnelId}.cfargotunnel.com`,
        id: `dns-budget-${index}`,
        name: hostname,
        proxied: true,
        type: "CNAME",
      });
      return env.REGISTRY_DB.prepare(
        `INSERT INTO node_reaches
          (node_id, hostname, tunnel_name, status, delete_requested_at, created_at, updated_at)
         VALUES (?, ?, ?, 'deleting', ?, ?, ?)`,
      ).bind(
        `orphan-${index}`,
        hostname,
        tunnelName,
        now - index,
        now,
        now - index,
      );
    }));

    await runScheduledCleanup(worker);
    const counts = await env.REGISTRY_DB.prepare(
      "SELECT status, COUNT(*) AS count FROM node_reaches GROUP BY status ORDER BY status",
    ).all<{ count: number; status: string }>();
    expect(counts.results).toEqual([
      { count: 4, status: "deleted" },
      { count: 1, status: "deleting" },
    ]);
    expect(cloudflare.calls).toHaveLength(40);
  });

  it("backs off scheduled cleanup retries and flags old rows for operator attention", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createRegistry(cloudflare.fetch);
    const now = Date.now();
    await env.REGISTRY_DB.prepare(
      `INSERT INTO node_reaches
        (node_id, hostname, tunnel_name, status, cleanup_attempts,
         last_cleanup_attempt_at, delete_requested_at, last_error_code, created_at, updated_at)
       VALUES (?, ?, ?, 'deleting', 2, ?, ?, 'dns_record_identity_conflict', ?, ?)`,
    ).bind(
      "orphan-backoff",
      `r-${"a".repeat(32)}.reach.helmryth.test`,
      `hry-r-${"a".repeat(32)}`,
      now - 14 * 60 * 1_000,
      now - 25 * 60 * 60 * 1_000,
      now - 25 * 60 * 60 * 1_000,
      now - 14 * 60 * 1_000,
    ).run();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runScheduledCleanup(worker);
    expect(cloudflare.calls).toHaveLength(0);
    expect(logged).not.toHaveBeenCalled();

    await env.REGISTRY_DB.prepare(
      "UPDATE node_reaches SET last_cleanup_attempt_at = ? WHERE node_id = ?",
    ).bind(now - 16 * 60 * 1_000, "orphan-backoff").run();
    await runScheduledCleanup(worker);

    expect(cloudflare.calls).toHaveLength(2);
    const row = await env.REGISTRY_DB.prepare(
      "SELECT status, cleanup_attempts FROM node_reaches WHERE node_id = ?",
    ).bind("orphan-backoff").first<{ cleanup_attempts: number; status: string }>();
    expect(row).toEqual({ cleanup_attempts: 3, status: "deleted" });
    const attentionLog = logged.mock.calls
      .flat()
      .find((entry) => typeof entry === "string" && entry.includes("requires operator attention"));
    expect(attentionLog).toBeTruthy();
    expect(JSON.parse(attentionLog ?? "{}")).toMatchObject({
      message: "managed reach cleanup requires operator attention",
      staleCandidateCount: 1,
      maxCleanupAttempts: 2,
      errorCodes: ["dns_record_identity_conflict"],
    });
    logged.mockRestore();
  });

  it("enforces reach action limits and the global body bound before Cloudflare calls", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createRegistry(cloudflare.fetch);
    const owner = await signIn(worker, "managed-limits@example.com");
    const node = await createNode(worker, owner.token, "managed-limits");
    const now = Date.now();
    await env.REGISTRY_DB.prepare(
      `INSERT INTO node_action_rate_limits
        (node_id, action, window_started_at, attempts, updated_at)
       VALUES (?, 'reconcile_reach', ?, 20, ?)`,
    ).bind(node.node.id, now, now).run();

    const limited = await call(worker, "/v1/nodes/self/reach", {
      method: "POST",
      token: node.credential,
    });
    expect(limited.status).toBe(429);
    expect(cloudflare.calls).toHaveLength(0);

    const oversized = await call(worker, "/v1/nodes/self/reach", {
      method: "POST",
      rawBody: "x".repeat(17 * 1024),
      token: node.credential,
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({ error: "request_too_large" });
    expect(cloudflare.calls).toHaveLength(0);
  });

  it("rejects invalid Cloudflare secret configuration without exposing it", async () => {
    const cloudflare = new FakeCloudflare();
    const worker = createRegistry(cloudflare.fetch);
    const invalidEnv: Env = { ...env, CLOUDFLARE_API_TOKEN: "too-short" };
    const request = new Request(`${BASE_URL}/healthz`);
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, invalidEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"misconfigured"}');
    expect(cloudflare.calls).toHaveLength(0);
  });
});
