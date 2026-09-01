import { parseJson, type JsonValue } from "./schema.ts";
import { z } from "zod";
import { isBotPackage, parseBotPackage, type ParsedBotPackage } from "./bot-package.ts";
import { CREW_MANIFEST_FILENAME, parseCrewManifest, type ParsedCrewManifest } from "./team-manifest.ts";

export const TEAM_LIBRARY_REPOSITORY = "https://github.com/helmryth/helmryth-crews";
export const TEAM_LIBRARY_RAW_ROOT = "https://raw.githubusercontent.com/helmryth/helmryth-crews/main";
export const TEAM_LIBRARY_CATALOG_URL = `${TEAM_LIBRARY_RAW_ROOT}/catalog.json`;

const MAX_CATALOG_BYTES = 256_000;
const MAX_MANIFEST_BYTES = 1_000_000;

export interface TeamCatalogEntry {
  slug: string;
  name: string;
  summary: string;
  category: string;
  outcome?: string;
  setupMinutes?: number;
  featured?: boolean;
  package?: string;
  manifest: string;
  readme: string;
  members: number;
  skills: string[];
  requires: { apps: string[] };
}

export interface TeamCatalog {
  format: "helmryth.crew-catalog";
  version: 1;
  /** The bytes served to the client came from this source. The repository URL
   * remains attribution for the optional upstream, not a claim that it was
   * reachable for this response. */
  source: "bundled" | "remote";
  repositoryUrl: typeof TEAM_LIBRARY_REPOSITORY;
  teams: TeamCatalogEntry[];
}

type BundledOperatorColor =
  | "green"
  | "blue"
  | "red"
  | "orange"
  | "purple"
  | "cyan"
  | "pink"
  | "yellow"
  | "teal"
  | "coral";

interface BundledOperator {
  key: string;
  name: string;
  title: string;
  description: string;
  color: BundledOperatorColor;
}

function bundledCrew(name: string, description: string, operators: BundledOperator[]): JsonValue {
  return {
    format: "helmryth.crew",
    version: 1,
    crew: {
      name,
      description,
      operators: operators.map((operator) => ({
        key: operator.key,
        name: operator.name,
        title: operator.title,
        description: operator.description,
        appearance: { color: operator.color },
      })),
    },
  };
}

/** These definitions ship in the application bundle. They deliberately carry
 * roles and appearance only: importing one cannot grant tools, credentials,
 * filesystem access, schedules, or remote instructions. */
const BUNDLED_TEAM_DOCUMENTS = new Map<string, JsonValue>([
  ["release-foundry", bundledCrew(
    "Release Foundry",
    "Turn an approved change into a verified, documented, and operable release.",
    [
      {
        key: "release-lead",
        name: "Keel",
        title: "Release lead",
        description: "Own scope, sequence the work, surface risk, and hold the final release decision.",
        color: "purple",
      },
      {
        key: "implementation",
        name: "Forge",
        title: "Implementation operator",
        description: "Deliver scoped changes while preserving system boundaries and migration safety.",
        color: "orange",
      },
      {
        key: "verification",
        name: "Proof",
        title: "Verification operator",
        description: "Exercise acceptance paths, regressions, failure states, and release evidence.",
        color: "green",
      },
      {
        key: "release-ops",
        name: "Harbor",
        title: "Release operations operator",
        description: "Check configuration, artifacts, rollout controls, observability, and rollback readiness.",
        color: "blue",
      },
    ],
  )],
  ["product-compass", bundledCrew(
    "Product Compass",
    "Shape a product decision from user evidence through a testable delivery brief.",
    [
      {
        key: "product-lead",
        name: "North",
        title: "Product lead",
        description: "Frame the decision, reconcile constraints, and keep the work tied to user value.",
        color: "yellow",
      },
      {
        key: "discovery",
        name: "Sounding",
        title: "Discovery operator",
        description: "Collect user signals, distinguish evidence from assumption, and expose unmet needs.",
        color: "cyan",
      },
      {
        key: "experience",
        name: "Contour",
        title: "Experience operator",
        description: "Map flows, states, accessibility needs, and the smallest coherent interaction model.",
        color: "pink",
      },
      {
        key: "measurement",
        name: "Bearing",
        title: "Measurement operator",
        description: "Define success signals, guardrails, instrumentation, and decision thresholds.",
        color: "teal",
      },
    ],
  )],
  ["evidence-desk", bundledCrew(
    "Evidence Desk",
    "Produce a concise research brief with traceable claims and explicit uncertainty.",
    [
      {
        key: "research-lead",
        name: "Ledger",
        title: "Research lead",
        description: "Decompose the question, assign evidence lanes, and synthesize the final brief.",
        color: "blue",
      },
      {
        key: "source-audit",
        name: "Vellum",
        title: "Source auditor",
        description: "Prefer primary sources, verify dates and provenance, and challenge weak claims.",
        color: "purple",
      },
      {
        key: "analysis",
        name: "Prism",
        title: "Analysis operator",
        description: "Compare findings, identify contradictions, and separate conclusions from inference.",
        color: "cyan",
      },
    ],
  )],
  ["customer-relay", bundledCrew(
    "Customer Relay",
    "Move a customer issue from clear intake to a verified resolution and useful follow-up.",
    [
      {
        key: "response-lead",
        name: "Relay",
        title: "Response lead",
        description: "Own the case, maintain context, and keep communication timely and accurate.",
        color: "coral",
      },
      {
        key: "triage",
        name: "Switchboard",
        title: "Triage operator",
        description: "Reproduce the issue, assess impact and urgency, and route it to the right owner.",
        color: "yellow",
      },
      {
        key: "resolution",
        name: "Mender",
        title: "Resolution operator",
        description: "Develop the corrective action, validate it against the reported behavior, and note risks.",
        color: "green",
      },
      {
        key: "customer-comms",
        name: "Beacon",
        title: "Customer communications operator",
        description: "Explain status and resolution in direct language without exposing internal or sensitive detail.",
        color: "blue",
      },
    ],
  )],
  ["reliability-watch", bundledCrew(
    "Reliability Watch",
    "Investigate an operational signal, contain impact, and leave the service safer than it was.",
    [
      {
        key: "incident-lead",
        name: "Watch",
        title: "Incident lead",
        description: "Set priorities, coordinate responders, keep a decision log, and own handoff.",
        color: "red",
      },
      {
        key: "diagnostics",
        name: "Trace",
        title: "Diagnostics operator",
        description: "Build the timeline, test hypotheses against telemetry, and identify the failure boundary.",
        color: "cyan",
      },
      {
        key: "containment",
        name: "Breakwater",
        title: "Containment operator",
        description: "Evaluate reversible mitigations, blast radius, dependencies, and rollback conditions.",
        color: "orange",
      },
      {
        key: "follow-through",
        name: "Anchor",
        title: "Follow-through operator",
        description: "Turn findings into owned corrective actions, verification steps, and durable documentation.",
        color: "purple",
      },
    ],
  )],
]);

const BUNDLED_CATALOG_DOCUMENT: JsonValue = {
  format: "helmryth.crew-catalog",
  version: 1,
  teams: [
    {
      slug: "release-foundry",
      name: "Release Foundry",
      summary: "Build, verify, and prepare a production release.",
      outcome: "A release candidate with evidence, operating checks, and a rollback path.",
      category: "Engineering",
      setupMinutes: 3,
      featured: true,
      manifest: "crews/release-foundry/helmcrew.json",
      readme: "crews/release-foundry/README.md",
      members: 4,
      skills: [],
      requires: { apps: [] },
    },
    {
      slug: "product-compass",
      name: "Product Compass",
      summary: "Turn user evidence into a decision-ready product brief.",
      outcome: "A scoped product direction with flows, measures, and explicit assumptions.",
      category: "Product",
      setupMinutes: 3,
      featured: true,
      manifest: "crews/product-compass/helmcrew.json",
      readme: "crews/product-compass/README.md",
      members: 4,
      skills: [],
      requires: { apps: [] },
    },
    {
      slug: "evidence-desk",
      name: "Evidence Desk",
      summary: "Research a question with source discipline and explicit uncertainty.",
      outcome: "A concise, traceable brief that separates evidence, inference, and open questions.",
      category: "Research",
      setupMinutes: 2,
      manifest: "crews/evidence-desk/helmcrew.json",
      readme: "crews/evidence-desk/README.md",
      members: 3,
      skills: [],
      requires: { apps: [] },
    },
    {
      slug: "customer-relay",
      name: "Customer Relay",
      summary: "Move customer issues from intake through resolution and follow-up.",
      outcome: "A verified resolution with clear communication and reusable learning.",
      category: "Customer operations",
      setupMinutes: 3,
      manifest: "crews/customer-relay/helmcrew.json",
      readme: "crews/customer-relay/README.md",
      members: 4,
      skills: [],
      requires: { apps: [] },
    },
    {
      slug: "reliability-watch",
      name: "Reliability Watch",
      summary: "Investigate and contain an operational incident.",
      outcome: "A contained incident, evidence-backed diagnosis, and owned follow-through.",
      category: "Operations",
      setupMinutes: 3,
      manifest: "crews/reliability-watch/helmcrew.json",
      readme: "crews/reliability-watch/README.md",
      members: 4,
      skills: [],
      requires: { apps: [] },
    },
  ],
};

type Fetcher = typeof fetch;

const catalogHeaderSchema = z.object({
  format: z.literal("helmryth.crew-catalog"),
  version: z.literal(1),
  teams: z.json(),
});
const catalogTeamsSchema = z.array(z.json()).min(1).max(100);
const catalogEntrySchema = z.record(z.string(), z.json());
const positiveMemberCountSchema = z.number().safe().int().min(1).max(200);

function text(value: JsonValue | undefined, field: string, max: number): string {
  const parsed = z.string().trim().min(1).safeParse(value);
  if (!parsed.success) throw new Error(`${field} is required`);
  const normalized = parsed.data;
  if (normalized.length > max) throw new Error(`${field} is too long`);
  return normalized;
}

function relativeFile(value: JsonValue | undefined, field: string, suffix: string, prefix: string): string {
  const path = text(value, field, 300);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    !path.startsWith(prefix) ||
    !path.endsWith(suffix)
  ) {
    throw new Error(`${field} is not a safe catalog path`);
  }
  return path;
}

function stringList(value: JsonValue | undefined, field: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${field} is invalid`);
  return value.map((item, index) => text(item, `${field}[${index}]`, 100));
}

/** Validate the remotely maintained index before any of it reaches the renderer. */
export function parseTeamCatalog(value: JsonValue, source: TeamCatalog["source"] = "remote"): TeamCatalog {
  const header = catalogHeaderSchema.safeParse(value);
  if (!header.success) {
    throw new Error("The crew library catalog is not supported");
  }
  const teamsResult = catalogTeamsSchema.safeParse(header.data.teams);
  if (!teamsResult.success) throw new Error("The crew library catalog is invalid");
  const slugs = new Set<string>();
  const teams = teamsResult.data.map((candidate, index): TeamCatalogEntry => {
    const field = `teams[${index}]`;
    const rawResult = catalogEntrySchema.safeParse(candidate);
    if (!rawResult.success) throw new Error(`${field} is invalid`);
    const raw = rawResult.data;
    const slug = text(raw.slug, `${field}.slug`, 80);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || slugs.has(slug)) {
      throw new Error(`${field}.slug is invalid`);
    }
    slugs.add(slug);
    const prefix = `crews/${slug}/`;
    const requiresResult = catalogEntrySchema.safeParse(raw.requires);
    const requires = requiresResult.success ? requiresResult.data : {};
    const membersResult = positiveMemberCountSchema.safeParse(raw.members);
    if (!membersResult.success) throw new Error(`${field}.members is invalid`);
    if (!Array.isArray(raw.skills)) throw new Error(`${field}.skills is invalid`);
    const team: TeamCatalogEntry = {
      slug,
      name: text(raw.name, `${field}.name`, 100),
      summary: text(raw.summary, `${field}.summary`, 300),
      category: text(raw.category, `${field}.category`, 80),
      manifest: relativeFile(raw.manifest, `${field}.manifest`, CREW_MANIFEST_FILENAME, prefix),
      readme: relativeFile(raw.readme, `${field}.readme`, "README.md", prefix),
      members: membersResult.data,
      skills: raw.skills.map((skill, skillIndex) =>
        relativeFile(skill, `${field}.skills[${skillIndex}]`, "SKILL.md", `${prefix}skills/`),
      ),
      requires: { apps: stringList(requires.apps ?? [], `${field}.requires.apps`, 30) },
    };
    const outcome = z.string().safeParse(raw.outcome);
    if (outcome.success) team.outcome = text(outcome.data, `${field}.outcome`, 300);
    const setupMinutes = z.number().safe().int().min(1).max(240).safeParse(raw.setupMinutes);
    if (setupMinutes.success) team.setupMinutes = setupMinutes.data;
    const featured = z.boolean().safeParse(raw.featured);
    if (featured.success) team.featured = featured.data;
    if (raw.package !== undefined) team.package = relativeFile(raw.package, `${field}.package`, ".md", "packages/");
    return team;
  });
  return {
    format: "helmryth.crew-catalog",
    version: 1,
    source,
    repositoryUrl: TEAM_LIBRARY_REPOSITORY,
    teams,
  };
}

async function fetchJson(url: string, maxBytes: number, fetcher: Fetcher): Promise<JsonValue> {
  const response = await fetcher(url, {
    headers: { accept: "application/json, text/plain;q=0.9" },
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const error = Object.assign(new Error(`GitHub returned HTTP ${response.status}`), { status: response.status });
    throw error;
  }
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > maxBytes) throw new Error("The remote crew file is too large");
  const raw = await response.text();
  if (Buffer.byteLength(raw) > maxBytes) throw new Error("The remote crew file is too large");
  try {
    return parseJson(raw);
  } catch {
    throw new Error("GitHub did not return valid JSON");
  }
}

async function fetchText(url: string, maxBytes: number, fetcher: Fetcher): Promise<string> {
  const response = await fetcher(url, {
    headers: { accept: "text/markdown, text/plain;q=0.9" },
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw Object.assign(new Error(`GitHub returned HTTP ${response.status}`), { status: response.status });
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > maxBytes) throw new Error("The remote crew file is too large");
  const raw = await response.text();
  if (Buffer.byteLength(raw) > maxBytes) throw new Error("The remote crew file is too large");
  return raw;
}

export async function fetchTeamCatalog(fetcher: Fetcher = fetch): Promise<TeamCatalog> {
  try {
    return parseTeamCatalog(await fetchJson(TEAM_LIBRARY_CATALOG_URL, MAX_CATALOG_BYTES, fetcher), "remote");
  } catch {
    // The built-in catalog is the availability boundary. The optional remote
    // source may disappear, time out, or publish malformed data without
    // taking the Library UI offline.
    return parseTeamCatalog(BUNDLED_CATALOG_DOCUMENT, "bundled");
  }
}

export type ParsedShareableTeam = ParsedCrewManifest | ParsedBotPackage;

function parseShareable(value: JsonValue | string): ParsedShareableTeam {
  const markdown = z.string().safeParse(value);
  if (markdown.success) return parseBotPackage(markdown.data);
  return isBotPackage(value) ? parseBotPackage(value) : parseCrewManifest(value);
}

async function fetchShareable(url: string, fetcher: Fetcher): Promise<ParsedShareableTeam> {
  return url.endsWith(".md")
    ? parseBotPackage(await fetchText(url, MAX_MANIFEST_BYTES, fetcher))
    : parseShareable(await fetchJson(url, MAX_MANIFEST_BYTES, fetcher));
}

export async function fetchLibraryTeam(slug: string, fetcher: Fetcher = fetch): Promise<ParsedShareableTeam> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error("That crew name is invalid");
  const bundled = BUNDLED_TEAM_DOCUMENTS.get(slug);
  if (bundled) return parseShareable(bundled);
  const catalog = await fetchTeamCatalog(fetcher);
  const entry = catalog.teams.find((team) => team.slug === slug);
  if (!entry) throw Object.assign(new Error("That library crew was not found"), { status: 404 });
  return fetchShareable(`${TEAM_LIBRARY_RAW_ROOT}/${entry.package ?? entry.manifest}`, fetcher);
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

const LEGACY_CREW_FILENAMES = ["botmrr.md", "team.md", "team.sigilteam.json"] as const;

/** Resolve only public GitHub Markdown playbooks and JSON crew files.
 * Other hosts never reach server fetch. */
export function githubManifestUrls(input: string): string[] {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter a valid GitHub URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Only public HTTPS GitHub links are supported");
  }
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (!parts.every(safeSegment)) throw new Error("That GitHub path is not supported");

  if (url.hostname === "github.com" || url.hostname === "www.github.com") {
    if (parts.length === 2) {
      const [owner, repo] = parts;
      return [
        `https://raw.githubusercontent.com/${owner}/${repo}/main/${CREW_MANIFEST_FILENAME}`,
        ...LEGACY_CREW_FILENAMES.map((filename) => `https://raw.githubusercontent.com/${owner}/${repo}/main/${filename}`),
        `https://raw.githubusercontent.com/${owner}/${repo}/master/${CREW_MANIFEST_FILENAME}`,
        ...LEGACY_CREW_FILENAMES.map((filename) => `https://raw.githubusercontent.com/${owner}/${repo}/master/${filename}`),
      ];
    }
    if (parts.length >= 5 && (parts[2] === "blob" || parts[2] === "raw")) {
      const [owner, repo, , ref, ...file] = parts;
      if (!file.at(-1)?.match(/\.(?:md|json)$/)) throw new Error("The GitHub link must point to a Markdown playbook or JSON crew file");
      return [`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${file.join("/")}`];
    }
  }

  if (url.hostname === "raw.githubusercontent.com" && parts.length >= 4) {
    if (!parts.at(-1)?.match(/\.(?:md|json)$/)) throw new Error("The GitHub link must point to a Markdown playbook or JSON crew file");
    return [`https://raw.githubusercontent.com/${parts.join("/")}`];
  }

  throw new Error("Paste a GitHub repository, Markdown playbook, or JSON crew link");
}

export async function fetchGithubTeam(input: string, fetcher: Fetcher = fetch): Promise<ParsedShareableTeam> {
  const urls = githubManifestUrls(input);
  let lastError: unknown;
  for (const url of urls) {
    try {
      return await fetchShareable(url, fetcher);
    } catch (error) {
      lastError = error;
      const status = z.object({ status: z.number().optional() }).safeParse(error);
      if (!status.success || status.data.status !== 404) throw error;
    }
  }
  throw lastError ?? new Error(`No ${CREW_MANIFEST_FILENAME} or supported legacy crew file was found in that repository`);
}
