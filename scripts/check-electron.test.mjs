import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TIMEOUT_MS,
  EXPECTED_ELECTRON_RUNTIME_MODULE_COUNT,
  electronDirectory,
  listElectronModules,
  runElectronSyntaxCheck,
  syntaxCheckModules,
} from "./check-electron.mjs";

const execFileAsync = promisify(execFile);
const temporaryDirectories = [];
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hry-check-electron-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("check-electron", () => {
  it("discovers the complete production Electron runtime module set recursively", () => {
    const modules = listElectronModules();
    const relativeModules = modules.map((modulePath) => path.relative(electronDirectory, modulePath));

    expect(modules).toHaveLength(EXPECTED_ELECTRON_RUNTIME_MODULE_COUNT);
    expect(EXPECTED_ELECTRON_RUNTIME_MODULE_COUNT).toBe(47);
    expect(modules).toEqual([...modules].sort());
    expect(relativeModules).toContain(path.join("vendor", "electron-updater.cjs"));
    expect(relativeModules).not.toContain("updater-coordinator.node-test.mjs");
    expect(relativeModules).not.toContain("window-state.test.mjs");
    expect(modules.every((modulePath) => /\.(?:cjs|mjs)$/.test(modulePath))).toBe(true);
  });

  it("includes nested runtime modules and consistently excludes non-runtime test artifacts", () => {
    const directory = makeTempDirectory();
    const runtimeModules = [
      path.join(directory, "main.mjs"),
      path.join(directory, "vendor", "adapter.cjs"),
      path.join(directory, "runtime", "nested", "bridge.mjs"),
    ];
    const excludedFiles = [
      path.join(directory, "main.test.mjs"),
      path.join(directory, "adapter.node-test.mjs"),
      path.join(directory, "bridge.spec.cjs"),
      path.join(directory, "test", "helper.mjs"),
      path.join(directory, "specs", "helper.cjs"),
      path.join(directory, "fixtures", "fixture.mjs"),
      path.join(directory, "generated", "bundle.cjs"),
    ];

    for (const modulePath of [...runtimeModules, ...excludedFiles]) {
      fs.mkdirSync(path.dirname(modulePath), { recursive: true });
      fs.writeFileSync(modulePath, "export const valid = true;\n");
    }

    expect(listElectronModules(directory)).toEqual([...runtimeModules].sort());
  });

  it("uses the current Node executable with a hard timeout for each module", () => {
    const exec = vi.fn();
    const modules = ["/tmp/alpha.mjs", "/tmp/bravo.cjs"];

    const checked = syntaxCheckModules(modules, { execFile: exec });

    expect(checked).toBe(2);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenNthCalledWith(1, process.execPath, ["--check", modules[0]], {
      stdio: "pipe",
      timeout: DEFAULT_TIMEOUT_MS,
    });
    expect(exec).toHaveBeenNthCalledWith(2, process.execPath, ["--check", modules[1]], {
      stdio: "pipe",
      timeout: DEFAULT_TIMEOUT_MS,
    });
  });

  it("rejects syntax failures with the offending filename", () => {
    const broken = "/tmp/broken.mjs";
    const exec = vi.fn(() => {
      const error = new Error("bad parse");
      error.stderr = Buffer.from("Unexpected token");
      throw error;
    });

    expect(() => syntaxCheckModules([broken], { execFile: exec })).toThrow(
      "Syntax check failed for broken.mjs: Unexpected token",
    );
  });

  it("rejects an empty Electron module set", () => {
    expect(() => runElectronSyntaxCheck({ directory: makeTempDirectory() })).toThrow(
      "No Electron modules were found to syntax-check",
    );
  });

  it("finishes promptly from the CLI without invoking Electron", async () => {
    const directory = makeTempDirectory();
    fs.writeFileSync(path.join(directory, "alpha.mjs"), "export const alpha = 1;\n");
    fs.writeFileSync(path.join(directory, "beta.cjs"), "module.exports = { beta: 2 };\n");
    const expectedCount = listElectronModules().length;

    const startedAt = Date.now();
    const result = await execFileAsync(process.execPath, ["scripts/check-electron.mjs"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HELMRYTH_DATA_DIR: path.join(directory, "isolated-state"),
      },
      timeout: 5_000,
    });

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.stdout.trim()).toBe(`Syntax-checked ${expectedCount} Electron modules with Node.`);
    expect(result.stderr).toBe("");
  });
});
