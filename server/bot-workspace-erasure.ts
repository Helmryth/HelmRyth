import { existsSync, lstatSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { ensurePrivateDirectory, repairPrivateFile } from "./private-storage.ts";
import { WORKSPACES_DIR } from "./workspace.ts";

export interface BotWorkspaceErasureReport {
  state: "complete" | "pending";
  botId: string;
  removed: { workspace: boolean };
  retained: {
    checkpointShadows: true;
    checkpointReason: string;
  };
  errors: string[];
  summary: string;
}

const CHECKPOINT_RETENTION =
  "Workspace checkpoint history was retained because snapshots belong to shared operator-and-folder recovery history rather than one workstream. It remains subject to the checkpoint retention policy.";
const SAFE_BOT_ID = /^[\w-]+$/;
const missingNodeErrorSchema = z.object({ code: z.literal("ENOENT") });
const workspaceStepSchema = z.object({
  state: z.enum(["pending", "complete"]),
  removed: z.boolean().optional(),
  error: z.string().optional(),
});
const entrySchema = z.object({
  botId: z.string(),
  state: z.enum(["pending", "complete"]),
  createdAt: z.number(),
  completedAt: z.number().optional(),
  steps: z.object({ workspace: workspaceStepSchema }),
});
const journalSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) });
type Entry = z.output<typeof entrySchema>;

export interface BotWorkspaceErasureManagerOptions {
  file: string;
  /** Product-owned root only. Entries are derived from a validated bot id. */
  workspacesDir?: string;
  /** A pending intent may run only after bots.json no longer owns this id. */
  botStillOwned?: (botId: string) => boolean;
  /** Test seam; production uses the guarded filesystem implementation. */
  removeWorkspace?: (path: string) => void;
  now?: () => number;
}

function assertBotId(botId: string): void {
  if (!SAFE_BOT_ID.test(botId)) throw new Error("invalid operator id");
}

/** Resolve exactly one validated child. This rejects traversal and makes it
 * impossible for a journal record to name an arbitrary filesystem target. */
function workspaceTarget(workspacesDir: string, botId: string): string {
  assertBotId(botId);
  const root = resolve(workspacesDir);
  const target = resolve(root, botId);
  if (dirname(target) !== root) throw new Error("invalid workspace target");
  return target;
}

/** Remove only the app-owned workspace entry. A bot workspace symlink is
 * unlinked as a symlink rather than traversed; a symlinked root is refused. */
function removeWorkspaceSafely(workspacesDir: string, botId: string): void {
  const target = workspaceTarget(workspacesDir, botId);
  try {
    const root = lstatSync(workspacesDir);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("workspace root is not a real directory");
  } catch (error) {
    if (missingNodeErrorSchema.safeParse(error).success) return;
    throw error;
  }
  try {
    const targetStat = lstatSync(target);
    if (targetStat.isSymbolicLink()) {
      unlinkSync(target);
      return;
    }
  } catch (error) {
    if (missingNodeErrorSchema.safeParse(error).success) return;
    throw error;
  }
  // `target` is a direct validated child of a private, non-symlink root.
  // force handles an already-removed entry; any real I/O failure is retained.
  rmSync(target, { recursive: true, force: true });
}

export class BotWorkspaceErasureManager {
  private readonly options: BotWorkspaceErasureManagerOptions;
  private readonly now: () => number;
  private entries: Entry[];
  private readonly inFlight = new Map<string, Promise<BotWorkspaceErasureReport>>();

  constructor(options: BotWorkspaceErasureManagerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.entries = this.load();
  }

  /** Durable pre-owner-delete intent. Once this returns, a process kill can
   * leave either a live bot or a restart-recoverable workspace obligation. */
  prepare(botId: string): void {
    assertBotId(botId);
    if (this.entries.some((entry) => entry.botId === botId)) return;
    this.entries.push({
      botId,
      state: "pending",
      createdAt: this.now(),
      steps: { workspace: { state: "pending" } },
    });
    const failure = this.save();
    if (failure) this.noteSaveFailure(this.entries[this.entries.length - 1]!, failure);
  }

  erase(botId: string): Promise<BotWorkspaceErasureReport> {
    assertBotId(botId);
    const existing = this.entries.find((entry) => entry.botId === botId);
    if (existing?.state === "complete") return Promise.resolve(this.report(existing));
    const active = this.inFlight.get(botId);
    if (active) return active;
    if (!existing) this.prepare(botId);
    const entry = this.entries.find((candidate) => candidate.botId === botId)!;
    const run = this.perform(entry).finally(() => this.inFlight.delete(botId));
    this.inFlight.set(botId, run);
    return run;
  }

  async retryPending(): Promise<BotWorkspaceErasureReport[]> {
    return Promise.all(this.entries
      .filter((entry) => entry.state === "pending" && !this.options.botStillOwned?.(entry.botId))
      .map((entry) => this.erase(entry.botId)));
  }

  private async perform(entry: Entry): Promise<BotWorkspaceErasureReport> {
    if (this.options.botStillOwned?.(entry.botId)) return this.report(entry, true);
    if (entry.steps.workspace.state === "pending") {
      try {
        const workspacesDir = this.options.workspacesDir ?? WORKSPACES_DIR;
        const target = workspaceTarget(workspacesDir, entry.botId);
        if (this.options.removeWorkspace) this.options.removeWorkspace(target);
        else removeWorkspaceSafely(workspacesDir, entry.botId);
        entry.steps.workspace.removed = true;
        entry.steps.workspace.state = "complete";
        delete entry.steps.workspace.error;
      } catch (error) {
        entry.steps.workspace.error = error instanceof Error ? error.message : String(error);
      }
      if (entry.steps.workspace.state === "complete") {
        entry.state = "complete";
        entry.completedAt = this.now();
      }
      // Every step failure above is folded into the entry so the caller still
      // gets a report; persisting it must behave the same way.
      const failure = this.save();
      if (failure) this.noteSaveFailure(entry, failure);
    }
    return this.report(entry);
  }

  private report(entry: Entry, ownerStillLive = false): BotWorkspaceErasureReport {
    const errors = entry.steps.workspace.error ? [`workspace: ${entry.steps.workspace.error}`] : [];
    const state = !ownerStillLive && errors.length === 0 && entry.state === "complete" ? "complete" : "pending";
    return {
      state,
      botId: entry.botId,
      removed: { workspace: entry.steps.workspace.removed === true },
      retained: { checkpointShadows: true, checkpointReason: CHECKPOINT_RETENTION },
      errors,
      summary: ownerStillLive
        ? "The operator still exists, so its private workspace was retained."
        : state === "complete"
          ? `The operator's private workspace was erased. ${CHECKPOINT_RETENTION}`
          : `The operator was deleted, but private workspace cleanup is pending and will retry after restart. ${CHECKPOINT_RETENTION}`,
    };
  }

  private load(): Entry[] {
    if (!existsSync(this.options.file)) return [];
    repairPrivateFile(this.options.file);
    try {
      return journalSchema.parse(JSON.parse(readFileSync(this.options.file, "utf8"))).entries;
    } catch (error) {
      throw new Error(`Invalid operator workspace erasure journal: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Persist the journal, reporting a write failure instead of throwing it.
   *
   * Both callers sit on the delete path. prepare() ran this BEFORE the work,
   * so a failed write threw synchronously out of erase() and the route answered
   * 500 having done nothing; perform() ran it after, so a failed write rejected
   * and discarded the receipt built on the next line — while the operator was
   * already off the roster. Either way the caller learned nothing about state
   * it could no longer inspect.
   *
   * A failed journal write is real: the erasure will not survive a restart,
   * because the intent that drives retry is what failed to persist. So it is
   * recorded on the entry and travels out in the report's errors, which keeps
   * the entry "pending" rather than falsely complete. */
  /** Persist the journal. Returns the failure instead of throwing it.
   *
   * Both callers sit on the delete path. prepare() runs this BEFORE the work,
   * so a throw escaped erase() synchronously and the route answered 500 having
   * done nothing; perform() runs it after, so a throw rejected and discarded
   * the receipt built on the next line — while the operator was already off the
   * roster. Either way the caller learned nothing about state it could no
   * longer inspect. The caller annotates the entry it is holding, so the report
   * carries the failure and stays "pending" rather than claiming a completion
   * that cannot survive a restart. */
  private save(): string | null {
    try {
      ensurePrivateDirectory(dirname(this.options.file));
      writeFileAtomic(this.options.file, JSON.stringify({ version: 1, entries: this.entries }, null, 2), { mode: 0o600 });
      return null;
    } catch (error) {
      return `journal: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private noteSaveFailure(entry: Entry, failure: string): void {
    entry.steps.workspace.error = entry.steps.workspace.error
      ? `${entry.steps.workspace.error}; ${failure}`
      : failure;
    // The completion is real in memory but not on disk, so it cannot be
    // replayed after a restart. report() keys "complete" off an empty error
    // list, which now correctly reads pending.
    entry.state = "pending";
    delete entry.completedAt;
  }
}
