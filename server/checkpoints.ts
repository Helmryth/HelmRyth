// Per-turn workspace checkpoints: a shadow git repository per bot+folder.
//
// Before a turn's engine can touch files, the working folder is snapshotted
// into a shadow repo at DATA_DIR/checkpoints/<botId>/<sha256(cwd)[..16]>/.git.
// The user's own .git (if the folder is a repository) is never read, written,
// or locked: every git call runs with GIT_DIR pointing at the shadow repo and
// GIT_WORK_TREE pointing at the folder, so the shadow index is the only index
// involved — and git always skips directories named .git when walking a work
// tree, so the user's repository internals are invisible to the snapshot.
//
// Restore is redo-friendly on purpose: it commits a safety point, then moves
// the index and work tree back with `git restore --source` + `git clean -fd`
// while HEAD stays put — so the state that was just replaced is itself a
// checkpoint, and "undo the undo" is one more restore. Ignored/excluded files
// (node_modules, .env, media) are never snapshotted and never removed by one.
//
// Failure policy: checkpointing is best-effort convenience, never load-bearing.
// Any git failure disables the feature for that bot for the rest of the
// session and logs — nothing here ever throws into the turn path.
//
// Adapted from the checkpoint designs of Cline, Roo-Code, and Gemini CLI
// (all Apache-2.0): the per-call GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* env
// override and restore shape follow Gemini CLI's gitService, the sanitized
// GIT_* env list and the exclude categories follow Roo-Code's checkpoint
// service, and the snapshot-before-every-turn cadence follows Cline.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

import { DATA_DIR } from "./config.ts";
import { ensurePrivateDirectory, repairPrivateDirectory, repairPrivateFile } from "./private-storage.ts";

export const CHECKPOINTS_DIR = join(DATA_DIR, "checkpoints");

export type Checkpoint = { hash: string; at: number; label: string };
export type RestoreResult = { ok: true } | { ok: false; error: string };
export type CheckpointWorkspaceLease = { release: () => void };
export type CheckpointWorkspaceLeaseClaim =
  | { ok: true; lease: CheckpointWorkspaceLease }
  | { ok: false; error: string };

/** Full sha1 hex only. The API hands out full hashes; accepting anything
 * looser would let arbitrary revspecs ("HEAD~3", "main@{u}") reach git. */
const COMMIT_HASH = /^[0-9a-f]{40}$/;

// What a checkpoint deliberately does not carry. Restores must never delete
// these either: `git clean -fd` (without -x) leaves ignored files alone, so
// everything listed here survives a rollback untouched. Categories follow
// Roo-Code's checkpoint excludes: VCS internals, dependency trees, build
// output, caches, logs, secrets, media, archives, databases, model weights.
const EXCLUDES = `# Helmryth checkpoint excludes — never snapshotted, never removed by restore
.git/
.svn/
.hg/
node_modules/
bower_components/
.pnpm-store/
.venv/
venv/
.direnv/
__pycache__/
.pytest_cache/
.mypy_cache/
.ruff_cache/
.tox/
.gradle/
Pods/
dist/
build/
out/
.next/
.nuxt/
.output/
.svelte-kit/
target/
coverage/
.cache/
.parcel-cache/
.turbo/
.vite/
.terraform/
*.log
logs/
*.tmp
*.swp
.DS_Store
Thumbs.db
*.env*
.env
.env.*
*.pem
*.key
*.jpg
*.jpeg
*.png
*.gif
*.bmp
*.tiff
*.webp
*.ico
*.icns
*.psd
*.mp3
*.wav
*.flac
*.ogg
*.mp4
*.mov
*.avi
*.mkv
*.webm
*.zip
*.tar
*.gz
*.tgz
*.bz2
*.xz
*.7z
*.rar
*.jar
*.iso
*.dmg
*.sqlite
*.sqlite3
*.db
*.parquet
*.onnx
*.safetensors
*.gguf
`;

// gpgsign off: the user's global config may demand signing, and a shadow
// commit must never block on a passphrase prompt. gc off: background gc in
// a repo we treat as disposable only risks lock contention with snapshots.
const GITCONFIG = "[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n[gc]\n\tauto = 0\n";

/** One failed git call disables checkpoints for that bot until restart —
 * a broken shadow repo must cost the user one log line, not a failed turn. */
const disabledBots = new Set<string>();

function disable(botId: string, message: string): void {
  disabledBots.add(botId);
  console.warn(`workspace checkpoints disabled for operator ${botId} this session: ${message}`);
}

// probed once: either the system has a usable git or checkpoints stay off
let gitProbe: Promise<boolean> | null = null;
function gitAvailable(): Promise<boolean> {
  gitProbe ??= new Promise((resolveProbe) => {
    execFile("git", ["--version"], { windowsHide: true }, (err) => resolveProbe(!err));
  });
  return gitProbe;
}

/** Folders a checkpoint must never be taken in: missing paths, the sprawling
 * personal folders (home, Desktop, Documents, Downloads), and the filesystem
 * root — snapshotting those would trawl unbounded personal data into a repo,
 * and a restore's `git clean -fd` there would be an act of vandalism. */
export function refusalReason(cwd: string): string | null {
  if (!isAbsolute(cwd)) return "the working folder must be an absolute path";
  const requested = resolve(cwd);
  let stat;
  let dir: string;
  try {
    stat = statSync(requested);
    dir = realpathSync(requested);
  } catch {
    return "the working folder does not exist";
  }
  if (!stat.isDirectory()) return "the working folder is not a folder";
  // Compare canonical paths too: otherwise /tmp/home-link -> $HOME bypasses
  // the refusal while git still follows the symlink into the protected tree.
  if (dir === parse(dir).root) return "checkpoints are not taken at the filesystem root";
  const requestedHome = resolve(homedir());
  const home = existsSync(requestedHome) ? realpathSync(requestedHome) : requestedHome;
  if (requested === requestedHome || dir === home) return "checkpoints are not taken in the home folder";
  for (const name of ["Desktop", "Documents", "Downloads"]) {
    const requestedProtected = join(requestedHome, name);
    const protectedDir = existsSync(requestedProtected) ? realpathSync(requestedProtected) : requestedProtected;
    if (requested === requestedProtected || dir === protectedDir) {
      return `checkpoints are not taken in the ${name} folder`;
    }
  }
  return null;
}

function shadowDir(botId: string, cwd: string): string {
  const key = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
  return join(CHECKPOINTS_DIR, botId, key);
}

function gitEnv(shadow: string, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Git has several redirection/config environment variables beyond the
  // common GIT_DIR set (for example GIT_COMMON_DIR and GIT_CONFIG_KEY_*).
  // None are needed by a local shadow repo, so clear the complete namespace
  // before installing the small, explicit environment below.
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_")) delete env[name];
  }
  env.GIT_DIR = join(shadow, ".git");
  env.GIT_WORK_TREE = resolve(cwd);
  env.GIT_CONFIG_GLOBAL = join(shadow, "gitconfig");
  env.GIT_CONFIG_SYSTEM = join(shadow, "gitconfig_empty");
  env.GIT_AUTHOR_NAME = "Helmryth Checkpoint";
  env.GIT_AUTHOR_EMAIL = "checkpoint@helmryth.local";
  env.GIT_COMMITTER_NAME = "Helmryth Checkpoint";
  env.GIT_COMMITTER_EMAIL = "checkpoint@helmryth.local";
  return env;
}

/** Run one git command against the shadow repo. cwd is the WORK TREE — the
 * "." pathspec in add/restore resolves relative to it. A hung git (index
 * lock, dead network filesystem) would otherwise jam the per-repo queue for
 * the whole session, so every call carries a hard timeout. */
function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      args,
      { cwd, env, windowsHide: true, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) rejectPromise(new Error(`git ${args[0]}: ${(stderr || err.message).trim().slice(0, 400)}`));
        else resolvePromise(stdout);
      },
    );
  });
}

/** `git diff --cached --quiet`: is there anything staged beyond HEAD? Used
 * instead of `status --porcelain` emptiness on purpose — a nested repo with
 * a dirty work tree shows up in status forever while staging nothing, which
 * would either commit empty churn every turn or fail the commit outright. */
function hasStagedChanges(cwd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      ["diff", "--cached", "--quiet", "--ignore-submodules=dirty"],
      { cwd, env, windowsHide: true, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err === null) resolvePromise(false);
        else if (err.code === 1) resolvePromise(true);
        else rejectPromise(new Error(`git diff: ${(stderr || err.message).trim().slice(0, 400)}`));
      },
    );
  });
}

// One operation at a time per shadow repo: snapshots and restores against the
// same folder queue behind each other (git's index lock would fail the loser
// anyway — this turns a crash into a wait). The stored tail never rejects, so
// one failed operation can't poison the queue.
const chains = new Map<string, Promise<void>>();
function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = chains.get(key) ?? Promise.resolve();
  const run = tail.then(fn);
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** Active turns share a read/write ownership lane for their canonical work
 * tree; restore takes the exclusive side of that lane. Keeping this beside
 * the shadow-repo queue makes aliases such as `/project` and a symlink to it
 * resolve to one authority boundary even when different operators use their
 * own checkpoint histories. */
type WorkspaceLeaseState = {
  activeOwners: Map<string, number>;
  restoring: boolean;
};

const workspaceLeases = new Map<string, WorkspaceLeaseState>();

function leaseState(worktree: string): WorkspaceLeaseState {
  const existing = workspaceLeases.get(worktree);
  if (existing) return existing;
  const created = { activeOwners: new Map<string, number>(), restoring: false };
  workspaceLeases.set(worktree, created);
  return created;
}

function dropIdleLeaseState(worktree: string, state: WorkspaceLeaseState): void {
  if (!state.restoring && state.activeOwners.size === 0 && workspaceLeases.get(worktree) === state) {
    workspaceLeases.delete(worktree);
  }
}

/** Claim a project folder for an active operator turn. Multiple operators may
 * work concurrently, but every claim must release before restore can begin.
 * Repeated claims by one operator are reference-counted independently, and
 * release is idempotent so cleanup paths can safely call it more than once. */
export function acquireCheckpointWorkspaceLease(ownerId: string, cwd: string): CheckpointWorkspaceLeaseClaim {
  const reason = refusalReason(cwd);
  if (reason !== null) return { ok: false, error: reason };
  const worktree = realpathSync(resolve(cwd));
  const state = leaseState(worktree);
  if (state.restoring) {
    dropIdleLeaseState(worktree, state);
    return { ok: false, error: "this project folder is being restored" };
  }
  state.activeOwners.set(ownerId, (state.activeOwners.get(ownerId) ?? 0) + 1);
  let released = false;
  return {
    ok: true,
    lease: {
      release: () => {
        if (released) return;
        released = true;
        const count = state.activeOwners.get(ownerId);
        if (count === 1) state.activeOwners.delete(ownerId);
        else if (count !== undefined) state.activeOwners.set(ownerId, count - 1);
        dropIdleLeaseState(worktree, state);
      },
    },
  };
}

function acquireRestoreLease(worktree: string): CheckpointWorkspaceLeaseClaim {
  const state = leaseState(worktree);
  if (state.activeOwners.size > 0) {
    return { ok: false, error: "restore blocked because this project folder is in use by an active operator" };
  }
  if (state.restoring) return { ok: false, error: "this project folder is already being restored" };
  state.restoring = true;
  let released = false;
  return {
    ok: true,
    lease: {
      release: () => {
        if (released) return;
        released = true;
        state.restoring = false;
        dropIdleLeaseState(worktree, state);
      },
    },
  };
}

/** Git owns every entry below the shadow's `.git`, and those objects can
 * contain copies of private project files. Repair both newly created entries
 * and legacy trees without following symlinks or changing file contents. */
function repairCheckpointTree(root: string): void {
  try {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  } catch {
    return;
  }
  repairPrivateDirectory(root);
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) repairCheckpointTree(path);
    else if (entry.isFile()) repairPrivateFile(path);
  }
}

function repairCheckpointStorage(shadow: string): void {
  repairPrivateDirectory(CHECKPOINTS_DIR);
  repairPrivateDirectory(dirname(shadow));
  repairPrivateDirectory(shadow);
  repairPrivateFile(join(shadow, "gitconfig"));
  repairPrivateFile(join(shadow, "gitconfig_empty"));
  repairCheckpointTree(join(shadow, ".git"));
}

// Checkpoint histories may never be opened again after an upgrade, so repair
// the complete legacy tree once at startup rather than waiting for access.
try {
  ensurePrivateDirectory(CHECKPOINTS_DIR);
  repairCheckpointTree(CHECKPOINTS_DIR);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`workspace checkpoint storage permission repair skipped: ${message}`);
}

/** Create the shadow repo on first use; self-heal its config files on every
 * use (they are tiny, and rewriting them lets exclude-list updates reach
 * shadows that already exist). The base commit is an EMPTY marker so HEAD
 * always resolves — it is filtered from listings and refused as a restore
 * target, because "restore to empty" on a user's own project folder would
 * delete their files. */
async function ensureShadow(cwd: string, env: NodeJS.ProcessEnv, shadow: string): Promise<void> {
  ensurePrivateDirectory(CHECKPOINTS_DIR);
  ensurePrivateDirectory(dirname(shadow));
  ensurePrivateDirectory(shadow);
  writeFileSync(join(shadow, "gitconfig"), GITCONFIG, { mode: 0o600 });
  writeFileSync(join(shadow, "gitconfig_empty"), "", { mode: 0o600 });
  repairPrivateFile(join(shadow, "gitconfig"));
  repairPrivateFile(join(shadow, "gitconfig_empty"));
  if (!existsSync(join(shadow, ".git", "HEAD"))) {
    // --template= keeps the user's init.templateDir hooks/config out
    await runGit(["init", "--initial-branch=main", "--template="], cwd, env);
  }
  ensurePrivateDirectory(join(shadow, ".git"));
  ensurePrivateDirectory(join(shadow, ".git", "info"));
  writeFileSync(join(shadow, ".git", "info", "exclude"), EXCLUDES);
  repairPrivateFile(join(shadow, ".git", "info", "exclude"));
  try {
    await runGit(["rev-parse", "--verify", "HEAD"], cwd, env);
  } catch {
    // brand-new repo (or a crash between init and first commit)
    await runGit(["commit", "--no-verify", "--allow-empty", "-m", "checkpoint base"], cwd, env);
  }
  repairCheckpointStorage(shadow);
}

type CommitResult = { hash: string; complete: boolean };

/** Stage everything and commit if anything actually changed. `complete`
 * records whether every path was indexable: ordinary snapshots may keep the
 * useful subset, but restore must not delete files its safety point missed. */
async function commitAll(cwd: string, env: NodeJS.ProcessEnv, label: string): Promise<CommitResult> {
  // --ignore-errors skips files git cannot index (unreadable, FIFOs) instead
  // of aborting — but still exits 1 when it skipped an unreadable file, so
  // the exit code is retained even though a partial snapshot remains useful.
  // Restore treats an incomplete safety point as a hard stop before touching
  // the work tree.
  let complete = true;
  await runGit(["add", "-A", "--ignore-errors", "."], cwd, env).catch(() => {
    complete = false;
  });
  if (await hasStagedChanges(cwd, env)) {
    await runGit(["commit", "--no-verify", "-m", label], cwd, env);
  }
  return { hash: (await runGit(["rev-parse", "HEAD"], cwd, env)).trim(), complete };
}

/** Snapshot the folder. Returns the checkpoint hash, or null when the
 * feature is off for this bot, git is missing, or the folder is refused.
 * Never throws — this is called fire-and-forget on the turn path. */
export async function snapshot(botId: string, cwd: string, label: string): Promise<string | null> {
  if (disabledBots.has(botId)) return null;
  if (!(await gitAvailable())) return null;
  if (refusalReason(cwd) !== null) return null;
  try {
    const worktree = realpathSync(resolve(cwd));
    const shadow = shadowDir(botId, worktree);
    return await serialize(shadow, async () => {
      try {
        const env = gitEnv(shadow, worktree);
        await ensureShadow(worktree, env, shadow);
        return (await commitAll(worktree, env, label)).hash;
      } finally {
        repairCheckpointStorage(shadow);
      }
    });
  } catch (e) {
    disable(botId, e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Every checkpoint for this bot+folder, newest first. Empty when nothing
 * was ever snapshotted (listing never creates the shadow repo). The empty
 * base marker is omitted — it is not a state anyone should return to. */
export async function listCheckpoints(botId: string, cwd: string): Promise<Checkpoint[]> {
  if (disabledBots.has(botId)) return [];
  if (!(await gitAvailable())) return [];
  if (refusalReason(cwd) !== null) return [];
  try {
    const worktree = realpathSync(resolve(cwd));
    const shadow = shadowDir(botId, worktree);
    if (!existsSync(join(shadow, ".git", "HEAD"))) return [];
    return await serialize(shadow, async () => {
      try {
        repairCheckpointStorage(shadow);
        const env = gitEnv(shadow, worktree);
        const out = await runGit(["log", "--format=%H%x09%ct%x09%s"], worktree, env);
        const lines = out.split("\n").filter((line) => line.trim() !== "");
        lines.pop(); // the root of the log is always the empty base marker
        return lines.flatMap((line) => {
          const [hash, seconds, ...subject] = line.split("\t");
          if (!hash || !COMMIT_HASH.test(hash)) return [];
          return [{ hash, at: Number(seconds) * 1000, label: subject.join("\t") }];
        });
      } finally {
        repairCheckpointStorage(shadow);
      }
    });
  } catch (e) {
    disable(botId, e instanceof Error ? e.message : String(e));
    return [];
  }
}

/** Can this bot take/restore checkpoints in this folder right now? */
export async function checkpointsEnabled(botId: string, cwd: string): Promise<boolean> {
  return !disabledBots.has(botId) && (await gitAvailable()) && refusalReason(cwd) === null;
}

/** Move the folder's files back to a checkpoint. The current state is
 * committed first ("before restore"), so the restore itself shows up as a
 * checkpoint and can be undone; HEAD never moves backwards, only forward
 * over the "restored" commit. Excluded and gitignored files are untouched. */
export async function restore(botId: string, cwd: string, hash: string): Promise<RestoreResult> {
  if (disabledBots.has(botId)) {
    return { ok: false, error: "Checkpoints are disabled for this operator until Helmryth restarts. An earlier snapshot failed; see the system log." };
  }
  if (!(await gitAvailable())) return { ok: false, error: "git is not installed on this machine" };
  const reason = refusalReason(cwd);
  if (reason !== null) return { ok: false, error: reason };
  if (!COMMIT_HASH.test(hash)) return { ok: false, error: "hash must be a full 40-character checkpoint hash" };
  let restoreLease: CheckpointWorkspaceLease | null = null;
  let checkpointShadow: string | null = null;
  try {
    const worktree = realpathSync(resolve(cwd));
    const leaseClaim = acquireRestoreLease(worktree);
    if (!leaseClaim.ok) return leaseClaim;
    restoreLease = leaseClaim.lease;
    const shadow = shadowDir(botId, worktree);
    checkpointShadow = shadow;
    if (!existsSync(join(shadow, ".git", "HEAD"))) {
      return { ok: false, error: "no checkpoints exist for this folder" };
    }
    return await serialize(shadow, async (): Promise<RestoreResult> => {
      const env = gitEnv(shadow, worktree);
      try {
        await runGit(["cat-file", "-e", `${hash}^{commit}`], worktree, env);
      } catch {
        return { ok: false, error: "no such checkpoint" };
      }
      const base = (await runGit(["rev-list", "--max-parents=0", "HEAD"], worktree, env)).trim();
      if (base === hash) return { ok: false, error: "that is the empty base marker, not a checkpoint" };
      // safety point: whatever is about to be overwritten becomes restorable
      const safety = await commitAll(worktree, env, "before restore");
      if (!safety.complete) {
        return {
          ok: false,
          error: "restore stopped because some current files could not be added to the safety checkpoint",
        };
      }
      // Index AND work tree move to the source; HEAD stays put. --staged
      // matters: with a work-tree-only restore, a file that exists in the
      // source but not in the index (deleted in a later checkpoint, now
      // resurrected) would be untracked the moment restore recreates it —
      // and the clean below would delete it right back. Restoring the index
      // too makes clean blind to everything the checkpoint owns; what clean
      // then sweeps is exactly the strays the safety commit could not stage
      // (unreadable files, add races) — never ignored/excluded files (no -x).
      await runGit(["restore", "--source", hash, "--staged", "--worktree", "--", "."], worktree, env);
      await runGit(["clean", "-fd"], worktree, env);
      // record the post-restore state (also re-syncs the index with the
      // deletions restore made), so the timeline shows the rollback
      await commitAll(worktree, env, `restored ${hash.slice(0, 8)}`);
      return { ok: true };
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    disable(botId, message);
    return { ok: false, error: `restore failed: ${message}` };
  } finally {
    if (checkpointShadow !== null) repairCheckpointStorage(checkpointShadow);
    restoreLease?.release();
  }
}
