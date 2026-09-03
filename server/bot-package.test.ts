import { describe, expect, it } from "vitest";

import { isBotPackage, packageAgentAsOperator, parseBotPackage, renderBotPackageMarkdown } from "./bot-package.ts";

const validPackage: any = {
  format: "helmryth.package",
  version: 1,
  package: {
    id: "research-desk",
    release: "1.0.0",
    name: "Research Desk",
    tagline: "Turn a question into a sourced brief.",
    summary: "A small research team.",
    category: "Research",
    author: { name: "Helmryth" },
    license: "MIT",
    outcomes: ["Produce a sourced brief."],
    setupMinutes: 3,
    requirements: { apps: [], capabilities: [] },
    agents: [
      {
        key: "lead",
        name: "Ada",
        title: "Research Lead",
        description: "Own the brief.",
        appearance: { color: "purple" },
        playbooks: ["source-check"],
        autoApprove: true,
      },
    ],
    chiefOfStaff: "lead",
    rooms: [
      {
        key: "desk",
        name: "Research Desk",
        members: ["lead"],
        bulletin: "Cite sources.",
        defaultResponder: { kind: "agent", agent: "lead" },
      },
    ],
    playbooks: [
      {
        key: "source-check",
        name: "Source Check",
        summary: "Verify sources.",
        triggers: ["research brief"],
        instructions: "Separate facts from inference.",
      },
    ],
  },
};

describe("bot packages", () => {
  it("parses the complete portable structure and strips authority fields", () => {
    const parsed = parseBotPackage(validPackage);
    expect(parsed.package.rooms![0]?.defaultResponder).toEqual({ kind: "agent", agent: "lead" });
    expect(parsed.package.agents[0]).not.toHaveProperty("autoApprove");
    expect(packageAgentAsOperator(parsed.package.agents[0]!)).toEqual({
      key: "lead",
      name: "Ada",
      title: "Research Lead",
      description: "Own the brief.",
      appearance: { color: "purple" },
    });
  });

  it("round-trips one Chief-of-Staff-readable Markdown playbook", () => {
    const markdown = renderBotPackageMarkdown(parseBotPackage(validPackage));
    expect(markdown).toContain("## Activation");
    expect(markdown).toContain("Give this file to your lead operator");
    expect(markdown).not.toContain("autoApprove");
    expect(parseBotPackage(markdown).package).toMatchObject({
      id: "research-desk",
      chiefOfStaff: "lead",
      agents: [{ key: "lead", name: "Ada" }],
    });
  });

  it("accepts only this product's version marker in exported Markdown", () => {
    // The exported playbook is a public artifact — a user downloads it and
    // shares it — so it names this product, and only this product, on both
    // write and read. No predecessor spelling is honoured.
    const markdown = renderBotPackageMarkdown(parseBotPackage(validPackage));
    expect(markdown).toContain("helmrythPackage: 1");
    expect(isBotPackage(markdown)).toBe(true);

    // Any other marker is not a package, however well-formed the rest is.
    const foreign = markdown.replace("helmrythPackage: 1", "otherProductPackage: 1");
    expect(isBotPackage(foreign)).toBe(false);

    // A version we do not speak is rejected rather than guessed at.
    expect(() => parseBotPackage(markdown.replace("helmrythPackage: 1", "helmrythPackage: 2")))
      .toThrow("Crew Markdown version is not supported");
  });

  it("rejects dangling agent, room, playbook, chief, and routine references", () => {
    expect(() => parseBotPackage({
      ...validPackage,
      package: { ...validPackage.package, chiefOfStaff: "missing" },
    })).toThrow("Unknown lead operator");
    expect(() => parseBotPackage({
      ...validPackage,
      package: {
        ...validPackage.package,
        agents: [{ ...validPackage.package.agents[0], playbooks: ["missing"] }],
      },
    })).toThrow("unknown playbook");
  });
});
