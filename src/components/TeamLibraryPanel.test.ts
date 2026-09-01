import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  LibraryCrewLoadError,
  composeProjectCrewManifest,
  parseScoutResult,
  projectScoutOperators,
  type ScoutResult,
} from "./TeamLibraryPanel";

const serverScoutResponse = {
  profile: {
    name: "Harbor Console",
    summary: "Coordinates a distributed release.",
    stacks: ["TypeScript", "React"],
    signals: [
      { role: "frontend", evidence: ["react"] },
      { role: "testing", evidence: ["vitest"] },
    ],
  },
  suggestion: {
    roomName: "Harbor Console",
    manifest: {
      format: "helmryth.crew",
      version: 1,
      crew: {
        name: "Harbor Console",
        description: "Coordinates a distributed release.",
        operators: [
          { key: "lead", name: "Compass", title: "Project Lead", description: "Coordinate the work.", appearance: { color: "yellow" } },
          { key: "frontend", name: "Pixel", title: "Frontend Builder", description: "Build the interface.", appearance: { color: "pink" } },
          { key: "testing", name: "Probe", title: "Test Engineer", description: "Prove the release.", appearance: { color: "green" } },
        ],
      },
    },
    reasons: {
      lead: "Every project needs one coordinator.",
      frontend: "react",
      testing: "vitest",
    },
  },
} satisfies ScoutResult;

function realScoutResult(): ScoutResult {
  return parseScoutResult(serverScoutResponse);
}

describe("project scout contract", () => {
  it("consumes the canonical crew operators returned by project scout", () => {
    const result = realScoutResult();

    expect(projectScoutOperators(result).map((operator) => operator.key)).toEqual([
      "lead",
      "frontend",
      "testing",
    ]);
    expect(projectScoutOperators(result)[1]?.name).toBe(result.suggestion.manifest.crew.operators[1]?.name);
  });

  it("adds selected directory operators to the canonical crew manifest", () => {
    const result = realScoutResult();
    const manifest = composeProjectCrewManifest(
      result,
      [{
        slug: "release-notes",
        name: "Release Scribe",
        category: "Documentation",
        integrations: [],
        prompt: "Prepare release notes.",
        detailUrl: "https://example.test/release-notes",
        matched: ["docs"],
      }],
      new Set(["release-notes"]),
    );

    expect(manifest.crew.operators).toHaveLength(result.suggestion.manifest.crew.operators.length + 1);
    expect(manifest.crew.operators.at(-1)).toMatchObject({
      key: "dir-release-notes",
      name: "Release Scribe",
      appearance: { color: "green" },
    });
    expect(manifest).not.toHaveProperty("team");
  });
});

describe("selected library crew failure", () => {
  it("renders an alert and an enabled retry on the Library surface", () => {
    const markup = renderToStaticMarkup(createElement(LibraryCrewLoadError, {
      crewName: "Launch Control",
      retrying: false,
      onRetry: vi.fn(),
    }));

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Helmryth couldn’t load Launch Control");
    expect(markup).toContain("Retry");
    expect(markup).not.toContain('disabled=""');
    expect(markup).not.toMatch(/\bteam\b/i);
  });

  it("disables retry and names progress while the same crew reloads", () => {
    const markup = renderToStaticMarkup(createElement(LibraryCrewLoadError, {
      crewName: "Launch Control",
      retrying: true,
      onRetry: vi.fn(),
    }));

    expect(markup).toContain("Retrying…");
    expect(markup).toContain('disabled=""');
  });
});
