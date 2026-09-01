// The profile patch parser is the boundary that keeps paired clients from
// writing anything but identity fields. The strict half is the one that
// matters: a privileged bot field arriving here must be refused by NAME,
// so a future field cannot silently become remotely writable.
import { describe, expect, it } from "vitest";

import { parseBotProfilePatch } from "./bot-profile.ts";
import type { JsonObject } from "./schema.ts";

const strictPatch = (input: JsonObject) => parseBotProfilePatch(input, true);
const lenientPatch = (input: JsonObject) => parseBotProfilePatch(input, false);

describe("parseBotProfilePatch (strict — the paired boundary)", () => {
  it("refuses every privilege-bearing bot field by name", () => {
    for (const field of ["autoApprove", "autoReview", "alwaysAllow", "computer", "cwd", "composio", "chiefOfStaff", "acknowledgeLocalAuto"]) {
      const result = strictPatch({ name: "Mira", [field]: true });
      expect(result.ok, field).toBe(false);
      if (!result.ok) expect(result.error).toContain(field);
    }
  });

  it("refuses unknown cosmetic keys too — strict means the allowlist IS the contract", () => {
    const result = strictPatch({ color: "red" });
    expect(result).toEqual({ ok: false, error: "unsupported profile field: color" });
  });

  it("accepts the full identity surface", () => {
    const result = parseBotProfilePatch(
      { name: "Mira", title: "Lead", description: "plans", notifications: true, voice: "vx", speakReplies: false },
      true,
    );
    expect(result).toEqual({
      ok: true,
      patch: { name: "Mira", title: "Lead", description: "plans", notifications: true, voice: "vx", speakReplies: false },
    });
  });
});

describe("parseBotProfilePatch (both modes)", () => {
  it("lenient mode drops unknown keys instead of failing — the desktop PATCH mixes fields", () => {
    const result = lenientPatch({ name: "Mira", color: "red" });
    expect(result).toEqual({ ok: true, patch: { name: "Mira" } });
  });

  it("rejects a blank or oversized name", () => {
    expect(parseBotProfilePatch({ name: "   " }, true).ok).toBe(false);
    expect(parseBotProfilePatch({ name: "x".repeat(101) }, true).ok).toBe(false);
  });

  it("only stored-attachment avatar URLs pass; clears normalize to undefined", () => {
    for (const bad of ["https://example.com/a.png", "data:image/png;base64,AAAA", "/api/attachments/../config.json", "/api/attachments/a.svg"]) {
      expect(strictPatch({ avatarUrl: bad }).ok, bad).toBe(false);
    }
    const cleared = parseBotProfilePatch({ avatarUrl: "" }, true);
    expect(cleared).toEqual({ ok: true, patch: { avatarUrl: undefined } });
    const nulled = parseBotProfilePatch({ avatarUrl: null }, true);
    expect(nulled).toEqual({ ok: true, patch: { avatarUrl: undefined } });
  });

  it("maps an avatarCrop issue to the readable message", () => {
    expect(strictPatch({ avatarCrop: "hexagon" })).toEqual({
      ok: false,
      error: "avatarCrop must be sigil, circle, rounded, or square",
    });
  });
});

// A profile field is composed into the engine's system prompt, and that prompt
// is handed to the CLI as a spawn argument. Node refuses an argv entry holding
// a NUL, so one pasted null byte used to be accepted here and then kill every
// future run for that operator with "args[12] must be a string without null
// bytes" — a permanently broken operator from a paste.
describe("control characters never reach the spawn boundary", () => {
  const NUL = String.fromCharCode(0);

  it("refuses a NUL in every text field", () => {
    for (const field of ["name", "title", "description", "voice"]) {
      const result = lenientPatch({ [field]: `Mira${NUL}Vale` });
      expect(result.ok, field).toBe(false);
      if (!result.ok) expect(result.error).toContain("control characters");
    }
  });

  it("refuses the other C0 controls and DEL", () => {
    for (const code of [0x01, 0x07, 0x08, 0x0b, 0x0c, 0x1b, 0x1f, 0x7f]) {
      const result = lenientPatch({ name: `Mira${String.fromCharCode(code)}Vale` });
      expect(result.ok, `U+${code.toString(16).padStart(4, "0")}`).toBe(false);
    }
  });

  it("still accepts the whitespace people actually type", () => {
    expect(lenientPatch({ name: "Mira Vale" }).ok).toBe(true);
    expect(lenientPatch({ name: "Mira\tVale" }).ok).toBe(true);
    expect(lenientPatch({ description: "line one\nline two\r\nline three" }).ok).toBe(true);
    expect(lenientPatch({ name: "Mira — Vale ✅ 日本語" }).ok).toBe(true);
  });
});
