import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  nextOccurrence,
  RoutineInputError,
  RoutineManager,
  type RoutineManagerOptions,
  type RoutineSchedule,
} from "./routines.ts";

const dirs: string[] = [];

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "hry-routines-"));
  dirs.push(dir);
  return join(dir, "routines.json");
}

function harness(start = new Date(2026, 7, 17, 8, 0, 0).getTime()) {
  let now = start;
  let bot: "ready" | "busy" | "missing" = "ready";
  let runBotState:
    | ((run: { botId: string; triggerSource?: "schedule" | "manual" | "webhook" }) => "ready" | "busy" | "missing")
    | undefined;
  let task = 0;
  const started: Array<{ botId: string; threadId: string; prompt: string }> = [];
  const runOns: string[] = [];
  const triggerSources: string[] = [];
  const taskActivations: boolean[] = [];
  const emitted: any[] = [];
  const changed: any[] = [];
  const failed: any[] = [];
  const options: RoutineManagerOptions = {
    file: tempFile(),
    now: () => now,
    emit: (payload) => emitted.push(payload),
    botState: () => bot,
    runBotState: (run) => runBotState?.(run) ?? bot,
    createTask: (_botId, _title, activate = false) => {
      taskActivations.push(activate);
      return { threadId: `thread-${++task}` };
    },
    startTurn: async (botId, threadId, prompt, runOn, triggerSource) => {
      started.push({ botId, threadId, prompt });
      runOns.push(runOn);
      triggerSources.push(triggerSource);
    },
    onRunChanged: (run) => changed.push(run),
    onRunFailed: (run) => failed.push(run),
  };
  const manager = new RoutineManager(options);
  return {
    manager,
    options,
    emitted,
    started,
    runOns,
    triggerSources,
    taskActivations,
    changed,
    failed,
    setNow: (value: number) => (now = value),
    setBot: (value: typeof bot) => (bot = value),
    setRunBotState: (value: typeof runBotState) => (runBotState = value),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("nextOccurrence", () => {
  it("finds the next selected weekday in local wall-clock time", () => {
    const monday = new Date(2026, 7, 17, 10, 0, 0).getTime();
    const next = nextOccurrence({ type: "daily", time: "09:30", weekdays: [1, 3] }, monday)!;
    const d = new Date(next);
    expect(d.getDay()).toBe(3);
    expect([d.getHours(), d.getMinutes()]).toEqual([9, 30]);
  });

  it("returns a one-off only while it is still in the future", () => {
    expect(nextOccurrence({ type: "once", at: 200 }, 100)).toBe(200);
    expect(nextOccurrence({ type: "once", at: 100 }, 100)).toBeNull();
  });
});

describe("RoutineManager", () => {
  it("persists definitions separately from permanent run receipts", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Morning brief",
      prompt: "Summarize what changed",
      botId: "sigil-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 5).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    const routineFile = h.options.file;
    if (!routineFile) throw new Error("test harness did not configure routine persistence");
    let failureWasPersistedBeforeCallback = false;
    h.options.onRunFailed = (run) => {
      h.failed.push(run);
      failureWasPersistedBeforeCallback = readFileSync(routineFile, "utf8").includes('"status": "failed"');
    };
    const reloaded = new RoutineManager(h.options);
    expect(reloaded.listRoutines()).toHaveLength(1);
    expect(reloaded.listRuns()).toMatchObject([
      { routineId: routine.id, routineName: "Morning brief", status: "failed", threadId: "thread-1" },
    ]);
    // Reload recovery truthfully marks an in-process run as interrupted.
    expect(reloaded.listRuns()[0]!.error).toContain("restarted");
    expect(failureWasPersistedBeforeCallback).toBe(true);
    expect(h.failed).toMatchObject([
      {
        routineId: routine.id,
        routineName: "Morning brief",
        status: "failed",
        threadId: "thread-1",
        error: "Helmryth restarted while this cadence was running",
      },
    ]);
  });

  it("persists confirmation receipts with the scheduler mutation and removes them after settlement", () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Before",
      prompt: "Review the queue",
      botId: "sigil-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });
    const request = {
      requestId: "request-update-1",
      messageId: "message-1",
      botId: "sigil-1",
      threadId: "thread-1",
      action: "update" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "a".repeat(64),
    };
    h.manager.update(routine.id, { name: "After" }, request);

    const reloaded = new RoutineManager(h.options);
    expect(reloaded.routineRequestReceipt(request.requestId)).toMatchObject({
      ...request,
      resultId: routine.id,
    });
    expect(reloaded.routineRequestReceiptOwners()).toEqual([{
      requestId: request.requestId,
      messageId: request.messageId,
      botId: request.botId,
      threadId: request.threadId,
    }]);
    expect(() => reloaded.update(routine.id, { name: "Never applied" }, {
      ...request,
      fingerprint: "b".repeat(64),
    })).toThrow(/does not match/);
    expect(reloaded.listRoutines()[0]!.name).toBe("After");

    expect(reloaded.reconcileRoutineRequestReceipts([request])).toBe(0);
    expect(reloaded.forgetRoutineRequestReceipt(request)).toBe(true);
    expect(new RoutineManager(h.options).routineRequestReceipt(request.requestId)).toBeNull();
  });

  it("persists trusted chat provenance and snapshots it onto detached runs", async () => {
    const h = harness();
    const request = {
      requestId: "request-source-thread",
      messageId: "message-source-thread",
      botId: "sigil-1",
      threadId: "conversation-that-created-it",
      action: "create" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "e".repeat(64),
    };
    const routine = h.manager.create({
      name: "Source report",
      prompt: "Summarize the queue",
      botId: "sigil-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 5).getTime() },
    }, request);

    expect(routine.sourceThreadId).toBe(request.threadId);
    const reloaded = new RoutineManager(h.options);
    expect(reloaded.listRoutines()[0]?.sourceThreadId).toBe(request.threadId);

    h.setNow(routine.nextRunAt!);
    await reloaded.tick();
    const run = reloaded.listRuns()[0]!;
    expect(run).toMatchObject({
      sourceThreadId: request.threadId,
      threadId: "thread-1",
      status: "running",
    });
    expect(run.threadId).not.toBe(run.sourceThreadId);
    expect(h.changed.map(({ status, sourceThreadId, threadId }) => ({ status, sourceThreadId, threadId })))
      .toEqual([
        { status: "queued", sourceThreadId: request.threadId, threadId: undefined },
        { status: "running", sourceThreadId: request.threadId, threadId: "thread-1" },
      ]);
  });

  it("does not trust a calendar payload to choose another conversation", () => {
    const h = harness();
    const schedule: RoutineSchedule = { type: "daily", time: "09:00", weekdays: [1] };
    const calendarPayload = {
      name: "Calendar-owned",
      prompt: "Run without a chat source",
      botId: "sigil-1",
      schedule,
      sourceThreadId: "forged-thread",
    };
    const routine = h.manager.create(calendarPayload);
    expect(routine.sourceThreadId).toBeUndefined();
  });

  it("keeps routine history when a persisted source thread is malformed", () => {
    const h = harness();
    const request = {
      requestId: "request-malformed-source",
      messageId: "message-malformed-source",
      botId: "sigil-1",
      threadId: "trusted-source",
      action: "create" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "2".repeat(64),
    };
    h.manager.create({
      name: "Survives malformed provenance",
      prompt: "Keep this routine",
      botId: "sigil-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    }, request);
    const file = h.options.file;
    if (!file) throw new Error("test harness did not configure routine persistence");
    const stored = readFileSync(file, "utf8");
    const malformed = stored.replace(`"sourceThreadId": "${request.threadId}"`, '"sourceThreadId": 42');
    expect(malformed).not.toBe(stored);
    writeFileSync(file, malformed);

    const reloaded = new RoutineManager(h.options);
    expect(reloaded.listRoutines()).toMatchObject([{
      name: "Survives malformed provenance",
      sourceThreadId: undefined,
    }]);
  });

  it("reports a chat-confirmed run-now to its invoking thread without rebinding the routine", () => {
    const h = harness();
    const createRequest = {
      requestId: "request-create-origin",
      messageId: "message-create-origin",
      botId: "sigil-1",
      threadId: "original-thread",
      action: "create" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "f".repeat(64),
    };
    const routine = h.manager.create({
      name: "Daily source",
      prompt: "Review it",
      botId: "sigil-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    }, createRequest);
    const runRequest = {
      ...createRequest,
      requestId: "request-run-now-elsewhere",
      messageId: "message-run-now-elsewhere",
      threadId: "invoking-thread",
      action: "run_now" as const,
      fingerprint: "1".repeat(64),
    };

    const run = h.manager.runNow(routine.id, runRequest)!;
    expect(run.sourceThreadId).toBe("invoking-thread");
    expect(h.manager.listRoutines()[0]?.sourceThreadId).toBe("original-thread");
  });

  it("removes unreachable recovery receipts when their conversation is deleted", () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Cleanup",
      prompt: "Clean unreachable confirmations",
      botId: "sigil-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });
    const request = {
      requestId: "request-orphaned-thread",
      messageId: "message-orphaned-thread",
      botId: "sigil-1",
      threadId: "thread-deleted",
      action: "pause" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "d".repeat(64),
    };
    h.manager.update(routine.id, { enabled: false }, request);

    expect(h.manager.forgetRoutineRequestReceiptsForThread("another-thread")).toBe(0);
    expect(h.manager.forgetRoutineRequestReceiptsForThread("thread-deleted")).toBe(1);
    expect(new RoutineManager(h.options).routineRequestReceipt(request.requestId)).toBeNull();
  });

  it("rolls back an uncommitted confirmation when the atomic file write fails", () => {
    const h = harness();
    const file = h.options.file!;
    // A directory at the destination makes the final atomic rename fail
    // after the temporary file has been written.
    mkdirSync(file);
    const request = {
      requestId: "request-create-write-failure",
      messageId: "message-write-failure",
      botId: "sigil-1",
      threadId: "thread-1",
      action: "create" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "c".repeat(64),
    };
    const input = {
      name: "Retry safely",
      prompt: "Check the queue",
      botId: "sigil-1",
      schedule: { type: "daily" as const, time: "09:00", weekdays: [1] },
    };

    expect(() => h.manager.create(input, request)).toThrow();
    expect(h.manager.listRoutines()).toEqual([]);
    expect(h.manager.routineRequestReceipt(request.requestId)).toBeNull();
    expect(h.emitted).toEqual([]);

    rmSync(file, { recursive: true, force: true });
    rmSync(`${file}.tmp`, { force: true });
    const routine = h.manager.create(input, request);
    expect(h.manager.listRoutines()).toHaveLength(1);
    expect(h.manager.routineRequestReceipt(request.requestId)).toMatchObject({
      ...request,
      resultId: routine.id,
    });
  });

  it("rejects missing and malformed create targets as client input without persistence or events", () => {
    const h = harness();
    const valid = {
      name: "Stale assignment",
      prompt: "Review the queue",
      botId: "removed-operator",
      schedule: { type: "daily" as const, time: "09:00", weekdays: [1] },
    };

    h.setBot("missing");
    expect(() => h.manager.create(valid)).toThrowError(RoutineInputError);
    try {
      h.manager.create(valid);
    } catch (error) {
      expect(error).toMatchObject({
        status: 400,
        message: "That operator no longer exists",
      });
    }

    h.setBot("ready");
    expect(() => h.manager.create({ ...valid, botId: " " })).toThrowError(RoutineInputError);
    try {
      h.manager.create({ ...valid, botId: " " });
    } catch (error) {
      expect(error).toMatchObject({ status: 400, message: "Choose an operator" });
    }
    expect(() => h.manager.create({
      ...valid,
      botId: "operator-1",
      schedule: { type: "daily", time: "25:61", weekdays: [1] },
    })).toThrowError(RoutineInputError);
    try {
      h.manager.create({
        ...valid,
        botId: "operator-1",
        schedule: { type: "daily", time: "25:61", weekdays: [1] },
      });
    } catch (error) {
      expect(error).toMatchObject({ status: 400, message: "Time must use HH:MM" });
    }

    expect(h.manager.listRoutines()).toEqual([]);
    expect(h.emitted).toEqual([]);
    expect(new RoutineManager(h.options).listRoutines()).toEqual([]);
  });

  it("rejects missing and malformed update targets without changing durable state or emitting", () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Keep this definition",
      prompt: "Keep these instructions",
      botId: "operator-1",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });
    const before = readFileSync(h.options.file!, "utf8");
    const emittedBefore = [...h.emitted];

    h.setBot("missing");
    expect(() => h.manager.update(routine.id, {
      name: "Must not persist",
      botId: "removed-operator",
    })).toThrowError(RoutineInputError);
    try {
      h.manager.update(routine.id, { botId: "removed-operator" });
    } catch (error) {
      expect(error).toMatchObject({
        status: 400,
        message: "That operator no longer exists",
      });
    }

    h.setBot("ready");
    expect(() => h.manager.update(routine.id, { name: " " })).toThrowError(RoutineInputError);
    try {
      h.manager.update(routine.id, { name: " " });
    } catch (error) {
      expect(error).toMatchObject({ status: 400, message: "Give the cadence a name" });
    }

    expect(h.manager.listRoutines()).toEqual([routine]);
    expect(h.emitted).toEqual(emittedBefore);
    expect(readFileSync(h.options.file!, "utf8")).toBe(before);
    expect(new RoutineManager(h.options).listRoutines()).toEqual([routine]);
  });

  it("queues behind a busy bot, then dispatches into a detached task", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "Review queue",
      prompt: "Review the queue",
      botId: "sigil-2",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
      durationMinutes: 45,
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]!.status).toBe("queued");
    expect(h.started).toHaveLength(0);

    h.setBot("ready");
    await h.manager.tick();
    expect(h.started).toEqual([{ botId: "sigil-2", threadId: "thread-1", prompt: "Review the queue" }]);
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "running", threadId: "thread-1" });
    expect(h.manager.activeRunForBot("sigil-2")?.threadId).toBe("thread-1");
    expect(h.manager.isActiveThread("thread-1")).toBe(true);
    expect(h.taskActivations).toEqual([false]);
  });

  it("cancels queued work when a routine is paused", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "Pauseable check",
      prompt: "Check later",
      botId: "sigil-2",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    h.manager.update(routine.id, { enabled: false });
    h.setBot("ready");
    await h.manager.tick();

    expect(h.manager.listRuns()[0]).toMatchObject({ status: "cancelled" });
    expect(h.started).toHaveLength(0);
  });

  it("snapshots queued instructions so later edits do not rewrite a receipt", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "Original brief",
      prompt: "Use the original instructions",
      botId: "sigil-2",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.manager.update(routine.id, { name: "Edited brief", prompt: "Use the new instructions" });

    h.setBot("ready");
    await h.manager.tick();

    expect(h.started[0]?.prompt).toBe("Use the original instructions");
    expect(h.manager.listRuns()[0]).toMatchObject({
      routineName: "Original brief",
      prompt: "Use the original instructions",
    });
  });

  it("snapshots and dispatches the selected execution machine", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "VM review",
      prompt: "Review the project on the virtual machine",
      botId: "sigil-cloud",
      runOn: "cloud",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.manager.update(routine.id, { runOn: "local" });

    h.setBot("ready");
    await h.manager.tick();

    expect(h.runOns).toEqual(["cloud"]);
    expect(h.manager.listRuns()[0]).toMatchObject({ runOn: "cloud" });
    expect(h.manager.listRoutines()[0]).toMatchObject({ runOn: "local" });
  });

  it("opens webhook jobs in the assigned bot's live chat", async () => {
    const h = harness();
    const receivedAt = new Date(2026, 7, 17, 8, 2).getTime();
    const queued = h.manager.enqueueWebhook({
      runId: "webhook-run-1",
      webhookId: "hook-1",
      webhookName: "New ticket",
      prompt: "Handle ticket 42",
      botId: "sigil-webhook",
      runOn: "cloud",
      deliveryId: "delivery-42",
      receivedAt,
    });
    await h.manager.tick();

    expect(queued).toMatchObject({
      routineId: "hook-1",
      webhookId: "hook-1",
      deliveryId: "delivery-42",
      triggerSource: "webhook",
      scheduledFor: receivedAt,
    });
    expect(queued).not.toHaveProperty("durationMinutes");
    expect(h.started).toEqual([{ botId: "sigil-webhook", threadId: "thread-1", prompt: "Handle ticket 42" }]);
    expect(h.runOns).toEqual(["cloud"]);
    expect(h.triggerSources).toEqual(["webhook"]);
    expect(h.taskActivations).toEqual([true]);
  });

  it("lets an existing webhook owner run even when cadence assignment treats it as archived", async () => {
    const h = harness();
    const receivedAt = new Date(2026, 7, 17, 8, 2).getTime();
    h.setBot("missing");
    h.setRunBotState((run) => run.triggerSource === "webhook" ? "ready" : "missing");

    const queued = h.manager.enqueueWebhook({
      runId: "webhook-run-hidden-owner",
      webhookId: "hook-hidden-owner",
      webhookName: "Archived owner webhook",
      prompt: "Handle the archived-owner event",
      botId: "archived-operator",
      runOn: "local",
      deliveryId: "delivery-hidden-owner",
      receivedAt,
    });
    await h.manager.tick();

    expect(queued).toMatchObject({
      id: "webhook-run-hidden-owner",
      status: "queued",
      triggerSource: "webhook",
    });
    expect(h.started).toEqual([{ botId: "archived-operator", threadId: "thread-1", prompt: "Handle the archived-owner event" }]);
    expect(h.triggerSources).toEqual(["webhook"]);
    expect(h.taskActivations).toEqual([true]);
    expect(h.failed).toEqual([]);
    expect(h.manager.listRuns()[0]).toMatchObject({
      id: "webhook-run-hidden-owner",
      status: "running",
      triggerSource: "webhook",
      threadId: "thread-1",
    });
  });

  it("replays the same webhook delivery idempotently in memory and after restart", () => {
    const h = harness();
    h.setBot("busy");
    const input = {
      runId: "webhook-run-stable",
      webhookId: "hook-stable",
      webhookName: "Stable delivery",
      prompt: "Handle the event once",
      botId: "sigil-webhook",
      runOn: "local" as const,
      deliveryId: "delivery-stable",
      receivedAt: new Date(2026, 7, 17, 8, 3).getTime(),
    };

    expect(h.manager.enqueueWebhook(input).id).toBe(input.runId);
    expect(h.manager.enqueueWebhook(input).id).toBe(input.runId);
    expect(h.manager.listRuns().filter((run) => run.deliveryId === input.deliveryId)).toHaveLength(1);
    if (process.platform !== "win32" && h.options.file) {
      expect(statSync(h.options.file).mode & 0o777).toBe(0o600);
      chmodSync(h.options.file, 0o644);
      const permissionsRestart = new RoutineManager(h.options);
      expect(permissionsRestart.listRuns().some((run) => run.id === input.runId)).toBe(true);
      expect(statSync(h.options.file).mode & 0o777).toBe(0o600);
    }

    const restarted = new RoutineManager(h.options);
    expect(restarted.enqueueWebhook(input).id).toBe(input.runId);
    expect(restarted.listRuns().filter((run) => run.deliveryId === input.deliveryId)).toHaveLength(1);
    expect(() => restarted.enqueueWebhook({ ...input, runId: "different-run" })).toThrow("another run id");
  });

  it("retains a running cadence when the 2000-run history bound overflows", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "History bound",
      prompt: "Keep the active run visible",
      botId: "sigil-history",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    });

    const active = h.manager.runNow(routine.id)!;
    await h.manager.tick();
    h.setBot("busy");

    const created: string[] = [];
    for (let i = 0; i < 2_005; i += 1) created.push(h.manager.runNow(routine.id)!.id);

    const runs = h.manager.listRuns().filter((run) => run.routineId === routine.id);
    expect(runs).toHaveLength(2_000);
    expect(runs.find((run) => run.id === active.id)?.status).toBe("running");
    expect(runs.some((run) => run.id === created[0])).toBe(false);
    expect(runs.some((run) => run.id === created.at(-1))).toBe(true);
    expect(runs.filter((run) => run.status === "queued")).toHaveLength(1_999);
    // Two thousand runs, each persisted through writeFileAtomic — a write and
    // a rename apiece. That is comfortably inside Vitest's default 20 s on a
    // developer machine and not on an NTFS CI runner, where it timed out.
    // Nothing is wrong with the code under test; the bound being exercised is
    // simply large. Same reasoning as the SSE back-pressure case in
    // index-resilience.test.ts, which carries 240 s for a kernel-buffer
    // difference between Linux and macOS.
  }, 120_000);

  it("folds provider lifecycle events into the calendar receipt", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Ship report",
      prompt: "Write the report",
      botId: "sigil-3",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    const base = {
      eventId: "event-1",
      provider: "fake",
      threadId: "thread-1",
      createdAt: new Date(h.manager.listRuns()[0]!.startedAt!).toISOString(),
    };
    const secret = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    h.manager.handleRuntimeEvent({
      ...base,
      type: "request.opened",
      requestType: "question",
      tool: "ask",
      summary: `Choose the two actions before using ${secret}`,
    });
    expect(h.manager.listRuns()[0]).toMatchObject({
      status: "waiting",
      attention: expect.stringContaining("Choose the two actions"),
    });
    expect(h.manager.listRuns()[0]!.attention).not.toContain(secret);
    h.manager.handleRuntimeEvent({ ...base, type: "request.resolved", behavior: "answer", source: "user" });
    expect(h.manager.listRuns()[0]!.attention).toBeUndefined();
    h.manager.handleRuntimeEvent({ ...base, type: "item.completed", itemType: "assistant_text", text: "Report shipped." });
    h.manager.handleRuntimeEvent({ ...base, type: "turn.completed", ok: true, cost: 0.02 });

    expect(h.manager.listRuns()[0]).toMatchObject({
      status: "completed",
      output: "Report shipped.",
      cost: 0.02,
    });
  });

  it("reports a failed run once with its detached thread", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Broken report",
      prompt: "Write the report",
      botId: "sigil-failed",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    h.manager.handleRuntimeEvent({
      eventId: "failed",
      provider: "fake",
      threadId: "thread-1",
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      ok: false,
      stopReason: "provider crashed",
    });

    expect(h.failed).toMatchObject([
      {
        routineName: "Broken report",
        botId: "sigil-failed",
        threadId: "thread-1",
        status: "failed",
        error: "The engine stopped before completing this run. Try again, or open Trace for technical details.",
      },
    ]);
    expect(h.manager.listRuns()[0]).toMatchObject({ threadId: "thread-1", status: "failed" });

    h.manager.markSeen(h.failed[0].id);
    expect(h.failed).toHaveLength(1);
  });

  it("keeps provider diagnostics out of routine failure receipts", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Private model report",
      prompt: "Write the report",
      botId: "sigil-private-error",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    const event = {
      eventId: "private-error",
      provider: "fake",
      threadId: "thread-1",
      createdAt: new Date().toISOString(),
    };

    h.manager.handleRuntimeEvent({
      ...event,
      type: "runtime.error",
      message: "upstream HTTP 404: model private-preview-2026 does not exist",
    });
    h.manager.handleRuntimeEvent({ ...event, type: "turn.completed", ok: false, stopReason: "provider_error" });

    const [failed] = h.failed;
    expect(failed.error).toBe(
      "This engine rejected the current run configuration. Review its engine settings, then try again.",
    );
    expect(failed.error).not.toMatch(/HTTP|private-preview|404/i);
  });

  it("keeps recurring history while advancing the definition", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Daily check",
      prompt: "Check it",
      botId: "sigil-4",
      schedule: { type: "daily", time: "08:05", weekdays: [1, 2, 3, 4, 5] },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.manager.handleRuntimeEvent({
      eventId: "done",
      provider: "fake",
      threadId: "thread-1",
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      ok: true,
    });

    expect(h.manager.listRuns()).toHaveLength(1);
    expect(h.manager.listRoutines()[0]!.nextRunAt).toBeGreaterThan(routine.nextRunAt!);
  });

  it("records a missed receipt instead of launching very stale work", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Old check",
      prompt: "Do the old thing",
      botId: "sigil-5",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt! + 13 * 60 * 60_000);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "missed" });
    expect(h.started).toHaveLength(0);
    expect(h.failed).toMatchObject([{ id: h.manager.listRuns()[0]!.id, status: "missed" }]);
  });

  it("records a missed receipt for a once routine created with a long-past time", async () => {
    const h = harness();
    const staleAt = new Date(2026, 7, 16, 6, 0, 0).getTime();
    const routine = h.manager.create({
      name: "Stale check",
      prompt: "Do the stale thing",
      botId: "sigil-6",
      schedule: { type: "once", at: staleAt },
    });
    expect(routine.nextRunAt).toBe(staleAt);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "missed", scheduledFor: staleAt });
    expect(h.started).toHaveLength(0);
  });

  it("runs a once routine created slightly late and records the original scheduled time", async () => {
    const h = harness();
    const lateAt = new Date(2026, 7, 17, 7, 55, 0).getTime();
    const routine = h.manager.create({
      name: "Late check",
      prompt: "Do the late thing",
      botId: "sigil-7",
      schedule: { type: "once", at: lateAt },
    });
    expect(routine.nextRunAt).toBe(lateAt);
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "running", scheduledFor: lateAt });
  });

  it("erases a thread's run/request receipts while detaching surviving cadence definitions", () => {
    const h = harness();
    const request = {
      requestId: "request-owned",
      messageId: "message-owned",
      botId: "sigil-1",
      threadId: "thread-owned",
      action: "create" as const,
      fingerprintVersion: 1 as const,
      fingerprint: "a".repeat(64),
    };
    const owned = h.manager.create({
      name: "Owned",
      prompt: "Do owned work",
      botId: "sigil-1",
      schedule: { type: "once", at: Date.now() + 60_000 },
    }, request);
    h.manager.runNow(owned.id, {
      ...request,
      requestId: "run-owned",
      messageId: "run-message",
      action: "run_now",
      fingerprint: "b".repeat(64),
    });
    const unrelated = h.manager.create({
      name: "Unrelated",
      prompt: "Do unrelated work",
      botId: "sigil-1",
      schedule: { type: "once", at: Date.now() + 120_000 },
    });

    expect(h.manager.eraseThreadData("thread-owned")).toEqual({
      detachedRoutines: 1,
      removedRuns: 1,
      removedRequestReceipts: 2,
    });
    expect(h.manager.listRoutines().find((routine) => routine.id === owned.id)?.sourceThreadId).toBeUndefined();
    expect(h.manager.listRoutines().map((routine) => routine.id)).toContain(unrelated.id);
    expect(h.manager.listRuns()).toEqual([]);
    expect(h.manager.routineRequestReceipt("request-owned")).toBeNull();
    expect(h.manager.routineRequestReceipt("run-owned")).toBeNull();

    const restarted = new RoutineManager(h.options);
    expect(restarted.listRoutines().find((routine) => routine.id === owned.id)?.sourceThreadId).toBeUndefined();
    expect(restarted.listRuns()).toEqual([]);
    expect(restarted.eraseThreadData("thread-owned")).toEqual({
      detachedRoutines: 0,
      removedRuns: 0,
      removedRequestReceipts: 0,
    });
  });
});
