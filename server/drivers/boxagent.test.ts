// Box agent contract tests against a scripted fake of ascii.dev's box HTTP
// API. The driver polls events + prompt status; the fake advances one poll
// per GET so we can assert message → tool → message order without sleeping.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { BoxAgentDriver } from "./boxagent.ts";

const BOX = "box-1";
const PROMPT = "p1";

/** JSON Response helper for the in-process Box HTTP fake. */
type BoxEventFixture = { id: string; type: string; text?: string | { drifted: boolean }; title?: string };
type BoxPromptRunFixture = {
  status?: string;
  result?: string | { drifted: boolean };
  id?: string | number;
};
type BoxResponseFixture =
  | { ok: boolean }
  | { error: string }
  | { events: BoxEventFixture[] }
  | { promptRun: BoxPromptRunFixture };

function json(body: BoxResponseFixture, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Poll = {
  events: BoxEventFixture[];
  eventsError?: { code: string; status: number };
  status?: { promptRun: BoxPromptRunFixture & { status: string } };
};

function assistantTexts(events: readonly RuntimeEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "item.completed" && event.itemType === "assistant_text" ? [event.text] : [],
  );
}

/** Stub fetch so each GET /events + /prompts pair advances one poll in `script`. */
function installFakeBox(script: Poll[], promptId: string | number = PROMPT) {
  let i = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/me")) return json({ ok: true });
    if (method === "POST" && /\/boxes\/[^/]+\/prompt$/.test(url)) return json({ promptRun: { id: promptId } });
    if (method === "POST" && url.includes("/interrupt")) return json({ ok: true });
    if (url.includes("/events")) {
      const step = script[Math.min(i, script.length - 1)]!;
      i += 1;
      if (step.eventsError) return json({ error: step.eventsError.code }, step.eventsError.status);
      return json({ events: step.events });
    }
    if (url.includes(`/prompts/${String(promptId)}`)) {
      const step = script[Math.min(Math.max(i - 1, 0), script.length - 1)]!;
      return json(step.status ?? { promptRun: { status: "running" } });
    }
    return json({ error: `unexpected ${method} ${url}` }, 404);
  };
  return installFetch(fakeFetch);
}

function installFetch(fakeFetch: typeof fetch) {
  const previous = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  return () => {
    globalThis.fetch = previous;
  };
}

const computer = { boxId: BOX, token: "box-test-token" };

describe("BoxAgentDriver turns (fake API)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let restoreFetch: (() => void) | undefined;

  const create = async () => {
    instance = await BoxAgentDriver.create({
      instanceId: "box-test",
      displayName: "Box Test",
      environment: { BOX_TOKEN: "box-test-token" },
      enabled: true,
      config: { pollMs: 1 },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    restoreFetch?.();
    restoreFetch = undefined;
  });

  it("rejects invalid polling intervals instead of silently creating a hot loop", () => {
    expect(() => BoxAgentDriver.decodeConfig({ pollMs: -1 })).toThrow();
    expect(() => BoxAgentDriver.decodeConfig({ pollMs: 0 })).toThrow();
    expect(() => BoxAgentDriver.decodeConfig({ pollMs: "fast" })).toThrow();
    expect(BoxAgentDriver.decodeConfig(undefined)).toEqual({ pollMs: 2500 });
  });

  it("keeps terminal status when auxiliary wire fields drift", async () => {
    restoreFetch = installFakeBox(
      [
        {
          events: [{ id: "e-drift", type: "response", text: { drifted: true } }],
          status: { promptRun: { status: "finished", result: { drifted: true } } },
        },
      ],
      17,
    );
    await create();
    await instance.adapter.sendTurn({ threadId: "t-drift", text: "go", integrations: { computer } });
    const done = await recorder.until((event) => event.type === "turn.completed");

    expect(recorder.events.find((event) => event.type === "session.started")).toMatchObject({ sessionId: "17" });
    expect(assistantTexts(recorder.events)).toEqual(["(finished)"]);
    expect(done).toMatchObject({ ok: true, stopReason: null });
  });

  it("fails an authenticated poll immediately instead of hanging until the run ceiling", async () => {
    restoreFetch = installFakeBox([{ events: [], eventsError: { code: "token_revoked", status: 401 } }]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-revoked", text: "go", integrations: { computer } });
    const done = await recorder.until((event) => event.type === "turn.completed");

    expect(recorder.events.find((event) => event.type === "runtime.error")).toMatchObject({ message: "token_revoked" });
    expect(done).toMatchObject({ ok: false, stopReason: "error" });
  });

  it("bounds persistent upstream poll failures instead of retrying for 30 minutes", async () => {
    restoreFetch = installFakeBox([{ events: [], eventsError: { code: "upstream_unavailable", status: 503 } }]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-upstream", text: "go", integrations: { computer } });
    const done = await recorder.until((event) => event.type === "turn.completed");

    expect(recorder.events.find((event) => event.type === "runtime.error")).toMatchObject({
      message: "upstream_unavailable",
    });
    expect(done).toMatchObject({ ok: false, stopReason: "error" });
  });

  it("aborts an in-flight poll when interrupted", async () => {
    let announcePollStarted = () => {};
    const pollStarted = new Promise<void>((resolve) => {
      announcePollStarted = resolve;
    });
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = String(init?.method ?? "GET").toUpperCase();
      if (method === "POST" && /\/boxes\/[^/]+\/prompt$/.test(url)) return json({ promptRun: { id: PROMPT } });
      if (method === "POST" && url.includes("/interrupt")) return json({ ok: true });
      if (url.includes("/events")) {
        announcePollStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return json({ error: `unexpected ${method} ${url}` }, 404);
    };
    restoreFetch = installFetch(fakeFetch);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-abort", text: "go", integrations: { computer } });
    await pollStarted;

    const interruptedAt = Date.now();
    await instance.adapter.interruptTurn("t-abort");
    const done = await recorder.until((event) => event.type === "turn.completed");

    expect(Date.now() - interruptedAt).toBeLessThan(500);
    expect(done).toMatchObject({ ok: false, stopReason: "interrupted" });
  });

  it("flushes prefix-grown text before a tool, then the tail at settle", async () => {
    restoreFetch = installFakeBox([
      {
        events: [{ id: "e1", type: "response", text: "hel" }],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "hel" },
          { id: "e2", type: "tool", title: "run" },
        ],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "hel" },
          { id: "e2", type: "tool", title: "run" },
          { id: "e3", type: "response", text: "hello there" },
        ],
        status: { promptRun: { status: "finished", result: "hello there" } },
      },
    ]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-prefix", text: "go", integrations: { computer } });
    await recorder.until((e) => e.type === "turn.completed");

    const texts = assistantTexts(recorder.events);
    expect(texts).toEqual(["hel", "lo there"]);
  });

  it("keeps a non-prefix response after a flush instead of slicing it away", async () => {
    restoreFetch = installFakeBox([
      {
        events: [{ id: "e1", type: "response", text: "before" }],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "before" },
          { id: "e2", type: "tool", title: "run" },
        ],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "before" },
          { id: "e2", type: "tool", title: "run" },
          { id: "e3", type: "response", text: "after" },
        ],
        status: { promptRun: { status: "finished", result: "after" } },
      },
    ]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-nonprefix", text: "go", integrations: { computer } });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed", // before
      "item.started",
      "content.delta",
      "item.completed", // after — must not be sliced to ""
      "turn.completed",
    ]);
    const texts = assistantTexts(recorder.events);
    expect(texts).toEqual(["before", "after"]);
  });

  it("ingests a non-prefix prompt result when events already set lastText", async () => {
    restoreFetch = installFakeBox([
      {
        events: [{ id: "e1", type: "response", text: "before" }],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "before" },
          { id: "e2", type: "tool", title: "run" },
        ],
        status: { promptRun: { status: "running" } },
      },
      {
        events: [
          { id: "e1", type: "response", text: "before" },
          { id: "e2", type: "tool", title: "run" },
        ],
        status: { promptRun: { status: "finished", result: "done" } },
      },
    ]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-status", text: "go", integrations: { computer } });
    await recorder.until((e) => e.type === "turn.completed");

    const texts = assistantTexts(recorder.events);
    expect(texts).toEqual(["before", "done"]);
  });

  it("flushes pending assistant text when the turn is interrupted", async () => {
    restoreFetch = installFakeBox([
      {
        events: [{ id: "e1", type: "response", text: "half" }],
        status: { promptRun: { status: "running" } },
      },
    ]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cancel", text: "go", integrations: { computer } });
    await recorder.until((e) => e.type === "content.delta");
    await instance.adapter.interruptTurn("t-cancel");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "interrupted" });
    const assistantIndex = recorder.events.findIndex(
      (event) => event.type === "item.completed" && event.itemType === "assistant_text",
    );
    expect(assistantIndex).toBeLessThan(recorder.events.indexOf(done));
    const texts = assistantTexts(recorder.events);
    expect(texts).toEqual(["half"]);
  });
});
