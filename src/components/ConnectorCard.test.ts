import { describe, expect, it } from "vitest";

import {
  connectorDismissedCopy,
  inlineConnectorInventoryUpdate,
  parseConnectorDismissResult,
} from "./ConnectorCard";

describe("inline connector inventory handoff", () => {
  it("marks a successful inline connection current but nonauthoritative until account refresh", () => {
    expect(inlineConnectorInventoryUpdate("ACTIVE")).toEqual({
      connected: true,
      pending: false,
      status: "ACTIVE",
    });
  });

  it("keeps a confirmed decline visible and names whether the run continued", () => {
    const settled = parseConnectorDismissResult({
      dismissed: true,
      outcome: "declined",
      resumed: true,
      pending: 0,
    });
    expect(connectorDismissedCopy(settled.resumed, settled.pending)).toEqual({
      description: "Connection declined. The operator run is continuing without this capability.",
      status: "Run continuing",
    });
    expect(connectorDismissedCopy(false, 2).status).toBe("2 capability decisions remain");
  });
});

// The server answers /dismiss with connectorDismissResponse(), whose `message` is
// the whole ConnectorMessage object — never a string. The client schema used to
// demand `message: z.string()`, so EVERY "Not now" threw a ZodError that the card
// then rendered raw. Parse the shape the server actually sends.
describe("dismiss result parses what the server actually returns", () => {
  const declinedResponse = {
    dismissed: true,
    outcome: "declined" as const,
    resumed: false,
    pending: 1,
    message: { id: "m1", kind: "connector", connector: { slug: "gmail", dismissed: true } },
  };

  it("accepts the server's object-valued message instead of throwing", () => {
    expect(() => parseConnectorDismissResult(declinedResponse)).not.toThrow();
    expect(parseConnectorDismissResult(declinedResponse)).toMatchObject({ outcome: "declined", pending: 1 });
  });

  it("still rejects a genuinely malformed result", () => {
    // SAFETY: `outcome` is deliberately off-contract here — the assertion under test
    // is that the parser rejects it, so the value must bypass the compile-time enum.
    const badOutcome: Parameters<typeof parseConnectorDismissResult>[0] = {
      dismissed: true,
      outcome: "declined",
      resumed: false,
      pending: 0,
    };
    // SAFETY: the cast is the test — it forces a value the enum forbids past the
    // compiler so the runtime parser can be shown to reject it.
    const offContract = "nope" as typeof badOutcome.outcome;
    expect(() => parseConnectorDismissResult({ ...badOutcome, outcome: offContract })).toThrow();
    expect(() => parseConnectorDismissResult({ dismissed: true, outcome: "declined", resumed: false, pending: -1 })).toThrow();
  });
});
