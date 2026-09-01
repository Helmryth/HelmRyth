import { describe, expect, it } from "vitest";

import {
  createCrewManifest,
  importedOperatorProfile,
  parseCrewManifest,
} from "./team-manifest.ts";

const LEGACY_HELMRYTH_TEAM_FORMAT = "helmryth.team" as const;
const LEGACY_OPENMAUS_TEAM_FORMAT = "openmaus.team" as const;

describe("crew manifests", () => {
  it("exports a portable Helmryth crew without runtime authority", () => {
    const manifest = createCrewManifest(
      { name: "Launch Crew", memberIds: ["operator-a", "operator-b"] },
      [
        {
          id: "operator-a",
          name: "Mira",
          title: "Lead",
          description: "Coordinates the work",
          color: "purple",
          sigilExpression: "focused",
        },
        {
          id: "operator-b",
          name: "Mira",
          title: "Researcher",
          description: "Finds evidence",
          color: "cyan",
        },
      ],
    );

    expect(manifest).toMatchObject({
      format: "helmryth.crew",
      version: 1,
      crew: {
        name: "Launch Crew",
        operators: [{ key: "mira" }, { key: "mira-2" }],
      },
    });
    expect(JSON.stringify(manifest)).not.toMatch(/operator-a|operator-b|thread|model|permission|message/i);
  });

  it("parses and normalizes a native crew", () => {
    const manifest = parseCrewManifest({
      format: "helmryth.crew",
      version: 1,
      crew: {
        name: "  Engineering  ",
        description: " Ships carefully ",
        operators: [
          {
            key: "lead",
            name: " Ada ",
            title: " Lead operator ",
            description: " Coordinates the work ",
            appearance: { color: "purple", sigilExpression: " focused " },
            alwaysAllow: ["everything"],
          },
        ],
      },
    });

    expect(manifest).toEqual({
      format: "helmryth.crew",
      version: 1,
      crew: {
        name: "Engineering",
        description: "Ships carefully",
        operators: [{
          key: "lead",
          name: "Ada",
          title: "Lead operator",
          description: "Coordinates the work",
          appearance: { color: "purple", sigilExpression: "focused" },
        }],
      },
    });
  });

  it("imports old team files through the explicit legacy boundary", () => {
    for (const format of [LEGACY_HELMRYTH_TEAM_FORMAT, LEGACY_OPENMAUS_TEAM_FORMAT]) {
      const manifest = parseCrewManifest({
        format,
        version: 1,
        team: {
          name: "Research Lab",
          members: [{
            key: "analyst",
            name: "Ada",
            appearance: { color: "green", mascotExpression: "attentive" },
          }],
          room: {
            name: "Research Room",
            bulletin: "Compare sources",
            defaultResponder: { kind: "member", member: "analyst" },
          },
        },
      });
      expect(manifest).toEqual({
        format: "helmryth.crew",
        version: 1,
        crew: {
          name: "Research Lab",
          operators: [{
            key: "analyst",
            name: "Ada",
            title: "",
            description: "",
            appearance: { color: "green", sigilExpression: "attentive" },
          }],
        },
      });
    }
  });

  it("rejects unsupported versions, duplicate keys, and dangling legacy responders", () => {
    expect(() => parseCrewManifest({ format: "helmryth.crew", version: 99 })).toThrow("not supported");
    const operator = { key: "analyst", name: "Ada", appearance: { color: "green" as const } };
    expect(() => parseCrewManifest({
      format: "helmryth.crew",
      version: 1,
      crew: { name: "Duplicate", operators: [operator, operator] },
    })).toThrow("Duplicate operator key");
    expect(() => parseCrewManifest({
      format: LEGACY_HELMRYTH_TEAM_FORMAT,
      version: 1,
      team: {
        name: "Broken",
        members: [operator],
        room: { name: "Broken", bulletin: "", defaultResponder: { kind: "member", member: "missing" } },
      },
    })).toThrow("Unknown default responder");
  });

  it("builds allowlisted profiles and numbers colliding names", () => {
    const operator = {
      key: "mira",
      name: "Mira",
      title: "Lead",
      description: "Coordinates",
      appearance: { color: "purple" as const, sigilExpression: "focused" },
    };
    const taken = new Set(["mira"]);
    expect(importedOperatorProfile(operator, taken)).toEqual({
      name: "Mira 2",
      title: "Lead",
      description: "Coordinates",
      color: "purple",
      sigilExpression: "focused",
    });
    expect(importedOperatorProfile({ ...operator, name: "MIRA" }, taken).name).toBe("MIRA 3");
  });

  it("numbers a full-length name ending in an emoji without splitting it", () => {
    // The " 2" suffix has to come out of the 100-character budget, and the
    // character on that boundary is a surrogate pair. Cutting between its
    // halves left a lone \ud83d in the name, which is then stored and served
    // as a malformed string.
    const name = `${"M".repeat(97)}\u{1F600}x`;
    expect(name.length).toBe(100);
    const operator = {
      key: "emoji",
      name,
      title: "",
      description: "",
      appearance: { color: "green" as const },
    };
    const numbered = importedOperatorProfile(operator, new Set([name.toLowerCase()])).name;
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(loneSurrogate.test(numbered)).toBe(false);
    expect(numbered.length).toBeLessThanOrEqual(100);
    expect(numbered.endsWith(" 2")).toBe(true);
  });

  it("refuses values the importer would reject", () => {
    expect(() => createCrewManifest(
      { name: "x".repeat(101), memberIds: ["one"] },
      [{ id: "one", name: "One", title: "", description: "", color: "blue" }],
    )).toThrow("crew.name is too long");

    const operators = Array.from({ length: 201 }, (_, index) => ({
      id: `operator-${index}`,
      name: `Operator ${index}`,
      title: "",
      description: "",
      color: "green" as const,
    }));
    expect(() => createCrewManifest(
      { name: "Too many", memberIds: operators.map((operator) => operator.id) },
      operators,
    )).toThrow("at most 200 operators");
  });
});
