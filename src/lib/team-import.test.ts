import { describe, expect, it } from "vitest";

import { CREW_MANIFEST_FORMAT, LEGACY_TEAM_MANIFEST_FORMAT, teamImportPreview } from "./team-import";

describe("crew import preview", () => {
  it("previews the canonical crew format", () => {
    const preview = teamImportPreview({
      format: CREW_MANIFEST_FORMAT,
      version: 1,
      crew: {
        name: " Engineering ",
        description: " Ships software ",
        operators: [{ key: "ada", name: " Ada ", title: " Tech Lead ", appearance: { color: "petrol" } }],
      },
    });

    expect(preview).toMatchObject({
      kind: "crew",
      name: "Engineering",
      description: "Ships software",
      members: [{ name: "Ada", title: "Tech Lead" }],
    });
  });

  it.each([1, 2])("previews legacy version %s crew files through the migration identifier", (version) => {
    const team = {
      name: " Engineering ",
      description: " Ships software ",
      members: [{ name: " Ada ", title: " Tech Lead " }],
    };
    if (version === 1) {
      Object.assign(team, { room: { name: "Engineering", bulletin: "", defaultResponder: { kind: "everyone" } } });
    }
    const preview = teamImportPreview({
      format: LEGACY_TEAM_MANIFEST_FORMAT,
      version,
      team,
    });

    expect(preview).toMatchObject({
      kind: "crew",
      name: "Engineering",
      description: "Ships software",
      members: [{ name: "Ada", title: "Tech Lead" }],
    });
  });

  it("rejects unsupported and empty files", () => {
    expect(() => teamImportPreview({ format: LEGACY_TEAM_MANIFEST_FORMAT, version: 3, team: {} })).toThrow("not supported");
    expect(() =>
      teamImportPreview({ format: LEGACY_TEAM_MANIFEST_FORMAT, version: 2, team: { name: "Empty", members: [] } }),
    ).toThrow("no operators");
  });

  it("previews the complete package setup before installation", () => {
    const preview = teamImportPreview({
      format: "helmryth.package",
      version: 1,
      package: {
        name: "Lead Desk",
        summary: "Find qualified conversations.",
        agents: [
          { key: "scout", name: "Scout", title: "Researcher" },
          { key: "writer", name: "Writer", title: "Outreach" },
        ],
        chiefOfStaff: "scout",
        rooms: [{}],
        playbooks: [{}, {}],
        routines: [{}],
        requirements: {
          apps: [
            { label: "Reddit" },
            { label: "Google Sheets", optional: true },
          ],
        },
      },
    });

    expect(preview).toMatchObject({
      kind: "package",
      name: "Lead Desk",
      chiefOfStaff: "Scout",
      rooms: 1,
      playbooks: 2,
      routines: 1,
      apps: [
        { label: "Reddit", optional: false },
        { label: "Google Sheets", optional: true },
      ],
    });
  });

  // `botmrr` is the pre-rebrand spelling of the version marker. Current
  // exports write `helmrythPackage`; both must preview identically so a
  // package saved before the rename still imports.
  it.each(["helmrythPackage", "botmrr"])("previews a portable Markdown playbook marked with %s", (marker) => {
    const preview = teamImportPreview(`---
${marker}: 1
name: Lead Desk
summary: Find qualified conversations.
agents:
  - key: scout
    name: Scout
    title: Researcher
chiefOfStaff: scout
rooms: []
playbooks: []
routines: []
requirements:
  apps:
    - label: Reddit
---

# Lead Desk

## Activation

Create the crew.`);

    expect(preview).toMatchObject({
      kind: "package",
      name: "Lead Desk",
      chiefOfStaff: "Scout",
      apps: [{ label: "Reddit", optional: false }],
    });
  });
});
