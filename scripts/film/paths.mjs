// Where the film pipeline reads and writes.
//
// Every path resolves from this file's own location so the harness runs from
// any clone. Nothing here may hardcode a developer's home directory: these
// scripts are committed, and an absolute path would both break for everyone
// else and leak a machine layout into the public repo.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const FILM = `${REPO}/scripts/film`;

// Footage and intermediates are build output, not source: they stay under the
// gitignored `output/` tree. Only the finished films are promoted to docs/media.
export const OUT = process.env.HELMRYTH_FILM_OUT ?? `${REPO}/output/film`;
export const RAW = `${OUT}/raw`;
export const FRAMES = `${OUT}/frames`;
export const FINAL = `${OUT}/final`;
export const LANES = `${OUT}/lanes`;
export const MEDIA = `${REPO}/docs/media`;

// Resolved from PATH by default so this does not depend on a Homebrew prefix.
export const PW = process.env.PLAYWRIGHT_CLI ?? "playwright-cli";
