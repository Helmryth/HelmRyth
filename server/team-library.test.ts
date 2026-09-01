import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "./schema.ts";

import {
  TEAM_LIBRARY_CATALOG_URL,
  TEAM_LIBRARY_RAW_ROOT,
  TEAM_LIBRARY_REPOSITORY,
  fetchGithubTeam,
  fetchLibraryTeam,
  fetchTeamCatalog,
  githubManifestUrls,
  parseTeamCatalog,
} from "./team-library.ts";

const manifest = {
  format: "helmryth.crew",
  version: 1,
  crew: {
    name: "Engineering",
    operators: [{
      key: "lead",
      name: "Ada",
      title: "Lead operator",
      description: "Coordinates the work",
      appearance: { color: "purple" },
    }],
  },
};

const catalog = {
  format: "helmryth.crew-catalog",
  version: 1,
  teams: [{
    slug: "engineering",
    name: "Engineering Crew",
    summary: "Plan and ship software.",
    category: "Engineering",
    manifest: "crews/engineering/helmcrew.json",
    readme: "crews/engineering/README.md",
    members: 1,
    skills: ["crews/engineering/skills/release/SKILL.md"],
    requires: { apps: ["GitHub"] },
  }],
};

function response(value: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("crew library", () => {
  it("validates catalog paths and adds the trusted repository URL", () => {
    const parsed = parseTeamCatalog(catalog);
    expect(parsed.repositoryUrl).toBe(TEAM_LIBRARY_REPOSITORY);
    expect(parsed.source).toBe("remote");
    expect(parsed.teams[0]).toMatchObject({ slug: "engineering", members: 1 });

    const unsafe = structuredClone(catalog);
    unsafe.teams[0]!.manifest = "../private.json";
    expect(() => parseTeamCatalog(unsafe)).toThrow("safe catalog path");
  });

  it.each([
    ["HTTP 404", async () => response({}, 404)],
    ["network failure", async () => { throw new TypeError("offline"); }],
    ["an invalid remote document", async () => response({ format: "unknown", teams: [] })],
  ])("uses the independent bundled catalog after %s", async (_label, reply) => {
    const fetcher = vi.fn<typeof fetch>(reply);

    const loaded = await fetchTeamCatalog(fetcher);

    expect(loaded.source).toBe("bundled");
    expect(loaded.teams.length).toBeGreaterThanOrEqual(4);
    expect(loaded.teams.map((entry) => entry.slug)).toContain("release-foundry");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("loads a bundled crew without a network request", async () => {
    const fetcher = vi.fn<typeof fetch>();

    const loaded = await fetchLibraryTeam("release-foundry", fetcher);

    if (loaded.format !== "helmryth.crew") throw new Error("expected a Helmryth crew");
    expect(loaded.crew.name).toBe("Release Foundry");
    expect(loaded.crew.operators.map((operator) => operator.key)).toEqual([
      "release-lead",
      "implementation",
      "verification",
      "release-ops",
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps every crew advertised by the bundled catalog importable", async () => {
    const catalogFetcher = vi.fn<typeof fetch>(async () => response({}, 404));
    const bundled = await fetchTeamCatalog(catalogFetcher);
    const unexpectedNetwork = vi.fn<typeof fetch>();

    for (const entry of bundled.teams) {
      const loaded = await fetchLibraryTeam(entry.slug, unexpectedNetwork);
      if (loaded.format !== "helmryth.crew") throw new Error("expected a Helmryth crew");
      expect(loaded.crew.operators, entry.slug).toHaveLength(entry.members);
    }
    expect(unexpectedNetwork).not.toHaveBeenCalled();
  });

  it("uses a valid remote catalog when the optional source is available", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(catalog));

    const loaded = await fetchTeamCatalog(fetcher);

    expect(loaded.source).toBe("remote");
    expect(loaded.teams).toHaveLength(1);
    expect(loaded.teams[0]?.slug).toBe("engineering");
  });

  it("loads only the manifest selected by the trusted catalog", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const target = String(url);
      if (target === TEAM_LIBRARY_CATALOG_URL) return response(catalog);
      if (target === `${TEAM_LIBRARY_RAW_ROOT}/crews/engineering/helmcrew.json`) return response(manifest);
      return response({}, 404);
    });

    const loaded = await fetchLibraryTeam("engineering", fetcher);
    if (loaded.format !== "helmryth.crew") throw new Error("expected a Helmryth crew");
    expect(loaded.crew.name).toBe("Engineering");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit", redirect: "error" });
  });

  it("fails closed for unknown or unsafe library slugs", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({}, 404));

    await expect(fetchLibraryTeam("not-in-the-library", fetcher)).rejects.toMatchObject({
      message: "That library crew was not found",
      status: 404,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await expect(fetchLibraryTeam("../release-foundry", fetcher)).rejects.toThrow("crew name is invalid");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("normalizes public GitHub repository, blob, and raw links", () => {
    const repositoryUrls = githubManifestUrls("https://github.com/acme/crew");
    expect(repositoryUrls[0]).toBe("https://raw.githubusercontent.com/acme/crew/main/helmcrew.json");
    expect(repositoryUrls[4]).toBe("https://raw.githubusercontent.com/acme/crew/master/helmcrew.json");
    expect(repositoryUrls).toHaveLength(8);
    expect(githubManifestUrls("https://github.com/acme/crew/blob/main/presets/seo.json")).toEqual([
      "https://raw.githubusercontent.com/acme/crew/main/presets/seo.json",
    ]);
    expect(githubManifestUrls("https://raw.githubusercontent.com/acme/crew/main/helmcrew.json")).toEqual([
      "https://raw.githubusercontent.com/acme/crew/main/helmcrew.json",
    ]);
    expect(() => githubManifestUrls("http://example.com/crew.json")).toThrow("public HTTPS GitHub");
    expect(() => githubManifestUrls("https://github.com/acme/crew/blob/main/run.sh")).toThrow("JSON crew file");
  });

  it("falls back from main to master for a repository link", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("helmcrew.json") && String(url).includes("/master/")
        ? response(manifest)
        : response({}, 404),
    );

    const loaded = await fetchGithubTeam("https://github.com/acme/crew", fetcher);
    if (loaded.format !== "helmryth.crew") throw new Error("expected a Helmryth crew");
    expect(loaded.crew.operators[0]?.name).toBe("Ada");
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
});
