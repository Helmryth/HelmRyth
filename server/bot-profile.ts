import { z } from "zod";

import { botAvatarCropSchema, botAvatarUrlSchema } from "../shared/bot-avatar.ts";
import { BOT_PROFILE_LIMITS } from "../shared/bot-profile.ts";

import type { BotRecord } from "./store.ts";

export const BOT_PROFILE_PATCH_FIELDS = [
  "name",
  "title",
  "description",
  "notifications",
  "avatarUrl",
  "avatarCrop",
  "voice",
  "speakReplies",
] as const;

/** C0 controls (minus tab/newline/return) and DEL. These are never meaningful
 * in a profile field, and they are not merely cosmetic: name, title and
 * description are composed into the engine's system prompt, which is handed to
 * the CLI as a spawn argument. Node rejects an argv entry containing a NUL
 * outright, so one pasted null byte made every future run for that operator die
 * with "The argument 'args[12]' must be a string without null bytes". */
// oxlint-disable-next-line no-control-regex -- matching them is the point
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const noControlCharacters = (label: string) =>
  ({ error: `${label} must not contain control characters` }) as const;

const profilePatchSchema = z.object({
  name: z
    .string({ error: "name must be a string" })
    .max(BOT_PROFILE_LIMITS.name, { error: "name must be at most 100 characters" })
    .refine((value) => !CONTROL_CHARACTERS.test(value), noControlCharacters("name"))
    .refine((value) => Boolean(value.trim()), { error: "name must not be empty" })
    .optional(),
  title: z
    .string({ error: "title must be a string" })
    .max(BOT_PROFILE_LIMITS.title, { error: "title must be at most 200 characters" })
    .refine((value) => !CONTROL_CHARACTERS.test(value), noControlCharacters("title"))
    .optional(),
  description: z
    .string({ error: "description must be a string" })
    .max(BOT_PROFILE_LIMITS.description, { error: "description must be at most 4000 characters" })
    .refine((value) => !CONTROL_CHARACTERS.test(value), noControlCharacters("description"))
    .optional(),
  notifications: z.boolean({ error: "notifications must be true or false" }).optional(),
  avatarUrl: z
    .union([botAvatarUrlSchema, z.literal(""), z.null()], {
      error: "avatarUrl must be a stored PNG, JPEG, GIF, or WebP attachment",
    })
    .optional(),
  avatarCrop: botAvatarCropSchema.optional(),
  voice: z
    .string({ error: "voice must be a string" })
    .max(BOT_PROFILE_LIMITS.voice, { error: "voice must be at most 200 characters" })
    .refine((value) => !CONTROL_CHARACTERS.test(value), noControlCharacters("voice"))
    .optional(),
  speakReplies: z.boolean({ error: "speakReplies must be true or false" }).optional(),
});

export type BotProfilePatchInput = z.input<typeof profilePatchSchema>;

export type BotProfilePatch = Partial<
  Pick<
    BotRecord,
    "name" | "title" | "description" | "notifications" | "avatarUrl" | "avatarCrop" | "voice" | "speakReplies"
  >
>;

export type BotProfilePatchResult =
  | { ok: true; patch: BotProfilePatch }
  | { ok: false; error: string };

/**
 * The shared validation boundary for profile fields. The desktop's broad bot
 * PATCH passes strict=false; paired clients use strict=true so a future bot
 * field cannot silently become remotely writable.
 *
 * avatarUrl deliberately uses `undefined` as the normalized clear value.
 * Store persistence already omits undefined fields, while wireBot sends null
 * back to clients so Codable and object-spread clients both clear stale data.
 */
export function parseBotProfilePatch(input: BotProfilePatchInput, strict = false): BotProfilePatchResult {
  const parsed = (strict ? profilePatchSchema.strict() : profilePatchSchema).safeParse(input);
  if (!parsed.success) {
    const unsupported = parsed.error.issues.find((issue) => issue.code === "unrecognized_keys");
    if (unsupported?.code === "unrecognized_keys") {
      return { ok: false, error: `unsupported profile field: ${unsupported.keys[0] ?? "unknown"}` };
    }
    const issue = parsed.error.issues[0];
    if (issue?.path[0] === "avatarCrop") {
      return { ok: false, error: "avatarCrop must be sigil, circle, rounded, or square" };
    }
    return { ok: false, error: issue?.message ?? "invalid profile patch" };
  }

  const { avatarUrl, ...fields } = parsed.data;
  const patch: BotProfilePatch = fields;
  if (avatarUrl !== undefined) patch.avatarUrl = avatarUrl || undefined;
  return { ok: true, patch };
}
