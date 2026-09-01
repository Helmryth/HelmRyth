import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordEvents } from "../testing/events.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

describe("OpenAICompatDriver", () => {
  const savedUrl = process.env.OPENAI_COMPAT_URL;
  const savedKey = process.env.OPENAI_COMPAT_API_KEY;

  beforeEach(() => {
    delete process.env.OPENAI_COMPAT_URL;
    delete process.env.OPENAI_COMPAT_API_KEY;
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.OPENAI_COMPAT_URL;
    else process.env.OPENAI_COMPAT_URL = savedUrl;
    if (savedKey === undefined) delete process.env.OPENAI_COMPAT_API_KEY;
    else process.env.OPENAI_COMPAT_API_KEY = savedKey;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers with the openai-compat kind and a display name", () => {
    expect(OpenAICompatDriver.driverKind).toBe("openai-compat");
    expect(OpenAICompatDriver.metadata.displayName).toMatch(/OpenRouter|Groq/);
  });

  it("falls back to the OpenRouter endpoint by default", () => {
    const cfg = OpenAICompatDriver.defaultConfig();
    expect(cfg.url).toBe("https://openrouter.ai/api/v1");
    expect(cfg.apiKeyEnv).toBe("OPENAI_COMPAT_API_KEY");
  });

  it("honours an explicit url and apiKeyEnv override", () => {
    const cfg = OpenAICompatDriver.decodeConfig({
      url: "https://api.groq.com/openai/v1/",
      apiKeyEnv: "GROQ_KEY",
    });
    expect(cfg.url).toBe("https://api.groq.com/openai/v1");
    expect(cfg.apiKeyEnv).toBe("GROQ_KEY");
  });

  it("reports unavailable without an API key", async () => {
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-1",
      displayName: "Free",
      enabled: true,
      config: { url: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENAI_COMPAT_API_KEY" },
      environment: {},
    });
    const snap = await inst.snapshot();
    expect(snap.state).toBe("unavailable");
    expect(snap.reason).toContain("System → Connections");
    expect(snap.reason).toContain("OPENAI_COMPAT_API_KEY");
    expect(snap.reason).not.toContain("config.json");
    await inst.dispose();
  });

  it("reports unavailable when the endpoint cannot be reached, despite holding a key", async () => {
    // A key string alone proves nothing. Before this, snapshot() returned
    // {available, authenticated:true} for a dead endpoint and the picker said "Ready"
    // while every send failed.
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-unreachable",
      displayName: "Dead endpoint",
      enabled: true,
      config: { url: "http://127.0.0.1:1/v1", apiKeyEnv: "OPENAI_COMPAT_API_KEY" },
      environment: { OPENAI_COMPAT_API_KEY: "sk-test-not-a-real-key" },
    });
    const snap = await inst.snapshot();
    expect(snap.state).toBe("unavailable");
    expect(snap.reason).toContain("could not reach");
    await inst.dispose();
  });

  it("keeps setup guidance out of plaintext config instructions", () => {
    expect(OpenAICompatDriver.install?.signInCommand).toContain("System → Connections");
    for (const command of Object.values(OpenAICompatDriver.install?.command ?? {})) {
      expect(command).toContain("OPENAI_COMPAT_API_KEY");
      expect(command).not.toContain("config.json");
      expect(command).not.toContain("openaiCompat.key");
    }
  });

  it("exposes a refreshed model catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "vendor/model-a", name: "Model A" },
              { id: "vendor/model-b" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-models",
      displayName: "Models",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });

    await inst.refreshModels?.();

    expect(inst.models).toEqual({
      default: "vendor/model-a",
      options: [
        { id: "vendor/model-a", label: "Model A" },
        { id: "vendor/model-b", label: "vendor/model-b" },
      ],
    });
    await inst.dispose();
  });

  it("includes streamed token totals in turn.completed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        return new Response(
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-turn",
      displayName: "Turn",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread", text: "private prompt", model: "vendor/model" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 12, output: 3 } });
    recorder.stop();
    await inst.dispose();
  });

  it("requests the final usage chunk for streamed completions", async () => {
    let sentBody: { stream?: boolean; stream_options?: { include_usage?: boolean } } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        sentBody = JSON.parse(String(init?.body));
        return new Response(
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-stream-usage-request",
      displayName: "Usage request",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "usage-request", text: "prompt", model: "vendor/model" });
    await recorder.until((event) => event.type === "turn.completed");

    expect(sentBody).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    recorder.stop();
    await inst.dispose();
  });

  it("does not fabricate zero totals from an unsupported usage shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
            'data: {"choices":[],"usage":{"input_tokens":12,"output_tokens":3}}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-unsupported-usage",
      displayName: "Unsupported usage",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "unsupported-usage", text: "prompt", model: "vendor/model" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).not.toHaveProperty("usage");
    expect(recorder.events.some((event) => event.type === "thread.token-usage.updated")).toBe(false);
    recorder.stop();
    await inst.dispose();
  });

  it("parses a final usage event when the stream closes without a trailing newline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-final-buffer-usage",
      displayName: "Final buffer usage",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "final-buffer", text: "prompt", model: "vendor/model" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 9, output: 2 } });
    recorder.stop();
    await inst.dispose();
  });

  it("preserves reported zero-token usage instead of treating it as absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0}}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-zero-usage",
      displayName: "Zero usage",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "zero-usage", text: "prompt", model: "vendor/model" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 0, output: 0 } });
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "thread.token-usage.updated", input: 0, output: 0 }),
    );
    recorder.stop();
    await inst.dispose();
  });

  it("merges split final usage frames fieldwise", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":17}}\n' +
            'data: {"choices":[],"usage":{"completion_tokens":5}}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-split-usage",
      displayName: "Split usage",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "split-usage", text: "prompt", model: "vendor/model" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 17, output: 5 } });
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "thread.token-usage.updated", input: 17, output: 5 }),
    );
    recorder.stop();
    await inst.dispose();
  });

  it("does not sum duplicate cumulative usage frames", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-duplicate-usage",
      displayName: "Duplicate usage",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "duplicate-usage", text: "prompt", model: "vendor/model" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 12, output: 3 } });
    recorder.stop();
    await inst.dispose();
  });

  it("does not let a later lower usage frame reduce cumulative totals", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":17,"completion_tokens":5}}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":14,"completion_tokens":4}}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-lower-usage",
      displayName: "Lower usage",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "lower-usage", text: "prompt", model: "vendor/model" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 17, output: 5 } });
    recorder.stop();
    await inst.dispose();
  });

  it("keeps explicit all-zero usage valid when split across frames", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":0}}\n' +
            'data: {"choices":[],"usage":{"completion_tokens":0}}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-split-zero-usage",
      displayName: "Split zero usage",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "split-zero-usage", text: "prompt", model: "vendor/model" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 0, output: 0 } });
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "thread.token-usage.updated", input: 0, output: 0 }),
    );
    recorder.stop();
    await inst.dispose();
  });

  it("ignores malformed usage frames between valid cumulative frames", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":17}}\n' +
            'data: {"choices":[],"usage":{"input_tokens":999,"output_tokens":999}}\n' +
            'data: {"choices":[],"usage":{"completion_tokens":5}}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-malformed-between-valid",
      displayName: "Malformed between valid",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "malformed-between-valid", text: "prompt", model: "vendor/model" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 17, output: 5 } });
    recorder.stop();
    await inst.dispose();
  });

  it("completes safely when a provider omits usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n' + "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-absent-usage",
      displayName: "Absent usage",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "absent-usage", text: "prompt", model: "vendor/model" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true });
    expect(completed).not.toHaveProperty("usage");
    expect(recorder.events.some((event) => event.type === "thread.token-usage.updated")).toBe(false);
    recorder.stop();
    await inst.dispose();
  });

  it("does not report usage for an upstream error turn", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response("provider unavailable", { status: 503 });
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-error-usage",
      displayName: "Error usage",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "error-usage", text: "prompt", model: "vendor/model" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: false, stopReason: "error" });
    expect(completed).not.toHaveProperty("usage");
    expect(recorder.events.some((event) => event.type === "thread.token-usage.updated")).toBe(false);
    recorder.stop();
    await inst.dispose();
  });

  it("does not report usage if the stream aborts after a partial usage frame", async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n'));
            controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":17}}\n'));
            init?.signal?.addEventListener("abort", () => {
              controller.error(new DOMException("interrupted", "AbortError"));
            }, { once: true });
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-interrupted-partial-usage",
      displayName: "Interrupted partial usage",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "interrupted-partial-usage", text: "prompt", model: "vendor/model" });
    await inst.adapter.interruptTurn("interrupted-partial-usage");
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: false, stopReason: "interrupted" });
    expect(completed).not.toHaveProperty("usage");
    expect(recorder.events.some((event) => event.type === "thread.token-usage.updated")).toBe(false);
    recorder.stop();
    await inst.dispose();
  });

  it("does not report usage if the stream errors after a partial usage frame", async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n'));
            controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":17}}\n'));
            controller.error(new Error("socket closed"));
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-error-partial-usage",
      displayName: "Error partial usage",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "error-partial-usage", text: "prompt", model: "vendor/model" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: false, stopReason: "error" });
    expect(completed).not.toHaveProperty("usage");
    expect(recorder.events.some((event) => event.type === "thread.token-usage.updated")).toBe(false);
    recorder.stop();
    await inst.dispose();
  });

  it("does not fabricate usage when a streamed turn is interrupted before the final chunk", async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n'));
            init?.signal?.addEventListener("abort", () => {
              controller.error(new DOMException("interrupted", "AbortError"));
            }, { once: true });
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-interrupted-usage",
      displayName: "Interrupted usage",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "interrupted-usage", text: "prompt", model: "vendor/model" });
    await inst.adapter.interruptTurn("interrupted-usage");
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: false, stopReason: "interrupted" });
    expect(completed).not.toHaveProperty("usage");
    expect(recorder.events.some((event) => event.type === "thread.token-usage.updated")).toBe(false);
    recorder.stop();
    await inst.dispose();
  });

  it("streams reasoning separately and completes only actual assistant text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(
          'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n' +
            'data: {"choices":[{"delta":{"content":"answer"}}]}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-reasoning-stream",
      displayName: "Reasoning",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "reasoning-thread", text: "question", model: "vendor/model" });
    await recorder.until((event) => event.type === "turn.completed");

    expect(recorder.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "content.delta", streamKind: "reasoning_text", delta: "thinking" }),
      expect.objectContaining({ type: "content.delta", streamKind: "assistant_text", delta: "answer" }),
      expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "answer" }),
    ]));
    expect(recorder.events).not.toContainEqual(
      expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "thinking" }),
    );
    recorder.stop();
    await inst.dispose();
  });

  it("uses reasoning as a helper-model fallback when normal content is whitespace", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: "  ", reasoning_content: "usable result" } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-reasoning-helper",
      displayName: "Reasoning helper",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });

    await expect(inst.generateText?.("question")).resolves.toBe("usable result");
    await inst.dispose();
  });

  it("falls back to reasoning_content when content is empty (streaming)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(
          'data: {"choices":[{"delta":{"reasoning_content":"thinking through the problem"}}]}\n' +
            'data: {"choices":[{"delta":{"content":""}}]}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-reasoning-fallback-stream",
      displayName: "Reasoning Fallback",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread-rf", text: "prompt", model: "vendor/model" });
    const item = await recorder.until((e) => e.type === "item.completed");
    const completed = await recorder.until((e) => e.type === "turn.completed");

    expect(item).toMatchObject({
      type: "item.completed",
      itemType: "assistant_text",
      text: "thinking through the problem",
    });
    expect(completed).toMatchObject({ ok: true, usage: { input: 10, output: 5 } });

    const deltas = recorder.events.filter((e) => e.type === "content.delta");
    expect(deltas.some((d: any) => d.streamKind === "reasoning_text" && d.delta === "thinking through the problem")).toBe(true);

    recorder.stop();
    await inst.dispose();
  });

  it("decodes a default model and provider from config", () => {
    const cfg = OpenAICompatDriver.decodeConfig({
      model: "deepseek/deepseek-v4-flash-0731",
      provider: "fireworks",
    });
    expect(cfg.model).toBe("deepseek/deepseek-v4-flash-0731");
    expect(cfg.provider).toBe("fireworks");
  });

  it("seeds the picker with the configured default model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-default-model",
      displayName: "Default model",
      enabled: true,
      config: {
        url: "https://openrouter.ai/api/v1",
        apiKeyEnv: "TEST_KEY",
        model: "deepseek/deepseek-v4-flash-0731",
      },
      environment: { TEST_KEY: "secret" },
    });
    expect(inst.models.default).toBe("deepseek/deepseek-v4-flash-0731");
    expect(inst.models.options.some((o) => o.id === "deepseek/deepseek-v4-flash-0731")).toBe(true);
    await inst.dispose();
  });

  it("pins the OpenRouter upstream provider in the request body", async () => {
    let sentBody: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        sentBody = JSON.parse(String(init?.body));
        return new Response(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n' + "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-provider-route",
      displayName: "Provider route",
      enabled: true,
      config: {
        url: "https://openrouter.ai/api/v1",
        apiKeyEnv: "TEST_KEY",
        provider: "fireworks",
      },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({
      threadId: "thread-p",
      text: "prompt",
      model: "deepseek/deepseek-v4-flash-0731",
    });
    await recorder.until((e) => e.type === "turn.completed");

    expect(sentBody?.model).toBe("deepseek/deepseek-v4-flash-0731");
    expect(sentBody?.provider).toEqual({ order: ["fireworks"], allow_fallbacks: false });
    recorder.stop();
    await inst.dispose();
  });

  it("omits provider routing on non-OpenRouter endpoints even when configured", async () => {
    let sentBody: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        sentBody = JSON.parse(String(init?.body));
        return new Response(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n' + "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-groq-no-provider",
      displayName: "Groq strict",
      enabled: true,
      config: {
        url: "https://api.groq.com/openai/v1",
        apiKeyEnv: "TEST_KEY",
        provider: "fireworks",
      },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread-g", text: "prompt", model: "vendor/model" });
    await recorder.until((e) => e.type === "turn.completed");

    // Strict OpenAI-compatible endpoints (Groq et al.) reject unknown
    // top-level fields — `provider` is OpenRouter-only routing.
    expect(sentBody).not.toBeNull();
    expect("provider" in sentBody).toBe(false);
    recorder.stop();
    await inst.dispose();
  });

  it("does not treat a lookalike host as OpenRouter", async () => {
    let sentBody: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        sentBody = JSON.parse(String(init?.body));
        return new Response(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n' + "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-lookalike",
      displayName: "Lookalike host",
      enabled: true,
      config: {
        // hostname is NOT openrouter.ai — substring matching on the whole
        // URL would be fooled by a lookalike domain or a path segment
        url: "https://notopenrouter.ai/api/v1",
        apiKeyEnv: "TEST_KEY",
        provider: "fireworks",
      },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread-l", text: "prompt", model: "vendor/model" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(sentBody).not.toBeNull();
    expect("provider" in sentBody).toBe(false);
    recorder.stop();
    await inst.dispose();
  });

  it("pins the provider on an OpenRouter subdomain", async () => {
    let sentBody: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        sentBody = JSON.parse(String(init?.body));
        return new Response(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n' + "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-subdomain",
      displayName: "OpenRouter subdomain",
      enabled: true,
      config: {
        url: "https://gateway.openrouter.ai/api/v1",
        apiKeyEnv: "TEST_KEY",
        provider: "fireworks",
      },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread-s", text: "prompt", model: "vendor/model" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(sentBody?.provider).toEqual({ order: ["fireworks"], allow_fallbacks: false });
    recorder.stop();
    await inst.dispose();
  });

  it("omits provider routing when none is configured", async () => {
    let sentBody: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        sentBody = JSON.parse(String(init?.body));
        return new Response(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n' + "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-no-provider",
      displayName: "No provider",
      enabled: true,
      config: { url: "https://openrouter.ai/api/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread-np", text: "prompt", model: "vendor/model" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(sentBody).not.toBeNull();
    expect("provider" in sentBody).toBe(false);
    recorder.stop();
    await inst.dispose();
  });
});
