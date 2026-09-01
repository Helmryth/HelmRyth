// A bot's working folder — where its shell tools run. Validated here, once,
// so a bad path is refused at PATCH time with a reason the settings panel
// can show, rather than surfacing later as a driver spawn failure.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

import type { JsonValue } from "./schema.ts";

export type CwdValidation = { ok: true; cwd: string | null } | { ok: false; error: string };

const cwdInputSchema = z.string().nullable();

export function validateBotCwd(input: JsonValue | undefined): CwdValidation {
  const parsed = cwdInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "working folder must be a path" };
  if (parsed.data === null) return { ok: true, cwd: null };
  const trimmed = parsed.data.trim();
  if (!trimmed) return { ok: true, cwd: null };
  const expanded = trimmed === "~" || trimmed.startsWith("~/") ? homedir() + trimmed.slice(1) : trimmed;
  if (!isAbsolute(expanded)) return { ok: false, error: "working folder must be an absolute path" };
  const cwd = resolve(expanded);
  let stat;
  try {
    stat = statSync(cwd);
  } catch {
    return { ok: false, error: `that folder doesn't exist: ${cwd}` };
  }
  if (!stat.isDirectory()) return { ok: false, error: `that path is not a folder: ${cwd}` };
  return { ok: true, cwd };
}
