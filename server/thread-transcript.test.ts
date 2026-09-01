import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { purgeThreadTranscript } from "./thread-transcript.ts";

const roots: string[] = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), "hry-thread-transcript-"));
  roots.push(path);
  return path;
};

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("purgeThreadTranscript", () => {
  it("treats only missing legacy snapshots as idempotent success", () => {
    const dataDir = root();
    expect(purgeThreadTranscript("missing-thread", dataDir)).toEqual({ database: true, legacyFilesRemoved: 0 });
  });

  it("surfaces a non-missing legacy unlink failure", () => {
    const dataDir = root();
    mkdirSync(join(dataDir, "messages-unlink-failure.json"));
    expect(() => purgeThreadTranscript("unlink-failure", dataDir)).toThrow();
  });
});
