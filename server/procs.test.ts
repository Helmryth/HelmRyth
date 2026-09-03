// argv hazards that kill a turn before the child process exists.
import { describe, expect, it } from "vitest";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { brokerSocketPath } from "./procs.ts";

describe("brokerSocketPath", () => {
  const tag = "a1b2c3d4";

  it("keeps the socket inside the data dir when the path fits", () => {
    const dir = mkdtempSync(join(tmpdir(), "hry-sock-"));
    if (process.platform === "win32") {
      // Windows has no unix domain sockets, so there is no path under the data
      // dir to keep anything inside. brokerSocketPath returns a named pipe
      // there, deliberately and with a comment saying so; a pipe lives in a
      // flat global namespace, not on the filesystem.
      expect(brokerSocketPath(dir, tag)).toContain(String.raw`\\.\pipe\helmryth-perm-`);
      return;
    }
    expect(brokerSocketPath(dir, tag)).toBe(join(dir, `perm-${tag}.sock`));
  });

  it("stays under the sun_path limit when the data dir is deep", () => {
    // A synced Documents folder or a nested test lane pushes the natural path
    // past 104 bytes; bind() answers EINVAL and every permission gate then
    // degrades to a deny nobody can explain.
    const deep = join("/Users/someone/Library/Mobile Documents/com~apple~CloudDocs", "a".repeat(60), "helmryth", "profile");
    const path = brokerSocketPath(deep, tag);
    expect(Buffer.byteLength(path, "utf8")).toBeLessThanOrEqual(103);
    expect(path).not.toContain(deep);
  });

  it("gives the fallback directory owner-only permissions", () => {
    // Whoever binds this socket decides what the operator may do, so the
    // fallback must not land anywhere another local user can pre-create.
    const deep = join(tmpdir(), "b".repeat(90), "profile");
    const path = brokerSocketPath(deep, tag);
    if (process.platform === "win32") return;
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("gives different data dirs different fallback rooms", () => {
    // POSIX only, and brokerSocketPath states the reason itself: "Named pipes
    // share a global namespace; DATA_DIR cannot isolate two concurrent app
    // instances the way a POSIX socket directory does." On Windows both calls
    // return the same `\\.\pipe\helmryth-perm-<pid>-<tag>`, so there is no
    // per-data-dir room to assert — that isolation genuinely does not exist
    // there. Skipping records the gap rather than asserting it away.
    const a = brokerSocketPath(join(tmpdir(), "c".repeat(90), "one"), tag);
    const b = brokerSocketPath(join(tmpdir(), "c".repeat(90), "two"), tag);
    expect(dirname(a)).not.toBe(dirname(b));
  });
});
