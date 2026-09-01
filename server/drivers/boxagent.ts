// Box agent driver — the purest form of the idea: the turn runs ON the
// bot's own cloud computer (box.ascii.dev), not on this machine. Uses the
// Box substrate's native agent facility:
//   POST /boxes/{id}/prompt   {provider: codex|claude-code, model, prompt}
//   GET  /boxes/{id}/prompts/{promptId}    run status
//   GET  /boxes/{id}/events                work events (polled)
//   POST /boxes/{id}/interrupt             stop running work
// The agent has the box's full desktop (Chrome, shell, disk) — the server
// separately polls screenshots so the chat shows the bot's screen live.
//
// The event payload shapes are tolerated liberally and teed verbatim to
// the native log — the same protocol-drift armor as every other driver.
import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import type { JsonValue } from "../schema.ts";
import { appendNative } from "./native.ts";
import { z } from "zod";

const DRIVER_KIND = "boxAgent";
const BOX_API = "https://ascii.dev/api/box/v1";

const MODELS = {
  default: "claude-fable-5",
  options: [
    { id: "claude-fable-5", label: "Claude Fable 5 · on the box" },
    { id: "sonnet", label: "Claude Sonnet · on the box" },
    { id: "gpt-5.4", label: "GPT-5.4 (Codex) · on the box" },
  ],
};

const providerFor = (model: string) => (model.startsWith("gpt") ? "codex" : "claude-code");

export interface BoxAgentConfig {
  pollMs: number;
}

const boxAgentConfigSchema = z.looseObject({ pollMs: z.number().int().min(1).max(60_000).optional() });
const boxJsonSchema = z.json();
const optionalWireString = z.string().optional().catch(undefined);
const optionalWireId = z
  .union([z.string(), z.number()])
  .transform(String)
  .optional()
  .catch(undefined);
const boxApiEnvelopeSchema = z.looseObject({
  ok: z.boolean().optional().catch(undefined),
  code: optionalWireString,
  error: optionalWireString,
});
const boxOptionalEnvelopeSchema = z.union([boxApiEnvelopeSchema, z.null()]);
const boxStartedSchema = z.looseObject({
  promptRun: z.looseObject({ id: optionalWireId }).optional().catch(undefined),
  prompt: z.looseObject({ id: optionalWireId }).optional().catch(undefined),
  promptId: optionalWireId,
});
const boxEventSchema = z
  .looseObject({
    id: optionalWireId,
    eventId: optionalWireId,
    type: optionalWireString,
    kind: optionalWireString,
    text: optionalWireString,
    message: optionalWireString,
    title: optionalWireString,
    command: optionalWireString,
    data: z
      .looseObject({ text: optionalWireString, content: optionalWireString })
      .optional()
      .catch(undefined),
  })
  .catch({});
const boxEventsSchema = z.looseObject({
  events: z.array(boxEventSchema).optional().catch(undefined),
  items: z.array(boxEventSchema).optional().catch(undefined),
});
const boxPromptStatusSchema = z
  .looseObject({
    status: optionalWireString,
    result: optionalWireString,
    output: optionalWireString,
  })
  .catch({});
const boxStatusSchema = z.looseObject({
  promptRun: boxPromptStatusSchema.optional().catch(undefined),
  prompt: boxPromptStatusSchema.optional().catch(undefined),
  status: optionalWireString,
  result: optionalWireString,
  output: optionalWireString,
});

class BoxApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "BoxApiError";
    this.status = status;
  }
}

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function decodeConfig(rawConfig: JsonValue | undefined): BoxAgentConfig {
  const config = boxAgentConfigSchema.parse(rawConfig ?? {});
  return { pollMs: config.pollMs ?? 2500 };
}

export const BoxAgentDriver: ProviderDriver<BoxAgentConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Computer", supportsMultipleInstances: false },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<BoxAgentConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const token = input.environment.BOX_TOKEN ?? process.env.BOX_TOKEN ?? "";
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { cancel: () => void; turnId: string; boxId: string }>();

    const emit = (event: RuntimeEvent) => {
      for (const listener of listeners) listener(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const api = async <Output>(path: string, schema: z.ZodType<Output>, opts: RequestInit = {}): Promise<Output> => {
      const timeoutSignal = AbortSignal.timeout(30_000);
      const requestSignal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
      const res = await fetch(`${BOX_API}${path}`, {
        ...opts,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...opts.headers },
        signal: requestSignal,
      });
      const body = boxJsonSchema.parse(await res.json().catch(() => null));
      const envelope = boxApiEnvelopeSchema.safeParse(body);
      if (!res.ok || (envelope.success && envelope.data.ok === false)) {
        const code = envelope.success ? (envelope.data.code ?? envelope.data.error) : undefined;
        throw new BoxApiError(res.status, code ?? `box HTTP ${res.status}`);
      }
      return schema.parse(body);
    };

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      const computer = turn.integrations?.computer;
      const boxId = computer && (!computer.kind || computer.kind === "box") ? computer.boxId : undefined;
      if (!token) throw new Error('box not configured — add {"box":{"token":"…"}} to ~/.helmryth/config.json');
      if (!boxId) {
        throw new Error("This operator has no Workbench yet. Open the Workbench panel and provision one.");
      }
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      const model = turn.model || MODELS.default;
      const pollController = new AbortController();

      const prompt = [
        turn.system,
        "You are working on your own cloud computer — its desktop, Chrome, and shell are yours.",
        "",
        turn.text,
      ]
        .filter((s) => s !== undefined)
        .join("\n");

      const started = await api(`/boxes/${boxId}/prompt`, boxStartedSchema, {
        method: "POST",
        body: JSON.stringify({ provider: providerFor(model), model, prompt }),
      });
      appendNative(threadId, { dir: "out", source: "box.prompt", msg: { model, prompt, response: started } });
      // real shape (2026-08): {type:"prompt.queued", promptId, promptRun:{id,…},
      // id:<box id>} — never fall back to the bare id, it's the box's
      const promptId = started?.promptRun?.id ?? started?.prompt?.id ?? started?.promptId ?? null;

      let cancelled = false;
      active.set(threadId, {
        turnId,
        boxId,
        cancel: () => {
          cancelled = true;
          pollController.abort();
          void api(`/boxes/${boxId}/interrupt`, boxOptionalEnvelopeSchema, { method: "POST" }).catch(() => {});
        },
      });
      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: promptId, model });

      // poll events + run status until the prompt settles
      (async () => {
        const seen = new Set<string>();
        const startedAt = Date.now();
        let lastText = "";
        let pendingText = "";
        /** Emit unflushed deltas as assistant_text and reset pendingText. */
        const flushAssistantText = () => {
          const text = pendingText;
          pendingText = "";
          if (!text.trim()) return;
          emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
        };
        /** Stream a full-text snapshot as a delta and accumulate it for flush. */
        const ingest = (text: string) => {
          const delta = text.startsWith(lastText) ? text.slice(lastText.length) : text;
          lastText = text;
          if (!delta) return;
          pendingText += delta;
          emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
        };
        try {
          let consecutivePollFailures = 0;
          for (;;) {
            if (cancelled) break;
            await waitForPoll(config.pollMs, pollController.signal);
            if (cancelled) break;
            let events: z.output<typeof boxEventsSchema>;
            let status: z.output<typeof boxStatusSchema> | null = null;
            try {
              events = await api(`/boxes/${boxId}/events`, boxEventsSchema, { signal: pollController.signal });
              if (promptId) {
                status = await api(`/boxes/${boxId}/prompts/${promptId}`, boxStatusSchema, {
                  signal: pollController.signal,
                });
              }
              consecutivePollFailures = 0;
            } catch (error) {
              if (cancelled) break;
              consecutivePollFailures += 1;
              const isAuthenticationFailure = error instanceof BoxApiError && (error.status === 401 || error.status === 403);
              if (isAuthenticationFailure || consecutivePollFailures >= 3) throw error;
              continue;
            }
            const list = events?.events ?? events?.items ?? [];
            for (const ev of list) {
              const id = String(ev.id ?? ev.eventId ?? JSON.stringify(ev).slice(0, 120));
              if (seen.has(id)) continue;
              seen.add(id);
              appendNative(threadId, { dir: "in", source: "box.events", msg: ev });
              const kind = String(ev.type ?? ev.kind ?? "");
              // "response" events carry the agent's text at data.content —
              // the FULL text so far, not a chunk. Clients accumulate
              // deltas, so forward only the growth; a drifted (non-prefix)
              // event re-sends whole and the settled message replaces the
              // stream anyway.
              const text = ev.text ?? ev.message ?? ev.data?.text ?? ev.data?.content ?? null;
              if (/assistant|message|output|response/i.test(kind) && text?.trim()) {
                ingest(text);
              } else if (/tool|command|exec|browse/i.test(kind)) {
                flushAssistantText();
                emit({
                  ...base(threadId, turnId),
                  type: "item.started",
                  itemType: "tool",
                  itemId: id,
                  title: String(ev.title ?? ev.command ?? kind).slice(0, 80),
                });
              }
              // shape-drift backstop: without a promptId the status poll
              // below can never see a terminal state, so settle off the
              // events themselves instead of hanging to the 30-min ceiling
              if (!promptId && /complete|finish|done|success|fail|error/i.test(kind)) {
                active.delete(threadId);
                flushAssistantText();
                const failed = /fail|error/i.test(kind);
                emit({ ...base(threadId, turnId), type: "turn.completed", ok: !failed, stopReason: failed ? kind : null, cost: null });
                return;
              }
            }
            if (promptId) {
              appendNative(threadId, { dir: "in", source: "box.prompt.status", msg: status });
              // real shape (2026-08): {promptRun:{status:"finished",…}} —
              // flat fallbacks kept for drift
              const run = status?.promptRun ?? status?.prompt ?? status;
              const state = String(run?.status ?? "");
              if (/completed|succeeded|done|finished/i.test(state)) {
                const result = run?.result ?? run?.output ?? lastText;
                if (result?.trim() && result !== lastText) {
                  ingest(result);
                }
                if (!pendingText.trim() && !lastText.trim()) pendingText = "(finished)";
                flushAssistantText();
                active.delete(threadId);
                emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
                return;
              }
              if (/failed|error|cancelled|interrupted/i.test(state)) {
                flushAssistantText();
                active.delete(threadId);
                emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: state, cost: null });
                return;
              }
            }
            if (Date.now() - startedAt > 30 * 60_000) {
              throw new Error("box run exceeded 30 minutes — interrupted");
            }
          }
          // cancelled
          flushAssistantText();
          active.delete(threadId);
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "interrupted", cost: null });
        } catch (error) {
          flushAssistantText();
          active.delete(threadId);
          const message = error instanceof Error ? error.message : String(error);
          emit({ ...base(threadId, turnId), type: "runtime.error", message });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "error", cost: null });
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      if (!token) {
        return { state: "unavailable", reason: 'no Box token — add {"box":{"token":"…"}} to ~/.helmryth/config.json' };
      }
      try {
        await api("/me", boxOptionalEnvelopeSchema);
        return { state: "available", authenticated: true, version: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { state: "unavailable", reason: `box API unreachable: ${message}` };
      }
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models: MODELS,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session" },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.cancel(),
        respondToRequest: async (): Promise<"unavailable"> => "unavailable", // this engine has no asks to answer
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { cancel } of active.values()) cancel();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        for (const { cancel } of active.values()) cancel();
        listeners.clear();
      },
    };
  },
};
