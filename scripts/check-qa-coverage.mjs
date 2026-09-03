import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const ROOT = new URL("../", import.meta.url);
const rootPath = fileURLToPath(ROOT);
const qaDir = path.join(rootPath, "docs", "qa");

const requiredDocs = [
  "01-desktop-shell-onboarding-roster.md",
  "02-workstreams-crews-runs-gates.md",
  "03-system-settings-engines-identity.md",
  "04-operations-cadences-webhooks-capabilities-methods-trace.md",
  "05-workbenches-browser-host-isolated-remote.md",
  "06-voice-mobile-relay-android-ios.md",
  "07-backend-http-sse-webhook-api.md",
  "08-cloud-registry-conduit-mcp.md",
  "09-security-privacy-data-migrations.md",
  "10-electron-packaging-ci-release.md",
  "11-accessibility-responsive-visual-performance.md",
  "12-automated-suite-environments-and-evidence.md",
  "13-route-control-traceability-matrix.md",
  "14-execution-report.md",
  "README.md",
  "TEST-CASE-TEMPLATE.md",
];

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function isMainModule(moduleUrl, argvEntry) {
  if (!argvEntry) return false;
  try {
    return fs.realpathSync(fileURLToPath(moduleUrl)) === fs.realpathSync(path.resolve(argvEntry));
  } catch {
    return false;
  }
}

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(target) : [target];
  });
}

function splitMarkdownRow(line) {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  const cells = [""];
  let inlineCode = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      cells[cells.length - 1] += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      cells[cells.length - 1] += character;
      escaped = true;
      continue;
    }
    if (character === "`") {
      inlineCode = !inlineCode;
      cells[cells.length - 1] += character;
      continue;
    }
    if (character === "|" && !inlineCode) {
      cells.push("");
      continue;
    }
    cells[cells.length - 1] += character;
  }
  return cells.map((cell) => cell.trim());
}

function markdownIntegrity(files) {
  const definitions = new Map();
  const malformedRows = [];
  const placeholderFindings = [];
  const brokenLinks = [];
  const brokenSourceReferences = [];
  const caseIdPattern = /^`?[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+`?$/;
  const definitionPattern = /(?:^\|\s*`?|^###\s+`?)([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)(?:`?\s*\||`?\s+[-—])/gm;
  const sourcePrefix = /^(?:\.github|apps|build|cloudflare|companion|docs|electron|ios|scripts|server|src|third_party)\//;
  const rootSourceFiles = new Set([
    "DESIGN.md",
    "SECURITY.md",
    "electron-builder.yml",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ]);

  for (const file of files) {
    const contents = read(file);
    const relative = path.relative(qaDir, file);
    const lines = contents.split("\n");

    for (const match of contents.matchAll(definitionPattern)) {
      const id = match[1];
      if (!definitions.has(id)) definitions.set(id, new Set());
      definitions.get(id).add(relative);
    }

    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].startsWith("|")) continue;
      const header = splitMarkdownRow(lines[index]);
      if (header[0] !== "ID") continue;
      if (!/^\|[ :|-]+\|/.test(lines[index + 1] ?? "")) continue;
      for (let row = index + 2; row < lines.length && lines[row].startsWith("|"); row += 1) {
        const cells = splitMarkdownRow(lines[row]);
        if (caseIdPattern.test(cells[0]) && cells.length !== header.length) {
          malformedRows.push(`${relative}:${row + 1} ${cells[0]} has ${cells.length} fields; header has ${header.length}`);
        }
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!/\b(?:TODO|TBD|FIXME)\b|same as above|repeat similarly|rest unchanged|placeholder/i.test(line)) continue;
      const allowedCloudflarePlaceholder = relative === "08-cloud-registry-conduit-mcp.md" && /placeholder/i.test(line);
      const allowedTemplateProhibition = relative === "TEST-CASE-TEMPLATE.md" && /may not omit.*repeat similarly/i.test(line);
      const allowedAuditSummary = relative === "05-workbenches-browser-host-isolated-remote.md" && /0 placeholder-pattern findings/i.test(line);
      const allowedExecutionSummary = relative === "14-execution-report.md" && /corpus integrity gate.*placeholder omissions/i.test(line);
      if (!allowedCloudflarePlaceholder && !allowedTemplateProhibition && !allowedAuditSummary && !allowedExecutionSummary) {
        placeholderFindings.push(`${relative}:${index + 1} ${line.trim()}`);
      }
    }

    for (const match of contents.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      let target = match[1].trim().replace(/^<|>$/g, "");
      if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
      target = target.split("#")[0].replace(/:\d+(?::\d+)?$/, "");
      if (!target) continue;
      const resolved = path.isAbsolute(target) ? target : path.resolve(path.dirname(file), target);
      if (!fs.existsSync(resolved)) brokenLinks.push(`${relative}: ${match[1]}`);
    }

    for (const match of contents.matchAll(/`([^`\n]+)`/g)) {
      let target = match[1].trim();
      if (!sourcePrefix.test(target) && !rootSourceFiles.has(target)) continue;
      if (/[{}*<>|?]/.test(target) || target.includes("...") || /\s/.test(target)) continue;
      target = target.replace(/[,:;.]$/, "").replace(/:\d+(?::\d+)?$/, "").replace(/#.*$/, "");
      // Packaged resource paths describe build output, not checked-in source.
      if (target === "server/index.js") continue;
      if (!fs.existsSync(path.join(rootPath, target))) brokenSourceReferences.push(`${relative}: ${match[1]}`);
    }
  }

  const duplicateIds = [...definitions.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([id, owners]) => `${id}: ${[...owners].join(", ")}`);
  return { duplicateIds, malformedRows, placeholderFindings, brokenLinks, brokenSourceReferences };
}

function sourceCensus() {
  const rendererFiles = walkFiles(path.join(rootPath, "src"))
    .filter((file) => file.endsWith(".tsx") && path.basename(file) !== "sigil-preview.tsx");
  const controlTags = new Set(["button", "input", "select", "textarea", "a", "form", "label", "summary"]);
  let rendererControls = 0;
  let rendererControlFiles = 0;
  for (const file of rendererFiles) {
    const sourceFile = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let fileControls = 0;
    const visit = (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (controlTags.has(node.tagName.getText(sourceFile))) fileControls += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    rendererControls += fileControls;
    if (fileControls > 0) rendererControlFiles += 1;
  }

  const rootTestFiles = ["server", "src", "companion", "electron", "scripts"]
    .flatMap((directory) => walkFiles(path.join(rootPath, directory)))
    .filter((file) => /(?:\.test\.ts|\.test\.tsx|\.test\.mjs)$/.test(file)).length;

  const ipcSources = ["electron/main.mjs", "electron/cua.mjs", "electron/updater.mjs", "electron/android-device.mjs"]
    .map((file) => read(path.join(rootPath, file)))
    .join("\n");
  const ipcCallSites = [...ipcSources.matchAll(/ipcMain\.(?:handle|on|once)\(/g)].length;
  const literalIpc = [...ipcSources.matchAll(/ipcMain\.(?:handle|on|once)\(\s*["'][^"']+["']/g)].length;
  const dynamicIpc = [...ipcSources.matchAll(/ipcMain\.(?:handle|on|once)\(\s*`\$\{prefix\}:[^`]+`/g)].length;
  const runtimeIpc = literalIpc + dynamicIpc * 2;
  const preload = read(path.join(rootPath, "electron/preload.cjs"));
  const ipcEvents = new Set(
    [...preload.matchAll(/ipcRenderer\s*\.\s*on\(\s*["']([^"']+)["']/g)].map((match) => match[1]),
  );

  const server = read(path.join(rootPath, "server/index.ts"));
  const webhook = read(path.join(rootPath, "server/webhook-ingress.ts"));
  const routeMarkers = {
    equality: [...server.matchAll(/path\s*===\s*"\/api\//g)].length,
    match: server.split("\n").filter((line) => line.includes("path.match(/^\\/api")).length,
    exec: [...server.matchAll(/\.exec\(path\)/g)].length,
    startsWith: [...server.matchAll(/path\.startsWith\("\/api\//g)].length,
    webhook: webhook.split("\n").filter((line) => /url\.pathname\s*===|url\.pathname\.match/.test(line)).length,
  };

  return {
    rendererFiles: rendererFiles.length,
    rendererControlFiles,
    rendererControls,
    rootTestFiles,
    ipcCallSites,
    literalIpc,
    dynamicIpc,
    runtimeIpc,
    ipcEvents: ipcEvents.size,
    routeMarkers,
  };
}

function listWorkflowJobIds(file) {
  const lines = read(file).split("\n");
  const jobs = [];
  let inJobs = false;
  for (const line of lines) {
    if (line === "jobs:") {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (!line.trim()) continue;
    if (!line.startsWith("  ")) break;
    const match = line.match(/^  ([A-Za-z0-9_-]+):$/);
    if (match) jobs.push(match[1]);
  }
  return jobs;
}

function routeInventory() {
  return [
    "GET /api/bots",
    "GET /api/bots/:id/checkpoints",
    "GET /api/bots/:id/computer",
    "GET /api/bots/:id/computer/control",
    "GET /api/bots/:id/connector-cards/:messageId/status",
    "GET /api/bots/:id/local-computer",
    "GET /api/bots/:id/memory",
    "GET /api/bots/:id/memory/topics/:topic",
    "GET /api/bots/:id/skills",
    "GET /api/bots/:id/skills/:slug",
    "GET /api/cli-candidates",
    "GET /api/config",
    "GET /api/connectors",
    "GET /api/connectors/catalog",
    "GET /api/connectors/connected",
    "GET /api/decisions",
    "GET /api/events",
    "GET /api/health",
    "GET /api/instances",
    "GET /api/internal/computer-control",
    "GET /api/internal/agents",
    "GET /api/internal/delegations/:taskId",
    "GET /api/internal/routines",
    "GET /api/local-computer",
    "GET /api/routines",
    "GET /api/search",
    "GET /api/section-context",
    "GET /api/team-library/catalog",
    "GET /api/team-library/teams/:slug",
    "GET /api/team-map",
    "GET /api/teams/scout",
    "GET /api/teams/scout/directory",
    "GET /api/teams/imports",
    "GET /api/threads/:threadId/events",
    "GET /api/threads/:threadId/export",
    "GET /api/threads/:threadId/messages",
    "GET /api/threads/:threadId/messages/:messageId/image",
    "GET /api/attachments/:name",
    "GET /api/tts/voices",
    "GET /api/webhooks",
    "PATCH /api/bots/:id",
    "PATCH /api/bots/:id/cards/:cardId",
    "PATCH /api/bots/:id/profile",
    "PATCH /api/bots/:id/skills/:slug",
    "PATCH /api/bots/:id/tasks/:taskId",
    "PATCH /api/config",
    "PATCH /api/groups/:id",
    "PATCH /api/groups/:id/setup",
    "PATCH /api/groups/:id/tasks/:taskId",
    "PATCH /api/instances/:id",
    "PATCH /api/routines/:id",
    "PATCH /api/webhooks/:id",
    "POST /api/attachments",
    "POST /api/bots",
    "POST /api/bots/:id/active-branch",
    "POST /api/bots/:id/always-allow",
    "POST /api/bots/:id/avatar/generate",
    "POST /api/bots/:id/checkpoints/restore",
    "POST /api/bots/:id/computer/control",
    "POST /api/bots/:id/computer/exec",
    "POST /api/bots/:id/computer/join",
    "POST /api/bots/:id/computer/provision",
    "POST /api/bots/:id/computer/remove",
    "POST /api/bots/:id/computer/screenshot",
    "POST /api/bots/:id/computer/sleep",
    "POST /api/bots/:id/computer/viewer-close",
    "POST /api/bots/:id/connector-cards/:messageId/authorize",
    "POST /api/bots/:id/connector-cards/:messageId/dismiss",
    "POST /api/bots/:id/connector-cards/:messageId/resume",
    "POST /api/bots/:id/interrupt",
    "POST /api/bots/:id/local-computer/remove",
    "POST /api/bots/:id/local-computer/run",
    "POST /api/bots/:id/local-computer/screenshot",
    "POST /api/bots/:id/local-computer/stop",
    "POST /api/bots/:id/messages",
    "POST /api/bots/:id/messages/:messageId/edit",
    "POST /api/bots/:id/read",
    "POST /api/bots/:id/respond",
    "POST /api/bots/:id/secret-cards/:messageId/dismiss",
    "POST /api/bots/:id/secret-cards/:messageId/provided",
    "POST /api/bots/:id/secret-cards/:messageId/resume",
    "POST /api/bots/:id/skills",
    "POST /api/bots/:id/tasks",
    "POST /api/bots/:id/tasks/:taskId",
    "POST /api/cli-test",
    "POST /api/connectors/:slug/authorize",
    "POST /api/groups",
    "POST /api/groups/:id/interrupt",
    "POST /api/groups/:id/messages",
    "POST /api/groups/:id/read",
    "POST /api/groups/:id/tasks",
    "POST /api/groups/:id/tasks/:taskId",
    "POST /api/internal/ask-bot",
    "POST /api/internal/connectors/mcp",
    "POST /api/internal/connectors/request",
    "POST /api/internal/computer-control",
    "POST /api/internal/create-bot",
    "POST /api/internal/delegate-bot",
    "POST /api/internal/request-credential",
    "POST /api/internal/routine-requests",
    "POST /api/local-computer/interrupt",
    "POST /api/local-computer/pull",
    "POST /api/local-computer/remove",
    "POST /api/local-computer/run",
    "POST /api/local-computer/screenshot",
    "POST /api/local-computer/start",
    "POST /api/local-computer/stop",
    "POST /api/routine-runs/:id/cancel",
    "POST /api/routine-runs/:id/seen",
    "POST /api/routines",
    "POST /api/routines/:id/run",
    "POST /api/team-library/github",
    "POST /api/teams/export",
    "POST /api/teams/import",
    "POST /api/teams/imports/:transactionId/undo",
    "POST /api/threads/:threadId/messages/:messageId/reactions",
    "POST /api/threads/:threadId/respond",
    "POST /api/tts/prepare",
    "POST /api/tts/speak",
    "POST /api/webhooks",
    "POST /api/webhooks/:id/rotate",
    "POST /api/webhooks/:id/test",
    "PUT /api/bots/:id/memory",
    "PUT /api/config",
    "PUT /api/section-context",
    "DELETE /api/bots/:id",
    "DELETE /api/bots/:id/queue/:queueId",
    "DELETE /api/bots/:id/skills/:slug",
    "DELETE /api/bots/:id/tasks/:taskId",
    "DELETE /api/connectors/:slug",
    "DELETE /api/connectors/:slug/accounts/:accountId",
    "DELETE /api/groups/:id",
    "DELETE /api/groups/:id/tasks/:taskId",
    "DELETE /api/internal/computer-control",
    "DELETE /api/routines/:id",
    "DELETE /api/webhooks/:id",
    "GET /health",
    "POST /hooks/:endpointId",
    "POST /hooks/:endpointId/:secret",
    "GET /healthz",
    "GET /v1/account",
    "GET /v1/nodes",
    "POST /v1/nodes",
    "GET /v1/nodes/self",
    "POST /v1/nodes/:id/credentials/rotate",
    "DELETE /v1/nodes/:id",
    "GET /v1/nodes/self/reach",
    "POST /v1/nodes/self/reach",
    "DELETE /v1/nodes/self/reach",
    "POST /api/auth/email-otp/send-verification-otp",
    "POST /api/auth/sign-in/email-otp",
    "POST /api/auth/sign-out",
    "POST /v1/mcp",
    "GET /v1/self",
    "GET /v1/capabilities/catalog",
    "GET /v1/capabilities/active",
    "GET /v1/capabilities",
    "POST /v1/capabilities/:slug/authorize",
    "DELETE /v1/capabilities/:slug",
    "DELETE /v1/capabilities/:slug/accounts/:accountId",
    // Conduit and Registry each register these same exact strings. Keep the
    // duplicates so the reported count represents source registrations,
    // while the unique count below remains an exact-string metric.
    "GET /healthz",
    "POST /v1/nodes",
  ];
}

function ipcInventory() {
  return [
    "android-device:frame",
    "android-device:input",
    "android-device:status",
    "assemblyai:set-key",
    "assemblyai:status",
    "assemblyai:streaming-token",
    "browser:available",
    "browser:back",
    "browser:close",
    "browser:forget-profile",
    "browser:forward",
    "browser:layout",
    "browser:navigate",
    "browser:state",
    "companion-account:request-code",
    "companion-account:retry",
    "companion-account:sign-out",
    "companion-account:state",
    "companion-account:verify-code",
    "companion:cloud-desktop",
    "companion:keep-awake",
    "companion:pairing",
    "companion:revoke",
    "companion:start",
    "companion:state",
    "companion:stop",
    "credential:set",
    "cua:connection",
    "cua:linux-disable",
    "cua:linux-enable",
    "cua:linux-retry",
    "cua:linux-status",
    "cua:permissions",
    "desktop-viewer:close",
    "desktop-viewer:open",
    "desktop-viewer:state-now",
    "desktop-workspace:close",
    "desktop-workspace:layout",
    "desktop-workspace:open",
    "desktop-workspace:set-interactive",
    "desktop:capabilities",
    "desktop:export-diagnostics",
    "desktop:open-external",
    "desktop:pick-folder",
    "desktop:save-file",
    "desktop:skin",
    "desktop:unread-count",
    "engine:open-terminal",
    "perm:open-settings",
    "perm:request-mic",
    "perm:status",
    "reach:cloud-desktop",
    "reach:keep-awake",
    "reach:pairing",
    "reach:revoke",
    "reach:start",
    "reach:state",
    "reach:stop",
    "registry:request-code",
    "registry:retry",
    "registry:sign-out",
    "registry:state",
    "registry:verify-code",
    "screen:frame",
    "screen:preview-intent",
    "skill-recorder:permissions",
    "skill-recorder:save",
    "skill-recorder:start",
    "skill-recorder:stop",
    "speech:finish",
    "speech:start",
    "speech:stop",
    "update:check",
    "update:download",
    "update:get-state",
    "update:install",
  ];
}

function ipcEventInventory() {
  return [
    "browser:state",
    "desktop-viewer:state",
    "desktop-workspace:state",
    "desktop:capabilities-changed",
    "package:install",
    "skill-recorder:end",
    "skill-recorder:event",
    "speech:end",
    "speech:transcript",
    "update:state",
  ];
}

function parsePackageScriptLedger(contents) {
  const match = contents.match(
    /<!-- qa-package-script-ledger:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- qa-package-script-ledger:end -->/,
  );
  if (!match) throw new Error("missing structured package-script ledger");
  const ledgerResult = z.record(z.string(), z.unknown()).safeParse(JSON.parse(match[1]));
  if (!ledgerResult.success) {
    throw new Error("package-script ledger must be a JSON object");
  }
  const normalizedEntries = [];
  const scriptsSchema = z.array(z.string().min(1));
  for (const [manifest, value] of Object.entries(ledgerResult.data)) {
    const scriptsResult = scriptsSchema.safeParse(value);
    if (!scriptsResult.success) {
      throw new Error(`package-script ledger entry ${manifest} must be an array of non-empty strings`);
    }
    const scripts = scriptsResult.data;
    if (new Set(scripts).size !== scripts.length) {
      throw new Error(`package-script ledger entry ${manifest} contains duplicate scripts`);
    }
    normalizedEntries.push([manifest, scripts]);
  }
  return Object.fromEntries(normalizedEntries);
}

function comparePackageScriptLedger(actualManifests, documentedLedger) {
  const actual = new Set(
    actualManifests.flatMap((manifest) => manifest.scripts.map((script) => `${manifest.name}:${script}`)),
  );
  const documented = new Set(
    Object.entries(documentedLedger).flatMap(([manifest, scripts]) =>
      scripts.map((script) => `${manifest}:${script}`),
    ),
  );
  return {
    missing: [...actual].filter((entry) => !documented.has(entry)).sort(),
    unexpected: [...documented].filter((entry) => !actual.has(entry)).sort(),
  };
}

export function runQaCoverage() {
  const packageManifestNames = [
    "package.json",
    "companion/package.json",
    "apps/docs/package.json",
    "cloudflare/composio-broker/package.json",
    "cloudflare/control-plane/package.json",
  ];
  const packageManifests = packageManifestNames.map((name) => ({
    name,
    scripts: Object.keys(JSON.parse(read(path.join(rootPath, name))).scripts ?? {}),
  }));
  const packageScriptCount = packageManifests.reduce((count, manifest) => count + manifest.scripts.length, 0);
  const workflowDir = path.join(rootPath, ".github", "workflows");
  const workflows = fs.readdirSync(workflowDir).filter((name) => name.endsWith(".yml")).sort();
  const workflowLabels = workflows.flatMap((name) => {
    const base = name.replace(/\.yml$/, "");
    return [name, ...listWorkflowJobIds(path.join(workflowDir, name)).map((job) => `${base}:${job}`)];
  });
  
  const qaFiles = fs.readdirSync(qaDir).filter((name) => name.endsWith(".md")).sort();
  const missingDocs = requiredDocs.filter((name) => !qaFiles.includes(name));
  const qaPaths = qaFiles.map((name) => path.join(qaDir, name));
  
  const qaCorpus = requiredDocs
    .filter((name) => fs.existsSync(path.join(qaDir, name)))
    .map((name) => read(path.join(qaDir, name)))
    .join("\n");
  
  function missing(items) {
    return items.filter((item) => !qaCorpus.includes(item));
  }
  
  let packageScriptLedger;
  let packageScriptLedgerError = "";
  try {
    packageScriptLedger = parsePackageScriptLedger(
      read(path.join(qaDir, "13-route-control-traceability-matrix.md")),
    );
  } catch (error) {
    packageScriptLedgerError = error instanceof Error ? error.message : String(error);
    packageScriptLedger = {};
  }
  const packageScriptDiff = comparePackageScriptLedger(packageManifests, packageScriptLedger);
  const missingWorkflows = missing(workflowLabels);
  const missingRoutes = missing(routeInventory());
  const missingIpc = missing(ipcInventory());
  const missingIpcEvents = missing(ipcEventInventory());
  const integrity = markdownIntegrity(qaPaths);
  const census = sourceCensus();
  const expected = {
    packageScripts: 95,
    workflowLabels: 17,
    routeRegistrations: 162,
    uniqueRoutes: 160,
    rendererFiles: 78,
    rendererControlFiles: 63,
    rendererControls: 597,
    rootTestFiles: 274,
    ipcCallSites: 64,
    literalIpc: 52,
    dynamicIpc: 12,
    runtimeIpc: 76,
    ipcEvents: 10,
    routeMarkers: { equality: 45, match: 57, exec: 1, startsWith: 2, webhook: 2 },
  };
  const censusFailures = [];
  function expectCensus(label, actual, wanted) {
    if (actual !== wanted) censusFailures.push(`${label}: discovered ${actual}, expected ${wanted}`);
  }
  expectCensus("package scripts", packageScriptCount, expected.packageScripts);
  expectCensus("workflow labels", workflowLabels.length, expected.workflowLabels);
  expectCensus("route registrations", routeInventory().length, expected.routeRegistrations);
  expectCensus("unique route strings", new Set(routeInventory()).size, expected.uniqueRoutes);
  expectCensus("main renderer TSX files", census.rendererFiles, expected.rendererFiles);
  expectCensus("control-bearing renderer files", census.rendererControlFiles, expected.rendererControlFiles);
  expectCensus("renderer control declarations", census.rendererControls, expected.rendererControls);
  expectCensus("root Vitest files", census.rootTestFiles, expected.rootTestFiles);
  expectCensus("ipcMain registration call sites", census.ipcCallSites, expected.ipcCallSites);
  expectCensus("literal ipcMain registrations", census.literalIpc, expected.literalIpc);
  expectCensus("dynamic ipcMain registrations", census.dynamicIpc, expected.dynamicIpc);
  expectCensus("runtime inbound IPC registrations", census.runtimeIpc, expected.runtimeIpc);
  expectCensus("preload IPC event topics", census.ipcEvents, expected.ipcEvents);
  for (const [name, wanted] of Object.entries(expected.routeMarkers)) {
    expectCensus(`server route marker ${name}`, census.routeMarkers[name], wanted);
  }
  
  if (
    missingDocs.length ||
    packageScriptLedgerError ||
    packageScriptDiff.missing.length ||
    packageScriptDiff.unexpected.length ||
    missingWorkflows.length ||
    missingRoutes.length ||
    missingIpc.length ||
    missingIpcEvents.length ||
    integrity.duplicateIds.length ||
    integrity.malformedRows.length ||
    integrity.placeholderFindings.length ||
    integrity.brokenLinks.length ||
    integrity.brokenSourceReferences.length ||
    censusFailures.length
  ) {
    console.error("qa-docs coverage failed");
    if (missingDocs.length) console.error("missing docs:", missingDocs.join(", "));
    if (packageScriptLedgerError) console.error("package-script ledger error:", packageScriptLedgerError);
    if (packageScriptDiff.missing.length) console.error("missing manifest/script pairs:", packageScriptDiff.missing.join(", "));
    if (packageScriptDiff.unexpected.length) console.error("unexpected manifest/script pairs:", packageScriptDiff.unexpected.join(", "));
    if (missingWorkflows.length) console.error("missing workflows/jobs:", missingWorkflows.join(", "));
    if (missingRoutes.length) console.error("missing routes:", missingRoutes.join(", "));
    if (missingIpc.length) console.error("missing ipc channels:", missingIpc.join(", "));
    if (missingIpcEvents.length) console.error("missing ipc events:", missingIpcEvents.join(", "));
    if (integrity.duplicateIds.length) console.error("cross-file duplicate case IDs:\n", integrity.duplicateIds.join("\n"));
    if (integrity.malformedRows.length) console.error("malformed compact rows:\n", integrity.malformedRows.join("\n"));
    if (integrity.placeholderFindings.length) console.error("placeholder findings:\n", integrity.placeholderFindings.join("\n"));
    if (integrity.brokenLinks.length) console.error("broken local Markdown links:\n", integrity.brokenLinks.join("\n"));
    if (integrity.brokenSourceReferences.length) console.error("broken source references:\n", integrity.brokenSourceReferences.join("\n"));
    if (censusFailures.length) console.error("source census drift:\n", censusFailures.join("\n"));
    process.exit(1);
  }
  
  console.log(
    JSON.stringify(
      {
        ok: true,
        docs: requiredDocs.length,
        scripts: packageScriptCount,
        workflowLabels: workflowLabels.length,
        routes: routeInventory().length,
        uniqueRoutes: new Set(routeInventory()).size,
        ipcChannels: ipcInventory().length,
        ipcEvents: ipcEventInventory().length,
        rendererFiles: census.rendererFiles,
        rendererControlFiles: census.rendererControlFiles,
        rendererControls: census.rendererControls,
        rootTestFiles: census.rootTestFiles,
        routeMarkers: census.routeMarkers,
      },
      null,
      2,
    ),
  );
}

export {
  comparePackageScriptLedger,
  markdownIntegrity,
  parsePackageScriptLedger,
  splitMarkdownRow,
  sourceCensus,
};

if (isMainModule(import.meta.url, process.argv[1])) {
  runQaCoverage();
}
