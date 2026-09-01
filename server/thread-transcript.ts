// The lowest-level transcript purge.  It intentionally has no knowledge of
// the Store or its owner records so a durable erasure journal can resume it
// at boot, even when a process died between recording intent and the Store's
// normal delete path.
import { unlinkSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import * as mdb from "./message-db.ts";

function assertThreadId(threadId: string): void {
  if (!/^[\w-]+$/.test(threadId)) throw new Error("invalid thread id");
}

export interface TranscriptPurgeResult {
  /** SQLite deletion is idempotent, so true means the destructive step ran. */
  database: true;
  /** Legacy snapshots are best-effort because an absent file is already gone. */
  legacyFilesRemoved: number;
}

/**
 * Delete every app-owned transcript representation for one thread.  This is
 * deliberately idempotent: the journal is allowed to call it after a crash
 * both before and after a previous process completed the same deletion.
 */
export function purgeThreadTranscript(threadId: string, dataDir = DATA_DIR): TranscriptPurgeResult {
  assertThreadId(threadId);
  mdb.deleteThread(threadId);
  let legacyFilesRemoved = 0;
  const base = join(dataDir, `messages-${threadId}.json`);
  for (const file of [base, `${base}.imported`]) {
    try {
      unlinkSync(file);
      legacyFilesRemoved += 1;
    } catch (error) {
      // Absence is the idempotent success case. Permission/I/O failures must
      // reach the journal manager so it stays pending and retries later.
      // SAFETY: Node filesystem errors expose the documented optional errno code.
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { database: true, legacyFilesRemoved };
}
