import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic, quarantineCorruptFile } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { redactSecretsInText } from "./redact.ts";
import { ensurePrivateDirectory, repairPrivateFile } from "./private-storage.ts";
import type { JsonValue } from "./schema.ts";
import type { RoutineRequestOperation } from "../shared/routine-request.ts";
import { presentRuntimeError } from "../shared/runtime-error.ts";

export type RoutineSchedule =
  | { type: "once"; at: number }
  | { type: "daily"; time: string; weekdays: number[] };

/** `cloud` runs the operator itself inside the operator's Box VM. `local` keeps
 * using the provider selected for the operator and only borrows its configured
 * computer tools, if any. */
export type RoutineRunOn = "local" | "cloud";
const LEGACY_ROUTINE_RUN_ON = "sigil" as const;

const persistedRoutineRunOnSchema = z.enum(["local", "cloud", LEGACY_ROUTINE_RUN_ON]).optional().catch(undefined);

function persistedRoutineRunOn(value: JsonValue | undefined): RoutineRunOn {
  const runOn = persistedRoutineRunOnSchema.parse(value);
  if (runOn === "cloud") return "cloud";
  if (runOn === "local" || runOn === LEGACY_ROUTINE_RUN_ON || runOn === undefined) return "local";
  return "local";
}

const persistedSourceThreadId = z.string().trim().min(1).optional().catch(undefined);

export type RoutineRunTrigger = "schedule" | "manual" | "webhook";

export type RoutineRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "missed";

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  botId: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  schedule: RoutineSchedule;
  durationMinutes: number;
  /** Conversation that created this routine in chat. Calendar/import-created
   * routines intentionally have no source, and older files migrate in place. */
  sourceThreadId?: string;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  routineName: string;
  /** Snapshot the work so an edited/deleted definition cannot rewrite history. */
  prompt?: string;
  durationMinutes?: number;
  botId: string;
  runOn: RoutineRunOn;
  scheduledFor: number;
  status: RoutineRunStatus;
  manual: boolean;
  /** Why this receipt exists. Kept optional so version-1 files migrate in place. */
  triggerSource?: RoutineRunTrigger;
  webhookId?: string;
  deliveryId?: string;
  /** Snapshot the routine's reporting destination. Execution remains on the
   * separate `threadId` so recurring work never contaminates chat context. */
  sourceThreadId?: string;
  threadId?: string;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  /** Human-readable reason the detached execution is waiting. */
  attention?: string;
  error?: string;
  cost?: number | null;
  denials?: string[];
  createdAt: number;
  seenAt?: number;
}

export interface RoutineRequestReceipt {
  requestId: string;
  messageId: string;
  botId: string;
  threadId: string;
  action: RoutineRequestOperation["action"];
  fingerprintVersion: 1;
  /** SHA-256 of the strict normalized operation carried by the card. */
  fingerprint: string;
  resultId: string;
  appliedAt: number;
}

export interface RoutineRequestCommit {
  requestId: string;
  messageId: string;
  botId: string;
  threadId: string;
  action: RoutineRequestOperation["action"];
  fingerprintVersion: 1;
  fingerprint: string;
}

export interface RoutineThreadErasure {
  detachedRoutines: number;
  removedRuns: number;
  removedRequestReceipts: number;
}

type RoutineRequestCommitFor<Action extends RoutineRequestOperation["action"]> =
  Omit<RoutineRequestCommit, "action"> & { action: Action };

export interface RoutineInput {
  name: string;
  prompt: string;
  botId: string;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  schedule: RoutineSchedule;
  durationMinutes?: number;
}

interface RoutineFile {
  version: 1;
  routines: Routine[];
  runs: RoutineRun[];
  /** Durable commit receipts for cross-file confirmation recovery. */
  routineRequestReceipts?: RoutineRequestReceipt[];
}

const routineRequestReceiptSchema = z.object({
  requestId: z.string(),
  messageId: z.string(),
  botId: z.string(),
  threadId: z.string(),
  action: z.enum(["create", "update", "pause", "resume", "run_now", "delete"]),
  fingerprintVersion: z.literal(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  resultId: z.string(),
  appliedAt: z.number().finite(),
});

const routineFileSchema = z.object({
  version: z.literal(1).optional(),
  routines: z.array(z.custom<Routine>()).optional(),
  runs: z.array(z.custom<RoutineRun>()).optional(),
  routineRequestReceipts: z.array(z.json()).optional(),
});

export type RoutineRequestOwner = Pick<RoutineRequestReceipt, "requestId" | "messageId" | "botId" | "threadId">;

function routineRequestOwnerKey(owner: RoutineRequestOwner): string {
  return JSON.stringify([owner.requestId, owner.messageId, owner.botId, owner.threadId]);
}

export interface RoutineManagerOptions {
  file?: string;
  now?: () => number;
  /** Keyed frames only: every payload on this bus is `{ kind, … }`, which
   * is what lets the server number and replay them. */
  emit?: (payload: RoutineEventFrame) => void;
  /** Assignment validation for create/update calls. Hidden/archived operators
   * may be disallowed here even if some existing detached work can still run. */
  botState: (botId: string) => "ready" | "busy" | "missing";
  /** Runtime eligibility for a specific queued run. Defaults to `botState`.
   * This lets webhooks keep using an existing hidden owner without letting
   * calendar definitions target archived operators again. */
  runBotState?: (run: Pick<RoutineRun, "botId" | "triggerSource">) => "ready" | "busy" | "missing";
  createTask: (botId: string, title: string, activate?: boolean) => { threadId: string } | null;
  startTurn: (
    botId: string,
    threadId: string,
    prompt: string,
    runOn: RoutineRunOn,
    triggerSource: RoutineRunTrigger,
    onDispatchError: (message: string) => void,
  ) => Promise<void>;
  interruptTurn?: (botId: string, threadId: string, runOn: RoutineRunOn) => Promise<void>;
  /** Projects every durable transition into the source conversation. */
  onRunChanged?: (run: RoutineRun) => void;
  onRunFailed?: (run: RoutineRun) => void;
}

export type RoutineEventFrame =
  | { kind: "routine.deleted"; routineId: string }
  | { kind: "routine"; routine: Routine }
  | { kind: "routine.run"; run: RoutineRun };

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const CATCH_UP_MS = 12 * 60 * 60_000;
const MAX_RUNS = 2_000;
const TERMINAL_RUN_STATUSES: RoutineRunStatus[] = ["completed", "failed", "cancelled", "missed"];

/** A caller supplied a cadence definition that cannot be applied.
 *
 * The HTTP boundary intentionally reads `status` from thrown values. Keeping
 * input failures typed here prevents a bad or stale operator selection from
 * being reported as an internal server failure while preserving the same
 * service contract for calendar, import, and chat-confirmation callers. */
export class RoutineInputError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "RoutineInputError";
  }
}

function invalidInput(message: string): never {
  throw new RoutineInputError(message);
}

function runtimeBotState(
  options: RoutineManagerOptions,
  run: Pick<RoutineRun, "botId" | "triggerSource">,
): "ready" | "busy" | "missing" {
  return options.runBotState?.(run) ?? options.botState(run.botId);
}

function cleanDays(days: JsonValue): number[] {
  const candidates = z.array(z.json()).safeParse(days);
  if (!candidates.success) return ALL_DAYS;
  const validDay = z.number().int().min(0).max(6);
  const out = [...new Set(candidates.data.flatMap((day) => {
    const parsed = validDay.safeParse(day);
    return parsed.success ? [parsed.data] : [];
  }))].sort();
  return out.length ? out : ALL_DAYS;
}

function cleanSchedule(schedule: RoutineSchedule): RoutineSchedule {
  if (schedule?.type === "once") {
    const at = Number(schedule.at);
    if (!Number.isFinite(at)) invalidInput("Choose a valid date and time");
    return { type: "once", at };
  }
  if (schedule?.type === "daily") {
    const time = String(schedule.time ?? "");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) invalidInput("Time must use HH:MM");
    return { type: "daily", time, weekdays: cleanDays(schedule.weekdays) };
  }
  invalidInput("Choose a supported schedule");
}

/** Next wall-clock occurrence in this computer's timezone, strictly after `after`. */
export function nextOccurrence(schedule: RoutineSchedule, after: number): number | null {
  if (schedule.type === "once") return schedule.at > after ? schedule.at : null;
  const [hour, minute] = schedule.time.split(":").map(Number);
  const weekdays = new Set(cleanDays(schedule.weekdays));
  for (let offset = 0; offset <= 8; offset++) {
    const d = new Date(after);
    d.setDate(d.getDate() + offset);
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() > after && weekdays.has(d.getDay())) return d.getTime();
  }
  return null;
}

function sanitizeInput(input: RoutineInput): Omit<Routine, "id" | "createdAt" | "updatedAt" | "nextRunAt"> {
  const name = String(input.name ?? "").trim().slice(0, 80);
  const prompt = String(input.prompt ?? "").trim().slice(0, 20_000);
  const botId = String(input.botId ?? "").trim();
  if (!name) invalidInput("Give the cadence a name");
  if (!prompt) invalidInput("Tell the operator what to do");
  if (!botId) invalidInput("Choose an operator");
  const runOn = input.runOn ?? "local";
  if (runOn !== "local" && runOn !== "cloud") invalidInput("Choose where this cadence runs");
  return {
    name,
    prompt,
    botId,
    runOn,
    enabled: input.enabled !== false,
    schedule: cleanSchedule(input.schedule),
    durationMinutes: Math.min(240, Math.max(15, Math.round(Number(input.durationMinutes) || 30))),
  };
}

export class RoutineManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: RoutineManagerOptions;
  private routines: Routine[] = [];
  private runs: RoutineRun[] = [];
  private routineRequestReceipts: RoutineRequestReceipt[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: RoutineManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "routines.json");
    ensurePrivateDirectory(dirname(this.file));
    repairPrivateFile(this.file);
    this.now = options.now ?? Date.now;
    try {
      const disk = routineFileSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
      this.routines = Array.isArray(disk.routines)
        ? disk.routines.map((routine) => ({
            ...routine,
            runOn: persistedRoutineRunOn(routine.runOn),
            sourceThreadId: persistedSourceThreadId.parse(routine.sourceThreadId),
          }))
        : [];
      this.runs = Array.isArray(disk.runs)
        ? disk.runs.map((run) => ({
            ...run,
            runOn: persistedRoutineRunOn(run.runOn),
            sourceThreadId: persistedSourceThreadId.parse(run.sourceThreadId),
          }))
        : [];
      this.routineRequestReceipts = (disk.routineRequestReceipts ?? []).flatMap((receipt) => {
        const parsed = routineRequestReceiptSchema.safeParse(receipt);
        return parsed.success ? [parsed.data] : [];
      });
    } catch (cause) {
      // Corruption here used to be indistinguishable from a first run: the
      // catch returned empty and the next save overwrote the original.
      // quarantineCorruptFile no-ops on a missing file, so a genuine first run
      // stays silent while real bytes are preserved and reported.
      quarantineCorruptFile(this.file, "", cause);
      this.routines = [];
      this.runs = [];
      this.routineRequestReceipts = [];
    }
    // A local process cannot still own these turns after a full restart.
    const recovered: RoutineRun[] = [];
    for (const run of this.runs) {
      if (run.status === "running" || run.status === "waiting") {
        run.status = "failed";
        run.error = "Helmryth restarted while this cadence was running";
        run.attention = undefined;
        run.finishedAt = this.now();
        recovered.push({ ...run });
      }
    }
    if (recovered.length > 0) {
      this.save();
      for (const run of recovered) {
        this.notifyRunChanged(run);
        this.options.onRunFailed?.(run);
      }
    }
  }

  listRoutines(): Routine[] {
    return this.routines.map((r) => ({ ...r, schedule: { ...r.schedule } }));
  }

  listRuns(from?: number, to?: number): RoutineRun[] {
    return this.runs
      .filter((r) => (from == null || r.scheduledFor >= from) && (to == null || r.scheduledFor <= to))
      .sort((a, b) => b.scheduledFor - a.scheduledFor)
      .map((r) => ({ ...r }));
  }

  activeRunForBot(botId: string): RoutineRun | null {
    const run = this.runs.find(
      (candidate) => candidate.botId === botId && ["running", "waiting"].includes(candidate.status),
    );
    return run ? { ...run } : null;
  }

  routineRequestReceipt(requestId: string): RoutineRequestReceipt | null {
    const receipt = this.routineRequestReceipts.find((candidate) => candidate.requestId === requestId);
    return receipt ? { ...receipt } : null;
  }

  /** Small startup index used to locate only transcripts that may need
   * cross-file commit recovery. Most launches have no receipts and therefore
   * do not read or cache any transcript for this feature. */
  routineRequestReceiptOwners(): RoutineRequestOwner[] {
    return this.routineRequestReceipts.map(({ requestId, messageId, botId, threadId }) => ({
      requestId,
      messageId,
      botId,
      threadId,
    }));
  }

  /** Once the transcript card is durably settled, its scheduler receipt is
   * redundant. Unsettled receipts are intentionally never count-evicted: an
   * actionable card may survive indefinitely and must retain its exact-once
   * recovery record for the same lifetime. */
  forgetRoutineRequestReceipt(request: RoutineRequestCommit): boolean {
    const receipt = this.matchingRoutineRequestReceipt(request);
    if (!receipt) return false;
    const index = this.routineRequestReceipts.indexOf(receipt);
    this.commitMutation(() => {
      this.routineRequestReceipts.splice(index, 1);
    });
    return true;
  }

  forgetRoutineRequestReceiptsForThread(threadId: string): number {
    const kept = this.routineRequestReceipts.filter((receipt) => receipt.threadId !== threadId);
    const removed = this.routineRequestReceipts.length - kept.length;
    if (removed === 0) return 0;
    this.commitMutation(() => {
      this.routineRequestReceipts = kept;
    });
    return removed;
  }

  /** Privacy erase for a deleted workstream. Cadence definitions remain
   * useful, but lose their reporting link; execution receipts and durable
   * confirmation receipts can contain thread-owned output and are removed. */
  eraseThreadData(threadId: string): RoutineThreadErasure {
    const detachedRoutines = this.routines.filter((routine) => routine.sourceThreadId === threadId).length;
    const keptRuns = this.runs.filter((run) => run.threadId !== threadId && run.sourceThreadId !== threadId);
    const removedRuns = this.runs.length - keptRuns.length;
    const keptReceipts = this.routineRequestReceipts.filter((receipt) => receipt.threadId !== threadId);
    const removedRequestReceipts = this.routineRequestReceipts.length - keptReceipts.length;
    if (detachedRoutines === 0 && removedRuns === 0 && removedRequestReceipts === 0) {
      return { detachedRoutines, removedRuns, removedRequestReceipts };
    }
    this.commitMutation(() => {
      for (const routine of this.routines) {
        if (routine.sourceThreadId === threadId) routine.sourceThreadId = undefined;
      }
      this.runs = keptRuns;
      this.routineRequestReceipts = keptReceipts;
    });
    return { detachedRoutines, removedRuns, removedRequestReceipts };
  }

  /** Drop only receipts whose confirmation transcript no longer exists.
   * Reachable open cards retain exact-once recovery for their full lifetime. */
  reconcileRoutineRequestReceipts(reachable: readonly RoutineRequestOwner[]): number {
    const keys = new Set(reachable.map(routineRequestOwnerKey));
    const kept = this.routineRequestReceipts.filter((receipt) => keys.has(routineRequestOwnerKey(receipt)));
    const removed = this.routineRequestReceipts.length - kept.length;
    if (removed === 0) return 0;
    this.commitMutation(() => {
      this.routineRequestReceipts = kept;
    });
    return removed;
  }

  isActiveThread(threadId: string): boolean {
    return this.runs.some(
      (run) => run.threadId === threadId && ["running", "waiting"].includes(run.status),
    );
  }

  create(
    input: RoutineInput,
    request?: RoutineRequestCommitFor<"create">,
    plannedId?: string,
  ): Routine {
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt) {
        const committed = this.routines.find((routine) => routine.id === receipt.resultId);
        if (committed) return { ...committed, schedule: { ...committed.schedule } };
        throw new Error("This cadence request was already applied");
      }
    }
    const clean = sanitizeInput(input);
    if (this.options.botState(clean.botId) === "missing") invalidInput("That operator no longer exists");
    const at = this.now();
    const routine: Routine = {
      id: plannedId ?? randomUUID(),
      ...clean,
      // Only a confirmed chat card supplies `request`; the public calendar
      // API cannot choose an arbitrary transcript as a reporting target.
      sourceThreadId: request?.threadId,
      nextRunAt: clean.enabled ? this.initialOccurrence(clean.schedule, at) : null,
      createdAt: at,
      updatedAt: at,
    };
    if (this.routines.some((candidate) => candidate.id === routine.id)) {
      throw new Error("Planned cadence identity is already in use");
    }
    this.commitMutation(() => {
      this.routines.unshift(routine);
      if (request) this.rememberRoutineRequest(request, routine.id, at);
    });
    this.emitRoutine(routine);
    return { ...routine, schedule: { ...routine.schedule } };
  }

  update(
    id: string,
    patch: Partial<RoutineInput>,
    request?: RoutineRequestCommitFor<"update" | "pause" | "resume">,
  ): Routine | null {
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt) {
        const committed = this.routines.find((routine) => routine.id === receipt.resultId);
        return committed ? { ...committed, schedule: { ...committed.schedule } } : null;
      }
    }
    const routine = this.routines.find((r) => r.id === id);
    if (!routine) return null;
    const now = this.now();
    const clean = sanitizeInput({
      name: patch.name ?? routine.name,
      prompt: patch.prompt ?? routine.prompt,
      botId: patch.botId ?? routine.botId,
      runOn: patch.runOn ?? routine.runOn,
      enabled: patch.enabled ?? routine.enabled,
      schedule: patch.schedule ?? routine.schedule,
      durationMinutes: patch.durationMinutes ?? routine.durationMinutes,
    });
    if (this.options.botState(clean.botId) === "missing") invalidInput("That operator no longer exists");
    const cancelledRuns: RoutineRun[] = [];
    this.commitMutation(() => {
      Object.assign(routine, clean, {
        nextRunAt: clean.enabled ? this.initialOccurrence(clean.schedule, now) : null,
        // `updatedAt` doubles as the optimistic revision on durable routine
        // confirmation cards. Keep it monotonic even for two writes in one ms.
        updatedAt: Math.max(now, routine.updatedAt + 1),
      });
      if (patch.enabled === false) {
        for (const run of this.runs) {
          if (run.routineId !== routine.id || run.status !== "queued") continue;
          run.status = "cancelled";
          run.attention = undefined;
          run.finishedAt = this.now();
          run.error = "The cadence was paused before this run started";
          cancelledRuns.push(run);
        }
      }
      if (request) this.rememberRoutineRequest(request, routine.id, now);
    });
    for (const run of cancelledRuns) this.emitRun(run);
    this.emitRoutine(routine);
    return { ...routine, schedule: { ...routine.schedule } };
  }

  remove(id: string, request?: RoutineRequestCommitFor<"delete">): boolean {
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt) {
        return true;
      }
    }
    const at = this.routines.findIndex((r) => r.id === id);
    if (at === -1) return false;
    const cancelledRuns: RoutineRun[] = [];
    this.commitMutation(() => {
      this.routines.splice(at, 1);
      for (const run of this.runs) {
        if (run.routineId !== id || run.status !== "queued") continue;
        run.status = "cancelled";
        run.attention = undefined;
        run.finishedAt = this.now();
        cancelledRuns.push(run);
      }
      if (request) this.rememberRoutineRequest(request, id, this.now());
    });
    for (const run of cancelledRuns) this.emitRun(run);
    this.options.emit?.({ kind: "routine.deleted", routineId: id });
    return true;
  }

  disableForBot(botId: string) {
    let changed = false;
    for (const routine of this.routines) {
      if (routine.botId !== botId || !routine.enabled) continue;
      routine.enabled = false;
      routine.nextRunAt = null;
      routine.updatedAt = Math.max(this.now(), routine.updatedAt + 1);
      this.emitRoutine(routine);
      changed = true;
    }
    for (const run of this.runs) {
      if (run.botId !== botId || !["queued", "running", "waiting"].includes(run.status)) continue;
      run.status = "cancelled";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = "The assigned operator was deleted";
      this.emitRun(run);
      if (run.threadId) void this.options.interruptTurn?.(run.botId, run.threadId, run.runOn ?? "local").catch(() => {});
      changed = true;
    }
    if (changed) this.save();
  }

  runNow(id: string, request?: RoutineRequestCommitFor<"run_now">): RoutineRun | null {
    if (request) {
      const receipt = this.matchingRoutineRequestReceipt(request);
      if (receipt) {
        const committed = this.runs.find((run) => run.id === receipt.resultId);
        return committed ? { ...committed } : null;
      }
    }
    const routine = this.routines.find((r) => r.id === id);
    if (!routine) return null;
    let run!: RoutineRun;
    this.commitMutation(() => {
      run = this.newRun(routine, this.now(), true);
      // A chat-confirmed "run now" reports back to the conversation that
      // invoked this one run. It must not silently rebind future schedules.
      if (request) run.sourceThreadId = request.threadId;
      if (request) this.rememberRoutineRequest(request, run.id, this.now());
    });
    this.emitRun(run);
    queueMicrotask(() => void this.tick());
    return { ...run };
  }

  /** Queue an event-driven job without inventing a calendar schedule. Webhook
   * definitions live in their own store; the execution receipt deliberately
   * reuses this manager so busy-bot ordering, task creation and VM routing stay
   * identical for every unattended job. */
  enqueueWebhook(input: {
    runId: string;
    webhookId: string;
    webhookName: string;
    prompt: string;
    botId: string;
    runOn: RoutineRunOn;
    deliveryId: string;
    receivedAt: number;
  }): RoutineRun {
    if (runtimeBotState(this.options, { botId: input.botId, triggerSource: "webhook" }) === "missing") {
      throw Object.assign(new Error("The assigned operator no longer exists"), { status: 410 });
    }
    const existing = this.runs.find(
      (candidate) => candidate.webhookId === input.webhookId && candidate.deliveryId === input.deliveryId,
    );
    if (existing) {
      if (existing.id !== input.runId) {
        throw new Error("Webhook delivery is already bound to another run id");
      }
      return { ...existing };
    }
    const run: RoutineRun = {
      id: input.runId,
      routineId: input.webhookId,
      routineName: input.webhookName,
      prompt: input.prompt,
      botId: input.botId,
      runOn: input.runOn,
      scheduledFor: input.receivedAt,
      status: "queued",
      manual: false,
      triggerSource: "webhook",
      webhookId: input.webhookId,
      deliveryId: input.deliveryId,
      createdAt: this.now(),
    };
    this.runs.push(run);
    this.trimRunsToMax();
    this.save();
    this.emitRun(run);
    queueMicrotask(() => void this.tick());
    return { ...run };
  }

  activeWebhookRunCount(webhookId: string): number {
    return this.runs.filter(
      (run) => run.webhookId === webhookId && ["queued", "running", "waiting"].includes(run.status),
    ).length;
  }

  cancelQueuedWebhook(webhookId: string, message: string): void {
    let changed = false;
    for (const run of this.runs) {
      if (run.webhookId !== webhookId || run.status !== "queued") continue;
      run.status = "cancelled";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = message.slice(0, 500);
      this.emitRun(run);
      changed = true;
    }
    if (changed) this.save();
  }

  async cancelRun(id: string): Promise<RoutineRun | null> {
    const run = this.runs.find((r) => r.id === id);
    if (!run || !["queued", "running", "waiting"].includes(run.status)) return null;
    run.status = "cancelled";
    run.attention = undefined;
    run.finishedAt = this.now();
    this.save();
    this.emitRun(run);
    if (run.threadId) await this.options.interruptTurn?.(run.botId, run.threadId, run.runOn ?? "local").catch(() => {});
    queueMicrotask(() => void this.tick());
    return { ...run };
  }

  markSeen(id: string): RoutineRun | null {
    const run = this.runs.find((r) => r.id === id);
    if (!run) return null;
    if (!run.seenAt) {
      run.seenAt = this.now();
      this.save();
      this.emitRun(run);
    }
    return { ...run };
  }

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 10_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      let changed = false;
      const missedRuns: RoutineRun[] = [];
      for (const routine of this.routines) {
        if (!routine.enabled || routine.nextRunAt == null || routine.nextRunAt > now) continue;
        const scheduledFor = routine.nextRunAt;
        const late = now - scheduledFor;
        if (late > CATCH_UP_MS) {
          const missed = this.newRun(routine, scheduledFor, false);
          missed.status = "missed";
          missed.finishedAt = now;
          missed.error = "This Workbench was offline for more than 12 hours after the scheduled time";
          this.emitRun(missed);
          missedRuns.push({ ...missed });
        } else {
          const run = this.newRun(routine, scheduledFor, false);
          this.emitRun(run);
        }
        routine.nextRunAt =
          routine.schedule.type === "once" ? null : nextOccurrence(routine.schedule, Math.max(now, scheduledFor));
        if (routine.schedule.type === "once") routine.enabled = false;
        routine.updatedAt = Math.max(now, routine.updatedAt + 1);
        this.emitRoutine(routine);
        changed = true;
      }
      if (changed) this.save();
      for (const missed of missedRuns) this.options.onRunFailed?.(missed);

      for (const run of [...this.runs].reverse()) {
        if (run.status !== "queued") continue;
        const state = runtimeBotState(this.options, run);
        if (state === "busy") continue;
        if (state === "missing") {
          this.failRun(run, "The assigned operator no longer exists");
          continue;
        }
        // A webhook is an incoming message, so make its task the bot's live
        // chat immediately. Scheduled work remains detached and unobtrusive.
        const task = this.options.createTask(run.botId, run.routineName, run.triggerSource === "webhook");
        if (!task) {
          this.failRun(run, "Could not create a workstream for this run");
          continue;
        }
        run.threadId = task.threadId;
        run.startedAt = this.now();
        run.status = "running";
        this.save();
        this.emitRun(run);
        try {
          const prompt = run.prompt ?? this.routines.find((r) => r.id === run.routineId)?.prompt;
          if (!prompt) {
            this.failThread(task.threadId, "The cadence was deleted before it could start");
            continue;
          }
          const triggerSource = run.triggerSource ?? (run.manual ? "manual" : "schedule");
          await this.options.startTurn(
            run.botId,
            task.threadId,
            prompt,
            run.runOn ?? "local",
            triggerSource,
            (message) => this.failThread(task.threadId, message),
          );
        } catch (error) {
          this.failThread(task.threadId, error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  handleRuntimeEvent(event: RuntimeEvent): RoutineRun | null {
    const run = this.runs.find((r) => r.threadId === event.threadId && ["running", "waiting"].includes(r.status));
    if (!run) return null;
    if (event.type === "request.opened") {
      run.status = "waiting";
      run.attention = redactSecretsInText(event.summary).trim().slice(0, 500) || undefined;
    } else if (event.type === "request.resolved") {
      run.status = "running";
      run.attention = undefined;
    } else if (event.type === "item.completed" && event.itemType === "assistant_text") {
      run.output = redactSecretsInText(event.text).trim().slice(0, 2_000);
    } else if (event.type === "runtime.error") {
      // Routine receipts are product UI, not diagnostic storage. The full
      // redacted diagnostic remains available in the workstream's Trace log.
      run.error = presentRuntimeError(event.message, event.setup).message;
    } else if (event.type === "turn.retrying") {
      // the driver will relaunch this same run; a transient blip is not a
      // receipt-worthy failure, so keep the run running and stay quiet
      return null;
    } else if (event.type === "turn.completed") {
      run.cost = event.cost;
      run.denials = event.denials;
      if (!event.ok) {
        const failure = run.error
          ?? presentRuntimeError(event.stopReason ?? "The operator did not complete this run").message;
        this.failRun(run, failure);
        queueMicrotask(() => void this.tick());
        return { ...run };
      }
      run.status = "completed";
      run.attention = undefined;
      run.finishedAt = this.now();
      run.error = undefined;
    } else {
      return null;
    }
    this.save();
    this.emitRun(run);
    if (event.type === "turn.completed") queueMicrotask(() => void this.tick());
    return { ...run };
  }

  failThread(threadId: string, message: string) {
    const run = this.runs.find((r) => r.threadId === threadId && ["running", "waiting"].includes(r.status));
    if (!run) return;
    this.failRun(run, message);
    queueMicrotask(() => void this.tick());
  }

  private failRun(run: RoutineRun, message: string) {
    run.status = "failed";
    run.attention = undefined;
    run.error = redactSecretsInText(message).slice(0, 500);
    run.finishedAt = this.now();
    this.save();
    this.emitRun(run);
    this.options.onRunFailed?.({ ...run });
  }

  private initialOccurrence(schedule: RoutineSchedule, now: number): number | null {
    // Return the original time, not max(at, now): tick() already decides
    // whether a stale "once" run fires or is recorded as "missed" based on
    // how far past the scheduled time it is. Clamping to now here hides the
    // original schedule from the run receipt (scheduledFor would read "now"
    // instead of the time the user chose) and prevents the 12-hour missed
    // threshold from ever triggering for a "once" routine created late.
    if (schedule.type === "once") return schedule.at;
    return nextOccurrence(schedule, now);
  }

  private newRun(routine: Routine, scheduledFor: number, manual: boolean): RoutineRun {
    const run: RoutineRun = {
      id: randomUUID(),
      routineId: routine.id,
      routineName: routine.name,
      prompt: routine.prompt,
      durationMinutes: routine.durationMinutes,
      botId: routine.botId,
      runOn: routine.runOn ?? "local",
      scheduledFor,
      status: "queued",
      manual,
      triggerSource: manual ? "manual" : "schedule",
      sourceThreadId: routine.sourceThreadId,
      createdAt: this.now(),
    };
    this.runs.push(run);
    this.trimRunsToMax();
    return run;
  }

  private trimRunsToMax() {
    let overflow = this.runs.length - MAX_RUNS;
    if (overflow <= 0) return;

    const evict = (predicate: (run: RoutineRun) => boolean) => {
      for (let index = 0; index < this.runs.length && overflow > 0;) {
        if (!predicate(this.runs[index]!)) {
          index += 1;
          continue;
        }
        this.runs.splice(index, 1);
        overflow -= 1;
      }
    };

    evict((run) => TERMINAL_RUN_STATUSES.includes(run.status));
    evict((run) => run.status === "queued");
    evict((run) => run.status === "running" || run.status === "waiting");
  }

  private emitRoutine(routine: Routine) {
    this.options.emit?.({ kind: "routine", routine: { ...routine, schedule: { ...routine.schedule } } });
  }

  private emitRun(run: RoutineRun) {
    this.options.emit?.({ kind: "routine.run", run: { ...run } });
    this.notifyRunChanged(run);
  }

  private notifyRunChanged(run: RoutineRun) {
    try {
      this.options.onRunChanged?.({ ...run });
    } catch (error) {
      // Reporting is secondary to scheduler truth. A transcript write must
      // never strand the run in memory or prevent the next tick.
      console.error("cadence: source-workstream lifecycle update failed", error);
    }
  }

  private matchingRoutineRequestReceipt(request: RoutineRequestCommit): RoutineRequestReceipt | null {
    const receipt = this.routineRequestReceipts.find((candidate) => candidate.requestId === request.requestId);
    if (!receipt) return null;
    if (
      receipt.action !== request.action ||
      receipt.messageId !== request.messageId ||
      receipt.botId !== request.botId ||
      receipt.threadId !== request.threadId ||
      receipt.fingerprintVersion !== request.fingerprintVersion ||
      receipt.fingerprint !== request.fingerprint
    ) {
      throw new Error("Cadence request receipt does not match this gate");
    }
    return receipt;
  }

  private rememberRoutineRequest(
    request: RoutineRequestCommit,
    resultId: string,
    appliedAt: number,
  ) {
    const existing = this.matchingRoutineRequestReceipt(request);
    if (existing) {
      if (existing.resultId !== resultId) throw new Error("Cadence request receipt has another result");
      return;
    }
    this.routineRequestReceipts.unshift({ ...request, resultId, appliedAt });
  }

  /**
   * A confirmation receipt is only true once the scheduler mutation and its
   * receipt reached the same atomic file. Restore the complete in-memory
   * state if writing or renaming that file fails so a retry cannot mistake an
   * uncommitted action for a durable one.
   */
  private commitMutation(mutate: () => void): void {
    const before = {
      routines: this.routines.map((routine) => ({ ...routine, schedule: { ...routine.schedule } })),
      runs: this.runs.map((run) => ({ ...run, denials: run.denials ? [...run.denials] : undefined })),
      receipts: this.routineRequestReceipts.map((receipt) => ({ ...receipt })),
    };
    try {
      mutate();
      this.save();
    } catch (error) {
      this.routines = before.routines;
      this.runs = before.runs;
      this.routineRequestReceipts = before.receipts;
      throw error;
    }
  }

  private save() {
    ensurePrivateDirectory(dirname(this.file));
    writeFileAtomic(
      this.file,
      JSON.stringify({
        version: 1,
        routines: this.routines,
        runs: this.runs,
        routineRequestReceipts: this.routineRequestReceipts,
      } satisfies RoutineFile, null, 2),
      { mode: 0o600 },
    );
  }
}
