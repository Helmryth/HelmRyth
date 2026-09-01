// Bundled skill catalog. Skills remain isolated resources so adding or
// disabling one does not require changing a provider driver. A future Skills
// UI can use the same manifests; today enabled built-ins are selected by their
// declared trigger terms and mounted capabilities.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";

import type { JsonValue } from "./schema.ts";

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  defaultEnabled: boolean;
  triggerTerms: string[];
  requiredCapabilities: string[];
}

export interface BundledSkill {
  manifest: SkillManifest;
  instructions: string;
  directory: string;
}

const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const manifestObjectSchema = z.record(z.string(), z.json());
const nonEmptyStringSchema = z.string().trim().min(1);
const stringListSchema = z.array(nonEmptyStringSchema);

export function parseSkillManifest(value: JsonValue, directory: string): SkillManifest {
  const objectResult = manifestObjectSchema.safeParse(value);
  if (!objectResult.success) throw new Error(`${directory}/manifest.json is invalid`);
  const raw = objectResult.data;
  const idResult = z.string().safeParse(raw.id);
  const id = idResult.success ? idResult.data : "";
  const triggerTermsResult = stringListSchema.safeParse(raw.triggerTerms);
  const triggerTerms = triggerTermsResult.success ? triggerTermsResult.data : null;
  const capabilitiesResult = stringListSchema.safeParse(raw.requiredCapabilities);
  const requiredCapabilities = capabilitiesResult.success ? capabilitiesResult.data : null;
  if (!SAFE_ID.test(id) || id !== basename(directory)) throw new Error(`${directory}/manifest.json has an invalid id`);
  const name = nonEmptyStringSchema.safeParse(raw.name);
  if (!name.success) throw new Error(`${directory}/manifest.json has no name`);
  const version = z.string().regex(/^\d+\.\d+\.\d+$/).safeParse(raw.version);
  if (!version.success) throw new Error(`${directory}/manifest.json has an invalid version`);
  const description = nonEmptyStringSchema.safeParse(raw.description);
  if (!description.success) throw new Error(`${directory}/manifest.json has no description`);
  const defaultEnabled = z.boolean().safeParse(raw.defaultEnabled);
  if (!defaultEnabled.success) throw new Error(`${directory}/manifest.json has no defaultEnabled flag`);
  if (!triggerTerms?.length) throw new Error(`${directory}/manifest.json has no trigger terms`);
  if (!requiredCapabilities) throw new Error(`${directory}/manifest.json has invalid capabilities`);
  return {
    id,
    name: name.data,
    version: version.data,
    description: description.data,
    defaultEnabled: defaultEnabled.data,
    triggerTerms,
    requiredCapabilities,
  };
}

function loadSkillDirectory(directory: string): BundledSkill | null {
  const manifestPath = join(directory, "manifest.json");
  const skillPath = join(directory, "SKILL.md");
  if (!existsSync(manifestPath) || !existsSync(skillPath)) return null;
  const manifest = parseSkillManifest(JSON.parse(readFileSync(manifestPath, "utf8")), directory);
  const instructions = readFileSync(skillPath, "utf8").trim();
  if (!instructions.startsWith("---")) throw new Error(`${skillPath} has no skill frontmatter`);
  return { manifest, instructions, directory };
}

export function loadBundledSkills(root = process.env.HELMRYTH_SKILLS_DIR || join(process.cwd(), "skills")): BundledSkill[] {
  if (!existsSync(root)) return [];
  const skills: BundledSkill[] = [];
  for (const name of readdirSync(root).sort()) {
    const directory = join(root, name);
    const skill = loadSkillDirectory(directory);
    if (skill) skills.push(skill);
  }
  return skills;
}

/** User-authored skills are hot-loaded on each turn so a just-recorded skill
 * works without restarting the desktop app. One hand-edited broken folder is
 * isolated instead of taking down every bot turn. */
export function loadUserSkills(root: string): BundledSkill[] {
  if (!existsSync(root)) return [];
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    return [];
  }
  const skills: BundledSkill[] = [];
  for (const name of names) {
    try {
      const skill = loadSkillDirectory(join(root, name));
      if (skill) skills.push(skill);
    } catch {
      // The recorder always writes atomically validated folders, but people
      // are free to edit them later. A malformed edit disables only itself.
    }
  }
  return skills;
}

export function mergeSkills(bundled: readonly BundledSkill[], user: readonly BundledSkill[]): BundledSkill[] {
  const byId = new Map(bundled.map((skill) => [skill.manifest.id, skill]));
  for (const skill of user) {
    if (!byId.has(skill.manifest.id)) byId.set(skill.manifest.id, skill);
  }
  return [...byId.values()];
}

export function skillInstructionsFor(
  text: string,
  capabilities: Iterable<string>,
  skills: readonly BundledSkill[],
  options?: { includeRoot?: boolean },
): string {
  return renderSkillInstructions(selectBundledSkills(text, capabilities, skills), options);
}

export function selectBundledSkills(
  text: string,
  capabilities: Iterable<string>,
  skills: readonly BundledSkill[],
): BundledSkill[] {
  const haystack = text.toLowerCase();
  const available = new Set(capabilities);
  return skills.filter(({ manifest }) =>
    manifest.defaultEnabled &&
    manifest.requiredCapabilities.every((capability) => available.has(capability)) &&
    manifest.triggerTerms.some((term) => haystack.includes(term.toLowerCase())),
  );
}

export function renderSkillInstructions(
  selected: readonly BundledSkill[],
  { includeRoot = false }: { includeRoot?: boolean } = {},
): string {
  if (!selected.length) return "";
  return selected.map(({ manifest, instructions, directory }) =>
    `\n\n<helmryth-skill id=${JSON.stringify(manifest.id)} version=${JSON.stringify(manifest.version)}${includeRoot ? ` root=${JSON.stringify(directory)}` : ""}>\n${instructions}\n</helmryth-skill>`,
  ).join("");
}
