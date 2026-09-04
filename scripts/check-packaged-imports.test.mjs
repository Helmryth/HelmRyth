import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  bareSpecifiers,
  includePatterns,
  DEVELOPMENT_ONLY_IMPORTS,
  isProvidedByRuntime,
  packageOf,
  packagedImportFindings,
  scanRepository,
  selectsPackage,
} from "./check-packaged-imports.mjs";

const EXCLUDES_NODE_MODULES = { files: ["electron/**", "!**/node_modules/**", "package.json"] };
const SHIPS_ZOD = { files: ["electron/**", "!**/node_modules/**", "node_modules/zod/**", "package.json"] };
// `exemptions: []` throughout: these fixtures are synthetic modules, and the
// real DEVELOPMENT_ONLY_IMPORTS list would correctly report itself stale
// against them. The real list is exercised against the real tree below.
const DEPS = { dependencies: ["zod"], devDependencies: ["electron", "vitest"], exemptions: [] };

describe("reading imports out of a main-process module", () => {
  it("finds every spelling the tree actually uses", () => {
    expect(bareSpecifiers(`
      import { z } from "zod";
      import { app } from "electron";
      export { parse } from "yaml";
      const mod = await import("@scope/pkg/sub");
      const cjs = require("node:path");
      import "./side-effect.mjs";
    `)).toEqual(["@scope/pkg/sub", "electron", "node:path", "yaml", "zod"]);
  });

  it("ignores paths, which travel with the module that imports them", () => {
    expect(bareSpecifiers(`
      import a from "./sibling.mjs";
      import b from "../parent/thing.cjs";
      import c from "/absolute/path.mjs";
    `)).toEqual([]);
  });
});

describe("what the runtime provides without packaging", () => {
  it("passes builtins under both spellings, and electron itself", () => {
    for (const specifier of ["node:path", "path", "node:child_process", "fs", "electron"]) {
      expect(isProvidedByRuntime(specifier), specifier).toBe(true);
    }
  });

  it("does not pass an ordinary package", () => {
    expect(isProvidedByRuntime("zod")).toBe(false);
    expect(isProvidedByRuntime("@trycua/cua-driver/electron")).toBe(false);
  });

  it("resolves a subpath to the package that has to be shipped", () => {
    expect(packageOf("zod/v4")).toBe("zod");
    expect(packageOf("@trycua/cua-driver/electron")).toBe("@trycua/cua-driver");
  });
});

describe("reading the electron-builder files list", () => {
  it("counts an explicit include, and its subtree, as shipping the package", () => {
    expect(selectsPackage(["node_modules/zod/**"], "zod")).toBe(true);
    expect(selectsPackage(["./node_modules/@scope/pkg/dist/**"], "@scope/pkg")).toBe(true);
  });

  it("keeps the glob entries and drops the copy-directory entries", () => {
    // electron-builder allows `{from, to, filter}` in the same list. Those name
    // a directory to copy wholesale, never a package glob, so resolving both
    // shapes here keeps every caller working with plain strings.
    expect(includePatterns(["electron/**", { from: "dist", to: "ui" }, "node_modules/zod/**"]))
      .toEqual(["electron/**", "node_modules/zod/**"]);
    expect(includePatterns(undefined)).toEqual([]);
  });

  it("never reads a negation as an include", () => {
    expect(selectsPackage(["!**/node_modules/**", "electron/**"], "zod")).toBe(false);
    expect(selectsPackage(["!node_modules/zod/**"], "zod")).toBe(false);
  });
});

describe("the launch failure this gate exists for", () => {
  const importsZod = [{ name: "electron/managed-composio.mjs", source: 'import { z } from "zod";' }];

  it("reports a package the manifest does not ship", () => {
    // The exact production failure: the packaged Linux app died at launch with
    // ERR_MODULE_NOT_FOUND for 'zod' imported from app.asar/electron/
    // managed-composio.mjs, and only the 25-minute package-and-launch CI job
    // saw it. The manifest excluded all of node_modules while three
    // main-process modules imported zod at module scope.
    expect(packagedImportFindings({ modules: importsZod, manifest: EXCLUDES_NODE_MODULES, ...DEPS }))
      .toMatchObject([{ name: "electron/managed-composio.mjs", specifier: "zod" }]);
  });

  it("is satisfied once the manifest ships it", () => {
    expect(packagedImportFindings({ modules: importsZod, manifest: SHIPS_ZOD, ...DEPS })).toEqual([]);
  });

  it("reports a package that packaging would ship but a production install would not have", () => {
    // The other half of the same launch failure. Shipping the pattern is not
    // enough if `pnpm install --prod` never puts the package on disk to copy.
    const findings = packagedImportFindings({
      modules: [{ name: "electron/main.mjs", source: 'import { build } from "esbuild";' }],
      manifest: { files: ["electron/**", "node_modules/esbuild/**"] },
      dependencies: [],
      devDependencies: ["esbuild"],
      exemptions: [],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toContain("devDependency");
  });

  it("stays quiet about an import that is excused, and loud when the excuse expires", () => {
    const exemptions = [{ module: "electron/cua.mjs", specifier: "@scope/dev-only", reason: "development path only" }];
    const stillImported = [{ name: "electron/cua.mjs", source: 'await import("@scope/dev-only");' }];
    expect(packagedImportFindings({ modules: stillImported, manifest: EXCLUDES_NODE_MODULES, ...DEPS, exemptions }))
      .toEqual([]);

    // An exemption that outlives its import is a lie the next reader inherits.
    const noLongerImported = [{ name: "electron/cua.mjs", source: "// the dev-only branch was deleted" }];
    expect(packagedImportFindings({ modules: noLongerImported, manifest: EXCLUDES_NODE_MODULES, ...DEPS, exemptions }))
      .toMatchObject([{ reason: expect.stringContaining("delete the exemption") }]);
  });
});

describe("this repository", () => {
  it("packages every main-process import it makes", () => {
    const { scanned, findings } = scanRepository();
    expect(findings).toEqual([]);
    // A scan that reaches nothing is broken, not clean — the same shape as a
    // green run with the suite silently missing.
    expect(scanned).toBeGreaterThan(30);
  });

  it("keeps every development-only exemption pointed at a module that exists", () => {
    for (const entry of DEVELOPMENT_ONLY_IMPORTS) {
      expect(entry.module, "exemption module").toMatch(/^electron\//);
      expect(entry.reason.length, `${entry.module} ${entry.specifier} needs a stated reason`).toBeGreaterThan(20);
    }
  });
});


describe("scripts a test can import", () => {
  it("carry no hashbang, which the transform on Windows does not strip", () => {
    // Node's ESM loader strips a leading `#!`. The transform a file goes
    // through when a TEST IMPORTS it on Windows does not, and `#` is not valid
    // JavaScript there — the suite fails to collect with
    // `SyntaxError: Invalid or unexpected token` and no line number.
    //
    // This has now happened twice. First for scripts/check-brand-residue.mjs,
    // which was fixed by stripping the hashbang from all four scripts that had
    // one. Then for scripts/check-packaged-imports.mjs, because the branch that
    // added it was cut from main BEFORE that fix landed, so it reintroduced a
    // fifth. Neither was caught locally: the Windows leg is the only place the
    // failure exists.
    //
    // A hashbang does something only for a file run as `./script.mjs`, which
    // needs an execute bit. Nothing under scripts/ has one, every call site is
    // `node scripts/<name>.mjs` via a package script, and even
    // `electron-builder.yml`'s `afterPack: ./scripts/after-pack.mjs` is loaded
    // as a module rather than executed. So the line buys nothing and costs a
    // whole suite.
    const scripts = join(dirname(fileURLToPath(import.meta.url)));
    const offenders = readdirSync(scripts)
      .filter((name) => name.endsWith(".mjs") && !name.includes(".test."))
      .filter((name) => readFileSync(join(scripts, name), "utf8").startsWith("#!"));
    expect(offenders).toEqual([]);
  });
});
