// The inspector's data: what a thread's turn actually looked like on the
// wire. Nothing new is captured here — the harness already tees two logs
// per thread, and this just reads them back:
//
//   events/<threadId>.ndjson  — the normalized RuntimeEvent stream the bus
//                               publishes (server/harness/bus.ts)
//   native/<threadId>.ndjson  — the provider's own protocol messages,
//                               verbatim and secret-redacted
//                               (server/drivers/native.ts)
//
// Merged by timestamp so a tool call and the raw message behind it sit
// next to each other. Newest-`limit` only: a long-lived thread has
// thousands of native lines and the panel wants the recent ones first.
import { closeSync, fstatSync, openSync, readSync, unlinkSync, type Stats } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RuntimeEvent } from "./contracts.ts";

const persistedJsonSchema = z.json();
export type PersistedJson = z.output<typeof persistedJsonSchema>;

/** One parsed line of native/<threadId>.ndjson (server/drivers/native.ts). */
export const nativeRecordSchema = z.object({
  at: z.string(),
  dir: z.enum(["in", "out"]),
  source: z.string(),
  msg: persistedJsonSchema,
});
export type NativeRecord = z.output<typeof nativeRecordSchema>;

const runtimeEventBaseSchema = z.object({
  eventId: z.string(),
  provider: z.string(),
  providerInstanceId: z.string().optional(),
  threadId: z.string(),
  createdAt: z.string(),
  turnId: z.string().optional(),
  itemId: z.string().optional(),
  requestId: z.string().optional(),
  raw: z.object({ source: z.string(), payload: persistedJsonSchema }).optional(),
});

const runtimeEventDetailSchema = z.union([
  z.object({ type: z.literal("session.started"), sessionId: z.string().nullable(), model: z.string().nullable().optional() }),
  z.object({ type: z.literal("session.exited"), reason: z.string().optional() }),
  z.object({ type: z.literal("turn.started") }),
  z.object({
    type: z.literal("turn.retrying"),
    attempt: z.number().int().min(1),
    delayMs: z.number().finite().nonnegative(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("turn.completed"),
    ok: z.boolean(),
    stopReason: z.string().nullable().optional(),
    cost: z.number().nullable().optional(),
    denials: z.array(z.string()).optional(),
    usage: z.object({ input: z.number(), output: z.number(), cachedInput: z.number().optional() }).optional(),
  }),
  z.object({ type: z.literal("item.started"), itemType: z.enum(["tool", "reasoning"]), title: z.string().optional() }),
  z.object({ type: z.literal("item.updated"), itemType: z.enum(["tool", "reasoning"]), tokens: z.number().nullable().optional() }),
  z.object({ type: z.literal("item.completed"), itemType: z.literal("tool"), ok: z.boolean() }),
  z.object({ type: z.literal("item.completed"), itemType: z.literal("assistant_text"), text: z.string() }),
  z.object({ type: z.literal("content.delta"), streamKind: z.enum(["assistant_text", "reasoning_text"]), delta: z.string() }),
  z.object({
    type: z.literal("request.opened"),
    requestType: z.enum(["permission", "question"]),
    tool: z.string(),
    summary: z.string(),
    choices: z.array(z.string()).optional(),
    approvalScope: z.literal("local-computer").optional(),
  }),
  z.object({
    type: z.literal("request.resolved"),
    behavior: z.enum(["allow", "deny", "answer"]),
    source: z.enum(["user", "auto", "timeout", "system", "unavailable", "peer"]),
    approvalScope: z.literal("local-computer").optional(),
  }),
  z.object({
    type: z.literal("thread.token-usage.updated"),
    input: z.number(),
    output: z.number(),
    cachedInput: z.number().optional(),
  }),
  z.object({ type: z.literal("runtime.error"), message: z.string(), setup: z.boolean().optional() }),
]);

/** Persisted canonical event contract. Intersection keeps the shared base
 * required for every discriminated event while rejecting malformed rows. */
export const runtimeEventSchema: z.ZodType<RuntimeEvent> = z.intersection(
  runtimeEventBaseSchema,
  runtimeEventDetailSchema,
);

export type InspectorEntry =
  | { kind: "runtime"; at: string; data: RuntimeEvent }
  | { kind: "native"; at: string; data: NativeRecord };

export interface InspectorPage {
  entries: InspectorEntry[];
  /** line counts before the cap, so the UI can say "showing 200 of 1,687" */
  total: { runtime: number; native: number };
}

const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 2000;
const READ_CHUNK = 64 * 1024;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;

interface LineCount {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  complete: number;
  trailing: boolean;
}
type FileStat = Pick<Stats, "dev" | "ino" | "size" | "mtimeMs">;

// Counts are incremental per append-only log. The first request scans bytes
// once (without decoding or parsing every JSON record); later requests inspect
// only bytes appended since the cached size. Keep this bounded across threads.
const lineCounts = new Map<string, LineCount>();
const LINE_COUNT_CACHE_MAX = 256;

/** Thread ids are uuids the harness minted; anything else is not a file we
 * should be reading. */
function assertThreadId(threadId: string) {
  if (!/^[\w-]+$/.test(threadId)) throw new Error("invalid thread id");
}

export interface ThreadEventErasure {
  runtimeLogRemoved: boolean;
  nativeLogRemoved: boolean;
}

/** Physically remove both append-only per-thread traces. Deletion is
 * idempotent because a retry after a crash may find either file already gone. */
export function eraseThreadEventLogs(input: {
  eventsDir: string;
  nativeDir: string;
  threadId: string;
}): ThreadEventErasure {
  assertThreadId(input.threadId);
  const remove = (file: string): boolean => {
    lineCounts.delete(file);
    try {
      unlinkSync(file);
      return true;
    } catch (error) {
      const failure = z.object({ code: z.string() }).safeParse(error);
      if (failure.success && failure.data.code === "ENOENT") return false;
      throw error;
    }
  };
  return {
    runtimeLogRemoved: remove(join(input.eventsDir, `${input.threadId}.ndjson`)),
    nativeLogRemoved: remove(join(input.nativeDir, `${input.threadId}.ndjson`)),
  };
}

function countLines(fd: number, file: string, stat: FileStat): number {
  const previous = lineCounts.get(file);
  const appended =
    previous &&
    previous.dev === stat.dev &&
    previous.ino === stat.ino &&
    stat.size >= previous.size &&
    (stat.size > previous.size || stat.mtimeMs === previous.mtimeMs);
  if (appended && stat.size === previous.size) return previous.complete + Number(previous.trailing);

  let offset = appended ? previous.size : 0;
  let complete = appended ? previous.complete : 0;
  let trailing = appended ? previous.trailing : false;
  while (offset < stat.size) {
    const length = Math.min(READ_CHUNK, stat.size - offset);
    const chunk = Buffer.allocUnsafe(length);
    const read = readSync(fd, chunk, 0, length, offset);
    if (read <= 0) break;
    for (let i = 0; i < read; i++) {
      if (chunk[i] === 0x0a) {
        if (trailing) complete++;
        trailing = false;
      } else if (chunk[i] !== 0x0d) {
        trailing = true;
      }
    }
    offset += read;
  }
  const next = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, complete, trailing };
  lineCounts.delete(file);
  lineCounts.set(file, next);
  while (lineCounts.size > LINE_COUNT_CACHE_MAX) lineCounts.delete(lineCounts.keys().next().value!);
  return complete + Number(trailing);
}

type RecordParser<T> = (value: PersistedJson) => T | null;

function parseRecent<T>(text: string, includeFirst: boolean, limit: number, parseRecord: RecordParser<T>): T[] {
  const lines = text.split("\n");
  if (!includeFirst) lines.shift();
  const out: T[] = [];
  for (const raw of lines) {
    if (!raw) continue;
    try {
      const json = persistedJsonSchema.safeParse(JSON.parse(raw));
      if (!json.success) continue;
      const value = parseRecord(json.data);
      if (value !== null) out.push(value);
    } catch {
      // A torn line during a write, or a hand-edited record. Keep looking
      // farther back until we still have `limit` valid recent entries.
    }
  }
  return out.slice(-limit);
}

interface RecentLines<T> {
  lines: T[];
  total: number;
}

function readRecentLines<T>(file: string, limit: number, parseRecord: RecordParser<T>): RecentLines<T> {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return { lines: [], total: 0 };
  }
  try {
    const stat = fstatSync(fd);
    const total = countLines(fd, file, stat);
    let position = stat.size;
    let bytes = Buffer.alloc(0);
    let lines: T[] = [];
    while (position > 0 && bytes.length < MAX_TAIL_BYTES) {
      const remaining = MAX_TAIL_BYTES - bytes.length;
      const start = Math.max(0, position - Math.min(READ_CHUNK, remaining));
      const length = position - start;
      const chunk = Buffer.allocUnsafe(length);
      const read = readSync(fd, chunk, 0, length, start);
      if (read <= 0) break;
      bytes = Buffer.concat([chunk.subarray(0, read), bytes]);
      position = start;
      // The first line is partial until we reach byte zero. Parse only once
      // enough complete candidates exist; corrupt candidates make us keep
      // walking backwards rather than returning fewer valid rows.
      const text = bytes.toString("utf8");
      if (position === 0 || text.split("\n").length - 1 >= limit) {
        lines = parseRecent(text, position === 0, limit, parseRecord);
        if (lines.length >= limit || position === 0) break;
      }
    }
    if (lines.length === 0 && bytes.length > 0) {
      lines = parseRecent(bytes.toString("utf8"), position === 0, limit, parseRecord);
    }
    return { lines, total };
  } finally {
    closeSync(fd);
  }
}

function parseRuntimeEvent(value: PersistedJson): RuntimeEvent | null {
  const parsed = runtimeEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseNativeRecord(value: PersistedJson): NativeRecord | null {
  const parsed = nativeRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function readThreadEvents(input: {
  eventsDir: string;
  nativeDir: string;
  threadId: string;
  limit?: number;
}): InspectorPage {
  const { eventsDir, nativeDir, threadId } = input;
  assertThreadId(threadId);
  const requested = input.limit ?? DEFAULT_LIMIT;
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(Math.trunc(requested), MAX_LIMIT)) : DEFAULT_LIMIT;

  const runtime = readRecentLines(join(eventsDir, `${threadId}.ndjson`), limit, parseRuntimeEvent);
  const native = readRecentLines(join(nativeDir, `${threadId}.ndjson`), limit, parseNativeRecord);

  // cap each log on its own, then merge: the native tee is several times
  // chattier than the runtime stream, and one shared cap would leave the
  // Events lens with a handful of rows behind hundreds of raw ones
  const merged: InspectorEntry[] = [
    ...runtime.lines.map((data): InspectorEntry => ({ kind: "runtime", at: data.createdAt, data })),
    ...native.lines.map((data): InspectorEntry => ({ kind: "native", at: data.at, data })),
  ];
  // stable sort: ties keep file order, which is emit order
  merged.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  return {
    entries: merged,
    total: { runtime: runtime.total, native: native.total },
  };
}
