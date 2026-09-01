// Gemini CLI harness support — Google's `gemini` CLI over ACP stdio
// (`gemini --experimental-acp`). Rides the generic runtime in acp/core.ts.
//
// RETIRED FROM THE DEFAULT FLEET: Google stopped serving Gemini CLI requests
// for the free/Pro/Ultra tiers on 2026-06-18 and pointed everyone at the
// Antigravity CLI (see drivers/antigravity.ts), so this only reaches a model
// on an enterprise licence. Kept registered for exactly that case — add
// {"instances": {"gemini": {"driver": "geminiAgent"}}} to config.json.
//
// Auth reality since 2026-06-18 (#28): consumer "Login with Google" no
// longer serves the Gemini CLI — consumer tiers route through Antigravity,
// and the login that produced ~/.gemini/oauth_creds.json stopped working
// for them. The remaining paths are a GEMINI_API_KEY, Vertex, or an
// enterprise Code Assist licence (whose OAuth refresh still works). The
// driver cannot tell a consumer from an enterprise file locally, so the
// file check only counts a *live-looking* credential (unexpired access
// token, or a refresh token the CLI may still be able to use) and the
// login note names the three real paths instead of the retired login.
//
// Auth is intentionally lenient (authFailure "continue"): the CLI may run
// off an ambient login, so we attempt the advertised authenticate method
// but never hard-fail the turn on it, unlike Grok's subscription-bound
// cached_token.
//
// NOTE: untested against a live `gemini` CLI on this machine (not installed);
// the ACP flag + auth method ids follow the published Gemini CLI ACP contract
// and should be re-verified end-to-end once the CLI is present.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { parseJson } from "../../schema.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

// Prefer an explicit key method, then personal OAuth, then Vertex — but fall
// back to whatever the CLI advertises so a new method id still works.
const AUTH_PREFERENCE = ["gemini-api-key", "oauth-personal", "vertex-ai"];
const oauthCredentialSchema = z
  .object({
    access_token: z.string().trim().min(1),
    refresh_token: z.string().optional().catch(undefined),
    expiry_date: z.number().finite().optional(),
  })
  .catchall(z.json());

/** A stored oauth_creds.json only counts when it looks alive: the access
 * token has not passed its expiry_date, or a refresh token is present that
 * an enterprise licence may still redeem. A stale consumer credential —
 * the common case since 2026-06-18 — reads as not signed in, which is the
 * truthful answer for an engine that would fail its first turn anyway. */
function liveOauthCredential(): boolean {
  try {
    const parsed = oauthCredentialSchema.safeParse(
      parseJson(readFileSync(join(homedir(), ".gemini", "oauth_creds.json"), "utf8")),
    );
    if (!parsed.success) return false;
    const creds = parsed.data;
    const hasRefresh = Boolean(creds.refresh_token?.trim());
    if (creds.expiry_date !== undefined) {
      return Date.now() < creds.expiry_date || hasRefresh;
    }
    // no recorded expiry — treat possession of the credential as the signal
    return true;
  } catch {
    return false;
  }
}

const nonBlank = (value: string | undefined): boolean => Boolean(value?.trim());

/** The credential check as a named function, so the support entry and the
 * exported test surface are the same implementation, not a self-call.
 * Config is unused — kept to match the AcpSupport signature. */
export function geminiIsAuthenticated(env: Record<string, string | undefined>): boolean {
  return (
    nonBlank(env.GEMINI_API_KEY) ||
    nonBlank(env.GOOGLE_API_KEY) ||
    (existsSync(join(homedir(), ".gemini", "oauth_creds.json")) && liveOauthCredential())
  );
}

const support: AcpSupport = {
  driverKind: "geminiAgent",
  displayName: "Gemini",
  models: {
    default: "gemini-2.5-pro",
    options: [
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ],
  },
  defaultCli: "gemini",
  nativeSource: "gemini.acp",
  loginNote:
    "Gemini CLI needs a GEMINI_API_KEY, a Vertex AI setup, or an enterprise Code Assist login — consumer Google logins stopped working on 2026-06-18 (use the Antigravity engine for those accounts)",

  spawnArgs: (_config, turn) => ["--experimental-acp", ...(turn.model ? ["-m", turn.model] : [])],
  credentialEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],

  pickAuthMethod: (methods) => {
    const ids = methods.flatMap((method) => {
      const parsed = z.string().safeParse(method.id);
      return parsed.success ? [parsed.data] : [];
    });
    for (const pref of AUTH_PREFERENCE) if (ids.includes(pref)) return pref;
    return ids[0] ?? null;
  },
  authFailure: "continue",

  isAuthenticated: geminiIsAuthenticated,

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const GeminiAgentDriver = createAcpDriver(support);
