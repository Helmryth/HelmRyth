import { describe, expect, it } from "vitest";

import { presentRuntimeActivityLabel, presentRuntimeError } from "../../shared/runtime-error";

describe("provider runtime error presentation", () => {
  it.each([
    ["upstream HTTP 404: model 'private-preview-model-2026' does not exist", "configuration"],
    ["HTTP 401: invalid API key for private-engine", "authentication"],
    ["429 rate_limit_exceeded for account acct_private", "usage-limit"],
    ["upstream HTTP 503 at https://provider.internal/v1", "connection"],
    ["content_filter blocked the request", "request"],
    ["driver exploded with opaque detail", "interrupted"],
  ] as const)("maps %s to safe %s copy", (diagnostic, kind) => {
    const result = presentRuntimeError(diagnostic);

    expect(result.kind).toBe(kind);
    expect(result.message).not.toContain(diagnostic);
    expect(result.message).not.toMatch(/HTTP|private|provider\.internal|acct_/i);
  });

  it("gives setup failures actionable setup copy without reflecting diagnostics", () => {
    expect(presentRuntimeError("spawn /private/bin/engine ENOENT", true)).toEqual({
      kind: "setup",
      message: "This engine is not ready. Finish its setup in Settings, then try again.",
    });
  });

  it("is idempotent for server-normalized records", () => {
    const first = presentRuntimeError("upstream HTTP 404: secret-model");
    expect(presentRuntimeError(first.message)).toEqual(first);
  });

  it("normalizes only runtime-error activity labels", () => {
    expect(presentRuntimeActivityLabel("error: upstream HTTP 404: secret-model"))
      .toBe("error: This engine rejected the current run configuration. Review its engine settings, then try again.");
    expect(presentRuntimeActivityLabel("Bash: upstream HTTP 404")).toBe("Bash: upstream HTTP 404");
    expect(presentRuntimeActivityLabel("error: no activity for 10 minutes — the turn was stopped"))
      .toBe("error: no activity for 10 minutes — the turn was stopped");
    expect(presentRuntimeActivityLabel("error: opaque driver failure", false, true))
      .toBe("error: The engine stopped before completing this run. Try again, or open Trace for technical details.");
  });
});

describe("model-capability failures are not credential failures", () => {
  // OpenAI answers "this model cannot be used for chat" with HTTP 403. Classified
  // as "authentication" it tells the user to reconnect a key that is working fine.
  it.each([
    ["upstream HTTP 403: You are not allowed to sample from this model", "configuration"],
    ["upstream HTTP 400: This is not a chat model", "configuration"],
    ["upstream HTTP 404: model_not_found", "configuration"],
  ] as const)("classifies %s as %s", (diagnostic, kind) => {
    expect(presentRuntimeError(diagnostic).kind).toBe(kind);
  });

  // The narrow capability check above must not swallow genuine auth failures.
  it.each([
    ["upstream HTTP 401: Incorrect API key provided", "authentication"],
    ["upstream HTTP 403: Forbidden - your credential was revoked", "authentication"],
    ["upstream HTTP 429: rate limit exceeded", "usage-limit"],
    ["fetch failed", "connection"],
  ] as const)("still classifies %s as %s", (diagnostic, kind) => {
    expect(presentRuntimeError(diagnostic).kind).toBe(kind);
  });
});
