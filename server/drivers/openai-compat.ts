// OpenAI-compatible driver — any endpoint that speaks the OpenAI
// chat-completions shape (OpenRouter, Groq, Together, a local llama.cpp,
// …). This is the "free models" entry point: point it at OpenRouter's
// free tier or Groq's open-model endpoints and a bot runs without a
// paid Claude/Codex/Grok subscription.
//
// Transcript-replay like grok.ts: the harness folds thread history and
// hands it back each turn (SendTurnInput.transcript); we emit true
// token-level content.delta events and supply generateText.
import { z } from "zod";

import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "openai-compat";

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  stream_options?: { include_usage: true };
  provider?: { order: string[]; allow_fallbacks: false };
}

interface TokenUsage {
  input: number;
  output: number;
}

interface PartialTokenUsage {
  input?: number;
  output?: number;
}

const configPayloadSchema = z.object({
  url: z.string().optional().catch(undefined),
  apiKeyEnv: z.string().optional().catch(undefined),
  key: z.string().optional().catch(undefined),
  model: z.string().optional().catch(undefined),
  provider: z.string().optional().catch(undefined),
}).catch({});

const upstreamUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
}).refine(
  (usage) => usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined,
).transform((usage): PartialTokenUsage => ({
  input: usage.prompt_tokens,
  output: usage.completion_tokens,
}));

const completionMessageSchema = z.object({
  content: z.string().nullish().catch(undefined),
  reasoning_content: z.string().nullish().catch(undefined),
}).catch({});

const completionResponseSchema = z.object({
  choices: z.array(z.object({ message: completionMessageSchema.optional() }).catch({})).catch([]),
  usage: upstreamUsageSchema.nullish().catch(undefined),
}).catch({ choices: [] });

const streamChunkSchema = z.object({
  choices: z.array(z.object({
    delta: z.object({
      content: z.string().nullish().catch(undefined),
      reasoning_content: z.string().nullish().catch(undefined),
    }).catch({}),
  }).catch({ delta: {} })).catch([]),
  usage: upstreamUsageSchema.nullish().catch(undefined),
}).catch({ choices: [] });

const modelRowSchema = z.object({
  id: z.string().optional().catch(undefined),
  name: z.string().optional().catch(undefined),
}).catch({});

const modelCatalogResponseSchema = z.union([
  z.array(modelRowSchema),
  z.object({ data: z.array(modelRowSchema).catch([]) }).transform((payload) => payload.data),
]).catch([]);

const externalErrorSchema = z.object({
  name: z.string().catch("Error"),
  message: z.string().catch("Unknown provider failure"),
});

function mergeUsage(
  current: TokenUsage | null,
  next: PartialTokenUsage | null | undefined,
): TokenUsage | null {
  if (!next) return current;
  if (!current) {
    return {
      input: next.input ?? 0,
      output: next.output ?? 0,
    };
  }
  return {
    input: Math.max(current.input, next.input ?? current.input),
    output: Math.max(current.output, next.output ?? current.output),
  };
}

// Default catalog — overwritten by /models when the endpoint answers.
// Free-tier-friendly defaults so the picker is never empty.
const DEFAULT_MODELS: ModelCatalog = {
  default: "meta-llama/llama-3.3-70b-instruct",
  options: [
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B (OpenRouter)" },
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (Groq)" },
  ],
};

export interface OpenAICompatConfig {
  /** Base URL, no trailing /v1 assumed — we append /chat/completions. */
  url: string;
  /** Env var (instance environment or process.env) carrying the API key. */
  apiKeyEnv: string;
  /** Direct API key if configured */
  key?: string;
  /** Default model when a turn doesn't specify one (seeds the picker). */
  model?: string;
  /** OpenRouter upstream provider slug to pin (e.g. "fireworks"). Sent as
   * `provider: { order: [provider], allow_fallbacks: false }` — but only to
   * OpenRouter endpoints: strict OpenAI-compatible servers (Groq et al.)
   * reject unknown top-level fields. */
  provider?: string;
}

/** True when the configured base URL points at OpenRouter (openrouter.ai or
 * a subdomain). Parses the hostname rather than substring-matching the whole
 * URL, so lookalike domains and path segments don't count. */
function isOpenRouterUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

const decodeConfig: ProviderDriver<OpenAICompatConfig>["decodeConfig"] = (raw) => {
  const payload = configPayloadSchema.parse(raw ?? {});
  const envUrl = process.env.OPENAI_COMPAT_URL;
  const envModel = process.env.OPENAI_COMPAT_MODEL;
  const envProvider = process.env.OPENAI_COMPAT_PROVIDER;
  return {
    url:
      payload.url
        ? payload.url.replace(/\/+$/, "")
        : envUrl
          ? envUrl.replace(/\/+$/, "")
          : "https://openrouter.ai/api/v1",
    apiKeyEnv: payload.apiKeyEnv || "OPENAI_COMPAT_API_KEY",
    key: payload.key || undefined,
    model: payload.model || envModel || undefined,
    provider: payload.provider || envProvider || undefined,
  };
};

function openAICompatSetupMessage(apiKeyEnv: string): string {
  return `Add your OpenAI-compatible API key in System → Connections, or set ${apiKeyEnv} for source or headless runs.`;
}

export const OpenAICompatDriver: ProviderDriver<OpenAICompatConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenAI-compatible (OpenRouter / Groq)",
    supportsMultipleInstances: true,
    access: "custom",
  },
  models: DEFAULT_MODELS,
  // No CLI to install — the "install" is getting a free API key.
  install: {
    docsUrl: "https://openrouter.ai/keys",
    signInCommand: "Open System → Connections and save your OpenAI-compatible API key.",
    command: {
      darwin: "OPENAI_COMPAT_API_KEY=sk-or-v1-... pnpm dev",
      linux: "OPENAI_COMPAT_API_KEY=sk-or-v1-... pnpm dev",
      win32: "$env:OPENAI_COMPAT_API_KEY='sk-or-v1-...'; pnpm dev",
    },
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<OpenAICompatConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const apiKey =
      config.key ??
      input.environment[config.apiKeyEnv] ??
      input.environment["OPENAI_COMPAT_API_KEY"] ??
      process.env[config.apiKeyEnv] ??
      process.env["OPENAI_COMPAT_API_KEY"] ??
      "";
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { abort: AbortController; turnId: string }>();
    // A configured default model seeds the picker so the intended model is
    // pre-selected before /models refreshes the catalog from the endpoint.
    let catalog: ModelCatalog = config.model
      ? {
          default: config.model,
          options: DEFAULT_MODELS.options.some((o) => o.id === config.model)
            ? DEFAULT_MODELS.options
            : [{ id: config.model, label: config.model }, ...DEFAULT_MODELS.options],
        }
      : DEFAULT_MODELS;

    const emit = (event: RuntimeEvent) => {
      for (const l of Array.from(listeners)) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const complete = async (
      messages: ChatMessage[],
      model: string,
      opts: {
        stream: boolean;
        signal?: AbortSignal;
        onDelta?: (d: string, streamKind?: "assistant_text" | "reasoning_text") => void;
      },
    ): Promise<{
      text: string;
      reasoning: string;
      usage: TokenUsage | null;
    }> => {
      const requestBody: ChatCompletionRequest = {
        model,
        messages,
        stream: opts.stream,
        stream_options: opts.stream ? { include_usage: true } : undefined,
      };
      if (config.provider && isOpenRouterUrl(config.url)) {
        requestBody.provider = { order: [config.provider], allow_fallbacks: false };
      }
      const res = await fetch(`${config.url}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        // OpenRouter routing is added above only for OpenRouter itself;
        // strict OpenAI-compatible endpoints reject the provider field.
        body: JSON.stringify(requestBody),
        signal: opts.signal ?? AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `upstream HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        );
      }
      if (!opts.stream) {
        const payload = completionResponseSchema.parse(await res.json());
        const message = payload.choices[0]?.message;
        return {
          text: message?.content ?? "",
          reasoning: message?.reasoning_content ?? "",
          usage: mergeUsage(null, payload.usage),
        };
      }
      let text = "";
      let reasoning = "";
      let usage: TokenUsage | null = null;
      if (!res.body) throw new Error("upstream returned no response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const processStreamLine = (rawLine: string) => {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        let chunk: z.output<typeof streamChunkSchema>;
        try {
          chunk = streamChunkSchema.parse(JSON.parse(data));
        } catch {
          return;
        }
        const delta = chunk.choices?.[0]?.delta;
        const contentDelta = delta?.content ?? undefined;
        const reasoningDelta = delta?.reasoning_content ?? undefined;
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          opts.onDelta?.(reasoningDelta, "reasoning_text");
        }
        if (contentDelta) {
          text += contentDelta;
          opts.onDelta?.(contentDelta, "assistant_text");
        }
        usage = mergeUsage(usage, chunk.usage);
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          processStreamLine(line);
        }
      }
      buf += decoder.decode();
      if (buf) processStreamLine(buf);
      return { text, reasoning, usage };
    };

    // Whether the last catalog probe actually reached the endpoint. snapshot()
    // reads this so the engine cannot report "Ready" while every send fails.
    let lastProbe: { ok: true } | { ok: false; rejectedKey: boolean; reason: string } | null = null;
    let probeInFlight: Promise<void> | null = null;

    const fetchModels = async (): Promise<void> => {
      if (!apiKey) return;
      try {
        const res = await fetch(`${config.url}/models`, {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) {
          // Only two statuses prove the instance cannot run. A 404 is normal
          // for compatible servers that never implement /models, and a 429 or
          // 5xx here says nothing about whether completions work, so those
          // keep the optimistic state rather than disabling a usable engine.
          lastProbe = res.status === 401 || res.status === 403
            ? { ok: false, rejectedKey: true, reason: "the endpoint rejected this API key" }
            : { ok: true };
          return;
        }
        const rows = modelCatalogResponseSchema.parse(await res.json());
        const seen = new Set<string>();
        const options: ModelCatalog["options"] = [];
        for (const row of rows) {
          const id = row.id ?? "";
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const label = row.name?.trim() ? row.name : id;
          options.push({ id, label });
        }
        if (options.length) {
          // Keep a configured default selected; surface it even if the
          // endpoint's catalog omits it.
          const preferred =
            config.model && (options.some((o) => o.id === config.model) ? config.model : null);
          if (config.model && !preferred) options.unshift({ id: config.model, label: config.model });
          catalog = { default: config.model ?? options[0].id, options };
        }
        lastProbe = { ok: true };
      } catch (error) {
        // The catalog itself still falls back to DEFAULT_MODELS — a miss must
        // not empty the picker — but the instance no longer claims to be
        // reachable when it demonstrably is not.
        lastProbe = {
          ok: false,
          rejectedKey: false,
          reason: `could not reach ${config.url} (${error instanceof Error ? error.message : String(error)})`,
        };
      }
    };
    if (apiKey) probeInFlight = fetchModels();

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (!apiKey) {
        throw new Error(`no API key — ${openAICompatSetupMessage(config.apiKeyEnv)}`);
      }
      if (active.has(threadId)) {
        throw new Error("a turn is already running on this thread");
      }
      const turnId = newId();
      const abort = new AbortController();
      active.set(threadId, { abort, turnId });

      const messages = [
        ...(turn.system ? [{ role: "system", content: turn.system }] : []),
        ...(turn.transcript ?? []).map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.text,
        })),
        { role: "user", content: turn.text },
      ];
      appendNative(threadId, {
        dir: "out",
        source: "openai-compat.chat.completions",
        // Native logs are diagnostic artifacts users commonly attach to
        // issues. Keep routing metadata, not prompts or transcript content.
        msg: { model: turn.model ?? catalog.default, messageCount: messages.length },
      });

      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({
        ...base(threadId, turnId),
        type: "session.started",
        sessionId: null,
        model: turn.model ?? catalog.default,
      });

      (async () => {
        try {
          const { text, reasoning, usage } = await complete(
            messages,
            turn.model || catalog.default,
            {
              stream: true,
              signal: abort.signal,
              onDelta: (delta, streamKind = "assistant_text") =>
                emit({
                  ...base(threadId, turnId),
                  type: "content.delta",
                  streamKind,
                  delta,
                }),
            },
          );
          appendNative(threadId, {
            dir: "in",
            source: "openai-compat.chat.completions",
            msg: { textLength: text.length, reasoningLength: reasoning.length, usage },
          });
          const replyText = text.trim() ? text : reasoning;
          if (replyText.trim()) {
            emit({
              ...base(threadId, turnId),
              type: "item.completed",
              itemType: "assistant_text",
              text: replyText,
            });
          }
          if (usage) {
            emit({
              ...base(threadId, turnId),
              type: "thread.token-usage.updated",
              ...usage,
            });
          }
          active.delete(threadId);
          const completedEvent: RuntimeEvent = {
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: true,
            stopReason: null,
            cost: null,
          };
          if (usage) completedEvent.usage = usage;
          emit(completedEvent);
        } catch (e) {
          active.delete(threadId);
          const nativeError = z.instanceof(Error).safeParse(e);
          const errorPayload = externalErrorSchema.safeParse(e);
          const error = nativeError.success
            ? nativeError.data
            : new Error(errorPayload.success ? errorPayload.data.message : String(e));
          if (!nativeError.success && errorPayload.success) error.name = errorPayload.data.name;
          const aborted = error.name === "AbortError";
          if (!aborted) {
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: error.message,
            });
          }
          emit({
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: false,
            stopReason: aborted ? "interrupted" : "error",
            cost: null,
          });
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      if (!apiKey) {
        return {
          state: "unavailable",
          reason: `no API key — ${openAICompatSetupMessage(config.apiKeyEnv)}`,
        };
      }
      // Wait out the first probe so the very first /api/instances answer is
      // based on evidence rather than on the mere presence of a key string.
      if (probeInFlight) await probeInFlight;
      if (lastProbe && !lastProbe.ok) {
        return {
          state: "unavailable",
          reason: lastProbe.reason,
          authenticated: lastProbe.rejectedKey ? false : undefined,
        };
      }
      return { state: "available", authenticated: true, version: null, billing: "metered" };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return catalog;
      },
      refreshModels: fetchModels,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session" },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        respondToRequest: async () => "unavailable" as const,
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { abort } of active.values()) abort.abort();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: async (prompt: string) => {
        const { text, reasoning } = await complete(
          [{ role: "user", content: prompt }],
          catalog.default,
          { stream: false },
        );
        return text.trim() ? text : reasoning;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };
  },
};
