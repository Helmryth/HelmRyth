// The decision log's own mechanics: what a row looks like on disk, that
// credential-shaped content never reaches the file, that the file stays
// private, and that rotation keeps the fleet-wide log bounded without
// losing the recent past. The WIRING — which decisions get written at all
// — is pinned separately in decision-log-wiring.test.ts.
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendDecision, eraseDecisionsForThread, flushDecisionLog, readDecisions, type DecisionRow } from "./decision-log.ts";
import { removeTempDir } from "./testing/cleanup.ts";

let dir: string;
const file = () => join(dir, "decisions.ndjson");

const row = (overrides: Partial<DecisionRow> = {}): Omit<DecisionRow, "at"> => ({
  threadId: "t1",
  requestId: "req-1",
  botId: "b1",
  botName: "Scout",
  tool: "Bash",
  summary: "git status",
  decision: "auto-approved",
  source: "always-allow",
  rule: "Bash:git",
  ...overrides,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hry-decisions-"));
});

afterEach(async () => {
  await removeTempDir(dir);
});

describe("appendDecision / readDecisions", () => {
  it("writes one NDJSON row per decision and reads them back newest last", async () => {
    appendDecision(dir, row());
    appendDecision(dir, row({ requestId: "req-2", decision: "card-shown", source: "no-grant", rule: undefined }));
    await flushDecisionLog(dir);
    const rows = readDecisions(dir, 10);
    expect(rows).toHaveLength(2);
    expect(rows[0].decision).toBe("auto-approved");
    expect(rows[0].rule).toBe("Bash:git");
    expect(rows[0].botName).toBe("Scout");
    expect(Number.isNaN(new Date(rows[0].at).getTime())).toBe(false);
    expect(rows[1].decision).toBe("card-shown");
    expect(rows[1].source).toBe("no-grant");
  });

  it("returns only the newest `limit` rows", async () => {
    for (const id of ["req-1", "req-2", "req-3"]) appendDecision(dir, row({ requestId: id }));
    await flushDecisionLog(dir);
    const rows = readDecisions(dir, 2);
    expect(rows.map((r) => r.requestId)).toEqual(["req-2", "req-3"]);
  });

  it("keeps credential-shaped content out of the written row", async () => {
    // Both shapes redact.ts guards against: a known key prefix, and a
    // KEY=value pair with a secret-shaped name. The summary is whatever
    // the agent typed — this is exactly how a key ends up in a log.
    const secret = "sk-live-abcdefghijklmnop1234";
    appendDecision(dir, row({ summary: `export STRIPE_API_KEY=${secret}` }));
    await flushDecisionLog(dir);
    const raw = readFileSync(file(), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("redacted");
    expect(readDecisions(dir, 10)[0].summary).toContain("redacted");
  });

  it.skipIf(process.platform === "win32")("creates the file private (0600)", async () => {
    appendDecision(dir, row());
    await flushDecisionLog(dir);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("repairs a permissive live and rotated log without losing rows", async () => {
    appendDecision(dir, row({ requestId: "legacy" }));
    await flushDecisionLog(dir);
    chmodSync(dir, 0o755);
    chmodSync(file(), 0o644);
    appendDecision(dir, row({ requestId: "current" }), { maxBytes: 1 });
    await flushDecisionLog(dir);

    expect(readDecisions(dir, 10).map((entry) => entry.requestId)).toEqual(["legacy", "current"]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(statSync(`${file()}.1`).mode & 0o777).toBe(0o600);
  });

  it("rotates to a single .1 file at the cap, still reads across the seam, and stays bounded", async () => {
    // maxBytes 1: every append after the first finds the live file over
    // the cap and rotates it — three appends walk a row off the end.
    appendDecision(dir, row({ requestId: "req-A" }), { maxBytes: 1 });
    appendDecision(dir, row({ requestId: "req-B" }), { maxBytes: 1 });
    appendDecision(dir, row({ requestId: "req-C" }), { maxBytes: 1 });
    await flushDecisionLog(dir);
    expect(existsSync(`${file()}.1`)).toBe(true);
    // req-A has aged out entirely — the log is bounded, not archival —
    // while a read spanning the rotation still sees .1 before the live file
    expect(readDecisions(dir, 10).map((r) => r.requestId)).toEqual(["req-B", "req-C"]);
  });

  it("skips a corrupt line instead of losing the rows around it", async () => {
    appendDecision(dir, row({ requestId: "req-1" }));
    await flushDecisionLog(dir);
    appendFileSync(file(), "not json at all\n");
    appendDecision(dir, row({ requestId: "req-2" }));
    await flushDecisionLog(dir);
    expect(readDecisions(dir, 10).map((r) => r.requestId)).toEqual(["req-1", "req-2"]);
  });

  it("reads an empty log as an empty list, not an error", () => {
    expect(readDecisions(dir, 10)).toEqual([]);
  });

  it("serializes a burst without dropping or reordering rows", async () => {
    for (let i = 0; i < 100; i += 1) appendDecision(dir, row({ requestId: `req-${i}` }));
    await flushDecisionLog(dir);
    expect(readDecisions(dir, 100).map((entry) => entry.requestId)).toEqual(
      Array.from({ length: 100 }, (_, i) => `req-${i}`),
    );
  });

  it("erases one thread across rotated and live logs behind already queued appends", async () => {
    appendDecision(dir, row({ threadId: "erase-me", requestId: "old" }), { maxBytes: 1 });
    await flushDecisionLog(dir);
    appendDecision(dir, row({ threadId: "keep-me", requestId: "middle" }), { maxBytes: 1 });
    await flushDecisionLog(dir);
    appendDecision(dir, row({ threadId: "erase-me", requestId: "queued" }), { maxBytes: 1_000_000 });

    expect(await eraseDecisionsForThread(dir, "erase-me")).toBe(2);
    expect(readDecisions(dir, 20)).toEqual([expect.objectContaining({ threadId: "keep-me", requestId: "middle" })]);
    expect(await eraseDecisionsForThread(dir, "erase-me")).toBe(0);
  });
});
