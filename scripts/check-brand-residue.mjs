#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const self = relative(root, fileURLToPath(import.meta.url));

const SOURCE_ROOTS = [
  ".claude",
  ".github",
  "apps",
  "build",
  "cloudflare",
  "companion",
  "docs",
  "electron",
  "ios",
  "public",
  "scripts",
  "server",
  "shared",
  "skills",
  "src",
  "third_party",
  "tools",
];
const ROOT_FILES = [
  ".gitignore",
  ".oxlintrc.json",
  ".impeccable.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "DESIGN.md",
  "README.md",
  "SECURITY.md",
  "electron-builder.yml",
  "index.html",
  "package.json",
  "pnpm-workspace.yaml",
  "sigil-preview.html",
  "vite.config.ts",
];

const TEXT_EXTENSIONS = new Set([
  ".cjs", ".css", ".example", ".html", ".js", ".json", ".jsonc", ".jsx", ".md", ".mdx", ".mjs",
  ".plist", ".sh", ".swift", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);
const SKIP_DIRECTORIES = new Set([
  ".build", ".git", ".next", ".omc", ".output", ".svelte-kit", ".swiftpm", ".turbo", ".vite",
  ".wrangler", "DerivedData", "coverage", "dist", "dist-native", "dist-server", "node_modules", "out",
  "release", "vendor",
]);
// Retained legal text — license, notice, and attribution copy that must stay
// byte-for-byte. Anchored to the FILE name on purpose: the previous pattern
// also matched the `third_party` path SEGMENT, which exempted that whole tree
// and let 670 stale `openmausbot:` SBOM property names plus a stale
// `OMB_CLOUDFLARED_ARCHIVE_DIR` instruction survive a rebrand the gate
// reported as clean. Our own metadata under third_party/ is not legal text.
const LEGAL_TEXT_FILE =
  /(?:^|\/)(?:LICENSE|LICENCE|COPYING|NOTICE|LEGAL_PROVENANCE|PROVENANCE|ATTRIBUTION|THIRD_PARTY_LICENSES|THIRD_PARTY_NOTICES|Inter-OFL-[\d.]+)(?:\.[A-Za-z0-9.]+)?$/i;
// Vendored upstream source. Its identity must still be ours to police, but its
// prose is not Helmryth copy, so the vocabulary rules do not apply.
const VENDORED_UPSTREAM = /^third_party\/playwright-injected\//;
const ARCHIVAL_OR_PLANNING = /^(?:docs\/(?:plans|superpowers)\/|research-archives\/)/;
const INTERNAL_QA_COPY = /^docs\/qa\//;
const POLICY_OR_AGENT_FILE = /(?:^|\/)(?:AGENTS\.md|DESIGN\.md|\.impeccable\.md)$/;
const TEST_FILE = /(?:^|\/)(?:(?:Tests|__tests__|fixtures|test|tests|testing)\/|[^/]+\.(?:test|spec)\.[^/]+$)/i;
const NON_COPY_SURFACE = /^(?:\.claude\/|\.github\/workflows\/|scripts\/|skills\/)/;
const MAX_SCANNED_FILE_BYTES = 2_000_000;

const IDENTITY_RULES = [
  ["old product name", /\b(?:Open[ _-]?Maus(?:Bot)?|MausBot|Open?[ _-]?GrokBot|Grok[ _-]?Bot)\b/i],
  ["old mascot identity", /\b(?:SupaMaus|SupaSigil|MAUS(?:_[A-Z0-9_]+)?)\b/i],
  ["old bundle, domain, release, or scheme", /(?:openmaus(?:bot)?|opengrok(?:bot)?|mausbot)(?=[-_.:\x2f\\])/],
  ["old storage namespace", /(?:^|[\\/])\.openmaus(?:[\\/]|$)|\bopenmaus\.(?:json|db|sqlite)\b/i],
  ["old environment namespace", /\b(?:OPENMAUS|OPENGROK|MAUSBOT|OGB|OMB)_[A-Z0-9_]+\b/],
  ["old MCP namespace", /\bmcp__ogb(?:__|\b)/i],
  ["old short prefix", /(?:^|[^a-z0-9])omb[-_][a-z0-9]/],
  ["old crew filename", /\bteam\.sigilteam\.json\b/i],
  ["old manifest format", /\b(?:openmaus|helmryth)\.team\b/i],
  ["inherited Grok palette", /pixel[- ]sampled from the real Grok app|\[data-skin=["']midnight["']\]/i],
  [
    "previous-owner runtime destination",
    /(?:github\.com|raw\.githubusercontent\.com)\/milind-soni\b|buy\.polar\.sh\/|polar\.sh\/supa(?:maus|sigil)|\bsupamaus\b|milindsoni\d*\.workers\.dev|(?:Developer ID Application|Maintainer):\s*Milind Soni/i,
  ],
];

const BANNED_COPY = [
  ["bot", /\bbots?\b/i],
  ["assistant", /\bassistant\b/i],
  ["copilot", /\bcopilot\b/i],
  ["AI-powered", /\bAI[ -]powered\b/i],
  ["supercharge", /\bsupercharg(?:e|ed|es|ing)\b/i],
  ["unlock", /\bunlock(?:s|ed|ing)?\s+(?:the\s+)?(?:power|potential|productivity|possibilities|insights|capabilit(?:y|ies))\b/i],
  ["magic", /\bmagic(?:al|ally)?\b/i],
];

// A legacy identifier may remain only at a named, decode-only boundary. Each
// contract also proves that the same subsystem writes a Helmryth-owned value.
// This list is deliberately exact: adding a compatibility alias is a reviewed
// migration decision, never a generic suppression.
export const MIGRATION_CONTRACTS = [
  {
    name: "analytics local-storage migration",
    legacyFile: "src/lib/analytics.ts",
    legacy: [/omb-analytics-opt-out/, /omb-installed/, /omb-email-gate/],
    canonical: [
      ["src/lib/analytics.ts", /const OPT_IN_KEY = ["'](?:helmryth|hry)\./],
      ["src/lib/analytics.ts", /const INSTALLED_KEY = ["'](?:helmryth|hry)\./],
      ["src/lib/analytics.ts", /const PROFILE_GATE_KEY = ["'](?:helmryth|hry)\./],
      ["src/lib/analytics.ts", /writeStorage\(OPT_IN_KEY,/],
      ["src/lib/analytics.ts", /writeStorage\(INSTALLED_KEY,/],
      ["src/lib/analytics.ts", /writeStorage\(PROFILE_GATE_KEY,/],
    ],
    forbidden: [/writeStorage\(LEGACY_/, /setItem\(LEGACY_/],
  },
  {
    name: "webhook credential local-storage migration",
    legacyFile: "src/lib/webhook-credentials.ts",
    legacy: [/omb-webhook-credentials/],
    canonical: [
      ["src/lib/webhook-credentials.ts", /WEBHOOK_CREDENTIALS_KEY\s*=\s*["']helmryth\.webhook-credentials\.v1["']/],
      ["src/lib/webhook-credentials.ts", /setItem\(WEBHOOK_CREDENTIALS_KEY,/],
      ["src/lib/webhook-credentials.ts", /removeItem\?\.\(LEGACY_WEBHOOK_CREDENTIALS_KEY\)/],
    ],
    forbidden: [/setItem\(LEGACY_WEBHOOK_CREDENTIALS_KEY,/],
  },
  {
    name: "light-skin preference migration",
    legacyFile: "src/lib/skins.ts",
    legacy: [/omb-skin/],
    canonical: [
      ["src/lib/skins.ts", /const KEY = ["']helmryth-skin["']/],
      ["src/lib/skins.ts", /setItem\(KEY,/],
      ["src/lib/skins.ts", /removeItem\(LEGACY_KEY\)/],
    ],
    forbidden: [/setItem\(LEGACY_KEY,/],
  },
  {
    name: "companion pairing-token migration",
    legacyFile: "src/lib/companion-pairing.ts",
    legacy: [/omb_pair_/],
    canonical: [
      ["src/lib/companion-pairing.ts", /HELMRYTH_PAIRING_TOKEN\s*=\s*\/\^hry_pair_/],
      ["companion/src/devices.ts", /token:\s*`hry_pair_\$\{/],
    ],
    forbidden: [/token:\s*`omb_pair_\$\{/],
  },
  {
    name: "iOS pairing-token migration",
    legacyFile: "ios/Sources/CompanionCore/Client.swift",
    legacy: [/omb_pair_/],
    canonical: [
      ["ios/Sources/CompanionCore/Client.swift", /hry_pair_/],
      ["companion/src/devices.ts", /token:\s*`hry_pair_\$\{/],
    ],
    forbidden: [],
  },
  {
    name: "crew-manifest migration",
    legacyFile: "server/team-manifest.ts",
    legacy: [/openmaus\.team/, /helmryth\.team/],
    canonical: [
      ["server/team-manifest.ts", /CREW_MANIFEST_FORMAT\s*=\s*["']helmryth\.crew["']/],
      ["server/team-manifest.ts", /format:\s*CREW_MANIFEST_FORMAT/],
    ],
    forbidden: [],
  },
  {
    name: "renderer legacy-crew preview",
    legacyFile: "src/lib/team-import.ts",
    legacy: [/helmryth\.team/],
    canonical: [
      ["src/lib/team-import.ts", /LEGACY_TEAM_MANIFEST_FORMAT\s*=\s*["']helmryth\.team["']/],
      ["server/team-manifest.ts", /CREW_MANIFEST_FORMAT\s*=\s*["']helmryth\.crew["']/],
      ["server/team-manifest.ts", /format:\s*CREW_MANIFEST_FORMAT/],
    ],
    forbidden: [],
  },
  {
    name: "legacy crew-filename discovery",
    legacyFile: "server/team-library.ts",
    legacy: [/team\.sigilteam\.json/],
    canonical: [
      ["server/team-library.ts", /import \{ CREW_MANIFEST_FILENAME,/],
      ["server/team-library.ts", /main\/\$\{CREW_MANIFEST_FILENAME\}/],
    ],
    forbidden: [],
  },
];

export function shouldSkipDirectory(name) {
  return SKIP_DIRECTORIES.has(name);
}

function walk(path, files) {
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && shouldSkipDirectory(entry.name)) continue;
    const target = join(path, entry.name);
    if (entry.isDirectory()) walk(target, files);
    else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.add(target);
  }
}

function sourceFiles(scanRoot = root) {
  const files = new Set();
  for (const directory of SOURCE_ROOTS) walk(join(scanRoot, directory), files);
  for (const name of ROOT_FILES) {
    const path = join(scanRoot, name);
    try {
      if (statSync(path).isFile()) files.add(path);
    } catch {
      // Optional root files do not weaken the scan.
    }
  }
  return [...files].sort();
}

function matchingMigrationContract(name, line) {
  return MIGRATION_CONTRACTS.find(
    (contract) => contract.legacyFile === name && contract.legacy.some((pattern) => pattern.test(line)),
  );
}

function explicitlyLegacy(name, line) {
  const contract = matchingMigrationContract(name, line);
  if (!contract) return false;
  return (
    /\bLEGACY_[A-Z0-9_]+\b/.test(line) ||
    /\blegacy[A-Za-z0-9_]*\b/i.test(line) ||
    /brand-check:\s*allow-legacy\b/i.test(line)
  );
}

function ignoredFile(name) {
  return (
    name === self ||
    LEGAL_TEXT_FILE.test(name) ||
    ARCHIVAL_OR_PLANNING.test(name) ||
    POLICY_OR_AGENT_FILE.test(name)
  );
}

export function identityFindings(name, lines) {
  if (ignoredFile(name) || TEST_FILE.test(name)) return [];
  const findings = [];
  for (const [index, line] of lines.entries()) {
    for (const [label, pattern] of IDENTITY_RULES) {
      if (pattern.test(line) && !explicitlyLegacy(name, line)) {
        findings.push({ name, line: index + 1, label, excerpt: line.trim() });
        break;
      }
    }
  }
  return findings;
}

function stringLiterals(line) {
  const values = [];
  for (let index = 0; index < line.length; index += 1) {
    const quote = line[index];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    let value = "";
    let escaped = false;
    let closed = false;
    for (index += 1; index < line.length; index += 1) {
      const character = line[index];
      if (escaped) {
        value += character;
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        closed = true;
        break;
      } else {
        value += character;
      }
    }
    if (closed) values.push(value);
  }
  return values;
}

function internalContractLiteral(value) {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (!/\s/.test(trimmed) && /^[A-Za-z0-9_./:@${}-]+$/.test(trimmed)) return true;
  if (/^(?:bot|bots|assistant)$/.test(trimmed)) return true;
  if (/^(?:\/api\/|mcp__|[A-Z][A-Z0-9_]+$)/.test(trimmed)) return true;
  if (/^\[[a-z0-9_-]+(?:=[^\]]+)?\]$/i.test(trimmed)) return true;
  if (/^(?:list|create|update|delete|ask|delegate|send|get|set|wait|interrupt)_[a-z0-9_]+$/.test(trimmed)) return true;
  if (/^(?:bot|bots|group|groups|task|tasks|assistant)[.:/_-][a-z0-9.:/_-]+$/i.test(trimmed)) return true;
  if (/\.(?:json|ndjson|sqlite|db|ts|tsx|js|mjs)$/.test(trimmed) && !/\s/.test(trimmed)) return true;
  return false;
}

function proseLine(line) {
  return line
    .replace(/`[^`]*`/g, "")
    .replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, "");
}

function internalQaContractProse(value) {
  return value
    // The checked QA corpus must use the exact compatibility vocabulary that
    // it exercises. This exemption is intentionally term-level; every other
    // banned-copy category continues through the normal public-copy rules.
    .replace(/\bbots?\b/gi, "")
    // Driver transcripts call streamed model output "assistant text". Allow
    // that exact technical phrase without allowing "assistant" as product copy.
    .replace(/\bassistant(?=\s+text\b)/gi, "");
}

export function copyFindings(name, lines) {
  if (
    ignoredFile(name) ||
    TEST_FILE.test(name) ||
    NON_COPY_SURFACE.test(name) ||
    VENDORED_UPSTREAM.test(name)
  ) return [];
  const extension = extname(name).toLowerCase();
  const proseFile =
    extension === ".md" || extension === ".mdx" || extension === ".html" || extension === ".txt" ||
    name.startsWith(".github/ISSUE_TEMPLATE/");
  const findings = [];
  let fenced = false;
  for (const [index, line] of lines.entries()) {
    if (proseFile && /^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/brand-check:\s*allow-copy\b/i.test(line)) continue;
    if (!proseFile && /^\s*(?:\/\/|\/\*|\*|\*\/)/.test(line)) continue;
    // Swift interpolation contains internal model identifiers inside a visible
    // string. Remove only the interpolation expression; surrounding human copy
    // still goes through the vocabulary rules.
    const literalSource = extension === ".swift" ? line.replace(/\\\([^)]*\)/g, "") : line;
    const candidates = (proseFile ? [proseLine(line)] : stringLiterals(literalSource))
      .map((value) => value
        .replace(/\$\{[^}]*\}/g, "")
        .replace(/\\\([^)]*\)/g, "")
        .replace(/\([A-Za-z_][A-Za-z0-9_.?]*\)/g, ""));
    for (const value of candidates) {
      if (!proseFile && internalContractLiteral(value)) continue;
      const inspectedValue = INTERNAL_QA_COPY.test(name) ? internalQaContractProse(value) : value;
      for (const [label, pattern] of BANNED_COPY) {
        if (pattern.test(inspectedValue)) {
          findings.push({ name, line: index + 1, label: `visible copy: ${label}`, excerpt: value.trim() });
        }
      }
    }
  }
  return findings;
}

export function migrationContractFindings(contentsByName) {
  const findings = [];
  for (const contract of MIGRATION_CONTRACTS) {
    const legacyContents = contentsByName.get(contract.legacyFile);
    if (!legacyContents || !contract.legacy.some((pattern) => pattern.test(legacyContents))) continue;

    for (const [name, pattern] of contract.canonical) {
      const contents = contentsByName.get(name) ?? "";
      if (!pattern.test(contents)) {
        findings.push({
          name: contract.legacyFile,
          line: 1,
          label: "incomplete legacy migration",
          excerpt: `${contract.name} is missing canonical Helmryth proof ${pattern}`,
        });
      }
    }
    for (const pattern of contract.forbidden) {
      for (const [name, contents] of contentsByName) {
        if (TEST_FILE.test(name) || ignoredFile(name)) continue;
        if (pattern.test(contents)) {
          findings.push({
            name,
            line: 1,
            label: "legacy value is still written",
            excerpt: `${contract.name} must be decode/read-only (${pattern})`,
          });
        }
      }
    }
  }
  return findings;
}

export function scanRepository(scanRoot = root) {
  const findings = [];
  const contentsByName = new Map();
  for (const path of sourceFiles(scanRoot)) {
    let contents;
    try {
      if (statSync(path).size > MAX_SCANNED_FILE_BYTES) continue;
      contents = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (contents.includes("\0")) continue;
    // Every exemption below is written with forward slashes (docs/qa/,
    // third_party/playwright-injected/), but `relative` returns the platform
    // separator — so on Windows nothing matched and the gate reported 163
    // findings against QA prose it is supposed to exempt. Normalise once, here,
    // rather than teaching each pattern about backslashes.
    const name = relative(scanRoot, path).split(sep).join("/");
    contentsByName.set(name, contents);
    const lines = contents.split(/\r?\n/);
    findings.push(...identityFindings(name, lines), ...copyFindings(name, lines));
  }
  findings.push(...migrationContractFindings(contentsByName));
  return findings;
}

function main() {
  const findings = scanRepository();
  if (findings.length) {
    process.stderr.write(`Brand residue check failed with ${findings.length} finding(s):\n`);
    for (const finding of findings) {
      const excerpt = finding.excerpt.length > 180 ? `${finding.excerpt.slice(0, 177)}...` : finding.excerpt;
      process.stderr.write(`- ${finding.name}:${finding.line} [${finding.label}] ${excerpt}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write("Brand residue check passed.\n");
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
