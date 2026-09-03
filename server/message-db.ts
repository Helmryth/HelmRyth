// SQLite persistence for thread transcripts.
//
// messages-<threadId>.json rewrote the WHOLE thread file on every append —
// a long computer-use thread reaches megabytes, so each new message cost
// more disk than the last. This store writes deltas instead: one INSERT
// per message, one UPDATE per patch, and reads a thread once into the
// Store's in-memory cache. node:sqlite (built into Node ≥23.4) keeps it
// dependency-free — nothing new to bundle for the packaged app.
//
// Legacy JSON thread files import lazily: the first read of a thread with
// no rows pulls the old file in, after which the DB is the source of
// truth (the JSON file is left behind as a one-time backup).
import { closeSync, existsSync, openSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { DATA_DIR } from "./config.ts";
import { ensurePrivateDirectory, repairPrivateFile } from "./private-storage.ts";
import { parseJson } from "./schema.ts";
import type { Message } from "./store.ts";

const DB_FILE = () => join(DATA_DIR, "messages.db");

let handle: DatabaseSync | null = null;
let handlePath: string | null = null;

function open(): DatabaseSync {
  const file = DB_FILE();
  ensurePrivateDirectory(DATA_DIR);
  // Transcripts can contain private conversations and tool output. Create
  // the database with owner-only permissions and also repair an existing
  // file that may have inherited a permissive umask.
  closeSync(openSync(file, "a", 0o600));
  repairPrivateFile(file);
  const db = new DatabaseSync(file);
  // SQLite's built-in `lower()` folds ASCII and nothing else — `lower('Ärger')`
  // is `Ärger`. Search folds its needle in JavaScript, which folds everything,
  // so the two disagreed on every non-ASCII capital and a message containing
  // one could not be found under ANY casing of the query. Register a fold that
  // matches the one the caller uses. A JS call per scanned row is affordable
  // for the same reason the scan itself is: these transcripts are megabytes.
  db.function("unicode_lower", { deterministic: true }, (value) =>
    value === null || value === undefined ? null : String(value).toLowerCase());
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      thread_id TEXT NOT NULL,
      id TEXT NOT NULL,
      at INTEGER NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT,
      json TEXT NOT NULL,
      PRIMARY KEY (thread_id, id)
    );
    CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id);
    CREATE TABLE IF NOT EXISTS thread_state (
      thread_id TEXT PRIMARY KEY,
      active_leaf_id TEXT
    );
  `);
  for (const sqliteFile of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    repairPrivateFile(sqliteFile);
  }
  return db;
}

/** The live handle — reopened when the file was removed out from under us
 * (tests wipe DATA_DIR between cases; a fresh Store must get a fresh DB,
 * not a handle onto an unlinked inode). */
function db(): DatabaseSync {
  if (handle && handlePath === DB_FILE() && existsSync(DB_FILE())) return handle;
  try {
    handle?.close();
  } catch {}
  handle = open();
  handlePath = DB_FILE();
  return handle;
}

const persistedMessageIdentitySchema = z.looseObject({
  id: z.string(),
  role: z.string(),
  kind: z.string(),
  at: z.number(),
});
const persistedMessageSchema = z.custom<Message>(
  (value) => persistedMessageIdentitySchema.safeParse(value).success,
  "Invalid persisted message",
);
const persistedMessagesSchema = z.array(persistedMessageSchema);
const persistedThreadSchema = z.union([
  persistedMessagesSchema.transform((messages) => ({ messages, activeLeafId: null })),
  z
    .looseObject({
      messages: persistedMessagesSchema.optional().default([]),
      activeLeafId: z.string().nullable().optional().default(null),
    })
    .transform(({ messages, activeLeafId }) => ({ messages, activeLeafId })),
]);

const messageJsonRowsSchema = z.array(z.object({ json: z.string() }));
const threadStateRowSchema = z.object({ active_leaf_id: z.string().nullable() });
const searchRowsSchema = z.array(
  z.object({
    thread_id: z.string(),
    id: z.string(),
    at: z.number(),
    role: z.string(),
    kind: z.string(),
    text: z.string().nullable(),
    tool_name: z.string().nullable(),
    from_name: z.string().nullable(),
  }),
);

const rowToMessage = (row: { json: string }): Message => persistedMessageSchema.parse(parseJson(row.json));

export interface ThreadRows {
  messages: Message[];
  activeLeafId: string | null;
}

/** Read one thread, importing its legacy JSON file on first touch. */
export function readThread(threadId: string, legacyFile: string): ThreadRows {
  const rows = messageJsonRowsSchema.parse(
    db().prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid").all(threadId),
  );
  if (rows.length) {
    const state = threadStateRowSchema.optional().parse(
      db().prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?").get(threadId),
    );
    return { messages: rows.map(rowToMessage), activeLeafId: state?.active_leaf_id ?? null };
  }
  return importLegacy(threadId, legacyFile);
}

function importLegacy(threadId: string, legacyFile: string): ThreadRows {
  let legacyThread: ThreadRows;
  try {
    repairPrivateFile(legacyFile);
    legacyThread = persistedThreadSchema.parse(parseJson(readFileSync(legacyFile, "utf8")));
  } catch {
    return { messages: [], activeLeafId: null }; // fresh thread
  }
  const { messages, activeLeafId } = legacyThread;
  const insert = db().prepare(
    "INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  db().exec("BEGIN");
  try {
    for (const message of messages) {
      insert.run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
    }
    setActiveLeaf(threadId, activeLeafId);
    db().exec("COMMIT");
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
  // left beside the DB as a one-time backup, renamed so the import never
  // runs twice against a thread whose rows were later deleted
  try {
    renameSync(legacyFile, `${legacyFile}.imported`);
    repairPrivateFile(`${legacyFile}.imported`);
  } catch {}
  return { messages, activeLeafId };
}

export function insertMessage(threadId: string, message: Message): void {
  db()
    .prepare("INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
}

/** Persist a new message and the branch head as one crash-safe mutation. */
export function appendMessage(threadId: string, message: Message): void {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    insertMessage(threadId, message);
    setActiveLeaf(threadId, message.id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function updateMessage(threadId: string, message: Message): void {
  db()
    .prepare("UPDATE messages SET at = ?, role = ?, kind = ?, text = ?, json = ? WHERE thread_id = ? AND id = ?")
    .run(message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message), threadId, message.id);
}

export function setActiveLeaf(threadId: string, leafId: string | null): void {
  db()
    .prepare(
      "INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?) " +
        "ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id = excluded.active_leaf_id",
    )
    .run(threadId, leafId);
}

export function deleteThread(threadId: string): void {
  db().prepare("DELETE FROM messages WHERE thread_id = ?").run(threadId);
  db().prepare("DELETE FROM thread_state WHERE thread_id = ?").run(threadId);
}

export interface SearchHit {
  threadId: string;
  messageId: string;
  at: number;
  role: string;
  kind: string;
  /** the matched text, trimmed to a window around the first hit */
  snippet: string;
  /** where the match sits inside `snippet`, for highlighting */
  matchStart: number;
  matchLength: number;
  /** room messages: which member said it */
  from?: string;
}

/** Case-insensitive substring search over text messages, newest first.
 * A LIKE scan, deliberately: local transcripts are megabytes at most, a
 * scan is milliseconds, and it needs no FTS extension to exist. */
export function searchMessages(query: string, limit = 40, threadId?: string): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  // escape LIKE wildcards so a literal % or _ in the query stays literal
  const pattern = `%${needle.replace(/([\\%_])/g, "\\$1")}%`;
  // text messages by their text; activity chips by the tool name — "which
  // bot ran that migration" is a tool-name question. The chip's name lives
  // in the row's json; a JSON1 extract keeps this one query.
  const scope = threadId ? "thread_id = ? AND " : "";
  const statement = db().prepare(
    "SELECT thread_id, id, at, role, kind, text, json_extract(json, '$.tool.name') AS tool_name, json_extract(json, '$.from.name') AS from_name FROM messages " +
      `WHERE ${scope}((kind = 'text' AND text IS NOT NULL AND unicode_lower(text) LIKE ? ESCAPE '\\') ` +
      "   OR (kind = 'activity' AND tool_name IS NOT NULL AND unicode_lower(tool_name) LIKE ? ESCAPE '\\')) " +
      "ORDER BY at DESC LIMIT ?",
  );
  const rows = searchRowsSchema.parse(
    threadId
      ? statement.all(threadId, pattern, pattern, limit)
      : statement.all(pattern, pattern, limit),
  );
  return rows.map((row) => {
    const haystack = row.kind === "activity" ? (row.tool_name ?? "") : (row.text ?? "");
    const hitAt = Math.max(0, haystack.toLowerCase().indexOf(needle));
    const start = Math.max(0, hitAt - 60);
    const end = Math.min(haystack.length, hitAt + needle.length + 90);
    const head = start > 0 ? "…" : "";
    const body = haystack.slice(start, end).replace(/\s+/g, " ").trim();
    const snippet = head + body + (end < haystack.length ? "…" : "");
    // whitespace folding can shift the offset; find the match again inside
    const folded = needle.replace(/\s+/g, " ");
    const matchStart = snippet.toLowerCase().indexOf(folded);
    const hit: SearchHit = {
      threadId: row.thread_id,
      messageId: row.id,
      at: row.at,
      role: row.role,
      kind: row.kind,
      snippet,
      matchStart: matchStart < 0 ? head.length : matchStart,
      // A defensive fallback must not mark arbitrary snippet text as the hit.
      matchLength: matchStart < 0 ? 0 : folded.length,
    };
    if (row.from_name) hit.from = row.from_name;
    return hit;
  });
}

/** Test/shutdown hook — closes the handle so a wiped DATA_DIR starts clean. */
export function closeMessageDb(): void {
  try {
    handle?.close();
  } catch {}
  handle = null;
  handlePath = null;
}
