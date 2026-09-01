import { describe, expect, it } from "vitest";

import { isCustomOnly, splitEngineRail } from "./engine-rail";

describe("splitEngineRail", () => {
  it("keeps Cloud engines above Local engines", () => {
    const { subscription, custom } = splitEngineRail([
      { access: "subscription", instanceId: "claude" },
      { access: "custom", instanceId: "hermes" },
      { instanceId: "grok" },
      { access: "custom", instanceId: "qwen" },
    ]);
    expect(subscription.map((row) => row.instanceId)).toEqual(["claude", "grok"]);
    expect(custom.map((row) => row.instanceId)).toEqual(["hermes", "qwen"]);
  });

  it("hides the second group when nothing is custom-only", () => {
    const rows = [{ instanceId: "claude" }];
    expect(splitEngineRail(rows).custom).toEqual([]);
  });

  it("keeps a custom-access remote API with enumerated models on the Cloud rail", () => {
    const openaiCompat = {
      access: "custom",
      instanceId: "openai-compatible",
      driverKind: "openai-compat",
      models: {
        default: "fake-gpt",
        options: [{ id: "fake-gpt", label: "Fake GPT" }],
      },
    } as const;

    expect(isCustomOnly(openaiCompat)).toBe(false);
    expect(splitEngineRail([openaiCompat])).toEqual({
      subscription: [openaiCompat],
      custom: [],
    });
  });

  it("keeps true local-only and empty custom catalogs on the Local rail", () => {
    const localOnly = {
      access: "custom",
      instanceId: "hermes",
      models: {
        default: "omlx::qwen",
        options: [{ id: "omlx::qwen", label: "Qwen (oMLX)", custom: true }],
      },
    } as const;
    const waitingForLocalCatalog = {
      access: "custom",
      instanceId: "qwen",
      models: { default: "", options: [] },
    } as const;

    expect(isCustomOnly(localOnly)).toBe(true);
    expect(isCustomOnly(waitingForLocalCatalog)).toBe(true);
    expect(splitEngineRail([localOnly, waitingForLocalCatalog]).custom).toEqual([
      localOnly,
      waitingForLocalCatalog,
    ]);
  });

  it("keeps a mixed remote and local catalog on Cloud while retaining its local pane", () => {
    const mixed = {
      access: "custom",
      instanceId: "mixed",
      models: {
        default: "remote-model",
        options: [
          { id: "remote-model", label: "Remote model" },
          { id: "local-model", label: "Local model", custom: true },
        ],
      },
    } as const;

    expect(isCustomOnly(mixed)).toBe(false);
    expect(splitEngineRail([mixed]).subscription).toEqual([mixed]);
  });
});
