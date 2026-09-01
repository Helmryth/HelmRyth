const ALLOW_GATE_PHRASES = new Set([
  "yes",
  "yep",
  "allow",
  "approve",
  "approved",
  "go ahead",
  "do it",
  "please do",
]);

const DENY_GATE_PHRASES = new Set([
  "no",
  "nope",
  "don't",
  "do not",
  "deny",
  "denied",
  "cancel",
  "never",
  "skip it",
]);

/** Voice consent is intentionally narrow: only an unqualified, complete
 * utterance can decide a consequential Gate. Mixed or additional language
 * returns null so the voice line asks again instead of guessing authority. */
export function parseSpokenGateDecision(text: string): "allow" | "deny" | null {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .replaceAll(/\s+/g, " ");
  if (ALLOW_GATE_PHRASES.has(normalized)) return "allow";
  if (DENY_GATE_PHRASES.has(normalized)) return "deny";
  return null;
}
