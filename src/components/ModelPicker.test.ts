import { describe, expect, it } from "vitest";

import type { InstanceInfo } from "@/state/store";
import { modelPickerPane } from "./ModelPicker";

function instance(overrides: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    instanceId: "openai-compatible",
    driverKind: "openai-compat",
    displayName: "OpenAI-compatible",
    access: "custom",
    snapshot: { state: "available", authenticated: true },
    models: {
      default: "fake-gpt",
      options: [{ id: "fake-gpt", label: "Fake GPT" }],
    },
    ...overrides,
  };
}

describe("modelPickerPane", () => {
  it("opens an available BYOK remote API on its selectable model list", () => {
    expect(modelPickerPane(instance(), "fake-gpt")).toBe("main");
  });

  it("preserves the remote setup pane when a BYOK API is unavailable", () => {
    expect(modelPickerPane(instance({
      snapshot: { state: "unavailable", authenticated: false, reason: "no API key" },
    }))).toBe("main");
  });

  it("opens a true local-only catalog on its local model list", () => {
    expect(modelPickerPane(instance({
      instanceId: "hermes",
      driverKind: "hermesAgent",
      models: {
        default: "omlx::qwen",
        options: [{ id: "omlx::qwen", label: "Qwen (oMLX)", custom: true }],
      },
    }))).toBe("custom");
  });

  it("opens the selected local pane without hiding remote rows in a mixed catalog", () => {
    const mixed = instance({
      models: {
        default: "remote-model",
        options: [
          { id: "remote-model", label: "Remote model" },
          { id: "local-model", label: "Local model", custom: true },
        ],
      },
    });

    expect(modelPickerPane(mixed, "remote-model")).toBe("main");
    expect(modelPickerPane(mixed, "local-model")).toBe("custom");
  });
});
