// Cursor Agent CLI harness support — Anysphere's `cursor-agent acp` over ACP
// stdio, billed on the Cursor subscription (`cursor-agent login`,
// CURSOR_API_KEY, or CURSOR_AUTH_TOKEN). The generic protocol runtime lives in
// acp/core.ts; this file is only the per-harness quirks.
//
// Verified against the public CLI contract (cursor.com/docs/cli/acp,
// …/reference/parameters): `cursor-agent acp` speaks JSON-RPC on stdio, advertises
// `cursor_login`, and takes `--force` / `--model` as global flags before the
// `acp` subcommand. `session/set_model` is attempted when the CLI supports it;
// a missing method falls back to the argv `--model` pin.
import { z } from "zod";

import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { execCli } from "../../procs.ts";
import { parseJson, type JsonValue } from "../../schema.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

interface CursorSessionModel {
  modelId?: string;
  name?: string;
}

/** Translate an argv `--model` slug into the id this ACP session will accept.
 *
 * Cursor keeps two model namespaces and they do not match. `cursor-agent
 * models` and the `--model` flag speak flat slugs (`auto`, `gpt-5.3-codex`).
 * The ACP session advertises parameterised ids instead
 * (`default[]`, `gpt-5.3-codex[reasoning=medium,fast=false]`), and
 * `session/set_model` accepts *only* those. Sending the argv slug earns
 * `-32602 Invalid params` for every model, not merely unknown ones — which
 * read as "this account cannot use that model" and sent people to check their
 * subscription over a pure id-format mismatch.
 *
 * Matching walks from most to least specific, and `auto` is special-cased
 * because Cursor calls that entry `default[]` while naming it "Auto".
 *
 * Returns null when nothing matches, including when the agent advertised no
 * models at all. The caller then falls back to sending the slug unchanged,
 * which is what older CLIs that ignore the model list still expect.
 */
export function resolveCursorAcpModelId(
  available: readonly CursorSessionModel[],
  wanted: string,
): string | null {
  const want = wanted.trim().toLowerCase();
  if (!want) return null;
  const ids = available.filter(
    (model): model is CursorSessionModel & { modelId: string } => Boolean(model.modelId?.trim()),
  );
  if (!ids.length) return null;
  const base = (id: string) => id.split("[")[0].trim().toLowerCase();

  const exact = ids.find((model) => model.modelId.toLowerCase() === want);
  if (exact) return exact.modelId;

  const byBase = ids.find((model) => base(model.modelId) === want);
  if (byBase) return byBase.modelId;

  const byName = ids.find((model) => (model.name ?? "").trim().toLowerCase() === want);
  if (byName) return byName.modelId;

  if (want === "auto" || want === "default") {
    const dflt = ids.find((model) => base(model.modelId) === "default");
    if (dflt) return dflt.modelId;
  }
  return null;
}

export const STATIC_CURSOR_MODELS: ModelCatalog = {
  default: "auto",
  options: [
    { id: "auto", label: "Auto" },
    { id: "composer-2.5", label: "Composer 2.5" },
    { id: "composer-2.5-fast", label: "Composer 2.5 Fast" },
    { id: "gpt-5.3-codex", label: "Codex 5.3" },
    { id: "claude-sonnet-5-thinking-high", label: "Claude Sonnet 5 1M Thinking" },
  ],
};

const SLUG = /^[a-z0-9][a-z0-9._:+-]*$/i;
const EXEC_TIMEOUT_MS = 8_000;

const cursorModelObjectSchema = z.looseObject({
  id: z.string().optional(),
  modelId: z.string().optional(),
  slug: z.string().optional(),
  name: z.string().optional(),
  label: z.string().optional(),
  displayName: z.string().optional(),
});
const cursorModelRowSchema = z.union([
  z.string().transform((id) => ({ id, label: undefined })),
  cursorModelObjectSchema.transform((row) => {
    const id = row.id ?? row.modelId ?? row.slug ?? row.name;
    const label = row.label || row.displayName || (row.name && row.name !== id ? row.name : undefined);
    return { id, label };
  }),
]);
const cursorModelPayloadSchema = z.union([
  z.array(cursorModelRowSchema).transform((models) => ({ default: undefined, models })),
  z
    .looseObject({
      default: z.string().optional(),
      models: z.array(cursorModelRowSchema).optional(),
      data: z.array(cursorModelRowSchema).optional(),
      modelIds: z.array(cursorModelRowSchema).optional(),
    })
    .transform((payload) => ({
      default: payload.default,
      models: payload.models ?? payload.data ?? payload.modelIds ?? [],
    })),
]);
const cursorAuthStatusSchema = z.looseObject({
  isAuthenticated: z.json().optional(),
  authenticated: z.json().optional(),
  loggedIn: z.json().optional(),
  logged_in: z.json().optional(),
  status: z.json().optional(),
  auth: z
    .looseObject({
      isAuthenticated: z.json().optional(),
      authenticated: z.json().optional(),
      status: z.json().optional(),
    })
    .optional(),
});
const cursorFailureSchema = z.union([
  z
    .looseObject({
      code: z.union([z.string(), z.number()]).optional(),
      message: z.string().optional(),
    })
    .transform((failure) => ({ code: failure.code, message: failure.message ?? "" })),
  z.string().transform((message) => ({ code: undefined, message })),
  z.null().transform(() => ({ code: undefined, message: "" })),
  z.undefined().transform(() => ({ code: undefined, message: "" })),
]);

interface CursorFailure {
  code?: string | number;
  message: string;
}

type CursorFailureInput = Error | CursorFailure | string | null | undefined;

const nonBlank = (value: string | undefined): boolean => Boolean(value?.trim());

function firstJsonValue(text: string): JsonValue | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return parseJson(trimmed);
  } catch {
    // CLIs sometimes print a banner before the payload. Take the first
    // {...} or [...] span that parses, rather than requiring a clean stdout.
  }
  const start = trimmed.search(/[{[]/);
  if (start < 0) return null;
  for (let end = trimmed.length; end > start + 1; end--) {
    const slice = trimmed.slice(start, end).trim();
    if (!slice.endsWith("}") && !slice.endsWith("]")) continue;
    try {
      return parseJson(slice);
    } catch {
      // keep shrinking
    }
  }
  return null;
}

function labelFor(id: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  return id
    .split(/[-_./]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function pushModel(
  options: ModelCatalog["options"],
  seen: Set<string>,
  id: string,
  label?: string,
  custom = false,
): void {
  if (!SLUG.test(id) || seen.has(id)) return;
  seen.add(id);
  const option: ModelCatalog["options"][number] = { id, label: labelFor(id, label) };
  if (custom) option.custom = true;
  options.push(option);
}

/** Turn `cursor-agent models` JSON (or a close cousin) into a picker catalog.
 *  Unknown shapes return null so the caller can try text / keep the fallback. */
export function decodeCursorModelCatalog(payload: JsonValue): ModelCatalog | null {
  const parsed = cursorModelPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const records = parsed.data.models;
  if (!records.length) return null;

  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  for (const row of records) {
    if (!row.id) continue;
    pushModel(options, seen, row.id, row.label);
  }
  if (!options.length) return null;

  const configuredDefault = parsed.data.default;
  const defaultId =
    (configuredDefault && seen.has(configuredDefault) ? configuredDefault : undefined) ??
    (seen.has(STATIC_CURSOR_MODELS.default) ? STATIC_CURSOR_MODELS.default : options[0]!.id);

  // Keep the static cloud set at the front (stable picker rail) and append
  // live ids the static list does not already name.
  const merged: ModelCatalog["options"] = STATIC_CURSOR_MODELS.options.map((option) => ({ ...option }));
  const mergedSeen = new Set(merged.map((option) => option.id));
  for (const option of options) {
    if (mergedSeen.has(option.id)) continue;
    mergedSeen.add(option.id);
    merged.push(option);
  }
  return { default: defaultId, options: merged };
}

interface ModelMarkers {
  label: string;
  isDefault: boolean;
  isCurrent: boolean;
}

function stripModelMarkers(label: string): ModelMarkers {
  let cleaned = label.trim();
  let isDefault = false;
  let isCurrent = false;
  const defaultMatch = cleaned.match(/\s*\(default\)\s*$/i);
  if (defaultMatch) {
    isDefault = true;
    cleaned = cleaned.slice(0, defaultMatch.index).trim();
  }
  const currentMatch = cleaned.match(/\s*\(current\)\s*$/i);
  if (currentMatch) {
    isCurrent = true;
    cleaned = cleaned.slice(0, currentMatch.index).trim();
  }
  return { label: cleaned, isDefault, isCurrent };
}

/** Parse plain `cursor-agent models` text: one slug per line, optional `id - label`
 *  columns, and `(default)` / `(current)` markers on the label. */
export function decodeCursorModelText(text: string): ModelCatalog | null {
  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  let markedDefault: string | undefined;
  let markedCurrent: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || /^available\s+models?\b/i.test(line) || /^models?\b/i.test(line)) continue;
    const stripped = line.replace(/^[\s*•-]+\s*/, "");
    const parts = stripped.split(/\s+[—–|:]\s+|\s+-\s+|\s{2,}/);
    const id = (parts[0] ?? "").trim();
    const rawLabel = parts.slice(1).join(" ").trim();
    const { label, isDefault, isCurrent } = stripModelMarkers(rawLabel);
    pushModel(options, seen, id, label || undefined);
    if (isDefault) markedDefault = id;
    if (isCurrent) markedCurrent = id;
  }
  if (!options.length) return null;
  const merged: ModelCatalog["options"] = STATIC_CURSOR_MODELS.options.map((option) => ({ ...option }));
  const mergedSeen = new Set(merged.map((option) => option.id));
  for (const option of options) {
    if (mergedSeen.has(option.id)) continue;
    mergedSeen.add(option.id);
    merged.push(option);
  }
  const defaultId =
    (markedDefault && seen.has(markedDefault) ? markedDefault : undefined) ??
    (markedCurrent && seen.has(markedCurrent) ? markedCurrent : undefined) ??
    (seen.has(STATIC_CURSOR_MODELS.default) ? STATIC_CURSOR_MODELS.default : options[0]!.id);
  return { default: defaultId, options: merged };
}

function truthyAuthFlag(value: JsonValue | undefined): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  const parsed = z.string().safeParse(value);
  if (!parsed.success) return null;
  const normalized = parsed.data.trim().toLowerCase();
  if (["true", "authenticated", "logged_in", "logged-in", "yes"].includes(normalized)) return true;
  if (["false", "unauthenticated", "logged_out", "logged-out", "no"].includes(normalized)) return false;
  return null;
}

/** Read `cursor-agent status --format json`.
 *  Returns null when the payload does not actually answer the question. */
export function decodeCursorAuthStatus(payload: JsonValue): boolean | null {
  const parsed = cursorAuthStatusSchema.safeParse(payload);
  if (!parsed.success) return null;
  const rec = parsed.data;
  const auth = rec.auth;
  const candidates = [
    rec.isAuthenticated,
    rec.authenticated,
    rec.loggedIn,
    rec.logged_in,
    auth?.isAuthenticated,
    auth?.authenticated,
    rec.status,
    auth?.status,
  ];
  for (const candidate of candidates) {
    const flag = truthyAuthFlag(candidate);
    if (flag !== null) return flag;
  }
  return null;
}

/** Parse the documented human-readable `cursor-agent status` fallback. */
export function decodeCursorAuthText(text: string): boolean | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;
  if (/not (?:logged|signed) in|not authenticated|unauthenticated|logged out/.test(normalized)) return false;
  if (/login successful|logged in|signed in|authenticated/.test(normalized)) return true;
  return null;
}

function execText(
  run: typeof execCli,
  cli: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<string | null> {
  return new Promise((resolve) => {
    run(cli, args, { timeout: EXEC_TIMEOUT_MS, env }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout ?? ""));
    });
  });
}

export async function probeCursorAuth(
  cli: string,
  env: Record<string, string | undefined>,
  run: typeof execCli = execCli,
): Promise<boolean> {
  if (nonBlank(env.CURSOR_API_KEY) || nonBlank(env.CURSOR_AUTH_TOKEN)) return true;
  for (const args of [["status", "--format", "json"], ["status"]] as const) {
    const stdout = await execText(run, cli, [...args], env);
    if (stdout == null) continue;
    const decoded = decodeCursorAuthStatus(firstJsonValue(stdout)) ?? decodeCursorAuthText(stdout);
    if (decoded !== null) return decoded;
  }
  return false;
}

export async function fetchCursorModels(
  cli: string,
  env: Record<string, string | undefined>,
  run: typeof execCli = execCli,
): Promise<ModelCatalog> {
  // Live CLI prints plain text (`slug - Label`); `--format json` is not supported yet.
  for (const args of [["models"], ["--list-models"]] as const) {
    const stdout = await execText(run, cli, [...args], env);
    if (stdout == null) continue;
    const fromText = decodeCursorModelText(stdout);
    if (fromText) return fromText;
    const fromJson = decodeCursorModelCatalog(firstJsonValue(stdout));
    if (fromJson) return fromJson;
  }
  return STATIC_CURSOR_MODELS;
}

export function classifyCursorError(error: CursorFailureInput): ProviderErrorCode | undefined {
  const parsed = cursorFailureSchema.safeParse(error);
  const { code, message } = parsed.success ? parsed.data : { code: undefined, message: String(error ?? "") };
  const blob = `${code ?? ""} ${message}`.toLowerCase();
  if (
    code === -32000 ||
    /unauthoriz|unauthenticated|not signed in|not logged in|invalid api key|invalid_credentials|authentication required/.test(
      blob,
    )
  ) {
    return "invalid_credentials";
  }
  if (/inactive subscription|subscription.*(expired|inactive)|upgrade your (plan|subscription)/.test(blob)) {
    return "inactive_subscription";
  }
  return undefined;
}

const support = (run: typeof execCli): AcpSupport => ({
  driverKind: "cursorAgent",
  displayName: "Cursor",
  models: STATIC_CURSOR_MODELS,
  // Cursor and other coding agents can both install a generic `agent` shim.
  // Cursor's compatibility alias is unambiguous and ships with the same CLI.
  defaultCli: "cursor-agent",
  nativeSource: "cursor.acp",
  loginNote: "Cursor CLI is not signed in — run `cursor-agent login` in a terminal, or set CURSOR_API_KEY",

  install: {
    command: {
      darwin: "curl https://cursor.com/install -fsS | bash",
      linux: "curl https://cursor.com/install -fsS | bash",
      win32: "irm 'https://cursor.com/install?win32=true' | iex",
    },
    docsUrl: "https://cursor.com/docs/cli/installation",
    signInCommand: "cursor-agent login",
  },

  // Global flags must precede `acp` (cursor.com/docs/cli/reference/parameters).
  // `--force` is the documented auto-approve switch (`--yolo` is an alias);
  // `--model` is the reliable pin — ACP session/set_model is best-effort below.
  spawnArgs: (config, turn) => [
    ...(config.fullAuto ? ["--force"] : []),
    ...(turn.model ? ["--model", turn.model] : []),
    "acp",
  ],
  credentialEnv: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"],

  resolveModels: (environment, config) => fetchCursorModels(config.cli || "cursor-agent", environment, run),

  // Prefer the advertised ACP method. An already-signed-in CLI should accept
  // cursor_login without a browser; a missing method rides the ambient login
  // (CURSOR_API_KEY / `cursor-agent login`) instead of failing the turn.
  pickAuthMethod: (methods) => (methods.some((m) => m.id === "cursor_login") ? "cursor_login" : null),
  authFailure: "continue",
  isAuthenticated: (env, config) => probeCursorAuth(config.cli || "cursor-agent", env, run),
  classifyError: (error) => {
    const parsed = cursorFailureSchema.safeParse(error);
    return classifyCursorError(parsed.success ? parsed.data : String(error ?? ""));
  },

  async configureSession({ request, sessionId, turn, sessionModels }) {
    if (!turn.model) return;
    // Prefer the id this session actually advertised; fall back to the argv
    // slug so a CLI that advertises nothing behaves exactly as before.
    const modelId = resolveCursorAcpModelId(sessionModels ?? [], turn.model) ?? turn.model;
    try {
      await request("session/set_model", { sessionId, modelId });
    } catch (e) {
      const parsed = cursorFailureSchema.safeParse(e);
      const err = parsed.success ? parsed.data : { code: undefined, message: String(e ?? "") };
      // -32601 method missing, -32602 id not in this session's namespace. In
      // both cases spawnArgs already pinned `--model`, so the turn runs the
      // right model anyway; failing it here would refuse a working request.
      if (err.code === -32601 || err.code === -32602) return;
      throw new Error(
        `Cursor rejected model "${turn.model}" (sent as "${modelId}") via session/set_model: ${err.message}. ` +
          `Check that \`cursor-agent\` is current and that this account can use that model.`,
      );
    }
  },

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
});

export function createCursorAgentDriver(run: typeof execCli = execCli) {
  return createAcpDriver(support(run));
}

export const CursorAgentDriver = createCursorAgentDriver();
