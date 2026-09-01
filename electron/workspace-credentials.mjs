// Workspace credentials the desktop shell keeps OS-encrypted (credentials.bin
// via safeStorage) instead of leaving in plaintext config.json — the same
// treatment the Composio project key already gets in main.mjs. Pure functions:
// main.mjs owns the fs and safeStorage plumbing, so the migration decisions
// stay testable without an Electron runtime.
//
// One row per secret: the config.json home it migrates OUT of, the
// credentials.bin field it lives in, and the env var the spawned server
// prefers over the file (server/config.ts loadConfig).
export const WORKSPACE_CREDENTIALS = [
  { section: "xai", field: "key", name: "xaiApiKey", env: "XAI_API_KEY" },
  { section: "openaiCompat", field: "key", name: "openaiCompatApiKey", env: "OPENAI_COMPAT_API_KEY" },
  { section: "box", field: "token", name: "boxToken", env: "BOX_TOKEN" },
  { section: "tts", field: "key", name: "ttsKey", env: "HELMRYTH_TTS_KEY" },
  { section: "imageGen", field: "key", name: "openaiImageApiKey", env: "HELMRYTH_OPENAI_IMAGE_KEY" },
  { section: "opencodeGo", field: "apiKey", name: "opencodeGoApiKey", env: "OPENCODE_API_KEY" },
];

const isCallable = (value) => {
  try {
    Function.prototype.toString.call(value);
    return true;
  } catch {
    return false;
  }
};

const isObjectValue = (value) => Object(value) === value && !isCallable(value);

const primitiveString = (value) =>
  Object(value) !== value && value?.constructor === String ? value : null;

/** One boot-time sweep of config.json: move every plaintext workspace secret
 * into the encrypted store and DELETE the plaintext field.
 *
 * Deleting (never blanking) keeps the meaning of what remains unambiguous:
 *   - non-empty value  → newest user intent: overwrite the stored secret
 *   - "" or absent     → no plaintext information; the store stays authoritative
 *
 * "" must never drop a stored secret. The packaged app's external-secret
 * save path writes an empty tombstone into config.json on EVERY credential
 * commit (the real value goes to credentials.bin first), so reading "" as
 * "the user cleared this" deleted freshly saved keys at the next boot.
 * Clearing runs through the desktop shell's credential:set handler, which
 * removes the entry from the store directly before persisting the same
 * tombstone — so there is no "" case in which the store should lose data.
 * Running twice is a no-op, and nothing is lost if a boot dies between the
 * two writes — the caller persists credentials BEFORE rewriting config, so
 * the worst case re-runs the same overwrite.
 *
 * Inputs are treated as immutable; the changed flags tell the caller which
 * file(s) actually need rewriting. Non-string junk in a field is left for
 * the server's schema to reject rather than silently destroyed here. */
export function migrateWorkspaceCredentials(config, credentials) {
  const nextConfig = structuredClone(config ?? {});
  const nextCredentials = { ...credentials };
  let configChanged = false;
  let credentialsChanged = false;
  for (const { section, field, name } of WORKSPACE_CREDENTIALS) {
    const home = nextConfig?.[section];
    if (!isObjectValue(home) || Array.isArray(home)) continue;
    if (!Object.hasOwn(home, field)) continue;
    const value = home[field];
    const storedValue = primitiveString(value);
    if (storedValue === null) continue;
    const secret = storedValue.trim();
    if (secret && nextCredentials[name] !== secret) {
      nextCredentials[name] = secret;
      credentialsChanged = true;
    }
    delete home[field];
    configChanged = true;
  }
  return { config: nextConfig, credentials: nextCredentials, configChanged, credentialsChanged };
}

/** Env for the spawned server: one var per stored secret, nothing else.
 * The server treats each var as authoritative over its config.json field. */
export function workspaceCredentialEnv(credentials) {
  const env = {};
  for (const { name, env: envName } of WORKSPACE_CREDENTIALS) {
    const value = primitiveString(credentials?.[name]);
    if (value) env[envName] = value;
  }
  return env;
}

const WORKSPACE_ROUTING_ENV = [
  "OPENAI_COMPAT_URL",
  "OPENAI_COMPAT_MODEL",
  "OPENAI_COMPAT_PROVIDER",
];

/** The packaged server child never inherits provider identity or routing from
 * the desktop launch shell. Secrets come back only from credentials.bin;
 * non-secret OpenAI-compatible routing comes from config.json. */
export function workspaceCredentialChildEnvironment(credentials, environment) {
  const next = { ...environment };
  for (const { env } of WORKSPACE_CREDENTIALS) delete next[env];
  for (const name of WORKSPACE_ROUTING_ENV) delete next[name];
  return { ...next, ...workspaceCredentialEnv(credentials) };
}
