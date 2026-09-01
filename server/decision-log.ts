// The authorization DECISION log: one fleet-wide, append-only NDJSON file
// answering "which tool call was allowed, denied, or carded — by which
// rule, when, for which bot".
//
// The per-thread event log (harness/bus.ts) cannot answer that. It records
// that a request opened and later resolved, but the WHY — a grant waved it
// through, a guard held it, an unattended block overrode a grant that
// would otherwise have fired — exists only for a moment at the fold point
// and is gone by the time the event is on disk. So the fold writes the
// reason down here at the moment it is known, and the human-answer path
// writes a second row when a card comes back.
//
// Same discipline as the event tee: 0600 (rows name tools and command
// lines), through redactSecrets (summaries carry whatever the agent typed,
// credentials included), and fire-and-forget — an audit log must never
// take down the decision it is auditing.
//
// Deliberately NOT covered: ask_bot peer-approval cards. They never cross
// the runtime bus (peer-approval.ts appends its cards straight to the
// store), so wiring them here would mean a second, parallel tap — a
// separate change if it earns its keep.
import { readFileSync } from "node:fs";
import { appendFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type { AutoVerdictSource } from "./auto-approve.ts";
import { ensurePrivateDirectory, repairPrivateFile } from "./private-storage.ts";
import { redactSecrets } from "./redact.ts";
import { writeFileAtomic } from "./atomic.ts";

export type DecisionKind =
  | "auto-approved"
  | "card-shown"
  | "user-approved"
  | "user-denied"
  | "review-would-approve"
  | "review-would-deny";

/** Who or what produced the decision. The AutoVerdictSource values carry
 * straight through from auto-approve.ts; `question` marks cards a rule may
 * never answer, `auto-fallback` a card shown after delivery failed, `routine`
 * a durable chat scheduling proposal, `user` the human's answer, and
 * auto-review sources the isolated model reviewer. */
export type DecisionSource =
  | AutoVerdictSource
  | "question"
  | "auto-fallback"
  | "routine"
  | "user"
  | "auto-review"
  | "auto-review-shadow";

export interface DecisionRow {
  at: string;
  threadId: string;
  requestId?: string;
  botId?: string;
  botName?: string;
  tool?: string;
  summary?: string;
  decision: DecisionKind;
  source: DecisionSource;
  /** which rule decided: a guard's regex source, or the granted key */
  rule?: string;
  /** the turn ran with nobody at the keyboard when this was decided */
  unattended?: boolean;
}

const decisionKindSchema = z.enum([
  "auto-approved",
  "card-shown",
  "user-approved",
  "user-denied",
  "review-would-approve",
  "review-would-deny",
]);
const decisionSourceSchema: z.ZodType<DecisionSource> = z.enum([
  "always-allow",
  "auto-mode",
  "unattended-block",
  "local-computer-block",
  "destructive-guard",
  "sensitive-guard",
  "no-grant",
  "question",
  "auto-fallback",
  "routine",
  "user",
  "auto-review",
  "auto-review-shadow",
]);

/** Persisted fleet-wide decision record. Read paths parse every NDJSON line
 * through this contract before exposing it to the inspector. */
export const decisionRowSchema: z.ZodType<DecisionRow> = z.object({
  at: z.string(),
  threadId: z.string(),
  requestId: z.string().optional(),
  botId: z.string().optional(),
  botName: z.string().optional(),
  tool: z.string().optional(),
  summary: z.string().optional(),
  decision: decisionKindSchema,
  source: decisionSourceSchema,
  rule: z.string().optional(),
  unattended: z.boolean().optional(),
});

const FILE_NAME = "decisions.ndjson";

// Rotation is logrotate at its simplest: when the live file crosses the cap
// it becomes `.1` (clobbering the previous `.1`) and a fresh file starts.
// Total disk is bounded at ~2× the cap; at a few hundred bytes per row that
// is years of human-scale approvals, and anything fancier — dated segments,
// compression — is more machinery than an audit trail this size warrants.
const MAX_BYTES = 4 * 1024 * 1024;
const writeQueues = new Map<string, Promise<void>>();

async function writeDecision(
  dataDir: string,
  row: Omit<DecisionRow, "at">,
  maxBytes: number,
): Promise<void> {
  const file = join(dataDir, FILE_NAME);
  ensurePrivateDirectory(dataDir);
  repairPrivateFile(file);
  repairPrivateFile(`${file}.1`);
  try {
    if ((await stat(file)).size >= maxBytes) await rename(file, `${file}.1`);
  } catch {
    /* no live file yet — nothing to rotate */
  }
  const record = redactSecrets({ at: new Date().toISOString(), ...row });
  await appendFile(file, JSON.stringify(record) + "\n", { mode: 0o600 });
  repairPrivateFile(file);
}

/** Append one decision row. Fire-and-forget, mirroring the event bus tee:
 * the fold that calls this is delivering approvals and cards, and a full
 * disk must not turn into denied tools. */
export function appendDecision(
  dataDir: string,
  row: Omit<DecisionRow, "at">,
  opts?: { maxBytes?: number },
): void {
  const previous = writeQueues.get(dataDir) ?? Promise.resolve();
  // Serialize stat → optional rotate → append for each directory. Without
  // this queue two simultaneous approvals can both rotate, overwrite .1,
  // or append out of decision order.
  const queued = previous
    .then(() => writeDecision(dataDir, row, opts?.maxBytes ?? MAX_BYTES))
    .catch(() => {
      /* logging must never take down the fold */
    });
  writeQueues.set(dataDir, queued);
  void queued.finally(() => {
    if (writeQueues.get(dataDir) === queued) writeQueues.delete(dataDir);
  });
}

/** Test/shutdown seam: wait until every decision already queued for this
 * directory has reached disk. Normal request paths deliberately do not wait. */
export async function flushDecisionLog(dataDir: string): Promise<void> {
  await writeQueues.get(dataDir);
}

/** Remove every parseable decision owned by one erased thread from both
 * rotation segments. This queues behind earlier appends and becomes the
 * queue tail itself, so a row already accepted cannot race in after cleanup. */
export async function eraseDecisionsForThread(dataDir: string, threadId: string): Promise<number> {
  const previous = writeQueues.get(dataDir) ?? Promise.resolve();
  const operation = previous.then(() => {
    let removed = 0;
    const file = join(dataDir, FILE_NAME);
    for (const path of [`${file}.1`, file]) {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (error) {
        const failure = z.object({ code: z.string() }).safeParse(error);
        if (failure.success && failure.data.code === "ENOENT") continue;
        throw error;
      }
      const kept: string[] = [];
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const parsed = decisionRowSchema.safeParse(JSON.parse(line));
          if (parsed.success && parsed.data.threadId === threadId) {
            removed++;
            continue;
          }
        } catch {
          // Preserve malformed/torn evidence that cannot safely be assigned
          // to this thread; compaction must never delete unrelated bytes.
        }
        kept.push(line);
      }
      writeFileAtomic(path, kept.length ? `${kept.join("\n")}\n` : "", { mode: 0o600 });
      repairPrivateFile(path);
    }
    return removed;
  });
  const tail = operation.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(dataDir, tail);
  void tail.finally(() => {
    if (writeQueues.get(dataDir) === tail) writeQueues.delete(dataDir);
  });
  return operation;
}

/** The newest `limit` rows, oldest first — the same order the inspector
 * uses for thread events. Reads `.1` before the live file so a request
 * right after a rotation still sees history instead of a nearly empty
 * log; whole-file reads are fine here because rotation caps both files,
 * unlike the unbounded per-thread event logs that need a tail walk. */
export function readDecisions(dataDir: string, limit: number): DecisionRow[] {
  const file = join(dataDir, FILE_NAME);
  const rows: DecisionRow[] = [];
  for (const path of [`${file}.1`, file]) {
    repairPrivateFile(path);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const parsed = decisionRowSchema.safeParse(JSON.parse(line));
        if (parsed.success) rows.push(parsed.data);
      } catch {
        /* a line torn mid-write — skip the fragment, keep the rest */
      }
    }
  }
  return rows.slice(-limit);
}
