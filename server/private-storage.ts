import { chmodSync, lstatSync, mkdirSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const supportsPosixModes = process.platform !== "win32";

/** Create a server-owned directory and repair a legacy mode without ever
 * following a symlink. Windows keeps its ACL semantics and treats chmod as a
 * safe no-op at this boundary. */
export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  repairPrivateDirectory(path);
}

export function repairPrivateDirectory(path: string): boolean {
  if (!supportsPosixModes) return false;
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if ((stat.mode & 0o777) === PRIVATE_DIRECTORY_MODE) return false;
    chmodSync(path, PRIVATE_DIRECTORY_MODE);
    return true;
  } catch {
    return false;
  }
}

export function repairPrivateFile(path: string): boolean {
  if (!supportsPosixModes) return false;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    if ((stat.mode & 0o777) === PRIVATE_FILE_MODE) return false;
    chmodSync(path, PRIVATE_FILE_MODE);
    return true;
  } catch {
    return false;
  }
}

function repairTree(root: string, files: boolean): void {
  try {
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return;
  } catch {
    return;
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  repairPrivateDirectory(root);
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      repairTree(path, files);
    } else if (files && entry.isFile()) {
      repairPrivateFile(path);
    }
  }
}

const PRIVATE_DATA_FILE = /^(?:config|bots|groups|routines|webhooks|thread-erasures|bot-workspace-erasures|crew-import-transactions)\.json$|^messages-.+\.json(?:\.imported)?$|^messages\.db(?:-(?:wal|shm)|-journal)?$|^decisions\.ndjson(?:\.1)?$|\.tmp$/;

/** Startup repair for the product-owned storage layout. It intentionally
 * narrows file repair to known private artifacts; workspace directories are
 * private, but arbitrary executable files inside them keep their own modes. */
export function ensurePrivateStorageLayout(dataDir: string, eventsDir: string, nativeDir: string): void {
  const workspacesDir = join(dataDir, "workspaces");
  for (const directory of [dataDir, eventsDir, nativeDir, workspacesDir]) {
    ensurePrivateDirectory(directory);
  }
  repairTree(eventsDir, true);
  repairTree(nativeDir, true);
  repairTree(workspacesDir, false);

  let entries: Dirent[];
  try {
    entries = readdirSync(dataDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !PRIVATE_DATA_FILE.test(entry.name)) continue;
    repairPrivateFile(join(dataDir, entry.name));
  }
}
