// Keeping secrets out of the native protocol log.
//
// The native tee writes every provider message verbatim, which is what makes
// protocol drift diagnosable — but the messages that set a session up carry
// the credentials the agent is handed: the box token and the comms token
// travel inside `session/new`'s mcpServers env, and a Composio consumer key
// travels in an MCP header. Those logs sit in ~/.helmryth/native as
// ordinary files, are read by anyone debugging, and get pasted into issues.
//
// So the log keeps the SHAPE and loses the VALUES: a redacted entry still
// tells you a token was passed, under which name, and how long it was —
// enough to debug "the proxy got no token" without the token being there.
import { z } from "zod";

import type { RuntimeEvent } from "./contracts.ts";

/** Key names whose value is a credential. Matched case-insensitively as a
 * substring, so KEY catches ANTHROPIC_API_KEY and x-api-key. */
const SECRET_KEY_PARTS = ["token", "secret", "password", "passwd", "apikey", "api_key", "authorization", "auth_token"];

/** `key` alone is too broad — it matches `keyboard`, `keys`, `hotkey`. Only
 * treat it as a credential when it stands alone or is a suffix, which is how
 * every real one is spelled (API_KEY, consumer-key, xai_key). */
function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SECRET_KEY_PARTS.some((part) => lower.includes(part))) return true;
  return /(^|[_.-])keys?$/.test(lower);
}

const mask = (value: string) => `«redacted ${value.length} chars»`;
/** A body that a previous pass already masked. Every other pattern is immune
 * to a second pass because `«` is outside its value charset, but the PEM body
 * is `[\s\S]*?` and happily re-matches its own placeholder — remasking it
 * would report the placeholder's length instead of the key's ("«redacted 20
 * chars»" for a 200-char key). Redaction runs on paths that can double-apply
 * (a redacted event replayed back through the bus), and a wrong length is a
 * false statement in a security-facing message. */
const MASKED = /^«redacted \d+ chars»$/;

// ── content-shaped secrets ────────────────────────────────────────────
// What a bot's own reply, a tool title, or a permission card can carry —
// and, since the rebuild replays activity into every handed-over context,
// what would otherwise become permanent. High precision on purpose: a
// generic "long hex/base64" heuristic would rewrite real code in the
// transcript, so only shapes that are unmistakably credentials match.

const KEY_PREFIXES: RegExp[] = [
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, // anthropic / openai / stripe
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // github classic
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // github fine-grained
  /\bxox[abposr]-[A-Za-z0-9-]{20,}/g, // slack
  /\bAKIA[0-9A-Z]{16}\b/g, // aws access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g, // google api key
  /\bnpm_[A-Za-z0-9]{20,}/g, // npm
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // gitlab personal access token
  /\bpypi-[A-Za-z0-9_-]{16,}/g, // pypi api token
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // jwt
];
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/g;
const PEM_BLOCK = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z ]*PRIVATE KEY-----)/g;
/** key=value / key: value / key="value" where the key is secret-shaped.
 * The value must be a single token of some length; prose after a colon
 * ("password: leave blank…") has spaces and does not match. */
const KEY_VALUE =
  /\b((?:[A-Za-z0-9_-]*_)?(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)s?)(["']?\s*[=:]\s*)(["']?)([A-Za-z0-9._~+/=-]{8,})\3/gi;

export function redactSecretsInText(text: string): string {
  if (!text || text.length < 8) return text;
  let out = text;
  out = out.replace(PEM_BLOCK, (match, open: string, body: string, close: string) => {
    const inner = body.trim();
    return MASKED.test(inner) ? match : `${open}\n${mask(inner)}\n${close}`;
  });
  for (const re of KEY_PREFIXES) out = out.replace(re, (m) => mask(m));
  out = out.replace(BEARER, (_m, lead: string, tok: string) => `${lead}${mask(tok)}`);
  out = out.replace(KEY_VALUE, (_m, key: string, sep: string, quote: string, value: string) => `${key}${sep}${quote}${mask(value)}${quote}`);
  return out;
}

/** Deep copy with credential VALUES replaced. Handles the two shapes that
 * actually carry them: a plain object of env vars ({KEY: "v"}) and the ACP
 * wire shape (env: [{name, value}]). Anything unrecognised is copied as-is. */
export interface RedactedObject {
  [key: string]: RedactedValue;
}
export type RedactedValue = string | number | boolean | null | undefined | RedactedValue[] | RedactedObject;

const stringSchema = z.string();
const scalarSchema = z.union([z.number(), z.boolean(), z.null(), z.undefined()]);
const arraySchema = z.array(z.unknown());
const objectSchema = z.record(z.string(), z.unknown());
const acpEnvironmentEntrySchema = z.object({ name: z.string(), value: z.string() });
const MAX_REDACTION_DEPTH = 12;

/** Convert an arbitrary protocol payload into a JSON-safe, secret-redacted
 * tree. Each structural branch is parsed before traversal. Cycles and trees
 * beyond the depth bound collapse to null instead of retaining an unscanned
 * object that could still contain a credential. */
function redactNode<Input>(input: Input, depth: number, seen: WeakSet<object>): RedactedValue {
  const text = stringSchema.safeParse(input);
  if (text.success) return redactSecretsInText(text.data);

  const scalar = scalarSchema.safeParse(input);
  if (scalar.success) return scalar.data;

  if (depth > MAX_REDACTION_DEPTH) return null;

  const array = arraySchema.safeParse(input);
  if (array.success) {
    if (seen.has(array.data)) return null;
    seen.add(array.data);
    return array.data.map((item) => redactNode(item, depth + 1, seen));
  }

  const record = objectSchema.safeParse(input);
  if (!record.success) return undefined;
  if (seen.has(record.data)) return null;
  seen.add(record.data);

  // ACP env entries use {name,value}; the variable name decides whether the
  // whole value is a credential, while ordinary values still get the normal
  // content-shaped secret pass.
  const environmentEntry = acpEnvironmentEntrySchema.safeParse(record.data);
  const out: RedactedObject = {};
  for (const [key, value] of Object.entries(record.data)) {
    const stringValue = stringSchema.safeParse(value);
    if (stringValue.success && isSecretName(key)) {
      out[key] = mask(stringValue.data);
      continue;
    }
    if (environmentEntry.success && key === "value") {
      out[key] = isSecretName(environmentEntry.data.name)
        ? mask(environmentEntry.data.value)
        : redactSecretsInText(environmentEntry.data.value);
      continue;
    }
    // Any other string may still contain a credential (a command line, a
    // header value, or a reply), so recurse through the same content pass.
    out[key] = redactNode(value, depth + 1, seen);
  }
  return out;
}

export function redactSecrets<Input>(input: Input): RedactedValue {
  return redactNode(input, 0, new WeakSet<object>());
}

/** Produce the single canonical RuntimeEvent used by every EventBus sink.
 * Stable routing/correlation identifiers remain intact; every provider- or
 * model-authored text field and the native payload pass through redaction. */
export function redactRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  const canonical: RuntimeEvent = { ...event };
  if (event.raw) {
    canonical.raw = {
      source: event.raw.source,
      payload: redactSecrets(event.raw.payload),
    };
  }

  switch (canonical.type) {
    case "session.started":
      canonical.sessionId = canonical.sessionId === null ? null : redactSecretsInText(canonical.sessionId);
      if (canonical.model !== undefined && canonical.model !== null) {
        canonical.model = redactSecretsInText(canonical.model);
      }
      break;
    case "session.exited":
      if (canonical.reason !== undefined) canonical.reason = redactSecretsInText(canonical.reason);
      break;
    case "turn.retrying":
      canonical.reason = redactSecretsInText(canonical.reason);
      break;
    case "turn.completed":
      if (canonical.stopReason !== undefined && canonical.stopReason !== null) {
        canonical.stopReason = redactSecretsInText(canonical.stopReason);
      }
      if (canonical.denials) canonical.denials = canonical.denials.map(redactSecretsInText);
      break;
    case "item.started":
      if (canonical.title !== undefined) canonical.title = redactSecretsInText(canonical.title);
      break;
    case "item.completed":
      if (canonical.itemType === "assistant_text") canonical.text = redactSecretsInText(canonical.text);
      break;
    case "content.delta":
      canonical.delta = redactSecretsInText(canonical.delta);
      break;
    case "request.opened":
      canonical.tool = redactSecretsInText(canonical.tool);
      canonical.summary = redactSecretsInText(canonical.summary);
      if (canonical.choices) canonical.choices = canonical.choices.map(redactSecretsInText);
      break;
    case "runtime.error":
      canonical.message = redactSecretsInText(canonical.message);
      break;
    case "turn.started":
    case "item.updated":
    case "request.resolved":
    case "thread.token-usage.updated":
      break;
  }
  return canonical;
}
