import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  legacyWebhookUrl,
  listenWebhookIngress,
  MAX_WEBHOOK_BODY_BYTES,
  webhookCredential,
  type WebhookIngress,
} from "./webhook-ingress.ts";
import { WebhookManager, type WebhookManagerOptions } from "./webhooks.ts";

let dir: string;
let ingress: WebhookIngress;
let endpointId: string;
let secret: string;
let manager: WebhookManager;
const queued: Array<Parameters<WebhookManagerOptions["enqueue"]>[0]> = [];
let persistCount = 0;
let runCount = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hry-webhook-ingress-"));
  manager = new WebhookManager({
    file: join(dir, "webhooks.json"),
    newRunId: () => `run-${++runCount}`,
    onPersist: () => { persistCount += 1; },
    botState: () => "ready",
    enqueue: (input) => {
      queued.push(input);
      return { id: input.runId };
    },
  });
  const created = manager.create({ name: "Build event", prompt: "Review the build", botId: "sigil-1" });
  endpointId = created.webhook.endpointId;
  secret = created.secret;
  ingress = await listenWebhookIngress(manager, { port: 0 });
});

afterAll(async () => {
  manager.flushDeferredAttempts();
  await new Promise<void>((resolve) => ingress.server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe("webhook-only ingress", () => {
  it("exposes health but nothing from the main Helmryth API", async () => {
    const health = await fetch(`${ingress.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ app: "helmryth-webhooks", ready: true });
    expect((await fetch(`${ingress.baseUrl}/api/bots`)).status).toBe(404);
  });

  it("accepts the Bearer command contract and deduplicates command replays", async () => {
    const credential = webhookCredential(ingress.baseUrl, endpointId, secret);
    expect(credential.endpointUrl).not.toContain(secret);
    expect(JSON.stringify(credential)).not.toContain(`/${secret}`);
    expect(credential.idempotencyKey).toMatch(/^hry_evt_[0-9a-f-]{36}$/);
    const send = () => fetch(credential.endpointUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.secret}`,
        "content-type": "application/json",
        "idempotency-key": credential.idempotencyKey,
        "x-github-event": "push",
      },
      body: JSON.stringify({ ref: "main", id: "event-in-body" }),
    });
    const first = await send();
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ accepted: true, duplicate: false, runId: "run-1" });
    const retry = await send();
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ accepted: true, duplicate: true, runId: "run-1" });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.prompt).toContain("Event: push");
  });

  it("retains secret-in-path compatibility without using it in the generated-command contract", async () => {
    const credential = webhookCredential(ingress.baseUrl, endpointId, secret);
    expect(credential).not.toHaveProperty("url");
    const response = await fetch(legacyWebhookUrl(credential.endpointUrl, secret), {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `compat-${Date.now()}` },
      body: JSON.stringify({ compatibility: true }),
    });
    expect(response.status).toBe(202);
  });

  it("also accepts a bearer secret without putting it in the URL", async () => {
    const response = await fetch(`${ingress.baseUrl}/hooks/${endpointId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/x-www-form-urlencoded" },
      body: "ticket=42&priority=high",
    });
    expect(response.status).toBe(202);
    expect(queued.at(-1)?.prompt).toContain('"ticket": "42"');
  });

  it("does not deduplicate separate requests that reuse a generic payload id", async () => {
    const credential = webhookCredential(ingress.baseUrl, endpointId, secret);
    const before = queued.length;
    const send = () => fetch(credential.endpointUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${credential.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "shared-record", task: "Handle this update" }),
    });
    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(202);
    expect(queued).toHaveLength(before + 2);
  });

  it("captures a verification event without queueing work", async () => {
    const created = manager.create({ name: "Verify", prompt: "", botId: "sigil-1", enabled: false, verificationPending: true });
    const before = queued.length;
    const credential = webhookCredential(ingress.baseUrl, created.webhook.endpointId, created.secret);
    const response = await fetch(credential.endpointUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.secret}`,
        "content-type": "application/json",
        "x-webhook-event": "support.created",
      },
      body: JSON.stringify({ task: "Triage ticket 42" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, captured: true });
    expect(queued).toHaveLength(before);
    expect(manager.list().find((webhook) => webhook.id === created.webhook.id)).toMatchObject({ verificationPending: false, enabled: false });
  });

  it("rejects invalid credentials, malformed JSON and oversized bodies", async () => {
    const unauthorized = await fetch(`${ingress.baseUrl}/hooks/${endpointId}/wrong`, { method: "POST", body: "{}" });
    expect(unauthorized.status).toBe(401);

    const malformed = await fetch(`${ingress.baseUrl}/hooks/${endpointId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);

    const oversized = await fetch(`${ingress.baseUrl}/hooks/${endpointId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "text/plain" },
      body: "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1),
    });
    expect(oversized.status).toBe(413);
    expect(manager.listAttempts().filter((attempt) => attempt.webhookId === manager.list().find((webhook) => webhook.endpointId === endpointId)?.id && attempt.outcome === "rejected").length).toBeGreaterThanOrEqual(3);
  });

  it("rate-limits invalid-secret abuse without synchronously persisting every attempt", async () => {
    const beforePersists = persistCount;
    const previouslyLogged = manager.listAttempts()
      .filter((attempt) => attempt.reason?.includes("Invalid webhook")).length;
    const remainingBeforeLimit = 10 - previouslyLogged;
    const responses = await Promise.all(Array.from({ length: 30 }, (_, index) =>
      fetch(`${ingress.baseUrl}/hooks/${endpointId}/wrong-${index}`, { method: "POST", body: "ignored" }),
    ));
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(remainingBeforeLimit);
    expect(statuses.filter((status) => status === 429)).toHaveLength(30 - remainingBeforeLimit);
    expect(persistCount).toBe(beforePersists);
    expect(manager.listAttempts().filter((attempt) => attempt.reason?.includes("Invalid webhook"))).toHaveLength(10);

    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(persistCount).toBe(beforePersists + 1);
  });

  it.each(["%", "%E0%A4%A", "%ZZ"])("returns a controlled client error for malformed secret encoding %s", async (encoded) => {
    const response = await fetch(`${ingress.baseUrl}/hooks/${endpointId}/${encoded}`, { method: "POST" });
    expect([400, 401]).toContain(response.status);
    expect(response.status).not.toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) });
  });
});
