import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadOrQuarantine, quarantineCorruptFile, writeFileAtomic } from "./atomic.ts";

describe("writeFileAtomic", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hry-atomic-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the file", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, '{"a":1}');
    expect(readFileSync(p, "utf8")).toBe('{"a":1}');
  });

  it("replaces existing contents in full", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "old-and-longer");
    writeFileAtomic(p, "new");
    expect(readFileSync(p, "utf8")).toBe("new");
  });

  it("leaves no temp files behind", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "a");
    writeFileAtomic(p, "b");
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });

  it("preserves unicode across the write", () => {
    const p = join(dir, "u.json");
    const s = JSON.stringify({ msg: "café — 日本語 — 🚀" });
    writeFileAtomic(p, s);
    expect(readFileSync(p, "utf8")).toBe(s);
    expect(existsSync(p)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("applies the requested mode when replacing a file", () => {
    const p = join(dir, "secret.json");
    writeFileAtomic(p, "old");
    chmodSync(p, 0o644);

    writeFileAtomic(p, "new", { mode: 0o600 });

    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("defaults atomic and temporary inodes to owner-only mode under umask 022", () => {
    const previousUmask = process.umask(0o022);
    try {
      const p = join(dir, "private.json");
      writeFileAtomic(p, "private");
      expect(statSync(p).mode & 0o777).toBe(0o600);
      chmodSync(p, 0o644);
      writeFileAtomic(p, "repaired");
      expect(statSync(p).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("cleans up the temporary file when replacement fails", () => {
    const p = join(dir, "target");
    mkdirSync(p);
    expect(() => writeFileAtomic(p, "cannot replace a directory")).toThrow();
    expect(readdirSync(dir)).toEqual(["target"]);
  });
});

describe("quarantineCorruptFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hry-quarantine-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("moves an unreadable file aside instead of leaving it to be overwritten", () => {
    const p = join(dir, "bots.json");
    writeFileAtomic(p, '[{"id":"keep-me"'); // truncated
    const target = quarantineCorruptFile(p, '[{"id":"keep-me"', new Error("Unexpected end of JSON input"));
    expect(target).not.toBeNull();
    expect(existsSync(p)).toBe(false);
    expect(readFileSync(target!, "utf8")).toBe('[{"id":"keep-me"');
  });

  it("says nothing was preserved when there was no file to preserve", () => {
    expect(quarantineCorruptFile(join(dir, "absent.json"), "", new Error("nope"))).toBeNull();
  });

  it("keeps the private mode on the preserved copy", () => {
    const p = join(dir, "groups.json");
    writeFileAtomic(p, "{oops");
    const target = quarantineCorruptFile(p, "{oops", new Error("bad"))!;
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });
});

describe("loadOrQuarantine", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hry-guarded-load-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the loaded value when the file reads cleanly", () => {
    const p = join(dir, "journal.json");
    writeFileAtomic(p, '{"version":1,"entries":[]}');
    expect(loadOrQuarantine(p, () => JSON.parse(readFileSync(p, "utf8")))).toEqual({ version: 1, entries: [] });
    expect(existsSync(p)).toBe(true);
  });

  it("moves a journal aside and re-runs the loader instead of letting the throw escape", () => {
    // A journal reads itself inside its own constructor, so a truncated file
    // used to take the whole process down at boot with nothing to act on.
    const p = join(dir, "journal.json");
    writeFileAtomic(p, '{"version":1,"entries":');
    const load = () => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { entries: [] });

    expect(loadOrQuarantine(p, load)).toEqual({ entries: [] });
    expect(existsSync(p)).toBe(false);
    const preserved = readdirSync(dir).filter((f) => f.startsWith("journal.json.corrupt-"));
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(dir, preserved[0]), "utf8")).toBe('{"version":1,"entries":');
  });

  it("lets a loader that fails for reasons other than the file surface", () => {
    // Quarantine only answers bad bytes. If the loader still throws with the
    // file gone, that is a bug in the loader and must not be swallowed.
    const p = join(dir, "journal.json");
    writeFileAtomic(p, "{}");
    expect(() => loadOrQuarantine(p, () => {
      throw new Error("loader is broken");
    })).toThrow(/loader is broken/);
  });
});
