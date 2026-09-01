// Codex model catalog — official ChatGPT rows stay in the main picker;
// everything the user already wired in ~/.codex (providers, profiles,
// cached catalogs, live /v1/models) is tagged `custom` so ModelPicker
// can hide it behind Custom. `codex app-server` thread/start takes
// `model` + `modelProvider` separately; picker ids encode both.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";

import type { ModelCatalog } from "../contracts.ts";
import { killCliTree, spawnCli } from "../procs.ts";
import { parseJson, type JsonValue } from "../schema.ts";
import { mergeLocalInject } from "./local-inject.ts";

export const STATIC_CODEX_MODELS: ModelCatalog = {
  default: "gpt-5.6-sol",
  options: [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
  ],
};

/** Built-in ChatGPT / OpenAI provider id. Official picker rows force this
 *  so a user's local `model_provider = "omlx"` does not swallow GPT-5.6. */
export const OFFICIAL_CODEX_PROVIDER = "openai";

const SEP = "::";
const MODEL_ID = /^[\w][\w./:+-]*$/;
const PROVIDER_ID = /^[a-z][a-z0-9_-]*$/i;

export interface CodexSelection {
  model: string | null;
  modelProvider: string | null;
}

type AppServerPendingRequest = "initialize" | "models";

interface AppServerInitializeRequest {
  method: "initialize";
  params: { clientInfo: { name: "helmryth"; version: "1" } };
}

interface AppServerModelsRequest {
  method: "model/list";
  params: { cursor: string | null; limit: 100 };
}

type AppServerRequest = AppServerInitializeRequest | AppServerModelsRequest;

interface CodexAppServerModel {
  id: string;
  displayName?: string;
  hidden?: boolean;
  isDefault?: boolean;
}

const appServerResponseSchema = z.object({
  id: z.number().int(),
  error: z.unknown().optional(),
  result: z.unknown().optional(),
}).passthrough();

const appServerModelSchema: z.ZodType<CodexAppServerModel> = z.object({
  id: z.string(),
  displayName: z.string().optional().catch(undefined),
  hidden: z.boolean().optional().catch(undefined),
  isDefault: z.boolean().optional().catch(undefined),
}).passthrough();

const appServerModelPageSchema = z.object({
  data: z.array(z.unknown()).optional().catch(undefined),
  nextCursor: z.string().nullable().optional().catch(undefined),
}).passthrough();

export function encodeCodexSelection(provider: string, model: string): string {
  return `${provider}${SEP}${model}`;
}

export function decodeCodexSelection(id: string | null | undefined): CodexSelection {
  if (!id) return { model: null, modelProvider: null };
  const sep = id.indexOf(SEP);
  if (sep > 0) {
    return { model: id.slice(sep + SEP.length), modelProvider: id.slice(0, sep) };
  }
  // Every official app-server picker row has a bare id. Custom providers are
  // always provider-qualified above, so a newly released cloud model must not
  // silently fall through to the user's configured local provider.
  return { model: id, modelProvider: MODEL_ID.test(id) ? OFFICIAL_CODEX_PROVIDER : null };
}

/** Ask the installed Codex CLI for the ChatGPT model catalog it can actually
 * use. This is the authoritative subscription catalog and changes more often
 * than Helmryth releases, so consume every page instead of hard-coding the
 * current set forever. */
export function readCodexAppServerModelCatalog(
  cli: string,
  env: Record<string, string | undefined>,
  timeoutMs = 8_000,
): Promise<ModelCatalog | null> {
  return new Promise((resolve) => {
    const child = spawnCli(cli, ["app-server"], {
      cwd: homedir(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let buffer = "";
    let nextId = 1;
    const models: CodexAppServerModel[] = [];
    const cursors = new Set<string>();
    const pending = new Map<number, AppServerPendingRequest>();

    const finish = (catalog: ModelCatalog | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killCliTree(child);
      resolve(catalog);
    };
    const request = (request: AppServerRequest, kind: AppServerPendingRequest) => {
      const id = nextId++;
      pending.set(id, kind);
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...request })}\n`);
      } catch {
        finish(null);
      }
    };
    const requestModels = (cursor: string | null) => {
      request({ method: "model/list", params: { cursor, limit: 100 } }, "models");
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try {
          const parsedMessage = appServerResponseSchema.safeParse(parseJson(line));
          if (!parsedMessage.success) continue;
          message = parsedMessage.data;
        } catch {
          continue;
        }
        const kind = pending.get(message.id);
        if (!kind) continue;
        pending.delete(message.id);
        if (message.error) {
          finish(null);
          return;
        }
        if (kind === "initialize") {
          try {
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
          } catch {
            finish(null);
            return;
          }
          requestModels(null);
          continue;
        }

        const parsedPage = appServerModelPageSchema.safeParse(message.result);
        if (!parsedPage.success) {
          finish(null);
          return;
        }
        for (const candidate of parsedPage.data.data ?? []) {
          const parsedModel = appServerModelSchema.safeParse(candidate);
          if (parsedModel.success) models.push(parsedModel.data);
        }
        const cursor = parsedPage.data.nextCursor || null;
        if (cursor && !cursors.has(cursor)) {
          cursors.add(cursor);
          requestModels(cursor);
          continue;
        }

        const options: ModelCatalog["options"] = [];
        const seen = new Set<string>();
        let defaultModel: string | null = null;
        for (const row of models) {
          if (row.hidden === true || !MODEL_ID.test(row.id) || seen.has(row.id)) continue;
          seen.add(row.id);
          options.push({
            id: row.id,
            label: row.displayName?.trim() ? row.displayName : row.id,
          });
          if (row.isDefault === true) defaultModel = row.id;
        }
        if (!options.length) {
          finish(null);
          return;
        }
        finish({
          default: defaultModel && seen.has(defaultModel) ? defaultModel : options[0].id,
          options,
        });
      }
    });
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    request({ method: "initialize", params: { clientInfo: { name: "helmryth", version: "1" } } }, "initialize");
  });
}

export function codexHome(env: Record<string, string | undefined>): string {
  if (env.CODEX_HOME) return env.CODEX_HOME;
  return join(env.HOME || env.USERPROFILE || homedir(), ".codex");
}

function unquote(raw: string): string {
  let value = raw.trim();
  const hash = value.indexOf(" #");
  if (hash !== -1 && !(value.startsWith('"') || value.startsWith("'"))) {
    value = value.slice(0, hash).trim();
  }
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      return value.slice(1, -1).replace(/\\"/g, '"');
    }
  }
  return value;
}

interface CodexProvider {
  id: string;
  name?: string;
  baseUrl?: string;
  envKey?: string;
}

interface CodexToml {
  model?: string;
  modelProvider?: string;
  providers: CodexProvider[];
}

function parseCodexToml(text: string): CodexToml {
  const result: CodexToml = { providers: [] };
  const byId = new Map<string, CodexProvider>();
  let section: "root" | "other" | CodexProvider = "root";

  const providerFor = (id: string): CodexProvider => {
    let provider = byId.get(id);
    if (!provider) {
      provider = { id };
      byId.set(id, provider);
      result.providers.push(provider);
    }
    return provider;
  };

  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      const inner = stripped.slice(1, -1);
      const match = /^model_providers\.(.+)$/.exec(inner);
      if (match) {
        let id = match[1];
        if (id.startsWith('"') && id.endsWith('"')) id = id.slice(1, -1);
        section = PROVIDER_ID.test(id) ? providerFor(id) : "other";
      } else {
        section = "other";
      }
      continue;
    }
    const eq = stripped.indexOf("=");
    if (eq < 0) continue;
    const key = stripped.slice(0, eq).trim();
    const value = unquote(stripped.slice(eq + 1));
    if (!value) continue;
    if (section === "root") {
      if (key === "model") result.model = value;
      if (key === "model_provider") result.modelProvider = value;
      continue;
    }
    if (section === "other") continue;
    if (key === "name") section.name = value;
    if (key === "base_url") section.baseUrl = value;
    if (key === "env_key") section.envKey = value;
  }
  return result;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function providerName(provider: string, known: Map<string, CodexProvider>): string {
  return known.get(provider)?.name || provider;
}

function niceLabel(model: string, provider: string, known: Map<string, CodexProvider>, named: Map<string, string>): string {
  const encoded = encodeCodexSelection(provider, model);
  const configured = named.get(encoded);
  if (configured) return configured;
  const host = providerName(provider, known);
  return host === provider ? model : `${model} (${host})`;
}

interface CachedCatalogEntry {
  slug?: string;
  id?: string;
  display_name?: string;
  name?: string;
}

const cachedCatalogEntrySchema: z.ZodType<CachedCatalogEntry> = z.object({
  slug: z.string().optional().catch(undefined),
  id: z.string().optional().catch(undefined),
  display_name: z.string().optional().catch(undefined),
  name: z.string().optional().catch(undefined),
}).passthrough().catch({});

const cachedCatalogEntriesSchema = z.array(cachedCatalogEntrySchema);
const cachedCatalogEnvelopeSchema = z.object({
  models: cachedCatalogEntriesSchema.optional().catch(undefined),
  data: cachedCatalogEntriesSchema.optional().catch(undefined),
}).passthrough();

function parseCachedCatalogEntries(payload: JsonValue): CachedCatalogEntry[] {
  const direct = cachedCatalogEntriesSchema.safeParse(payload);
  if (direct.success) return direct.data;
  const envelope = cachedCatalogEnvelopeSchema.safeParse(payload);
  if (!envelope.success) return [];
  return envelope.data.models ?? envelope.data.data ?? [];
}

function collectCatalogNames(home: string): Map<string, string> {
  const named = new Map<string, string>();
  for (const file of listDir(join(home, "model-catalogs"))) {
    if (!file.endsWith(".json")) continue;
    const provider = basename(file, ".json").replace(/-models$/, "");
    if (!PROVIDER_ID.test(provider)) continue;
    const raw = readText(join(home, "model-catalogs", file));
    if (!raw) continue;
    let parsed: JsonValue;
    try {
      parsed = parseJson(raw);
    } catch {
      continue;
    }
    for (const row of parseCachedCatalogEntries(parsed)) {
      const slug = row.slug ?? row.id ?? "";
      if (!MODEL_ID.test(slug)) continue;
      const label = row.display_name ?? row.name ?? "";
      if (label) named.set(encodeCodexSelection(provider, slug), label);
    }
  }
  return named;
}

interface ProviderModelEntry {
  id: string;
}

const providerModelEntrySchema: z.ZodType<ProviderModelEntry> = z.union([
  z.string().transform((id) => ({ id })),
  z.object({
    id: z.string().optional().catch(undefined),
    slug: z.string().optional().catch(undefined),
  }).passthrough().transform((entry) => ({ id: entry.id ?? entry.slug ?? "" })),
]).catch({ id: "" });

const providerModelEntriesSchema = z.array(providerModelEntrySchema);
const providerModelsEnvelopeSchema = z.object({
  data: providerModelEntriesSchema.optional().catch(undefined),
  models: providerModelEntriesSchema.optional().catch(undefined),
}).passthrough();

function idsFromModelsPayload(payload: JsonValue): string[] {
  const direct = providerModelEntriesSchema.safeParse(payload);
  const records = direct.success
    ? direct.data
    : (() => {
        const envelope = providerModelsEnvelopeSchema.safeParse(payload);
        if (!envelope.success) return [];
        return envelope.data.data ?? envelope.data.models ?? [];
      })();
  return records.flatMap((record) => MODEL_ID.test(record.id) ? [record.id] : []);
}

async function probeProviderModels(
  provider: CodexProvider,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  if (!provider.baseUrl) return [];
  const url = `${provider.baseUrl.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> = {};
  if (provider.envKey && env[provider.envKey]) {
    headers.Authorization = `Bearer ${env[provider.envKey]}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers });
    if (!response.ok) return [];
    return idsFromModelsPayload(parseJson(await response.text()));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Local slugs Codex already knows, plus the three official cloud rows. */
export async function readCodexModelCatalog(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  cli?: string,
): Promise<ModelCatalog> {
  const official = (cli ? await readCodexAppServerModelCatalog(cli, env) : null) ?? STATIC_CODEX_MODELS;
  const home = codexHome(env);
  const mainText = readText(join(home, "config.toml"));
  if (!mainText) return mergeLocalInject(official, env, fetchImpl);

  const main = parseCodexToml(mainText);
  const known = new Map(main.providers.map((provider) => [provider.id, provider]));
  const named = collectCatalogNames(home);
  const extras: Array<{ provider: string; model: string }> = [];

  const remember = (provider: string | undefined, model: string | undefined) => {
    if (!provider || !model) return;
    if (!PROVIDER_ID.test(provider) || !MODEL_ID.test(model)) return;
    // A local provider may expose the same slug as an official OpenAI model.
    // Keep that provider-qualified row; otherwise selecting the configured
    // default would decode the bare slug back to the OpenAI provider.
    if (
      provider === OFFICIAL_CODEX_PROVIDER &&
      official.options.some((option) => option.id === model)
    ) return;
    extras.push({ provider, model });
  };

  remember(main.modelProvider, main.model);

  for (const file of listDir(home)) {
    if (!file.endsWith(".config.toml")) continue;
    const profile = parseCodexToml(readText(join(home, file)) ?? "");
    for (const provider of profile.providers) {
      if (!known.has(provider.id)) known.set(provider.id, provider);
    }
    remember(profile.modelProvider ?? main.modelProvider, profile.model);
  }

  for (const [encoded, _label] of named) {
    const decoded = decodeCodexSelection(encoded);
    if (decoded.model && decoded.modelProvider) remember(decoded.modelProvider, decoded.model);
  }

  const live = await Promise.all(
    [...known.values()].map(async (provider) => {
      const ids = await probeProviderModels(provider, env, fetchImpl);
      return ids.map((model) => ({ provider: provider.id, model }));
    }),
  );
  for (const row of live.flat()) remember(row.provider, row.model);

  const options = official.options.map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  for (const extra of extras) {
    const id = encodeCodexSelection(extra.provider, extra.model);
    if (seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      label: niceLabel(extra.model, extra.provider, known, named),
      custom: true,
    });
  }

  const configured = main.model && main.modelProvider
    ? main.modelProvider === OFFICIAL_CODEX_PROVIDER &&
      official.options.some((option) => option.id === main.model)
      ? main.model
      : encodeCodexSelection(main.modelProvider, main.model)
    : main.model && seen.has(main.model)
      ? main.model
      : null;

  return mergeLocalInject(
    {
      default: configured && seen.has(configured) ? configured : official.default,
      options,
    },
    env,
    fetchImpl,
  );
}
