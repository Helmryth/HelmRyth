import { describe, expect, it } from "vitest";

import { createAgentSkillsClient, type ImportedMethod } from "./agent-skills-api";

const method: ImportedMethod = {
  name: "release-check",
  description: "Review the release boundary.",
  enabled: false,
  source: "github.com/acme/methods/release-check",
  sha256: "a".repeat(64),
  importedAt: "2026-08-30T08:00:00.000Z",
  license: "Apache-2.0",
  compatibility: "Helmryth desktop",
  warnings: ["review external commands"],
  skippedFiles: ["run.sh"],
  reviewRevision: "b".repeat(64),
};

interface FetchCall {
  path: string;
  init: RequestInit | undefined;
}

function responseQueue(...responses: Array<{ body: object; status?: number }>) {
  const calls: FetchCall[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ path: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, client: createAgentSkillsClient(fetcher) };
}

describe("Agent Skills API", () => {
  it("maps the complete per-operator lifecycle to the existing routes", async () => {
    const { calls, client } = responseQueue(
      { body: { skills: [method] } },
      { body: { installed: [method], errors: ["second method: invalid frontmatter"] }, status: 201 },
      { body: { text: "---\nname: release-check\ndescription: Review releases\n---\n# Full method" } },
      { body: { skill: { ...method, enabled: true } } },
      { body: { ok: true } },
    );

    expect(await client.list("operator one")).toEqual([method]);
    const imported = await client.importFromGitHub("operator one", "acme/methods");
    expect(imported.installed[0]?.enabled).toBe(false);
    expect(imported.errors).toEqual(["second method: invalid frontmatter"]);
    expect(await client.read("operator one", "release-check")).toContain("# Full method");
    expect((await client.setEnabled("operator one", "release-check", {
      enabled: true,
      review: { revision: method.reviewRevision, acknowledged: true },
    })).enabled).toBe(true);
    await expect(client.remove("operator one", "release-check")).resolves.toBeUndefined();

    expect(calls.map((call) => [call.init?.method ?? "GET", call.path])).toEqual([
      ["GET", "/api/bots/operator%20one/skills"],
      ["POST", "/api/bots/operator%20one/skills"],
      ["GET", "/api/bots/operator%20one/skills/release-check"],
      ["PATCH", "/api/bots/operator%20one/skills/release-check"],
      ["DELETE", "/api/bots/operator%20one/skills/release-check"],
    ]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ source: "acme/methods" });
    expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({
      enabled: true,
      review: { revision: method.reviewRevision, acknowledged: true },
    });
    expect(calls[4]?.init?.headers).toEqual({ "content-type": "application/json" });
  });

  it("surfaces server errors and rejects invalid success payloads", async () => {
    const serverFailure = responseQueue({ body: { error: "no SKILL.md found there" }, status: 422 }).client;
    await expect(serverFailure.importFromGitHub("op", "acme/empty")).rejects.toThrow("no SKILL.md found there");

    const invalidSuccess = responseQueue({ body: { skills: [{ name: "missing-contract" }] } }).client;
    await expect(invalidSuccess.list("op")).rejects.toThrow("invalid methods response");
  });

  it("sends an explicit false when disabling a method", async () => {
    const { calls, client } = responseQueue({ body: { skill: method } });
    await client.setEnabled("op", method.name, { enabled: false });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ enabled: false });
  });

  it("does not accept a non-JSON error page as method data", async () => {
    const fetcher = async (): Promise<Response> => new Response("gateway down", { status: 502 });
    const client = createAgentSkillsClient(fetcher);
    await expect(client.list("op")).rejects.toThrow("Request failed (502)");
  });

  it("rejects an import response that tries to arrive enabled", async () => {
    const client = responseQueue({
      body: { installed: [{ ...method, enabled: true }], errors: [] },
      status: 201,
    }).client;
    await expect(client.importFromGitHub("op", "acme/methods")).rejects.toThrow("invalid methods response");
  });
});
