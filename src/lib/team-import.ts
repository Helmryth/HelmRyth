import type { JsonObject, JsonValue } from "../../server/schema.js";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** Canonical format for every new Helmryth crew export. */
export const CREW_MANIFEST_FORMAT = "helmryth.crew" as const;
/** Decode-only compatibility identifier for pre-crew Helmryth manifests. */
export const LEGACY_TEAM_MANIFEST_FORMAT = "helmryth.team" as const;

export type TeamImportSource = JsonValue | string;

export interface PendingTeamImport {
  manifest: JsonObject;
  kind: "crew" | "package";
  name: string;
  description: string;
  members: Array<{ name: string; title: string }>;
  chiefOfStaff?: string;
  rooms: number;
  playbooks: number;
  routines: number;
  apps: Array<{ label: string; optional: boolean }>;
}

interface PreviewOperator {
  name: string;
  title: string;
  key?: string;
}

const jsonObjectSchema = z.record(z.string(), z.json());
const jsonArraySchema = z.array(z.json());
const nonEmptyNameSchema = z.string().trim().min(1);
const optionalTextSchema = z.string();

/** Small client-side preview only; the server remains the trust boundary. */
export function teamImportPreview(source: TeamImportSource): PendingTeamImport {
  const stringSource = z.string().safeParse(source);
  const manifest = stringSource.success
    ? markdownPackage(stringSource.data)
    : parseManifestObject(source);
  if (manifest.format === "helmryth.package") return packagePreview(manifest);
  if (manifest.format === CREW_MANIFEST_FORMAT) return crewPreview(manifest);
  if (manifest.format !== LEGACY_TEAM_MANIFEST_FORMAT) {
    throw new Error("This is not a portable or supported legacy crew package.");
  }
  return legacyTeamPreview(manifest);
}

function parseManifestObject(source: JsonValue): JsonObject {
  const parsed = jsonObjectSchema.safeParse(source);
  if (!parsed.success) throw new Error("This file does not contain a crew package.");
  return parsed.data;
}

function crewPreview(root: JsonObject): PendingTeamImport {
  if (root.version !== 1) throw new Error(`Crew package version ${String(root.version)} is not supported.`);
  const crew = jsonObjectSchema.safeParse(root.crew);
  if (!crew.success) throw new Error("This crew package is missing its crew definition.");
  const name = nonEmptyNameSchema.safeParse(crew.data.name);
  if (!name.success) throw new Error("This crew does not have a name.");
  const operators = jsonArraySchema.safeParse(crew.data.operators);
  if (!operators.success || operators.data.length === 0) throw new Error("This crew has no operators.");
  if (operators.data.length > 200) throw new Error("This crew has too many operators.");
  return {
    manifest: root,
    kind: "crew",
    name: name.data,
    description: optionalText(crew.data.description),
    members: previewOperators(operators.data).map(({ name: operatorName, title }) => ({
      name: operatorName,
      title,
    })),
    rooms: 0,
    playbooks: 0,
    routines: 0,
    apps: [],
  };
}

function legacyTeamPreview(root: JsonObject): PendingTeamImport {
  if (root.version !== 1 && root.version !== 2) {
    throw new Error(`Crew package version ${String(root.version)} is not supported.`);
  }
  const team = jsonObjectSchema.safeParse(root.team);
  if (!team.success) throw new Error("This crew package is missing its crew definition.");
  const name = nonEmptyNameSchema.safeParse(team.data.name);
  if (!name.success) throw new Error("This crew does not have a name.");
  const operators = jsonArraySchema.safeParse(team.data.members);
  if (!operators.success || operators.data.length === 0) throw new Error("This crew has no operators.");
  if (operators.data.length > 200) throw new Error("This crew has too many operators.");
  return {
    manifest: root,
    kind: "crew",
    name: name.data,
    description: optionalText(team.data.description),
    members: previewOperators(operators.data).map(({ name: operatorName, title }) => ({
      name: operatorName,
      title,
    })),
    rooms: root.version === 1 && jsonObjectSchema.safeParse(team.data.room).success ? 1 : 0,
    playbooks: 0,
    routines: 0,
    apps: [],
  };
}

function previewOperators(input: JsonValue[]): PreviewOperator[] {
  return input.map((member, index) => {
    const operator = jsonObjectSchema.safeParse(member);
    if (!operator.success) throw new Error(`Operator ${index + 1} is invalid.`);
    const name = nonEmptyNameSchema.safeParse(operator.data.name);
    if (!name.success) throw new Error(`Operator ${index + 1} does not have a name.`);
    const result: PreviewOperator = {
      name: name.data,
      title: optionalText(operator.data.title),
    };
    const key = optionalTextSchema.safeParse(operator.data.key);
    if (key.success) result.key = key.data;
    return result;
  });
}

function optionalText(value: JsonValue | undefined): string {
  const parsed = optionalTextSchema.safeParse(value);
  return parsed.success ? parsed.data.trim() : "";
}

function markdownPackage(markdown: string): JsonObject {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw new Error("This Markdown package is missing its metadata block.");
  let yaml: ReturnType<typeof parseYaml>;
  try {
    yaml = parseYaml(frontmatter[1]);
  } catch {
    throw new Error("This Markdown has invalid YAML frontmatter.");
  }
  const metadata = jsonObjectSchema.safeParse(yaml);
  if (!metadata.success) throw new Error("This Markdown package is missing its crew blueprint.");
  // `botmrr` is the pre-rebrand spelling of this marker. Packages exported
  // before the rename still carry it, so both are accepted on read.
  const declared = metadata.data.helmrythPackage ?? metadata.data.botmrr;
  if (declared !== 1) throw new Error("This portable Markdown package version is not supported.");
  const pkg: JsonObject = { ...metadata.data };
  delete pkg.helmrythPackage;
  delete pkg.botmrr;
  return { format: "helmryth.package", version: 1, package: pkg };
}

function packagePreview(root: JsonObject): PendingTeamImport {
  if (root.version !== 1) {
    throw new Error(`Portable crew package version ${String(root.version)} is not supported.`);
  }
  const pkg = jsonObjectSchema.safeParse(root.package);
  if (!pkg.success) throw new Error("This package is missing its crew definition.");
  const name = nonEmptyNameSchema.safeParse(pkg.data.name);
  if (!name.success) throw new Error("This crew package does not have a name.");
  const agents = jsonArraySchema.safeParse(pkg.data.agents);
  if (!agents.success || agents.data.length === 0) throw new Error("This crew package has no operators.");
  if (agents.data.length > 200) throw new Error("This crew package has too many operators.");
  const previewedOperators = previewOperators(agents.data);
  const members = previewedOperators.map(({ name: operatorName, title }) => ({
    name: operatorName,
    title,
  }));
  const chiefKey = optionalTextSchema.safeParse(pkg.data.chiefOfStaff);
  const chief = chiefKey.success
    ? previewedOperators.find((operator) => operator.key === chiefKey.data)?.name
    : undefined;
  const requirements = jsonObjectSchema.safeParse(pkg.data.requirements);
  const requirementApps = requirements.success
    ? jsonArraySchema.safeParse(requirements.data.apps)
    : null;
  const apps: PendingTeamImport["apps"] = [];
  if (requirementApps?.success) {
    for (const appValue of requirementApps.data) {
      const app = jsonObjectSchema.safeParse(appValue);
      if (!app.success) continue;
      const label = optionalTextSchema.safeParse(app.data.label);
      if (label.success) apps.push({ label: label.data.trim(), optional: app.data.optional === true });
    }
  }
  const preview: PendingTeamImport = {
    manifest: root,
    kind: "package",
    name: name.data,
    description: optionalText(pkg.data.summary),
    members,
    rooms: collectionSize(pkg.data.rooms),
    playbooks: collectionSize(pkg.data.playbooks),
    routines: collectionSize(pkg.data.routines),
    apps,
  };
  if (chief) preview.chiefOfStaff = chief;
  return preview;
}

function collectionSize(value: JsonValue | undefined): number {
  const parsed = jsonArraySchema.safeParse(value);
  return parsed.success ? parsed.data.length : 0;
}
