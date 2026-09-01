import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { BotWorkspaceErasureManager } from "./bot-workspace-erasure.ts";

const roots: string[] = [];

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "hry-bot-workspace-erasure-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("BotWorkspaceErasureManager", () => {
  it("writes the intent before an owner commit and never removes a live bot workspace", async () => {
    const root = temp();
    const journal = join(root, "bot-workspace-erasures.json");
    const workspacesDir = join(root, "workspaces");
    const botId = "live-owner";
    const workspace = join(workspacesDir, botId);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "private.md"), "do not remove yet");

    const preCommit = new BotWorkspaceErasureManager({
      file: journal,
      workspacesDir,
      botStillOwned: () => true,
    });
    preCommit.prepare(botId);
    expect(await preCommit.retryPending()).toEqual([]);
    expect(existsSync(workspace)).toBe(true);

    // Simulate a process kill after intent but before bots.json commits: the
    // next process sees the tombstone but preserves the still-owned desk.
    const restartedBeforeCommit = new BotWorkspaceErasureManager({
      file: journal,
      workspacesDir,
      botStillOwned: () => true,
    });
    expect(await restartedBeforeCommit.retryPending()).toEqual([]);
    expect(existsSync(workspace)).toBe(true);

    const committed = new BotWorkspaceErasureManager({ file: journal, workspacesDir, botStillOwned: () => false });
    await expect(committed.retryPending()).resolves.toMatchObject([
      { botId, state: "complete", removed: { workspace: true } },
    ]);
    expect(existsSync(workspace)).toBe(false);
  });

  it("keeps a non-ENOENT workspace failure pending and retries it after restart", async () => {
    const root = temp();
    const journal = join(root, "bot-workspace-erasures.json");
    const workspacesDir = join(root, "workspaces");
    const botId = "failed-owner";
    const workspace = join(workspacesDir, botId);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "private.md"), "retry me");
    let attempts = 0;
    const failing = new BotWorkspaceErasureManager({
      file: journal,
      workspacesDir,
      botStillOwned: () => false,
      removeWorkspace: () => {
        attempts++;
        throw Object.assign(new Error("disk unavailable"), { code: "EIO" });
      },
    });
    failing.prepare(botId);
    await expect(failing.erase(botId)).resolves.toMatchObject({
      state: "pending",
      errors: ["workspace: disk unavailable"],
      removed: { workspace: false },
      retained: { checkpointShadows: true },
    });
    expect(attempts).toBe(1);
    expect(existsSync(workspace)).toBe(true);

    const restarted = new BotWorkspaceErasureManager({ file: journal, workspacesDir, botStillOwned: () => false });
    await expect(restarted.retryPending()).resolves.toMatchObject([
      { botId, state: "complete", removed: { workspace: true }, errors: [] },
    ]);
    expect(existsSync(workspace)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("unlinks a workspace symlink without traversing it", async () => {
    const root = temp();
    const workspacesDir = join(root, "workspaces");
    const outside = join(root, "outside");
    const botId = "symlink-owner";
    mkdirSync(workspacesDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "must-survive.txt"), "safe");
    symlinkSync(outside, join(workspacesDir, botId), "dir");

    const manager = new BotWorkspaceErasureManager({
      file: join(root, "bot-workspace-erasures.json"),
      workspacesDir,
      botStillOwned: () => false,
    });
    manager.prepare(botId);
    await expect(manager.erase(botId)).resolves.toMatchObject({ state: "complete", removed: { workspace: true } });
    expect(existsSync(join(workspacesDir, botId))).toBe(false);
    expect(existsSync(join(outside, "must-survive.txt"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("refuses a symlinked workspace root instead of following it", async () => {
    const root = temp();
    const outside = join(root, "outside");
    const workspacesDir = join(root, "workspaces");
    const botId = "root-symlink-owner";
    mkdirSync(join(outside, botId), { recursive: true });
    writeFileSync(join(outside, botId, "must-survive.txt"), "safe");
    symlinkSync(outside, workspacesDir, "dir");

    const manager = new BotWorkspaceErasureManager({
      file: join(root, "bot-workspace-erasures.json"),
      workspacesDir,
      botStillOwned: () => false,
    });
    manager.prepare(botId);
    await expect(manager.erase(botId)).resolves.toMatchObject({
      state: "pending",
      errors: ["workspace: workspace root is not a real directory"],
    });
    expect(existsSync(join(outside, botId, "must-survive.txt"))).toBe(true);
  });

  it("still returns a receipt when the journal write itself fails", async () => {
    // Every step failure was already folded into the report, but persisting the
    // entry sat outside that net: a failed journal write rejected out of
    // perform(), so DELETE /api/bots/:id answered 500 and discarded the receipt
    // built on the very next line — while the operator was already gone from
    // the roster. The caller must always learn what actually happened.
    const root = temp();
    const workspacesDir = join(root, "workspaces");
    mkdirSync(workspacesDir, { recursive: true });
    const journal = join(root, "bot-workspace-erasures.json");

    // Construct while the journal is simply absent, so this exercises the WRITE
    // path rather than the load path. Then put a directory where the file
    // belongs: every subsequent write fails with EISDIR, without modelling a
    // full disk.
    const manager = new BotWorkspaceErasureManager({
      file: journal,
      workspacesDir,
      removeWorkspace: () => {},
    });
    mkdirSync(journal, { recursive: true });

    const report = await manager.erase("bot-journal-fail");
    expect(report.botId).toBe("bot-journal-fail");
    expect(report.state).toBe("pending");
    expect(report.errors.join(" ")).toContain("journal:");
  });

  it("rejects arbitrary journal identifiers before it can name a workspace target", () => {
    const root = temp();
    const manager = new BotWorkspaceErasureManager({ file: join(root, "bot-workspace-erasures.json"), workspacesDir: root });
    expect(() => manager.prepare("../outside")).toThrow(/operator id/i);
    expect(() => manager.prepare("operator/other")).toThrow(/operator id/i);
    expect(existsSync(join(root, "bot-workspace-erasures.json"))).toBe(false);
  });
});
