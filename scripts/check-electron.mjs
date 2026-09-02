import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_TIMEOUT_MS = 10_000;
export const EXPECTED_ELECTRON_RUNTIME_MODULE_COUNT = 47;
export const electronDirectory = fileURLToPath(new URL("../electron/", import.meta.url));

const NON_RUNTIME_DIRECTORIES = new Set([
  "__generated__",
  "__tests__",
  ".git",
  "coverage",
  "dist",
  "fixture",
  "fixtures",
  "generated",
  "node_modules",
  "spec",
  "specs",
  "test",
  "tests",
]);

function isRuntimeModuleName(name) {
  if (!/\.(?:cjs|mjs)$/i.test(name)) return false;
  return !/(?:^|[.-])(?:node-)?(?:spec|test)\.(?:cjs|mjs)$/i.test(name);
}

export function listElectronModules(directory = electronDirectory) {
  const modules = [];

  function visit(currentDirectory) {
    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (!NON_RUNTIME_DIRECTORIES.has(entry.name.toLowerCase())) visit(entryPath);
      } else if (entry.isFile() && isRuntimeModuleName(entry.name)) {
        modules.push(entryPath);
      }
    }
  }

  visit(directory);
  return modules.sort();
}

function formatExecFailure(error) {
  if (error?.stderr?.length) return String(error.stderr).trim();
  if (error?.stdout?.length) return String(error.stdout).trim();
  return error?.message ?? "Unknown syntax-check failure";
}

export function syntaxCheckModules(
  modules,
  {
    execFile = execFileSync,
    nodeExecutable = process.execPath,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    stdio = "pipe",
  } = {},
) {
  if (modules.length === 0) throw new Error("No Electron modules were found to syntax-check");
  for (const modulePath of modules) {
    try {
      execFile(nodeExecutable, ["--check", modulePath], {
        stdio,
        timeout: timeoutMs,
      });
    } catch (error) {
      throw new Error(`Syntax check failed for ${path.basename(modulePath)}: ${formatExecFailure(error)}`, {
        cause: error,
      });
    }
  }
  return modules.length;
}

export function runElectronSyntaxCheck(options = {}) {
  const modules = listElectronModules(options.directory);
  const checked = syntaxCheckModules(modules, options);
  return { checked, modules };
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const { checked } = runElectronSyntaxCheck();
  console.log(`Syntax-checked ${checked} Electron modules with Node.`);
}
