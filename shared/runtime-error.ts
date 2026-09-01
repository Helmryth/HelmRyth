/**
 * Stable, user-facing presentation for provider/runtime failures.
 *
 * RuntimeEvent.message is diagnostic data from a provider boundary. It may
 * contain HTTP vocabulary, configured model identifiers, endpoint details, or
 * other implementation-specific text. Keep that diagnostic in the redacted
 * Trace record; never interpolate it into a workstream, roster preview, or
 * other ordinary product surface.
 */
export type RuntimeErrorKind =
  | "setup"
  | "authentication"
  | "usage-limit"
  | "configuration"
  | "connection"
  | "request"
  | "interrupted";

export interface RuntimeErrorPresentation {
  kind: RuntimeErrorKind;
  message: string;
}

function classifyRuntimeDiagnostic(diagnostic: string): RuntimeErrorKind | null {
  const value = diagnostic.toLowerCase();
  // Checked ahead of the 401/403 branch on purpose. OpenAI answers "this model
  // cannot be used for chat" with HTTP 403, which would otherwise be presented
  // as a credential failure and send the user off to re-enter a key that is
  // working perfectly well. The phrases here are model-capability specific, so
  // a genuine authorization failure still falls through to "authentication".
  if (
    /not allowed to sample from this model|not a chat model|model[ _-]?not[ _-]?found/.test(value)
    || /model[^.]{0,40}does not exist/.test(value)
  ) return "configuration";
  if (
    /\b(?:401|403)\b/.test(value)
    || /auth(?:entication|orization)?|unauthori[sz]ed|forbidden|credential|api[ _-]?key|token[_ -]?revoked|sign[ -]?in|log[ -]?in/.test(value)
  ) return "authentication";
  if (/\b429\b|rate[ _-]?limit|quota|billing|insufficient[ _-]?(?:credit|fund)|account[ _-]?limit/.test(value)) {
    return "usage-limit";
  }
  if (
    /\b(?:400|404|405|409|415|422)\b/.test(value)
    || /\bmodel\b|configuration|invalid[ _-]?(?:request|parameter)|unsupported|not[ _-]?found/.test(value)
  ) return "configuration";
  if (
    /\b5\d\d\b|upstream|timed?[ _-]?out|timeout|network|socket|fetch failed|econn|enotfound|connection (?:closed|refused|reset)/.test(value)
  ) return "connection";
  if (/content[ _-]?(?:filter|policy)|safety|blocked|refused|declined/.test(value)) return "request";
  return null;
}

const PRESENTATIONS = {
  setup: "This engine is not ready. Finish its setup in Settings, then try again.",
  authentication: "This engine connection needs attention. Reconnect it in Settings, then try again.",
  "usage-limit": "This engine is temporarily unavailable because of an account limit. Review its account or wait, then try again.",
  configuration: "This engine rejected the current run configuration. Review its engine settings, then try again.",
  connection: "The engine could not be reached. Check the connection and try again.",
  request: "The engine could not process this direction. Revise it and try again.",
  interrupted: "The engine stopped before completing this run. Try again, or open Trace for technical details.",
} as const satisfies Record<RuntimeErrorKind, string>;

const RUNTIME_ERROR_KINDS = [
  "setup",
  "authentication",
  "usage-limit",
  "configuration",
  "connection",
  "request",
  "interrupted",
] as const satisfies readonly RuntimeErrorKind[];

function knownPresentation(message: string): RuntimeErrorPresentation | null {
  const normalized = message.trim();
  const kind = RUNTIME_ERROR_KINDS.find((candidate) => PRESENTATIONS[candidate] === normalized);
  return kind ? { kind, message: PRESENTATIONS[kind] } : null;
}

/**
 * Classify untrusted provider diagnostics without carrying any part of the
 * input into the returned copy. This is intentionally idempotent so clients
 * can protect records written by older server versions without degrading
 * records that were already normalized at the server boundary.
 */
export function presentRuntimeError(diagnostic: string, setup = false): RuntimeErrorPresentation {
  const known = knownPresentation(diagnostic);
  if (known) return known;
  if (setup) return { kind: "setup", message: PRESENTATIONS.setup };

  const kind = classifyRuntimeDiagnostic(diagnostic) ?? "interrupted";
  return { kind, message: PRESENTATIONS[kind] };
}

/** Protect an activity label produced by an older server snapshot. */
export function presentRuntimeActivityLabel(label: string, setup = false, runtimeError = false): string {
  if (!/^\s*error\s*:/i.test(label)) return label;
  const diagnostic = label.replace(/^\s*error\s*:\s*/i, "");
  // Preserve actionable product-authored errors (delegation conflicts,
  // watchdog stops, unavailable connected apps). Runtime-origin records carry
  // an explicit marker; older records are normalized only when their text has
  // a recognisable provider/transport signature.
  if (!runtimeError && !knownPresentation(diagnostic) && !classifyRuntimeDiagnostic(diagnostic)) return label;
  return `error: ${presentRuntimeError(diagnostic, setup).message}`;
}
