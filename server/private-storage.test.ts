import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ensurePrivateStorageLayout,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  repairPrivateFile,
} from "./private-storage.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const mode = (path: string) => lstatSync(path).mode & 0o777;

describe.skipIf(process.platform === "win32")("private storage modes", () => {
  it("repairs legacy product storage under umask 022 without changing data", () => {
    const previousUmask = process.umask(0o022);
    let root: string;
    try {
      root = mkdtempSync(join(tmpdir(), "hry-private-"));
      roots.push(root);
      chmodSync(root, 0o755);
      const events = join(root, "events");
      const native = join(root, "native");
      const workspaces = join(root, "workspaces", "operator-1", "memory");
      for (const directory of [events, native, workspaces]) {
        // Creation deliberately follows the permissive umask.
        mkdirSync(directory, { recursive: true, mode: 0o777 });
      }
      const fixtures = [
        join(root, "config.json"),
        join(root, "bots.json"),
        join(root, "groups.json"),
        join(root, "routines.json"),
        join(root, "webhooks.json"),
        join(root, "bot-workspace-erasures.json"),
        join(root, "messages.db"),
        join(root, "messages.db-wal"),
        join(root, "decisions.ndjson"),
        join(root, "webhooks.json.legacy.tmp"),
        join(events, "thread.ndjson"),
        join(native, "thread.ndjson"),
      ];
      for (const file of fixtures) writeFileSync(file, `private:${file}`, { mode: 0o666 });

      ensurePrivateStorageLayout(root, events, native);

      expect(mode(root)).toBe(PRIVATE_DIRECTORY_MODE);
      expect(mode(events)).toBe(PRIVATE_DIRECTORY_MODE);
      expect(mode(native)).toBe(PRIVATE_DIRECTORY_MODE);
      expect(mode(workspaces)).toBe(PRIVATE_DIRECTORY_MODE);
      for (const file of fixtures) {
        expect(mode(file), file).toBe(PRIVATE_FILE_MODE);
        expect(readFileSync(file, "utf8")).toBe(`private:${file}`);
      }
    } finally {
      process.umask(previousUmask);
    }
  });

  it("does not follow a file symlink during repair", () => {
    const root = mkdtempSync(join(tmpdir(), "hry-private-link-"));
    roots.push(root);
    const target = join(root, "target");
    writeFileSync(target, "outside", { mode: 0o644 });
    const link = join(root, "config.json");
    symlinkSync(target, link);

    expect(repairPrivateFile(link)).toBe(false);
    expect(mode(target)).toBe(0o644);
  });

  it("does not traverse a symlinked private directory", () => {
    const root = mkdtempSync(join(tmpdir(), "hry-private-root-"));
    const outside = mkdtempSync(join(tmpdir(), "hry-private-outside-"));
    roots.push(root, outside);
    chmodSync(outside, 0o755);
    const outsideFile = join(outside, "keep.ndjson");
    writeFileSync(outsideFile, "outside", { mode: 0o644 });
    const eventsLink = join(root, "events");
    symlinkSync(outside, eventsLink);

    ensurePrivateStorageLayout(root, eventsLink, join(root, "native"));

    expect(mode(outside)).toBe(0o755);
    expect(mode(outsideFile)).toBe(0o644);
  });
});
