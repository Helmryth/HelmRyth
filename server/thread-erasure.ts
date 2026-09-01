import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { removeAppOwnedAttachment } from "./attachments.ts";
import { eraseDecisionsForThread } from "./decision-log.ts";
import { ensurePrivateDirectory, repairPrivateFile } from "./private-storage.ts";
import { eraseThreadEventLogs, type ThreadEventErasure } from "./thread-events.ts";
import { purgeThreadTranscript, type TranscriptPurgeResult } from "./thread-transcript.ts";
import type { RoutineThreadErasure } from "./routines.ts";

export interface ThreadErasureReport {
  state: "complete" | "pending";
  threadId: string;
  removed: {
    transcript: boolean;
    attachmentFiles: number;
    runtimeLog: boolean;
    nativeLog: boolean;
    decisionRows: number;
    routineRuns: number;
    routineRequestReceipts: number;
  };
  retained: {
    cadenceDefinitions: number;
    checkpointShadows: true;
    checkpointReason: string;
  };
  errors: string[];
  summary: string;
}

const eventErasureSchema = z.object({ runtimeLogRemoved: z.boolean(), nativeLogRemoved: z.boolean() });
const routineErasureSchema = z.object({
  detachedRoutines: z.number().int().nonnegative(),
  removedRuns: z.number().int().nonnegative(),
  removedRequestReceipts: z.number().int().nonnegative(),
});
const pendingStepSchema = z.object({ state: z.enum(["pending", "complete"]), error: z.string().optional() });
const transcriptStepSchema = pendingStepSchema.extend({
  result: z.object({ database: z.literal(true), legacyFilesRemoved: z.number().int().nonnegative() }).optional(),
});
const attachmentsStepSchema = pendingStepSchema.extend({
  candidates: z.array(z.string()),
  removed: z.array(z.string()).default([]),
  retained: z.array(z.string()).default([]),
});
const eventsStepSchema = pendingStepSchema.extend({ result: eventErasureSchema.optional() });
const decisionsStepSchema = pendingStepSchema.extend({ result: z.number().int().nonnegative().optional() });
const routinesStepSchema = pendingStepSchema.extend({ result: routineErasureSchema.optional() });
const entrySchemaV2 = z.object({
  threadId: z.string(),
  state: z.enum(["pending", "complete"]),
  createdAt: z.number(),
  completedAt: z.number().optional(),
  steps: z.object({
    transcript: transcriptStepSchema,
    attachments: attachmentsStepSchema,
    events: eventsStepSchema,
    decisions: decisionsStepSchema,
    routines: routinesStepSchema,
  }),
});
const entrySchemaV1 = z.object({
  threadId: z.string(),
  state: z.enum(["pending", "complete"]),
  createdAt: z.number(),
  completedAt: z.number().optional(),
  steps: z.object({ events: eventsStepSchema, decisions: decisionsStepSchema, routines: routinesStepSchema }),
});
const journalSchemaV2 = z.object({ version: z.literal(2), entries: z.array(entrySchemaV2) });
const journalSchemaV1 = z.object({ version: z.literal(1), entries: z.array(entrySchemaV1) });
type Entry = z.output<typeof entrySchemaV2>;

export interface ThreadErasureManagerOptions {
  file: string;
  eventsDir: string;
  nativeDir: string;
  dataDir?: string;
  /** Idempotent transcript purge, invoked again on restart if needed. */
  eraseTranscript?: (threadId: string) => TranscriptPurgeResult;
  /** True means a still-live transcript or bot profile references the file. */
  attachmentStillReferenced?: (name: string) => boolean;
  /** A pending intent may run only after its owner record stopped naming this
   * thread; this distinguishes a committed deletion from a pre-save crash. */
  threadStillOwned?: (threadId: string) => boolean;
  /** Safe generated-name-only unlink. */
  removeAttachment?: (name: string) => boolean;
  eraseEventLogs?: (input: { eventsDir: string; nativeDir: string; threadId: string }) => ThreadEventErasure;
  eraseDecisions?: (dataDir: string, threadId: string) => Promise<number>;
  eraseRoutineData: (threadId: string) => RoutineThreadErasure;
  now?: () => number;
}

const CHECKPOINT_RETENTION =
  "Workspace checkpoint history was retained because snapshots belong to shared operator-and-folder recovery history rather than one workstream. It remains subject to the checkpoint retention policy.";
const SAFE_ATTACHMENT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|gif|webp)$/i;

function assertThreadId(threadId: string): void {
  if (!/^[\w-]+$/.test(threadId)) throw new Error("invalid thread id");
}

export class ThreadErasureManager {
  private readonly options: ThreadErasureManagerOptions;
  private readonly now: () => number;
  private entries: Entry[];
  private readonly inFlight = new Map<string, Promise<ThreadErasureReport>>();

  constructor(options: ThreadErasureManagerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.entries = this.load();
  }

  /** Durable pre-delete intent. This is deliberately synchronous: once it
   * returns, a crash cannot lose the obligation to purge the transcript. */
  prepare(threadId: string, attachmentCandidates: readonly string[] = []): Entry {
    return this.prepareMany([{ threadId, attachmentCandidates }])[0]!;
  }

  /** Atomically record every intent for an owner-level deletion. Validation
   * completes before entries are changed, and one atomic write commits the
   * whole batch. A crash can therefore leave either the still-live owner or a
   * complete recovery plan — never a partially journaled deleted group/bot. */
  prepareMany(requests: ReadonlyArray<{ threadId: string; attachmentCandidates?: readonly string[] }>): Entry[] {
    const normalized = requests.map(({ threadId, attachmentCandidates = [] }) => {
      assertThreadId(threadId);
      return {
        threadId,
        candidates: [...new Set(attachmentCandidates.filter((name) => SAFE_ATTACHMENT_NAME.test(name)))],
      };
    });
    const requestsByThread = new Map<string, string[]>();
    for (const request of normalized) {
      requestsByThread.set(request.threadId, [
        ...new Set([...(requestsByThread.get(request.threadId) ?? []), ...request.candidates]),
      ]);
    }
    let changed = false;
    const entries: Entry[] = [];
    for (const [threadId, candidates] of requestsByThread) {
      let entry = this.entries.find((candidate) => candidate.threadId === threadId);
      if (entry) {
        if (entry.state !== "complete") {
          const merged = [...new Set([...entry.steps.attachments.candidates, ...candidates])];
          if (merged.length !== entry.steps.attachments.candidates.length) {
            entry.steps.attachments.candidates = merged;
            changed = true;
          }
        }
      } else {
        entry = {
          threadId,
          state: "pending",
          createdAt: this.now(),
          steps: {
            transcript: { state: "pending" },
            attachments: { state: "pending", candidates, removed: [], retained: [] },
            events: { state: "pending" },
            decisions: { state: "pending" },
            routines: { state: "pending" },
          },
        };
        this.entries.push(entry);
        changed = true;
      }
      entries.push(entry);
    }
    if (changed) this.save();
    return entries;
  }

  erase(threadId: string): Promise<ThreadErasureReport> {
    assertThreadId(threadId);
    const existing = this.entries.find((entry) => entry.threadId === threadId);
    if (existing?.state === "complete") return Promise.resolve(this.report(existing));
    const active = this.inFlight.get(threadId);
    if (active) return active;
    const entry = existing ?? this.prepare(threadId);
    const run = this.perform(entry).finally(() => this.inFlight.delete(threadId));
    this.inFlight.set(threadId, run);
    return run;
  }

  async retryPending(): Promise<ThreadErasureReport[]> {
    return Promise.all(this.entries
      .filter((entry) => entry.state === "pending" && !this.options.threadStillOwned?.(entry.threadId))
      .map((entry) => this.erase(entry.threadId)));
  }

  private async perform(entry: Entry): Promise<ThreadErasureReport> {
    if (entry.steps.transcript.state === "pending") {
      try {
        entry.steps.transcript.result = (this.options.eraseTranscript ?? ((threadId) =>
          purgeThreadTranscript(threadId, this.options.dataDir)))(entry.threadId);
        entry.steps.transcript.state = "complete";
        delete entry.steps.transcript.error;
      } catch (error) {
        entry.steps.transcript.error = error instanceof Error ? error.message : String(error);
      }
      this.save();
    }
    if (entry.steps.attachments.state === "pending") {
      try {
        const removed: string[] = [];
        const retained: string[] = [];
        for (const name of entry.steps.attachments.candidates) {
          if (this.options.attachmentStillReferenced?.(name) ?? false) retained.push(name);
          else if ((this.options.removeAttachment ?? removeAppOwnedAttachment)(name)) removed.push(name);
        }
        entry.steps.attachments.removed = removed;
        entry.steps.attachments.retained = retained;
        entry.steps.attachments.state = "complete";
        delete entry.steps.attachments.error;
      } catch (error) {
        entry.steps.attachments.error = error instanceof Error ? error.message : String(error);
      }
      this.save();
    }
    if (entry.steps.events.state === "pending") {
      try {
        entry.steps.events.result = (this.options.eraseEventLogs ?? eraseThreadEventLogs)({
          eventsDir: this.options.eventsDir,
          nativeDir: this.options.nativeDir,
          threadId: entry.threadId,
        });
        entry.steps.events.state = "complete";
        delete entry.steps.events.error;
      } catch (error) {
        entry.steps.events.error = error instanceof Error ? error.message : String(error);
      }
      this.save();
    }
    if (entry.steps.decisions.state === "pending") {
      try {
        entry.steps.decisions.result = await (this.options.eraseDecisions ?? eraseDecisionsForThread)(
          this.options.dataDir ?? dirname(this.options.file),
          entry.threadId,
        );
        entry.steps.decisions.state = "complete";
        delete entry.steps.decisions.error;
      } catch (error) {
        entry.steps.decisions.error = error instanceof Error ? error.message : String(error);
      }
      this.save();
    }
    if (entry.steps.routines.state === "pending") {
      try {
        entry.steps.routines.result = this.options.eraseRoutineData(entry.threadId);
        entry.steps.routines.state = "complete";
        delete entry.steps.routines.error;
      } catch (error) {
        entry.steps.routines.error = error instanceof Error ? error.message : String(error);
      }
      this.save();
    }
    if (Object.values(entry.steps).every((step) => step.state === "complete")) {
      entry.state = "complete";
      entry.completedAt = this.now();
    }
    this.save();
    return this.report(entry);
  }

  private report(entry: Entry): ThreadErasureReport {
    const events = entry.steps.events.result;
    const routines = entry.steps.routines.result;
    const errors = [
      ...(entry.steps.transcript.error ? [`transcript: ${entry.steps.transcript.error}`] : []),
      ...(entry.steps.attachments.error ? [`attachments: ${entry.steps.attachments.error}`] : []),
      ...(entry.steps.events.error ? [`events: ${entry.steps.events.error}`] : []),
      ...(entry.steps.decisions.error ? [`decisions: ${entry.steps.decisions.error}`] : []),
      ...(entry.steps.routines.error ? [`routines: ${entry.steps.routines.error}`] : []),
    ];
    const state = errors.length === 0 && entry.state === "complete" ? "complete" : "pending";
    return {
      state,
      threadId: entry.threadId,
      removed: {
        transcript: entry.steps.transcript.state === "complete",
        attachmentFiles: entry.steps.attachments.removed.length,
        runtimeLog: events?.runtimeLogRemoved === true,
        nativeLog: events?.nativeLogRemoved === true,
        decisionRows: entry.steps.decisions.result ?? 0,
        routineRuns: routines?.removedRuns ?? 0,
        routineRequestReceipts: routines?.removedRequestReceipts ?? 0,
      },
      retained: {
        cadenceDefinitions: routines?.detachedRoutines ?? 0,
        checkpointShadows: true,
        checkpointReason: CHECKPOINT_RETENTION,
      },
      errors,
      summary: state === "complete"
        ? `The transcript, app-owned unreferenced image attachments, private trace files, decision rows, and thread-owned cadence receipts were erased. ${CHECKPOINT_RETENTION}`
        : `The workstream was deleted, but some private-data cleanup is pending and will retry after restart. ${CHECKPOINT_RETENTION}`,
    };
  }

  private load(): Entry[] {
    if (!existsSync(this.options.file)) return [];
    repairPrivateFile(this.options.file);
    try {
      const raw = JSON.parse(readFileSync(this.options.file, "utf8"));
      const v2 = journalSchemaV2.safeParse(raw);
      if (v2.success) return v2.data.entries;
      const v1 = journalSchemaV1.parse(raw);
      // v1 intent was written after transcript mutation. A pending v1 record
      // still gets an idempotent purge on startup; completed records stay
      // complete because the historical manager had already finished them.
      return v1.entries.map((entry) => ({
        ...entry,
        steps: {
          transcript: { state: entry.state === "complete" ? "complete" : "pending" },
          attachments: { state: "complete", candidates: [], removed: [], retained: [] },
          ...entry.steps,
        },
      }));
    } catch (error) {
      throw new Error(`Invalid thread erasure journal: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private save(): void {
    ensurePrivateDirectory(dirname(this.options.file));
    writeFileAtomic(this.options.file, JSON.stringify({ version: 2, entries: this.entries }, null, 2), { mode: 0o600 });
  }
}
