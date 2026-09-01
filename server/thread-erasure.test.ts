import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ThreadErasureManager } from "./thread-erasure.ts";

const temp = () => mkdtempSync(join(tmpdir(), "hry-erasure-"));

describe("ThreadErasureManager", () => {
  it("persists intent before cleanup and reports every removed or deliberately retained data class", async () => {
    const root = temp();
    const order: string[] = [];
    const manager = new ThreadErasureManager({
      file: join(root, "thread-erasures.json"),
      eventsDir: join(root, "events"),
      nativeDir: join(root, "native"),
      eraseEventLogs: () => {
        order.push(JSON.parse(readFileSync(join(root, "thread-erasures.json"), "utf8")).entries[0].state);
        return { runtimeLogRemoved: true, nativeLogRemoved: true };
      },
      eraseDecisions: async () => 3,
      eraseRoutineData: () => ({ detachedRoutines: 1, removedRuns: 2, removedRequestReceipts: 4 }),
    });

    const report = await manager.erase("thread-1");
    expect(order).toEqual(["pending"]);
    expect(report).toMatchObject({
      state: "complete",
      threadId: "thread-1",
      removed: {
        transcript: true,
        runtimeLog: true,
        nativeLog: true,
        decisionRows: 3,
        routineRuns: 2,
        routineRequestReceipts: 4,
      },
      retained: { cadenceDefinitions: 1, checkpointShadows: true },
      errors: [],
    });
    expect(report.summary).toMatch(/workspace checkpoint history was retained/i);
    await expect(manager.erase("thread-1")).resolves.toEqual(report);
  });

  it("persists transcript and attachment intent before mutation, then completes it after a crash before transcript purge", async () => {
    const root = temp();
    const file = join(root, "thread-erasures.json");
    const name = "123e4567-e89b-42d3-a456-426614174000.png";
    const first = new ThreadErasureManager({
      file,
      eventsDir: join(root, "events"),
      nativeDir: join(root, "native"),
      eraseRoutineData: () => ({ detachedRoutines: 0, removedRuns: 0, removedRequestReceipts: 0 }),
    });

    // This simulates a process death immediately after Store's synchronous
    // prepare hook returns and before it can call its low-level purge.
    first.prepare("thread-before-transcript", [name]);
    const intent = JSON.parse(readFileSync(file, "utf8"));
    expect(intent).toMatchObject({
      version: 2,
      entries: [{
        threadId: "thread-before-transcript",
        state: "pending",
        steps: { transcript: { state: "pending" }, attachments: { candidates: [name], state: "pending" } },
      }],
    });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

    const eraseTranscript = vi.fn(() => ({ database: true as const, legacyFilesRemoved: 1 }));
    const removeAttachment = vi.fn(() => true);
    const restarted = new ThreadErasureManager({
      file,
      eventsDir: join(root, "events"),
      nativeDir: join(root, "native"),
      eraseTranscript,
      removeAttachment,
      eraseEventLogs: () => ({ runtimeLogRemoved: false, nativeLogRemoved: false }),
      eraseDecisions: async () => 0,
      eraseRoutineData: () => ({ detachedRoutines: 0, removedRuns: 0, removedRequestReceipts: 0 }),
    });
    await expect(restarted.retryPending()).resolves.toEqual([
      expect.objectContaining({ state: "complete", removed: expect.objectContaining({ attachmentFiles: 1 }) }),
    ]);
    expect(eraseTranscript).toHaveBeenCalledWith("thread-before-transcript");
    expect(removeAttachment).toHaveBeenCalledWith(name);
  });

  it("checkpoints each destructive boundary so completed transcript, attachment, and ancillary steps never replay", async () => {
    const root = temp();
    const file = join(root, "thread-erasures.json");
    const name = "123e4567-e89b-42d3-a456-426614174000.webp";
    const eraseTranscript = vi.fn(() => ({ database: true as const, legacyFilesRemoved: 0 }));
    const removeAttachment = vi.fn(() => true);
    const eraseEvents = vi.fn(() => ({ runtimeLogRemoved: true, nativeLogRemoved: true }));
    const eraseRoutines = vi.fn(() => ({ detachedRoutines: 0, removedRuns: 1, removedRequestReceipts: 2 }));
    const first = new ThreadErasureManager({
      file,
      eventsDir: join(root, "events"),
      nativeDir: join(root, "native"),
      eraseTranscript,
      removeAttachment,
      eraseEventLogs: eraseEvents,
      eraseDecisions: async () => { throw new Error("crash after ancillary boundaries"); },
      eraseRoutineData: eraseRoutines,
    });
    first.prepare("thread-after-boundaries", [name]);
    await expect(first.erase("thread-after-boundaries")).resolves.toMatchObject({ state: "pending" });
    expect(eraseTranscript).toHaveBeenCalledTimes(1);
    expect(removeAttachment).toHaveBeenCalledTimes(1);
    expect(eraseEvents).toHaveBeenCalledTimes(1);
    expect(eraseRoutines).toHaveBeenCalledTimes(1);

    const recoverDecisions = vi.fn(async () => 7);
    const restarted = new ThreadErasureManager({
      file,
      eventsDir: join(root, "events"),
      nativeDir: join(root, "native"),
      eraseTranscript: () => { throw new Error("transcript must not replay"); },
      removeAttachment: () => { throw new Error("attachment must not replay"); },
      eraseEventLogs: () => { throw new Error("event log must not replay"); },
      eraseDecisions: recoverDecisions,
      eraseRoutineData: () => { throw new Error("routine data must not replay"); },
    });
    await expect(restarted.retryPending()).resolves.toEqual([
      expect.objectContaining({ state: "complete", errors: [], removed: expect.objectContaining({ decisionRows: 7 }) }),
    ]);
    expect(recoverDecisions).toHaveBeenCalledTimes(1);
  });

  it("retains a candidate while a surviving transcript or avatar references it and never accepts unsafe candidates", async () => {
    const root = temp();
    const name = "123e4567-e89b-42d3-a456-426614174000.gif";
    const removeAttachment = vi.fn(() => true);
    const manager = new ThreadErasureManager({
      file: join(root, "thread-erasures.json"),
      eventsDir: join(root, "events"),
      nativeDir: join(root, "native"),
      attachmentStillReferenced: (candidate) => candidate === name,
      removeAttachment,
      eraseTranscript: () => ({ database: true, legacyFilesRemoved: 0 }),
      eraseEventLogs: () => ({ runtimeLogRemoved: false, nativeLogRemoved: false }),
      eraseDecisions: async () => 0,
      eraseRoutineData: () => ({ detachedRoutines: 0, removedRuns: 0, removedRequestReceipts: 0 }),
    });
    manager.prepare("thread-retained-attachment", [name, "../config.png", "plain.png"]);
    const report = await manager.erase("thread-retained-attachment");
    expect(report.removed.attachmentFiles).toBe(0);
    expect(removeAttachment).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(root, "thread-erasures.json"), "utf8"))).toMatchObject({
      entries: [{ steps: { attachments: { candidates: [name], retained: [name] } } }],
    });
  });

  it("migrates a v1 journal without discarding a pending transcript obligation", async () => {
    const root = temp();
    const file = join(root, "thread-erasures.json");
    writeFileSync(file, JSON.stringify({
      version: 1,
      entries: [{
        threadId: "legacy-pending",
        state: "pending",
        createdAt: 1,
        steps: {
          events: { state: "complete", result: { runtimeLogRemoved: false, nativeLogRemoved: false } },
          decisions: { state: "complete", result: 0 },
          routines: { state: "complete", result: { detachedRoutines: 0, removedRuns: 0, removedRequestReceipts: 0 } },
        },
      }],
    }), { mode: 0o600 });
    const transcript = vi.fn(() => ({ database: true as const, legacyFilesRemoved: 0 }));
    const manager = new ThreadErasureManager({
      file,
      eventsDir: join(root, "events"),
      nativeDir: join(root, "native"),
      eraseTranscript: transcript,
      eraseRoutineData: () => ({ detachedRoutines: 0, removedRuns: 0, removedRequestReceipts: 0 }),
    });
    await manager.retryPending();
    expect(transcript).toHaveBeenCalledWith("legacy-pending");
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(2);
    expect(existsSync(file)).toBe(true);
  });

  it("writes a multi-thread intent batch all at once and never replays a pre-owner-save intent", async () => {
    const root = temp();
    const file = join(root, "thread-erasures.json");
    const manager = new ThreadErasureManager({
      file,
      eventsDir: join(root, "events"),
      nativeDir: join(root, "native"),
      eraseRoutineData: () => ({ detachedRoutines: 0, removedRuns: 0, removedRequestReceipts: 0 }),
    });
    expect(() => manager.prepareMany([
      { threadId: "valid-thread" },
      { threadId: "../invalid-thread" },
    ])).toThrow(/thread id/i);
    expect(existsSync(file)).toBe(false);

    manager.prepareMany([{ threadId: "owner-still-live" }, { threadId: "second-owner-still-live" }]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      entries: [{ threadId: "owner-still-live" }, { threadId: "second-owner-still-live" }],
    });
    const transcript = vi.fn(() => ({ database: true as const, legacyFilesRemoved: 0 }));
    const preSaveRestart = new ThreadErasureManager({
      file,
      eventsDir: join(root, "events"),
      nativeDir: join(root, "native"),
      threadStillOwned: () => true,
      eraseTranscript: transcript,
      eraseRoutineData: () => ({ detachedRoutines: 0, removedRuns: 0, removedRequestReceipts: 0 }),
    });
    await expect(preSaveRestart.retryPending()).resolves.toEqual([]);
    expect(transcript).not.toHaveBeenCalled();
  });

  it("keeps transcript and attachment faults pending with a truthful partial report", async () => {
    const root = temp();
    const manager = new ThreadErasureManager({
      file: join(root, "thread-erasures.json"),
      eventsDir: join(root, "events"),
      nativeDir: join(root, "native"),
      eraseTranscript: () => { throw new Error("disk I/O"); },
      removeAttachment: () => { throw new Error("attachment permissions"); },
      eraseEventLogs: () => ({ runtimeLogRemoved: false, nativeLogRemoved: false }),
      eraseDecisions: async () => 0,
      eraseRoutineData: () => ({ detachedRoutines: 0, removedRuns: 0, removedRequestReceipts: 0 }),
    });
    manager.prepare("failing-private-purge", ["123e4567-e89b-42d3-a456-426614174000.png"]);
    await expect(manager.erase("failing-private-purge")).resolves.toMatchObject({
      state: "pending",
      removed: { transcript: false, attachmentFiles: 0 },
      errors: ["transcript: disk I/O", "attachments: attachment permissions"],
    });
  });

  it("keeps a durable pending tombstone, retries after restart, and never re-runs completed steps", async () => {
    const root = temp();
    const file = join(root, "thread-erasures.json");
    let decisionAttempts = 0;
    const eraseEventLogs = vi.fn(() => ({ runtimeLogRemoved: true, nativeLogRemoved: false }));
    const first = new ThreadErasureManager({
      file,
      eventsDir: join(root, "events"),
      nativeDir: join(root, "native"),
      eraseEventLogs,
      eraseDecisions: async () => {
        decisionAttempts++;
        throw new Error("disk unavailable");
      },
      eraseRoutineData: () => ({ detachedRoutines: 0, removedRuns: 1, removedRequestReceipts: 0 }),
    });
    expect(await first.erase("thread-2")).toMatchObject({ state: "pending", errors: ["decisions: disk unavailable"] });

    const restarted = new ThreadErasureManager({
      file,
      eventsDir: join(root, "events"),
      nativeDir: join(root, "native"),
      eraseEventLogs,
      eraseDecisions: async () => {
        decisionAttempts++;
        return 2;
      },
      eraseRoutineData: () => {
        throw new Error("completed routine cleanup must not repeat");
      },
    });
    expect(await restarted.retryPending()).toEqual([
      expect.objectContaining({ state: "complete", threadId: "thread-2", errors: [] }),
    ]);
    expect(eraseEventLogs).toHaveBeenCalledTimes(1);
    expect(decisionAttempts).toBe(2);
  });

  it("deduplicates concurrent erasure calls and rejects unsafe identifiers", async () => {
    const root = temp();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const eraseDecisions = vi.fn(async () => { await gate; return 1; });
    const manager = new ThreadErasureManager({
      file: join(root, "thread-erasures.json"),
      eventsDir: join(root, "events"),
      nativeDir: join(root, "native"),
      eraseEventLogs: () => ({ runtimeLogRemoved: false, nativeLogRemoved: false }),
      eraseDecisions,
      eraseRoutineData: () => ({ detachedRoutines: 0, removedRuns: 0, removedRequestReceipts: 0 }),
    });
    const one = manager.erase("thread-3");
    const two = manager.erase("thread-3");
    release();
    await expect(one).resolves.toEqual(await two);
    expect(eraseDecisions).toHaveBeenCalledTimes(1);
    expect(() => manager.erase("../bots")).toThrow(/thread id/i);
  });

  it("refuses a corrupt journal instead of treating it as an empty successful history", () => {
    const root = temp();
    const file = join(root, "thread-erasures.json");
    writeFileSync(file, "{broken", { mode: 0o600 });
    expect(() => new ThreadErasureManager({
      file,
      eventsDir: join(root, "events"),
      nativeDir: join(root, "native"),
      eraseEventLogs: () => ({ runtimeLogRemoved: false, nativeLogRemoved: false }),
      eraseDecisions: async () => 0,
      eraseRoutineData: () => ({ detachedRoutines: 0, removedRuns: 0, removedRequestReceipts: 0 }),
    })).toThrow(/erasure journal/i);
  });
});
