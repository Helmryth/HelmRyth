// Durable, atomic file replace: write to a sibling temp file, fsync it, then
// rename over the target. rename(2) is atomic on the same filesystem, so a
// crash or power loss mid-write can never leave a truncated file behind — a
// reader always sees either the complete old contents or the complete new
// ones. Without this, an interrupted writeFileSync produces half-written JSON
// that fails to parse on next boot and is silently treated as empty state.
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export function writeFileAtomic(path: string, data: string, options: { mode?: number } = {}): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    // Apply sensitive-file permissions to the temporary inode itself. The
    // final rename preserves them and never leaves a broader-permission
    // config file visible between the write and a later chmod.
    fd = openSync(tmp, "w", options.mode ?? 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort cleanup */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
}

/** The read counterpart to writeFileAtomic. A state file that exists but cannot
 * be parsed is still the user's data — a roster, a set of rooms — and the caller
 * is about to fall back to empty state and save over it. Move the bytes aside
 * under a timestamped name first so the loss is recoverable instead of total.
 *
 * rename(2) is preferred (atomic, keeps the inode); if it fails we still have
 * the text the caller already read, so write that copy instead. Returns the
 * path the original now lives at, or null if it could not be preserved. */
export function quarantineCorruptFile(path: string, contents: string, cause: unknown): string | null {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${path}.corrupt-${stamp}`;
  const reason = cause instanceof Error ? cause.message : String(cause);
  try {
    renameSync(path, target);
  } catch {
    try {
      writeFileAtomic(target, contents, { mode: 0o600 });
    } catch {
      console.error(
        `helmryth: ${path} could not be read (${reason}) AND could not be preserved. `
        + "Refusing to report a copy that does not exist — back this file up before the next save.",
      );
      return null;
    }
  }
  console.error(
    `helmryth: ${path} could not be read (${reason}). `
    + `The original is preserved at ${target}; starting from empty state for this file.`,
  );
  return target;
}

/** Guarded load for state whose reader opens the file itself.
 *
 * quarantineCorruptFile assumes the caller already has the bytes in hand.
 * Journals do not work that way — a manager reads, validates and throws
 * inside its own constructor, so the failure escapes before anyone can
 * decide what to do with it. At boot that kills the process before it binds
 * a port, on EVERY restart, from a bookkeeping file the app wrote itself:
 * the workspace becomes permanently unopenable with no operator-facing
 * message. Move the bytes aside and run the loader again — the file is gone
 * now, so it yields the fresh empty state. A second failure is a bug in the
 * loader rather than bad data on disk, so that one is allowed to surface. */
export function loadOrQuarantine<T>(path: string, load: () => T): T {
  try {
    return load();
  } catch (cause) {
    quarantineCorruptFile(path, "", cause);
    return load();
  }
}
