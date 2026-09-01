import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic, quarantineCorruptFile } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { ensurePrivateDirectory, repairPrivateFile } from "./private-storage.ts";
import type { RoutineRunOn } from "./routines.ts";
import { parseJson, schemaIssue, type JsonValue } from "./schema.ts";

export interface WebhookTrigger {
  id: string;
  endpointId: string;
  name: string;
  prompt: string;
  botId: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastReceivedAt?: number;
  lastRunId?: string;
  deliveryCount: number;
  /** Monotonic non-secret generation of the one-time credential. It changes
   * only when the secret rotates, never for ordinary webhook edits. */
  credentialVersion: number;
  /** New UI-created hooks capture one authenticated request before they can run. */
  verificationPending?: boolean;
  verifiedAt?: number;
  verificationSample?: WebhookVerificationSample;
  /** Optional event-name allowlist. Empty means every event type. */
  eventTypes?: string[];
}

export interface WebhookTriggerInput {
  name: string;
  prompt: string;
  botId: string;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  verificationPending?: boolean;
  eventTypes?: string[];
}

type CleanWebhookInput = Omit<
  WebhookTrigger,
  | "id"
  | "endpointId"
  | "createdAt"
  | "updatedAt"
  | "lastReceivedAt"
  | "lastRunId"
  | "deliveryCount"
  | "credentialVersion"
  | "verifiedAt"
  | "verificationSample"
>;

export interface WebhookVerificationSample {
  receivedAt: number;
  eventName?: string;
  contentType?: string;
  preview: string;
}

export type WebhookAttemptOutcome = "accepted" | "captured" | "duplicate" | "ignored" | "rejected";

export interface WebhookAttempt {
  id: string;
  webhookId: string;
  receivedAt: number;
  outcome: WebhookAttemptOutcome;
  statusCode: number;
  eventName?: string;
  preview?: string;
  deliveryId?: string;
  runId?: string;
  reason?: string;
}

interface StoredWebhookTrigger extends WebhookTrigger {
  secretHash: string;
}

interface DeliveryReceipt {
  key: string;
  runId: string;
  at: number;
  state: "pending" | "committed";
  eventHash?: string;
  pendingInput?: WebhookRunInput;
}

interface WebhookFile {
  version: 1;
  webhooks: StoredWebhookTrigger[];
  deliveries: DeliveryReceipt[];
  attempts?: WebhookAttempt[];
}

interface CreatedWebhook {
  webhook: WebhookTrigger;
  secret: string;
}

export interface WebhookEvent {
  payload: JsonValue;
  contentType?: string;
  eventName?: string;
  userAgent?: string;
  deliveryId?: string;
}

export interface WebhookReceiveResult {
  runId?: string;
  deliveryId: string;
  duplicate: boolean;
  captured?: boolean;
  ignored?: boolean;
}

export interface WebhookManagerOptions {
  file?: string;
  now?: () => number;
  emit?: (event: WebhookManagerEvent) => void;
  botState: (botId: string) => "ready" | "busy" | "missing";
  enqueue: (input: WebhookRunInput) => { id: string };
  /** Stable id allocated before the run is enqueued, allowing crash-safe replay. */
  newRunId?: () => string;
  /** Verification seam for crash-boundary tests; production leaves this unset. */
  fault?: (point: WebhookFaultPoint) => void;
  /** Persistence observer used by abuse/fault tests. */
  onPersist?: (reason: "state" | "deferred-attempts") => void;
  cancelQueued?: (webhookId: string, message: string) => void;
  pendingRuns?: (webhookId: string) => number;
}

export interface WebhookRunInput {
  runId: string;
  webhookId: string;
  webhookName: string;
  prompt: string;
  botId: string;
  runOn: RoutineRunOn;
  deliveryId: string;
  receivedAt: number;
}

export type WebhookFaultPoint =
  | "after-intent-persisted"
  | "after-run-enqueued"
  | "before-receipt-persisted"
  | "after-receipt-persisted";

export interface WebhookAuthRejection {
  statusCode: 401 | 429;
  logged: boolean;
}

export type WebhookManagerEvent =
  | { kind: "webhook"; webhook: WebhookTrigger }
  | { kind: "webhook.deleted"; webhookId: string }
  | { kind: "webhook.attempt"; attempt: WebhookAttempt };

const MAX_DELIVERIES = 2_000;
const MAX_ATTEMPTS = 2_000;
const MAX_EVENT_CHARS = 48_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 10;
const INVALID_AUTH_RATE_LIMIT = 10;
const DEFERRED_ATTEMPT_SAVE_MS = 250;
const MAX_PENDING_RUNS = 3;

const runOnSchema = z.enum(["local", "cloud"]);
const LEGACY_WEBHOOK_RUN_ON = "sigil" as const;
const persistedRunOnSchema = z
  .union([runOnSchema, z.literal(LEGACY_WEBHOOK_RUN_ON)])
  .transform((value) => value === LEGACY_WEBHOOK_RUN_ON ? "local" as const : value);
const eventTypesSchema = z.array(z.string()).max(20).optional();
const triggerInputSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  botId: z.string(),
  runOn: runOnSchema.optional(),
  enabled: z.boolean().optional(),
  verificationPending: z.boolean().optional(),
  eventTypes: eventTypesSchema,
});
const triggerPatchSchema = triggerInputSchema.partial();
const verificationSampleSchema = z.object({
  receivedAt: z.number().finite().nonnegative(),
  eventName: z.string().optional(),
  contentType: z.string().optional(),
  preview: z.string(),
});
const storedWebhookSchema = z.object({
  id: z.string().min(1),
  endpointId: z.string().min(1),
  name: z.string(),
  prompt: z.string(),
  botId: z.string().min(1),
  runOn: persistedRunOnSchema,
  enabled: z.boolean(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  lastReceivedAt: z.number().finite().nonnegative().optional(),
  lastRunId: z.string().optional(),
  deliveryCount: z.number().int().nonnegative(),
  credentialVersion: z.number().int().positive().optional().default(1),
  verificationPending: z.boolean().optional(),
  verifiedAt: z.number().finite().nonnegative().optional(),
  verificationSample: verificationSampleSchema.optional(),
  eventTypes: eventTypesSchema,
  secretHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const deliveryReceiptSchema = z.object({
  key: z.string().min(1),
  runId: z.string().min(1),
  at: z.number().finite().nonnegative(),
  state: z.enum(["pending", "committed"]).optional().default("committed"),
  eventHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  pendingInput: z.object({
    runId: z.string().min(1),
    webhookId: z.string().min(1),
    webhookName: z.string(),
    prompt: z.string(),
    botId: z.string().min(1),
    runOn: runOnSchema,
    deliveryId: z.string().min(1),
    receivedAt: z.number().finite().nonnegative(),
  }).optional(),
});
const webhookAttemptSchema = z.object({
  id: z.string().min(1),
  webhookId: z.string().min(1),
  receivedAt: z.number().finite().nonnegative(),
  outcome: z.enum(["accepted", "captured", "duplicate", "ignored", "rejected"]),
  statusCode: z.number().int().min(100).max(599),
  eventName: z.string().optional(),
  preview: z.string().optional(),
  deliveryId: z.string().optional(),
  runId: z.string().optional(),
  reason: z.string().optional(),
});
const webhookFileSchema = z.object({
  version: z.literal(1),
  webhooks: z.array(storedWebhookSchema),
  deliveries: z.array(deliveryReceiptSchema),
  attempts: z.array(webhookAttemptSchema).optional(),
});
const taskPayloadSchema = z.object({ task: z.string().optional(), message: z.string().optional() });
const statusErrorSchema = z.object({ status: z.number().int().optional() });
const faultInjectionSchema = z.object({ webhookFaultInjection: z.literal(true) });

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function invalidInput(error: z.ZodError): never {
  fail(400, schemaIssue(error, "Invalid webhook settings"));
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function secretMatches(secret: string, expectedHex: string): boolean {
  if (!secret) return false;
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function newEndpointId(): string {
  return `wh_${randomBytes(12).toString("base64url")}`;
}

function newSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

function cleanInput(input: WebhookTriggerInput): CleanWebhookInput {
  const name = input.name.trim().slice(0, 80);
  const prompt = input.prompt.trim().slice(0, 20_000);
  const botId = input.botId.trim();
  const runOn = input.runOn ?? "local";
  if (!name) fail(400, "Give the webhook a name");
  if (!botId) fail(400, "Choose an operator");
  if (runOn !== "local" && runOn !== "cloud") fail(400, "Choose where this webhook runs");
  const eventTypes = Array.from(new Set(
    (input.eventTypes ?? [])
      .map((value) => value.trim().slice(0, 200))
      .filter(Boolean),
  )).slice(0, 20);
  const enabled = input.enabled !== false;
  const clean: CleanWebhookInput = {
    name,
    prompt,
    botId,
    runOn,
    enabled,
    verificationPending: enabled ? false : input.verificationPending === true,
  };
  if (eventTypes.length) clean.eventTypes = eventTypes;
  return clean;
}

function parseTriggerInput(value: JsonValue): WebhookTriggerInput {
  const parsed = triggerInputSchema.safeParse(value);
  if (!parsed.success) invalidInput(parsed.error);
  return parsed.data;
}

function parseTriggerPatch(value: JsonValue): Partial<WebhookTriggerInput> {
  const parsed = triggerPatchSchema.safeParse(value);
  if (!parsed.success) invalidInput(parsed.error);
  return parsed.data;
}

function publicTrigger(trigger: StoredWebhookTrigger): WebhookTrigger {
  const { secretHash: _secretHash, ...safe } = trigger;
  return { ...safe };
}

function serializePayload(payload: JsonValue): string {
  let text: string;
  const plainText = z.string().safeParse(payload);
  if (plainText.success) text = plainText.data;
  else {
    try {
      text = JSON.stringify(payload, null, 2) ?? String(payload);
    } catch {
      text = String(payload);
    }
  }
  if (text.length <= MAX_EVENT_CHARS) return text;
  return `${text.slice(0, MAX_EVENT_CHARS)}\n\n[Payload truncated by Helmryth]`;
}

/** Keep sender-controlled text readable without allowing it to spell one of
 * the prompt compiler's structural markers. The literal escape sequences are
 * data, not brackets the model can mistake for a boundary. */
function escapePromptData(text: string): string {
  return text.replaceAll("[", "\\u005b").replaceAll("]", "\\u005d");
}

function previewPayload(payload: JsonValue): string {
  return serializePayload(payload).replace(/\s+/g, " ").trim().slice(0, 2_000);
}

function taskFromPayload(payload: JsonValue): string {
  const parsed = taskPayloadSchema.safeParse(payload);
  if (!parsed.success) return "";
  const task = parsed.data.task ?? parsed.data.message ?? "";
  return task.trim().slice(0, 20_000);
}

function eventHash(event: WebhookEvent): string {
  return createHash("sha256").update(JSON.stringify({
    payload: event.payload,
    contentType: event.contentType ?? null,
    eventName: event.eventName ?? null,
    userAgent: event.userAgent ?? null,
  })).digest("hex");
}

function eventPrompt(trigger: StoredWebhookTrigger, event: WebhookEvent, receivedAt: number, deliveryId: string): string {
  const metadata = [
    `Received: ${new Date(receivedAt).toISOString()}`,
    `Delivery ID: ${escapePromptData(deliveryId)}`,
    event.eventName && `Event: ${escapePromptData(event.eventName.slice(0, 200))}`,
    event.contentType && `Content-Type: ${escapePromptData(event.contentType.slice(0, 200))}`,
    event.userAgent && `Sender: ${escapePromptData(event.userAgent.slice(0, 300))}`,
  ].filter(Boolean);
  const configured = trigger.prompt.trim();
  const requestedTask = configured ? "" : taskFromPayload(event.payload);
  const instructionBlock = configured
    ? ["[USER-CONFIGURED WEBHOOK INSTRUCTIONS]", configured, "[/USER-CONFIGURED WEBHOOK INSTRUCTIONS]"]
    : requestedTask
      ? ["[AUTHENTICATED WEBHOOK TASK]", escapePromptData(requestedTask), "[/AUTHENTICATED WEBHOOK TASK]"]
      : [
          "[DEFAULT WEBHOOK INSTRUCTIONS]",
          "Review the incoming event and summarize what happened. Do not take external actions unless the event clearly requires them and existing permissions allow them.",
          "[/DEFAULT WEBHOOK INSTRUCTIONS]",
        ];
  return [
    ...instructionBlock,
    "",
    "[UNTRUSTED WEBHOOK EVENT DATA]",
    ...metadata,
    "",
    escapePromptData(serializePayload(event.payload)),
    "[/UNTRUSTED WEBHOOK EVENT DATA]",
  ].join("\n");
}

export class WebhookManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: WebhookManagerOptions;
  private webhooks: StoredWebhookTrigger[] = [];
  private deliveries: DeliveryReceipt[] = [];
  private attempts: WebhookAttempt[] = [];
  private rate = new Map<string, number[]>();
  private invalidAuthRate = new Map<string, number[]>();
  private deferredAttemptSave: ReturnType<typeof setTimeout> | null = null;
  private deferredAttemptsDirty = false;

  constructor(options: WebhookManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "webhooks.json");
    ensurePrivateDirectory(dirname(this.file));
    repairPrivateFile(this.file);
    this.now = options.now ?? Date.now;
    try {
      const parsed = webhookFileSchema.safeParse(parseJson(readFileSync(this.file, "utf8")));
      if (!parsed.success) throw parsed.error;
      this.webhooks = parsed.data.webhooks;
      this.deliveries = parsed.data.deliveries.slice(-MAX_DELIVERIES);
      this.attempts = (parsed.data.attempts ?? []).slice(-MAX_ATTEMPTS);
    } catch (cause) {
      // Corruption here used to be indistinguishable from a first run: the
      // catch returned empty, the API answered 200 with nothing, and the next
      // save overwrote the original. quarantineCorruptFile no-ops when the file
      // does not exist, so a genuine first run stays silent while real bytes
      // are preserved and reported.
      quarantineCorruptFile(this.file, "", cause);
      this.webhooks = [];
      this.deliveries = [];
      this.attempts = [];
    }
  }

  list(): WebhookTrigger[] {
    return this.webhooks.map(publicTrigger);
  }

  listAttempts(): WebhookAttempt[] {
    return this.attempts.map((attempt) => ({ ...attempt }));
  }

  create(input: JsonValue): CreatedWebhook {
    const clean = cleanInput(parseTriggerInput(input));
    if (this.options.botState(clean.botId) === "missing") fail(400, "That operator no longer exists");
    const now = this.now();
    const secret = newSecret();
    const trigger: StoredWebhookTrigger = {
      id: randomUUID(),
      endpointId: newEndpointId(),
      ...clean,
      secretHash: hashSecret(secret),
      createdAt: now,
      updatedAt: now,
      deliveryCount: 0,
      credentialVersion: 1,
    };
    this.webhooks.unshift(trigger);
    this.save();
    this.emit(trigger);
    return { webhook: publicTrigger(trigger), secret };
  }

  update(id: string, value: JsonValue): WebhookTrigger | null {
    const trigger = this.webhooks.find((candidate) => candidate.id === id);
    if (!trigger) return null;
    const patch = parseTriggerPatch(value);
    const clean = cleanInput({
      name: patch.name ?? trigger.name,
      prompt: patch.prompt ?? trigger.prompt,
      botId: patch.botId ?? trigger.botId,
      runOn: patch.runOn ?? trigger.runOn,
      enabled: patch.enabled ?? trigger.enabled,
      verificationPending: patch.verificationPending ?? trigger.verificationPending,
      eventTypes: patch.eventTypes ?? trigger.eventTypes,
    });
    if (this.options.botState(clean.botId) === "missing") fail(400, "That operator no longer exists");
    Object.assign(trigger, clean, { updatedAt: this.now() });
    if (!clean.eventTypes?.length) delete trigger.eventTypes;
    if (patch.enabled === false) {
      this.options.cancelQueued?.(trigger.id, "The webhook was paused before this delivery started");
    }
    this.save();
    this.emit(trigger);
    return publicTrigger(trigger);
  }

  remove(id: string): boolean {
    const at = this.webhooks.findIndex((candidate) => candidate.id === id);
    if (at === -1) return false;
    const [trigger] = this.webhooks.splice(at, 1);
    this.deliveries = this.deliveries.filter((delivery) => !delivery.key.startsWith(`${trigger.endpointId}:`));
    this.attempts = this.attempts.filter((attempt) => attempt.webhookId !== trigger.id);
    this.rate.delete(trigger.endpointId);
    this.invalidAuthRate.delete(trigger.endpointId);
    this.options.cancelQueued?.(trigger.id, "The webhook was deleted before this delivery started");
    this.save();
    this.options.emit?.({ kind: "webhook.deleted", webhookId: id });
    return true;
  }

  rotateSecret(id: string): { webhook: WebhookTrigger; secret: string } | null {
    const trigger = this.webhooks.find((candidate) => candidate.id === id);
    if (!trigger) return null;
    const secret = newSecret();
    trigger.secretHash = hashSecret(secret);
    trigger.credentialVersion += 1;
    trigger.updatedAt = this.now();
    this.save();
    this.emit(trigger);
    return { webhook: publicTrigger(trigger), secret };
  }

  disableForBot(botId: string): void {
    let changed = false;
    for (const trigger of this.webhooks) {
      if (trigger.botId !== botId || !trigger.enabled) continue;
      trigger.enabled = false;
      trigger.updatedAt = this.now();
      this.options.cancelQueued?.(trigger.id, "The assigned operator was deleted");
      this.emit(trigger);
      changed = true;
    }
    if (changed) this.save();
  }

  authorize(endpointId: string, secret: string): boolean {
    const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
    return Boolean(trigger && secretMatches(secret, trigger.secretHash));
  }

  receive(endpointId: string, secret: string, event: WebhookEvent): WebhookReceiveResult {
    const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
    if (!trigger || !secretMatches(secret, trigger.secretHash)) fail(401, "Invalid webhook URL or secret");
    if (trigger.verificationPending && !trigger.enabled) return this.captureVerification(trigger, event);
    try {
      return this.dispatch(trigger, event);
    } catch (error) {
      if (faultInjectionSchema.safeParse(error).success) throw error;
      const parsedError = statusErrorSchema.safeParse(error);
      const status = parsedError.success ? parsedError.data.status ?? 500 : 500;
      this.recordRejectedForTrigger(trigger, status, error instanceof Error ? error.message : String(error), event);
      throw error;
    }
  }

  test(id: string, payload: JsonValue = { event: "helmryth.test", message: "Test webhook delivery" }): WebhookReceiveResult | null {
    const trigger = this.webhooks.find((candidate) => candidate.id === id);
    if (!trigger) return null;
    const eventName = trigger.eventTypes?.[0] ?? "helmryth.test";
    return this.dispatch(trigger, {
      payload,
      contentType: "application/json",
      eventName,
      userAgent: "Helmryth webhook tester",
      deliveryId: `test-${randomUUID()}`,
    });
  }

  recordRejected(endpointId: string, statusCode: number, reason: string, event: Partial<WebhookEvent> = {}): WebhookAttempt | null {
    const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
    if (!trigger) return null;
    return this.recordRejectedForTrigger(trigger, statusCode, reason, event);
  }

  /** Known-endpoint authentication failures are observable in memory/SSE but
   * persisted in one bounded batch. Unknown endpoint ids never allocate rate
   * state, preventing attacker-controlled map growth. */
  recordUnauthorized(endpointId: string, event: Partial<WebhookEvent> = {}): WebhookAuthRejection {
    const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
    if (!trigger) return { statusCode: 401, logged: false };
    const now = this.now();
    const recent = (this.invalidAuthRate.get(endpointId) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
    if (recent.length >= INVALID_AUTH_RATE_LIMIT) {
      this.invalidAuthRate.set(endpointId, recent);
      return { statusCode: 429, logged: false };
    }
    recent.push(now);
    this.invalidAuthRate.set(endpointId, recent);
    this.appendAttempt(trigger, event, {
      outcome: "rejected",
      statusCode: 401,
      reason: "Invalid webhook URL or secret",
      deliveryId: event.deliveryId,
    });
    this.scheduleDeferredAttemptSave();
    return { statusCode: 401, logged: true };
  }

  recordRejectedDeferred(endpointId: string, statusCode: number, reason: string, event: Partial<WebhookEvent> = {}): WebhookAttempt | null {
    const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
    if (!trigger) return null;
    const attempt = this.appendAttempt(trigger, event, {
      outcome: "rejected",
      statusCode,
      reason: reason.slice(0, 500),
      deliveryId: event.deliveryId,
    });
    this.scheduleDeferredAttemptSave();
    return attempt;
  }

  flushDeferredAttempts(): void {
    if (this.deferredAttemptSave) clearTimeout(this.deferredAttemptSave);
    this.deferredAttemptSave = null;
    if (!this.deferredAttemptsDirty) return;
    this.deferredAttemptsDirty = false;
    try {
      this.save("deferred-attempts");
    } catch (error) {
      this.deferredAttemptsDirty = true;
      throw error;
    }
  }

  private dispatch(trigger: StoredWebhookTrigger, event: WebhookEvent): WebhookReceiveResult {
    if (!trigger.enabled) fail(409, "This webhook is paused");
    if (this.options.botState(trigger.botId) === "missing") fail(410, "The assigned operator no longer exists");

    const allowed = trigger.eventTypes ?? [];
    if (allowed.length > 0 && (!event.eventName || !allowed.includes(event.eventName))) {
      const deliveryId = String(event.deliveryId ?? "").trim().slice(0, 200) || randomUUID();
      this.appendAttempt(trigger, event, {
        outcome: "ignored",
        statusCode: 202,
        deliveryId,
        reason: event.eventName ? `Event type “${event.eventName}” is not enabled` : "Event type is missing",
      });
      this.save();
      return { deliveryId, duplicate: false, ignored: true };
    }

    const now = this.now();
    const requestedDeliveryId = String(event.deliveryId ?? "").trim().slice(0, 200);
    if (requestedDeliveryId) {
      const key = `${trigger.endpointId}:${requestedDeliveryId}`;
      const duplicate = this.deliveries.find((delivery) => delivery.key === key);
      if (duplicate) {
        if (duplicate.state === "pending") {
          if (duplicate.eventHash && duplicate.eventHash !== eventHash(event)) {
            fail(409, "This delivery id is already pending with different event data");
          }
          this.enqueueReceipt(duplicate);
          this.finalizeReceipt(trigger, event, duplicate, true);
          return { runId: duplicate.runId, deliveryId: requestedDeliveryId, duplicate: true };
        }
        this.appendAttempt(trigger, event, {
          outcome: "duplicate",
          statusCode: 202,
          deliveryId: requestedDeliveryId,
          runId: duplicate.runId,
          reason: "Duplicate delivery ignored",
        });
        this.save();
        return { runId: duplicate.runId, deliveryId: requestedDeliveryId, duplicate: true };
      }
    }

    // A sender retrying an already-accepted delivery must remain idempotent
    // even while this webhook's queue is full. Only new work consumes a slot.
    if ((this.options.pendingRuns?.(trigger.id) ?? 0) >= MAX_PENDING_RUNS) {
      fail(429, "This webhook already has too many unfinished runs");
    }

    const recent = (this.rate.get(trigger.endpointId) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) fail(429, "Webhook rate limit exceeded");
    recent.push(now);
    this.rate.set(trigger.endpointId, recent);

    const deliveryId = requestedDeliveryId || randomUUID();
    const runId = this.options.newRunId?.() ?? randomUUID();
    const pendingInput: WebhookRunInput = {
      runId,
      webhookId: trigger.id,
      webhookName: trigger.name,
      prompt: eventPrompt(trigger, event, now, deliveryId),
      botId: trigger.botId,
      runOn: trigger.runOn,
      deliveryId,
      receivedAt: now,
    };
    const receipt: DeliveryReceipt = {
      key: `${trigger.endpointId}:${deliveryId}`,
      runId,
      at: now,
      state: "pending",
      eventHash: eventHash(event),
      pendingInput,
    };
    this.deliveries.push(receipt);
    if (this.deliveries.length > MAX_DELIVERIES) {
      this.deliveries.splice(0, this.deliveries.length - MAX_DELIVERIES);
    }
    try {
      this.save();
    } catch (error) {
      this.deliveries = this.deliveries.filter((candidate) => candidate !== receipt);
      throw error;
    }
    this.options.fault?.("after-intent-persisted");
    this.enqueueReceipt(receipt);
    this.options.fault?.("after-run-enqueued");
    this.finalizeReceipt(trigger, event, receipt, false);
    return { runId: receipt.runId, deliveryId, duplicate: false };
  }

  private enqueueReceipt(receipt: DeliveryReceipt): void {
    if (!receipt.pendingInput) fail(500, "Pending webhook delivery is missing its durable run input");
    const run = this.options.enqueue(receipt.pendingInput);
    if (run.id !== receipt.runId) {
      fail(500, "Webhook run id did not match its durable delivery intent");
    }
  }

  private finalizeReceipt(
    trigger: StoredWebhookTrigger,
    event: WebhookEvent,
    receipt: DeliveryReceipt,
    recovered: boolean,
  ): void {
    const deliveryId = receipt.key.slice(trigger.endpointId.length + 1);
    receipt.state = "committed";
    delete receipt.pendingInput;
    trigger.lastReceivedAt = receipt.at;
    trigger.lastRunId = receipt.runId;
    trigger.deliveryCount += 1;
    trigger.updatedAt = receipt.at;
    this.appendAttempt(trigger, event, {
      outcome: recovered ? "duplicate" : "accepted",
      statusCode: 202,
      deliveryId,
      runId: receipt.runId,
      reason: recovered ? "Recovered durable delivery after an interrupted commit" : undefined,
    });
    this.options.fault?.("before-receipt-persisted");
    this.save();
    this.options.fault?.("after-receipt-persisted");
    this.emit(trigger);
  }

  private captureVerification(trigger: StoredWebhookTrigger, event: WebhookEvent): WebhookReceiveResult {
    const receivedAt = this.now();
    const deliveryId = String(event.deliveryId ?? "").trim().slice(0, 200) || randomUUID();
    trigger.verificationPending = false;
    trigger.verifiedAt = receivedAt;
    trigger.lastReceivedAt = receivedAt;
    trigger.updatedAt = receivedAt;
    const sample: WebhookVerificationSample = {
      receivedAt,
      preview: previewPayload(event.payload),
    };
    if (event.eventName) sample.eventName = event.eventName.slice(0, 200);
    if (event.contentType) sample.contentType = event.contentType.slice(0, 200);
    trigger.verificationSample = sample;
    this.appendAttempt(trigger, event, {
      outcome: "captured",
      statusCode: 202,
      deliveryId,
      reason: "Test event captured; enable the webhook to start operator runs",
    });
    this.save();
    this.emit(trigger);
    return { deliveryId, duplicate: false, captured: true };
  }

  private recordRejectedForTrigger(trigger: StoredWebhookTrigger, statusCode: number, reason: string, event: Partial<WebhookEvent>): WebhookAttempt {
    const attempt = this.appendAttempt(trigger, event, {
      outcome: "rejected",
      statusCode,
      reason: reason.slice(0, 500),
      deliveryId: event.deliveryId,
    });
    this.save();
    return attempt;
  }

  private appendAttempt(
    trigger: StoredWebhookTrigger,
    event: Partial<WebhookEvent>,
    details: Pick<WebhookAttempt, "outcome" | "statusCode"> & Partial<Pick<WebhookAttempt, "deliveryId" | "runId" | "reason">>,
  ): WebhookAttempt {
    const attempt: WebhookAttempt = {
      id: randomUUID(),
      webhookId: trigger.id,
      receivedAt: this.now(),
      outcome: details.outcome,
      statusCode: details.statusCode,
    };
    if (event.eventName) attempt.eventName = event.eventName.slice(0, 200);
    if (event.payload !== undefined) attempt.preview = previewPayload(event.payload);
    if (details.deliveryId) attempt.deliveryId = details.deliveryId.slice(0, 200);
    if (details.runId) attempt.runId = details.runId;
    if (details.reason) attempt.reason = details.reason;
    this.attempts.push(attempt);
    if (this.attempts.length > MAX_ATTEMPTS) this.attempts.splice(0, this.attempts.length - MAX_ATTEMPTS);
    this.options.emit?.({ kind: "webhook.attempt", attempt: { ...attempt } });
    return attempt;
  }

  private emit(trigger: StoredWebhookTrigger): void {
    this.options.emit?.({ kind: "webhook", webhook: publicTrigger(trigger) });
  }

  private scheduleDeferredAttemptSave(): void {
    this.deferredAttemptsDirty = true;
    if (this.deferredAttemptSave) return;
    this.deferredAttemptSave = setTimeout(() => {
      this.deferredAttemptSave = null;
      if (!this.deferredAttemptsDirty) return;
      this.deferredAttemptsDirty = false;
      try {
        this.save("deferred-attempts");
      } catch {
        // Keep the dirty bit. A later attempt or explicit flush retries one
        // bounded batch without turning attacker traffic into a write loop.
        this.deferredAttemptsDirty = true;
      }
    }, DEFERRED_ATTEMPT_SAVE_MS);
    this.deferredAttemptSave.unref?.();
  }

  private save(reason: "state" | "deferred-attempts" = "state"): void {
    ensurePrivateDirectory(dirname(this.file));
    writeFileAtomic(
      this.file,
      JSON.stringify({ version: 1, webhooks: this.webhooks, deliveries: this.deliveries, attempts: this.attempts } satisfies WebhookFile, null, 2),
      { mode: 0o600 },
    );
    if (reason === "state" && this.deferredAttemptsDirty) {
      this.deferredAttemptsDirty = false;
      if (this.deferredAttemptSave) clearTimeout(this.deferredAttemptSave);
      this.deferredAttemptSave = null;
    }
    this.options.onPersist?.(reason);
  }
}
