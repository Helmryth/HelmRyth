import { z } from "zod";

import { schemaIssue, type JsonValue } from "./schema.ts";
import type { SigilColor } from "./store.ts";

/** Native, shareable Helmryth crew document. */
export const CREW_MANIFEST_FORMAT = "helmryth.crew" as const;
export const CREW_MANIFEST_VERSION = 1 as const;
export const CREW_MANIFEST_FILENAME = "helmcrew.json" as const;
export const MAX_CREW_OPERATORS = 200;

/** Import-only identifier for files produced before the Helmryth crew contract. */
const LEGACY_HELMRYTH_TEAM_FORMAT = "helmryth.team" as const;
const LEGACY_TEAM_MANIFEST_VERSIONS = [1, 2] as const;

const COLORS = [
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "yellow",
  "teal",
  "coral",
] as const satisfies readonly SigilColor[];

const requiredText = (max: number) =>
  z.string({ error: "must be text" }).trim().min(1, { message: "is required" }).max(max, { message: "is too long" });

const optionalText = (max: number) =>
  z
    .union([z.string({ error: "must be text" }), z.null(), z.undefined()])
    .transform((value) => value?.trim() || undefined)
    .refine((value) => value === undefined || value.length <= max, { message: "is too long" })
    .optional();

const operatorSchema = z.object({
  key: requiredText(64).regex(/^[a-z0-9][a-z0-9_-]*$/, {
    message: "may only contain lowercase letters, numbers, - and _",
  }),
  name: requiredText(100),
  title: optionalText(200),
  description: optionalText(4_000),
  appearance: z.object({
    color: z.enum(COLORS, { error: "is not supported" }),
    sigilExpression: optionalText(80),
  }),
});

const operatorsSchema = z
  .array(operatorSchema)
  .min(1, { message: "A crew needs at least one operator" })
  .max(MAX_CREW_OPERATORS, { message: `A crew can have at most ${MAX_CREW_OPERATORS} operators` });

const crewManifestSchema = z.object({
  format: z.literal(CREW_MANIFEST_FORMAT, { error: "This is not a Helmryth crew file" }),
  version: z.literal(CREW_MANIFEST_VERSION, { error: "Crew file version is not supported" }),
  crew: z.object({
    name: requiredText(100),
    description: optionalText(2_000),
    operators: operatorsSchema,
  }),
});

const legacyResponderSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), member: requiredText(64) }),
  z.object({ kind: z.literal("everyone") }),
  z.object({ kind: z.literal("mentions") }),
]);

const legacyOperatorSchema = z.object({
  key: requiredText(64).regex(/^[a-z0-9][a-z0-9_-]*$/, {
    message: "may only contain lowercase letters, numbers, - and _",
  }),
  name: requiredText(100),
  title: optionalText(200),
  description: optionalText(4_000),
  appearance: z.object({
    color: z.enum(COLORS, { error: "is not supported" }),
    sigilExpression: optionalText(80),
    mascotExpression: optionalText(80),
  }),
});

const legacyOperatorsSchema = z
  .array(legacyOperatorSchema)
  .min(1, { message: "A legacy crew needs at least one operator" })
  .max(MAX_CREW_OPERATORS, { message: `A legacy crew can have at most ${MAX_CREW_OPERATORS} operators` });

const legacyTeamSchema = z.object({
  format: z.literal(LEGACY_HELMRYTH_TEAM_FORMAT),
  version: z.union([
    z.literal(LEGACY_TEAM_MANIFEST_VERSIONS[0]),
    z.literal(LEGACY_TEAM_MANIFEST_VERSIONS[1]),
  ]),
  team: z.object({
    name: requiredText(100),
    description: optionalText(2_000),
    members: legacyOperatorsSchema,
    room: z.object({
      name: requiredText(100),
      bulletin: optionalText(12_000),
      defaultResponder: legacyResponderSchema,
    }).optional(),
  }),
});

export interface CrewManifestOperator {
  key: string;
  name: string;
  title: string;
  description: string;
  appearance: {
    color: SigilColor;
    sigilExpression?: string;
  };
}

export interface ParsedCrewManifest {
  format: typeof CREW_MANIFEST_FORMAT;
  version: typeof CREW_MANIFEST_VERSION;
  crew: {
    name: string;
    description?: string;
    operators: CrewManifestOperator[];
  };
}

export type CrewManifestV1 = ParsedCrewManifest;
export type CrewManifestInput = JsonValue | ParsedCrewManifest;

interface ExportableOperator {
  id: string;
  name: string;
  title: string;
  description: string;
  color: SigilColor;
  sigilExpression?: string | null;
}

interface ExportableCrew {
  name: string;
  memberIds: string[];
}

function normalizedOperator(
  operator: z.output<typeof operatorSchema> | z.output<typeof legacyOperatorSchema>,
): CrewManifestOperator {
  const appearance: CrewManifestOperator["appearance"] = { color: operator.appearance.color };
  const expression = operator.appearance.sigilExpression ??
    ("mascotExpression" in operator.appearance ? operator.appearance.mascotExpression : undefined);
  if (expression) appearance.sigilExpression = expression;
  return {
    key: operator.key,
    name: operator.name,
    title: operator.title ?? "",
    description: operator.description ?? "",
    appearance,
  };
}

function uniqueOperators(
  values: Array<z.output<typeof operatorSchema> | z.output<typeof legacyOperatorSchema>>,
): CrewManifestOperator[] {
  const seenKeys = new Set<string>();
  return values.map((operator) => {
    if (seenKeys.has(operator.key)) throw new Error(`Duplicate operator key: ${operator.key}`);
    seenKeys.add(operator.key);
    return normalizedOperator(operator);
  });
}

/** Parse an untrusted shareable file and normalize legacy imports immediately. */
export function parseCrewManifest(value: CrewManifestInput): ParsedCrewManifest {
  const current = crewManifestSchema.safeParse(value);
  if (current.success) {
    const result: ParsedCrewManifest = {
      format: CREW_MANIFEST_FORMAT,
      version: CREW_MANIFEST_VERSION,
      crew: {
        name: current.data.crew.name,
        operators: uniqueOperators(current.data.crew.operators),
      },
    };
    if (current.data.crew.description) result.crew.description = current.data.crew.description;
    return result;
  }

  const legacy = legacyTeamSchema.safeParse(value);
  if (legacy.success) {
    const operators = uniqueOperators(legacy.data.team.members);
    if (legacy.data.version === 1 && legacy.data.team.room) {
      const responder = legacy.data.team.room.defaultResponder;
      if (responder.kind === "member" && !operators.some((operator) => operator.key === responder.member)) {
        throw new Error(`Unknown default responder: ${responder.member}`);
      }
    }
    const result: ParsedCrewManifest = {
      format: CREW_MANIFEST_FORMAT,
      version: CREW_MANIFEST_VERSION,
      crew: {
        name: legacy.data.team.name,
        operators,
      },
    };
    if (legacy.data.team.description) result.crew.description = legacy.data.team.description;
    return result;
  }

  const header = z.object({
    format: z.enum([CREW_MANIFEST_FORMAT, LEGACY_HELMRYTH_TEAM_FORMAT]),
    version: z.json(),
  }).safeParse(value);
  if (header.success) {
    const supportedVersion = z.union([z.literal(1), z.literal(2)]).safeParse(header.data.version);
    if (!supportedVersion.success) {
      throw new Error("Crew file version is not supported");
    }
  }
  throw new Error(schemaIssue(current.error, "This is not a Helmryth crew file"));
}

/** The only fields an imported operator definition may seed. */
export interface ImportedOperatorProfile {
  name: string;
  title: string;
  description: string;
  color: SigilColor;
  sigilExpression?: string;
}

const MAX_OPERATOR_NAME = 100;

/** Trim to a UTF-16 length budget without splitting a code point. `slice` cuts
 * between the halves of a surrogate pair, so a 100-unit name whose last
 * character is an emoji loses its low surrogate and the operator is stored —
 * and served over HTTP — with a lone `\ud83d` in its name, which is not a
 * legal string to encode. Advancing by code point keeps the name well formed
 * and still inside the budget the schema enforces. */
function sliceCodePoints(value: string, maxUnits: number): string {
  if (value.length <= maxUnits) return value;
  let out = "";
  for (const character of value) {
    if (out.length + character.length > maxUnits) break;
    out += character;
  }
  return out;
}

/** Build an additive-only operator profile from a portable, untrusted definition. */
export function importedOperatorProfile(
  operator: CrewManifestOperator,
  takenNames: Set<string>,
): ImportedOperatorProfile {
  const base = operator.name.trim();
  let name = base;
  for (let n = 2; takenNames.has(name.toLowerCase()); n++) {
    const tag = ` ${n}`;
    name = `${sliceCodePoints(base, MAX_OPERATOR_NAME - tag.length).trimEnd()}${tag}`;
  }
  takenNames.add(name.toLowerCase());
  const profile: ImportedOperatorProfile = {
    name,
    title: operator.title,
    description: operator.description,
    color: operator.appearance.color,
  };
  if (operator.appearance.sigilExpression) profile.sigilExpression = operator.appearance.sigilExpression;
  return profile;
}

function operatorKey(name: string, index: number, used: Set<string>): string {
  const stem =
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || `operator-${index + 1}`;
  let key = stem;
  let suffix = 2;
  while (used.has(key)) key = `${stem}-${suffix++}`;
  used.add(key);
  return key;
}

/** Build a shareable crew definition without IDs, transcripts, engines, or grants. */
export function createCrewManifest(crew: ExportableCrew, operators: ExportableOperator[]): CrewManifestV1 {
  const byId = new Map(operators.map((operator) => [operator.id, operator]));
  const usedKeys = new Set<string>();
  const portableOperators = crew.memberIds.map((id, index): CrewManifestOperator => {
    const operator = byId.get(id);
    if (!operator) throw new Error(`Crew operator ${id} no longer exists`);
    const appearance: CrewManifestOperator["appearance"] = { color: operator.color };
    if (operator.sigilExpression) appearance.sigilExpression = operator.sigilExpression;
    return {
      key: operatorKey(operator.name, index, usedKeys),
      name: operator.name,
      title: operator.title,
      description: operator.description,
      appearance,
    };
  });

  return parseCrewManifest({
    format: CREW_MANIFEST_FORMAT,
    version: CREW_MANIFEST_VERSION,
    crew: {
      name: crew.name,
      operators: portableOperators,
    },
  });
}
