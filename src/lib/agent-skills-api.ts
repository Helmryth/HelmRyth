import { z } from "zod";

const importedMethodSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string(),
  enabled: z.boolean(),
  source: z.string(),
  sha256: z.string(),
  importedAt: z.string(),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  warnings: z.array(z.string()),
  skippedFiles: z.array(z.string()),
  reviewRevision: z.string().regex(/^[a-f0-9]{64}$/),
  reviewedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  reviewedAt: z.string().optional(),
});

const listResponseSchema = z.strictObject({
  skills: z.array(importedMethodSchema),
});

const newlyImportedMethodSchema = importedMethodSchema.extend({ enabled: z.literal(false) });
const importResponseSchema = z.strictObject({
  installed: z.array(newlyImportedMethodSchema),
  errors: z.array(z.string()),
});

const methodResponseSchema = z.strictObject({ text: z.string() });
const updateResponseSchema = z.strictObject({ skill: importedMethodSchema });
const deleteResponseSchema = z.strictObject({ ok: z.literal(true) });
const errorResponseSchema = z.object({ error: z.string() });

export type ImportedMethod = z.infer<typeof importedMethodSchema>;
export interface ImportedMethodBatch {
  installed: ImportedMethod[];
  errors: string[];
}

export type ImportedMethodEnablement =
  | { enabled: false }
  | { enabled: true; review: { revision: string; acknowledged: true } };

export interface AgentSkillsClient {
  list(botId: string): Promise<ImportedMethod[]>;
  importFromGitHub(botId: string, source: string): Promise<ImportedMethodBatch>;
  read(botId: string, name: string): Promise<string>;
  setEnabled(botId: string, name: string, enablement: ImportedMethodEnablement): Promise<ImportedMethod>;
  remove(botId: string, name: string): Promise<void>;
}

const route = (botId: string, name?: string): string => {
  const root = `/api/bots/${encodeURIComponent(botId)}/skills`;
  return name ? `${root}/${encodeURIComponent(name)}` : root;
};

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit | undefined,
  fetcher: typeof fetch,
): Promise<T> {
  const response = await fetcher(path, init);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(response.ok ? "Helmryth returned an unreadable methods response" : `Request failed (${response.status})`);
  }
  if (!response.ok) {
    const parsedError = errorResponseSchema.safeParse(payload);
    throw new Error(parsedError.success ? parsedError.data.error : `Request failed (${response.status})`);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new Error("Helmryth returned an invalid methods response");
  return parsed.data;
}

export function createAgentSkillsClient(fetcher: typeof fetch = fetch): AgentSkillsClient {
  return {
    async list(botId) {
      return (await request(route(botId), listResponseSchema, undefined, fetcher)).skills;
    },
    async importFromGitHub(botId, source) {
      return request(
        route(botId),
        importResponseSchema,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source }),
        },
        fetcher,
      );
    },
    async read(botId, name) {
      return (await request(route(botId, name), methodResponseSchema, undefined, fetcher)).text;
    },
    async setEnabled(botId, name, enablement) {
      return (
        await request(
          route(botId, name),
          updateResponseSchema,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(enablement),
          },
          fetcher,
        )
      ).skill;
    },
    async remove(botId, name) {
      await request(
        route(botId, name),
        deleteResponseSchema,
        { method: "DELETE", headers: { "content-type": "application/json" } },
        fetcher,
      );
    },
  };
}

export const agentSkillsClient = createAgentSkillsClient();
