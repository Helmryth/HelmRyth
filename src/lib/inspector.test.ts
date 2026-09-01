import { describe, expect, it } from "vitest";

import { summarizeNative, summarizeRuntime, toRows, type InspectorEntry, type NativeRecord } from "./inspector";

const base = { eventId: "e", provider: "claudeAgent" as const, threadId: "t", createdAt: "2026-08-17T10:00:00.000Z" };

describe("summarizeRuntime", () => {
  it("labels turn boundaries and failures by tone", () => {
    expect(summarizeRuntime({ ...base, type: "turn.started", turnId: "abcdef12-rest" })).toEqual({
      summary: "run started · abcdef12",
      tone: "boundary",
    });
    expect(summarizeRuntime({ ...base, type: "turn.completed", ok: true, stopReason: "end_turn", cost: 0.01234 })).toEqual({
      summary: "run completed · end_turn · $0.0123",
      tone: "boundary",
    });
    expect(summarizeRuntime({ ...base, type: "turn.completed", ok: false })).toEqual({
      summary: "run failed",
      tone: "error",
    });
    expect(summarizeRuntime({ ...base, type: "turn.retrying", reason: "rate limited", attempt: 2, delayMs: 3_000 })).toEqual({
      summary: "run retry · rate limited · attempt 2 · 3s",
      tone: "plain",
    });
    const diagnostic = "upstream HTTP 404: model private-preview-2026 does not exist";
    const runtimeError = { ...base, type: "runtime.error" as const, message: diagnostic, setup: true };
    expect(summarizeRuntime(runtimeError).summary).toBe(
      "This engine is not ready. Finish its setup in Settings, then try again.",
    );
    expect(summarizeRuntime(runtimeError).summary).not.toMatch(/HTTP|private-preview|404/i);

    const [row] = toRows([{ kind: "runtime", at: "1", data: runtimeError }]);
    expect(row.summary).not.toContain(diagnostic);
    expect(row.data).toMatchObject({ message: diagnostic });
  });

  it("keeps session identifiers and provider diagnostics out of collapsed Trace rows", () => {
    const started = {
      ...base,
      type: "session.started" as const,
      sessionId: "provider-session-private-42",
      model: "invalid-final-private-model",
    };
    const exited = {
      ...base,
      type: "session.exited" as const,
      reason: "upstream HTTP 404 at private.fixture.invalid for invalid-final-private-model",
    };

    expect(summarizeRuntime(started)).toEqual({ summary: "engine session started", tone: "plain" });
    expect(summarizeRuntime(exited)).toEqual({ summary: "engine session ended", tone: "plain" });

    const rows = toRows([
      { kind: "runtime", at: "1", data: started },
      { kind: "runtime", at: "2", data: exited },
    ]);
    expect(rows.map((row) => row.summary).join(" ")).not.toMatch(
      /provider-session|invalid-final|upstream|HTTP|private\.fixture/i,
    );
    expect(rows[0]?.data).toMatchObject({ sessionId: "provider-session-private-42", model: "invalid-final-private-model" });
    expect(rows[1]?.data).toMatchObject({ reason: expect.stringContaining("private.fixture.invalid") });
  });

  it("clips long operator text to one line", () => {
    const text = "line one\nline two ".repeat(30);
    const { summary } = summarizeRuntime({ ...base, type: "item.completed", itemType: "assistant_text", text });
    expect(summary.startsWith("operator: line one line two")).toBe(true);
    expect(summary.length).toBeLessThanOrEqual("operator: ".length + 120);
    expect(summary).not.toContain("\n");
  });
});

describe("summarizeNative", () => {
  const record = (msg: NativeRecord["msg"]): NativeRecord => ({ at: "", dir: "out", source: "acp", msg });

  it("labels a claude stream_event instead of rendering [object Object]", () => {
    // `event` was typed as a string for antigravity's stream, but Claude's
    // stream_event frames carry an OBJECT there. The whole record failed to
    // parse and fell through to String(msg), so the Trace's Provider lens
    // showed a wall of "[object Object]" — roughly half the rows on a Claude run.
    expect(summarizeNative(record({ type: "stream_event", event: { type: "content_block_delta" } })))
      .toBe("stream_event");
    // antigravity's string form still resolves through the event branch.
    expect(summarizeNative(record({ event: "agent.step", result: { status: "ok" } })))
      .toBe("agent.step · ok");
  });

  it("names JSON-RPC methods and claude stream-json messages", () => {
    expect(summarizeNative({ at: "", dir: "out", source: "acp", msg: { jsonrpc: "2.0", id: 3, method: "session/prompt" } })).toBe(
      "session/prompt #3",
    );
    expect(summarizeNative({ at: "", dir: "in", source: "claude", msg: { type: "assistant", message: { role: "assistant" } } })).toBe(
      "assistant · assistant",
    );
    expect(summarizeNative({ at: "", dir: "in", source: "acp", msg: { jsonrpc: "2.0", id: 3, result: {} } })).toBe("result #3");
    expect(summarizeNative({ at: "", dir: "in", source: "agy.stream", msg: { event: "result", result: { status: "SUCCESS" } } })).toBe(
      "result · SUCCESS",
    );
    expect(summarizeNative({ at: "", dir: "in", source: "agy.stream", msg: { event: "step_update", step: {} } })).toBe("step_update");
  });
});

describe("toRows", () => {
  it("folds a run of content.delta on one stream into one row", () => {
    const entries: InspectorEntry[] = [
      { kind: "runtime", at: "1", data: { ...base, eventId: "a", type: "turn.started" } },
      { kind: "runtime", at: "2", data: { ...base, eventId: "b", type: "content.delta", streamKind: "assistant_text", delta: "Hel" } },
      { kind: "runtime", at: "3", data: { ...base, eventId: "c", type: "content.delta", streamKind: "assistant_text", delta: "lo" } },
      { kind: "runtime", at: "4", data: { ...base, eventId: "d", type: "content.delta", streamKind: "reasoning_text", delta: "hmm" } },
      { kind: "native", at: "5", data: { at: "5", dir: "in", source: "claude", msg: { type: "result" } } },
    ];
    const rows = toRows(entries);
    expect(rows.map((r) => [r.tag, r.count, r.summary])).toEqual([
      ["run.started", 1, "run started"],
      ["content.delta", 2, "operator_text: Hello"],
      ["content.delta", 1, "reasoning_text: hmm"],
      ["← in", 1, "claude · result"],
    ]);
  });

  it("builds a bounded folded preview without rejoining the full delta history", () => {
    const entries: InspectorEntry[] = Array.from({ length: 500 }, (_, i) => ({
      kind: "runtime" as const,
      at: String(i),
      data: { ...base, eventId: `d${i}`, type: "content.delta" as const, streamKind: "assistant_text" as const, delta: `word${i} ` },
    }));
    const [row] = toRows(entries);
    expect(row.count).toBe(500);
    expect(row.summary).toMatch(/^operator_text: word0 word1/);
    expect(row.summary.endsWith("…")).toBe(true);
    expect(row.summary.length).toBeLessThanOrEqual("operator_text: ".length + 120);
    expect(row.data).toHaveLength(500);
  });
});
