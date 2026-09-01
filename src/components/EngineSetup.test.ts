import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EngineSetup, needsCli, needsSignIn } from "./EngineSetup";
import { probeInstallHint } from "./EnginesSettings";
import type { InstanceInfo } from "@/state/store";

function instance(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
  return {
    instanceId: "kimi",
    driverKind: "kimiAgent",
    displayName: "Kimi",
    models: { default: "kimi-code/k3", options: [] },
    snapshot,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("needsCli / needsSignIn", () => {
  it("treats a missing binary as a CLI install, not a sign-in", () => {
    const missing = instance({ state: "unavailable", reason: "`kimi` CLI not found" });
    expect(needsCli(missing)).toBe(true);
    expect(needsSignIn(missing)).toBe(false);
  });

  it("lets Custom inject run when the CLI is installed but unsigned-in", () => {
    const unsigned = instance({ state: "available", authenticated: false, version: "0.36.1" });
    expect(needsCli(unsigned)).toBe(false);
    expect(needsSignIn(unsigned)).toBe(true);
  });

  it("is ready for inject when the CLI is present", () => {
    const ready = instance({ state: "available", authenticated: true, version: "0.36.1" });
    expect(needsCli(ready)).toBe(false);
    expect(needsSignIn(ready)).toBe(false);
  });

  it("uses secure Connections copy for OpenAI-compatible setup", () => {
    vi.stubGlobal("window", { helmryth: undefined });
    vi.stubGlobal("navigator", { userAgent: "Mac" });
    const markup = renderToStaticMarkup(createElement(EngineSetup, {
      instance: {
        instanceId: "openrouter",
        driverKind: "openai-compat",
        displayName: "OpenAI-compatible",
        access: "custom",
        models: { default: "openrouter/auto", options: [] },
        snapshot: { state: "unavailable", reason: "no API key" },
        install: {
          docsUrl: "https://openrouter.ai/keys",
          command: { darwin: "OPENAI_COMPAT_API_KEY=sk-or-v1-... pnpm dev" },
        },
      },
      intent: "inject",
    }));

    expect(markup).toContain("System → Connections");
    expect(markup).toContain("OPENAI_COMPAT_API_KEY");
    expect(markup).not.toContain("config.json");
    expect(markup).not.toContain("openaiCompat.key");
  });
});

describe("failed CLI probe install hint", () => {
  it("surfaces the install recipe the probe returned for this platform", () => {
    vi.stubGlobal("window", { helmryth: { platform: "darwin" } });

    expect(probeInstallHint({
      ok: false,
      message: "`claude` was not found on this app's PATH",
      install: {
        command: { darwin: "npm install -g @anthropic-ai/claude-code" },
        needsNode: true,
        docsUrl: "https://claude.com/claude-code",
      },
    })).toEqual({ command: "npm install -g @anthropic-ai/claude-code", needsNode: true });
  });

  it("offers nothing when the probe passed, or when this platform has no one-liner", () => {
    vi.stubGlobal("window", { helmryth: { platform: "win32" } });

    expect(probeInstallHint({ ok: true, version: "1.2.3" })).toBeNull();
    expect(probeInstallHint(null)).toBeNull();
    expect(probeInstallHint({ ok: false, message: "no", install: { command: { darwin: "brew install pi" } } })).toBeNull();
  });
});
