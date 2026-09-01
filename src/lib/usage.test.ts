import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { botUsage, cachedInput, costCaption, formatTokens, formatUsd, sumUsage, usageChip, usageDetail } from "./usage";
import { StoreProvider } from "@/state/store";
import { UsageSection, ledgerRows } from "@/components/UsageSection";

describe("usage formatting", () => {
  it("formats token counts compactly", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(120_000)).toBe("120k");
    expect(formatTokens(2_300_000)).toBe("2.3M");
  });

  it("keeps small dollar amounts visible", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.004)).toBe("$0.004");
    expect(formatUsd(0.31)).toBe("$0.31");
  });

  it("does not throw on missing usage fields from older bots.json", () => {
    expect(formatUsd(undefined)).toBe("");
    expect(formatTokens(undefined)).toBe("0");
    expect(usageChip({ input: 100, output: 20, turns: 1 })).toBe("120 tok");
  });

  it("treats NaN and Infinity cost as missing", () => {
    expect(formatUsd(Number.NaN)).toBe("");
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0");
    expect(usageChip({ input: 100, output: 20, costUsd: Number.NaN, turns: 1 })).toBe("120 tok");
    expect(usageChip({ input: 100, output: 20, costUsd: Number.POSITIVE_INFINITY, turns: 1 })).toBe("120 tok");
    expect(
      sumUsage([
        { input: 1, output: 1, costUsd: Number.NaN, turns: 1 },
        { input: 2, output: 2, costUsd: 0.01, turns: 1 },
      ]),
    ).toEqual({ input: 3, output: 3, costUsd: 0.01, turns: 2 });
  });

  it("carries the cached share through sums and names it in the breakdown", () => {
    // records from before the field existed simply don't contribute to it
    expect(sumUsage([{ input: 100, output: 10, costUsd: null, turns: 1 }, { input: 200, output: 20, cachedInput: 150, costUsd: null, turns: 1 }]))
      .toEqual({ input: 300, output: 30, cachedInput: 150, costUsd: null, turns: 2 });
    expect(sumUsage([{ input: 100, output: 10, costUsd: null, turns: 1 }])).toEqual({ input: 100, output: 10, costUsd: null, turns: 1 });
    // the headline stays the whole figure; the split is what explains it
    expect(usageDetail({ input: 88_200, output: 1_200, cachedInput: 79_000, costUsd: null, turns: 5 })).toBe("88.2k in (79k cached) · 1.2k out");
    expect(usageDetail({ input: 900, output: 50, costUsd: null, turns: 1 })).toBe("900 in · 50 out");
    expect(usageDetail({ input: 900, output: 50, cachedInput: 0, costUsd: null, turns: 1 })).toBe("900 in · 50 out");
    // a cached figure can never exceed the input it is part of, or go negative
    expect(cachedInput({ input: 100, output: 0, cachedInput: 250, costUsd: null, turns: 1 })).toBe(100);
    expect(cachedInput({ input: 100, output: 0, cachedInput: -3, costUsd: null, turns: 1 })).toBe(0);
    expect(cachedInput({ input: 100, output: 0, cachedInput: Number.NaN, costUsd: null, turns: 1 })).toBe(0);
  });

  it("builds the chip: tokens always, cost only when known, nothing when unused", () => {
    expect(usageChip({ input: 0, output: 0, costUsd: null, turns: 0 })).toBe("");
    expect(usageChip({ input: 10_000, output: 2_400, costUsd: null, turns: 3 })).toBe("12.4k tok");
    expect(usageChip({ input: 10_000, output: 2_400, costUsd: 0.06, turns: 3 })).toBe("12.4k tok · $0.06");
  });

  it("sums across tasks and leaves cost null until one reports it", () => {
    expect(sumUsage([{ input: 1, output: 1, costUsd: null, turns: 1 }, undefined, { input: 2, output: 2, costUsd: null, turns: 1 }])).toEqual({
      input: 3,
      output: 3,
      costUsd: null,
      turns: 2,
    });
    expect(
      botUsage({
        tasks: [
          { threadId: "a", title: "", createdAt: 0, usage: { input: 5, output: 5, costUsd: 0.01, turns: 1 } },
          { threadId: "b", title: "", createdAt: 0 },
          { threadId: "c", title: "", createdAt: 0, usage: { input: 5, output: 5, costUsd: null, turns: 2 } },
        ],
      }),
    ).toEqual({ input: 10, output: 10, costUsd: 0.01, turns: 3 });
  });

  it("captions cost by billing", () => {
    expect(costCaption("subscription")).toMatch(/not billed/);
    expect(costCaption("metered")).toMatch(/API key/);
    expect(costCaption(undefined)).toMatch(/reported/);
  });
});

describe("Spend ledger rows", () => {
  const spender = (id: string, hidden: boolean, costUsd: number) => ({
    id,
    name: id,
    color: "cyan" as const,
    hidden,
    modelSelection: { instanceId: "claude" },
    tasks: [{ threadId: `${id}-t`, title: "", createdAt: 0, usage: { input: 10, output: 5, costUsd, turns: 1 } }],
  });

  it("keeps an archived operator's spend in the ledger and in the total", () => {
    const rows = ledgerRows(
      [spender("live", false, 0.25), spender("archived", true, 1.5)],
      [{ instanceId: "claude", snapshot: { state: "available", billing: "metered" } }],
    );

    expect(rows.map((r) => r.bot.id)).toEqual(["archived", "live"]);
    expect(rows.find((r) => r.bot.id === "archived")?.archived).toBe(true);
    // archiving hides an operator; it must not rewrite what the workspace paid
    expect(sumUsage(rows.map((r) => r.usage)).costUsd).toBeCloseTo(1.75);
  });

  it("names itself for the spend it shows, not for the transcript step timeline", () => {
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(UsageSection)));

    expect(markup).toContain("Spend ledger");
    expect(markup).not.toContain("Run ledger");
  });

  it("still omits operators that have never settled a step", () => {
    const rows = ledgerRows(
      [{ id: "fresh", name: "Fresh", color: "cyan" as const, hidden: false, modelSelection: { instanceId: "claude" }, tasks: [] }],
      [],
    );

    expect(rows).toEqual([]);
  });
});
