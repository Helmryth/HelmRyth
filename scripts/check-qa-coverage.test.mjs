import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  comparePackageScriptLedger,
  markdownIntegrity,
  splitMarkdownRow,
} from "./check-qa-coverage.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function fixtures(entries) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "helmryth-qa-coverage-"));
  temporaryDirectories.push(directory);
  return Object.entries(entries).map(([name, contents]) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, contents);
    return file;
  });
}

describe("QA coverage checker integrity helpers", () => {
  it("parses Markdown fields without splitting pipes inside inline code", () => {
    expect(splitMarkdownRow("| ID | Surface | `GET /a|b` | Evidence |")).toEqual([
      "ID",
      "Surface",
      "`GET /a|b`",
      "Evidence",
    ]);
  });

  it("reports cross-file duplicate case definitions", () => {
    const files = fixtures({
      "one.md": "| ID | Surface | Evidence |\n|---|---|---|\n| QA-CHECK-001 | One | Test |\n",
      "two.md": "### `QA-CHECK-001` — duplicate\n",
    });
    expect(markdownIntegrity(files).duplicateIds).toHaveLength(1);
  });

  it("reports malformed compact rows against their table header", () => {
    const files = fixtures({
      "row.md": "| ID | Surface | Evidence |\n|---|---|---|\n| QA-CHECK-002 | Missing evidence |\n",
    });
    expect(markdownIntegrity(files).malformedRows).toHaveLength(1);
  });

  it("reports unfinished copy and broken local Markdown links", () => {
    const files = fixtures({
      "unfinished.md": "TODO: repeat similarly.\n[missing](missing.md)\n",
    });
    const result = markdownIntegrity(files);
    expect(result.placeholderFindings).toHaveLength(1);
    expect(result.brokenLinks).toHaveLength(1);
  });

  it("executes as a CLI through a repository path containing spaces", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "helmryth qa checker "));
    temporaryDirectories.push(directory);
    const linkedWorkspace = path.join(directory, "workspace with spaces");
    fs.symlinkSync(workspaceRoot, linkedWorkspace, "dir");
    const checker = path.join(linkedWorkspace, "scripts", "check-qa-coverage.mjs");
    const result = spawnSync(process.execPath, ["--preserve-symlinks-main", checker], {
      cwd: linkedWorkspace,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, scripts: 95 });
  });

  it("rejects script names documented under the wrong manifest", () => {
    const actual = [
      { name: "package.json", scripts: ["build"] },
      { name: "apps/docs/package.json", scripts: ["test"] },
    ];
    const documented = {
      "package.json": ["test"],
      "apps/docs/package.json": ["build"],
    };
    expect(comparePackageScriptLedger(actual, documented)).toEqual({
      missing: ["apps/docs/package.json:test", "package.json:build"],
      unexpected: ["apps/docs/package.json:build", "package.json:test"],
    });
  });
});
