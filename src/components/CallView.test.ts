import { describe, expect, it } from "vitest";

import { parseSpokenGateDecision } from "@/lib/voice-gate";

describe("spoken Gate decisions", () => {
  it.each(["yes", "Yep.", "allow", "approve!", "go ahead", "do it", "please do"])(
    "accepts the complete allow phrase %s",
    (phrase) => {
      expect(parseSpokenGateDecision(phrase)).toBe("allow");
    },
  );

  it.each(["no", "Nope.", "don't", "do not", "deny", "cancel", "never", "skip it"])(
    "accepts the complete deny phrase %s",
    (phrase) => {
      expect(parseSpokenGateDecision(phrase)).toBe("deny");
    },
  );

  it.each([
    "yes, don't do it",
    "yeah no",
    "sure, but stop",
    "fine",
    "okay",
    "approve after checking",
    "do it unless it is destructive",
    "no, actually yes",
  ])("rejects ambiguous or qualified speech: %s", (phrase) => {
    expect(parseSpokenGateDecision(phrase)).toBeNull();
  });
});
