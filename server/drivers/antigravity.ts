// Antigravity driver — Google's `agy` CLI in headless one-shot print mode
// (`agy --print --output-format stream-json`), modeled on claude.ts but fully
// self-contained. Per-turn CLI process; the conversation continues across
// turns via `--conversation <id>` (the resumeCursor is agy's conversation_id).
// Verified against agy 1.1.12.
//
// Unlike claude, print mode has NO interactive permission hook: there is no
// per-action broker here. `--mode accept-edits` allows file edits but
// auto-denies shell (`run_command` comes back as a tool ERROR); the default
// `request-review` auto-denies; `--dangerously-skip-permissions` (fullAuto)
// approves everything. Real per-action approval cards are a future path via
// native ACP (agy issue #31), which would reuse acp/core.ts like grok/gemini.
//
// Computer use: agy has no per-turn MCP flag, so the bot's computer (cloud
// box / Local VM / VPS) is mounted by upserting one key into the global
// `~/.gemini/config/mcp_config.json` before each spawn — see
// ensureAntigravityComputerMcp below. Full-auto instances only; the host
// desktop stays off (no approval channel in print mode, ever).
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

import { DATA_DIR, stripWorkspaceCredentialEnv } from "../config.ts";
import { computerProxyEnv } from "../container-computer.ts";
import { augmentedPath } from "../env-path.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { parseJson, type JsonValue } from "../schema.ts";
import { injectedApiModel, mergeLocalInject } from "./local-inject.ts";

import type { ChildProcess } from "node:child_process";
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "antigravityAgent";

export interface AntigravityConfig {
  cli: string;
  fullAuto: boolean;
}

// model catalog from `agy models` (agy 1.1.12)
export const STATIC_ANTIGRAVITY_MODELS: ModelCatalog = {
  default: "gemini-3.1-pro-high",
  options: [
    { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
    { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
    // 3.7 ids confirmed against the agy 1.1.12 binary's own model table
    { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
    { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
    { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
    { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
    { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
    { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
    { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
  ],
};

function antigravityEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath(), ...overrides };
  // The harness process may hold workspace credentials injected by the
  // desktop shell. Antigravity uses its own login, so none belong in any of
  // its turn, snapshot, or helper children.
  stripWorkspaceCredentialEnv(env);
  return env;
}

const AGY_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]*$/i;

const antigravitySettingsModelSchema = z.looseObject({
  id: z.string().optional(),
  model: z.string().optional(),
  name: z.string().optional(),
  displayName: z.string().optional(),
});
const antigravitySettingsSchema = z.looseObject({
  availableModels: z.array(z.json()).catch([]),
  customModels: z.array(z.json()).catch([]),
  extraModels: z.array(z.json()).catch([]),
  model: z.string().optional().catch(undefined),
});

function extrasFromSettingsModels(values: readonly JsonValue[]): Array<{ id: string; label: string }> {
  return values.flatMap((item) => {
    const directId = z.string().safeParse(item);
    if (directId.success) return AGY_MODEL_ID.test(directId.data) ? [{ id: directId.data, label: directId.data }] : [];
    const parsedRow = antigravitySettingsModelSchema.safeParse(item);
    if (!parsedRow.success) return [];
    const row = parsedRow.data;
    const id = row.id ?? row.model ?? "";
    if (!AGY_MODEL_ID.test(id)) return [];
    const label = row.name ?? row.displayName ?? id;
    return [{ id, label }];
  });
}

/** Extra ids from ~/.gemini/antigravity-cli/settings.json, if the user added any. */
export function readAntigravityModelCatalog(env: Record<string, string | undefined> = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  let settings: z.infer<typeof antigravitySettingsSchema>;
  try {
    const parsed = antigravitySettingsSchema.safeParse(
      parseJson(readFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), "utf8")),
    );
    if (!parsed.success) return STATIC_ANTIGRAVITY_MODELS;
    settings = parsed.data;
  } catch {
    return STATIC_ANTIGRAVITY_MODELS;
  }
  const extras = [
    ...extrasFromSettingsModels(settings.availableModels),
    ...extrasFromSettingsModels(settings.customModels),
    ...extrasFromSettingsModels(settings.extraModels),
  ];
  if (settings.model) extras.push(...extrasFromSettingsModels([settings.model]));
  const options = STATIC_ANTIGRAVITY_MODELS.options.map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  for (const extra of extras) {
    if (seen.has(extra.id)) continue;
    seen.add(extra.id);
    options.push({ id: extra.id, label: extra.label, custom: true });
  }
  return { default: STATIC_ANTIGRAVITY_MODELS.default, options };
}

// ── computer MCP mount ──────────────────────────────────────────────────
// agy has no per-session MCP flag and no project-level MCP config: verified
// against agy 1.1.19, whose embedded docs list exactly two locations — the
// global `~/.gemini/config/mcp_config.json` and per-plugin files — and whose
// `agy mcp list` ignores `.gemini/{settings,mcp_config}.json` in the cwd.
// So the bot's computer is mounted by upserting ONE key into the global file
// right before each spawn: every other byte of the user's config is
// preserved, and a malformed file starts from a fresh object instead of
// failing the turn (the ensureOpenCodeInjectModel discipline).
export const ANTIGRAVITY_COMPUTER_MCP_KEY = "helmryth-computer";

export interface AntigravityComputerMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

// agy's MCP file is machine-global. Hold this lease for the complete child
// lifetime so two Antigravity turns cannot see each other's computer tokens.
let antigravityComputerMcpLease: Promise<void> = Promise.resolve();

async function acquireAntigravityComputerMcpLease(): Promise<() => void> {
  const previous = antigravityComputerMcpLease;
  let unlock: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  antigravityComputerMcpLease = previous.then(() => current);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unlock?.();
  };
}

// Lenient by design: keep every unknown key the user put in the file. A
// present-but-wrong mcpServers (e.g. an array) fails the parse and is
// rebuilt fresh — that file was already unusable to agy itself.
const mcpConfigFileSchema = z.looseObject({
  mcpServers: z.looseObject({}).optional(),
});

/** The computer MCP server for this turn, or null when the turn has none.
 * Cloud boxes go through Helmryth's REST-to-MCP adapter (the same spec
 * claude.ts and codex.ts build); Local VM and VPS connections arrive as a
 * ready-made Cua Driver stdio command and pass through unchanged. */
export function antigravityComputerMcpServer(
  integrations: SendTurnInput["integrations"],
): AntigravityComputerMcpServer | null {
  const computer = integrations?.computer;
  if (computer) {
    const proxyEnv = computerProxyEnv(computer);
    return {
      command: process.execPath,
      args: [SPAWNED_PROXIES.computer],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        HELMRYTH_BOX_ID: proxyEnv.HELMRYTH_BOX_ID ?? "",
        HELMRYTH_BOX_TOKEN: proxyEnv.HELMRYTH_BOX_TOKEN ?? "",
        // who-is-driving endpoint, so a person taking the wheel in the
        // panel pauses this bot's hands mid-turn
        HELMRYTH_CONTROL_URL: proxyEnv.HELMRYTH_CONTROL_URL ?? "",
        HELMRYTH_CONTROL_TOKEN: proxyEnv.HELMRYTH_CONTROL_TOKEN ?? "",
      },
    };
  }
  const local = integrations?.localComputer;
  if (local) return { command: local.command, args: local.args, env: { ...local.env } };
  return null;
}

/** Upsert (server) or remove (null) the helmryth-computer entry in the
 * global mcp_config.json. Only that one key is ever written; a turn without
 * a computer removes it so a previous turn's mount cannot leak tools — or
 * box/control tokens — into later turns or the user's own agy sessions. */
export function ensureAntigravityComputerMcp(
  server: AntigravityComputerMcpServer | null,
  env: Record<string, string | undefined> = process.env,
): () => void {
  const home = env.HOME || env.USERPROFILE || homedir();
  const path = join(home, ".gemini", "config", "mcp_config.json");
  const existed = existsSync(path);
  const original = existed ? readFileSync(path, "utf8") : null;
  let config: z.infer<typeof mcpConfigFileSchema> = {};
  try {
    const parsed = mcpConfigFileSchema.safeParse(JSON.parse(original ?? ""));
    if (parsed.success) config = parsed.data;
  } catch {
    // Missing or malformed user config — rebuild only what the mount needs.
  }
  const servers = { ...config.mcpServers };
  // Nothing to remove and nothing to add: leave the user's file untouched
  // (don't create or reformat it on every computer-less turn).
  if (!server && !(ANTIGRAVITY_COMPUTER_MCP_KEY in servers)) return () => {};
  if (server) {
    servers[ANTIGRAVITY_COMPUTER_MCP_KEY] = { command: server.command, args: server.args, env: server.env };
  } else {
    delete servers[ANTIGRAVITY_COMPUTER_MCP_KEY];
  }
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (existed) chmodSync(path, 0o600);
  const mounted = `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`;
  writeFileSync(path, mounted, { mode: 0o600 });
  chmodSync(path, 0o600);

  const hadOriginalEntry = ANTIGRAVITY_COMPUTER_MCP_KEY in (config.mcpServers ?? {});
  const originalEntry = config.mcpServers?.[ANTIGRAVITY_COMPUTER_MCP_KEY];

  // Restore exactly what was present before this turn when nobody else touched
  // the file. A user's own agy process is outside our module-wide lease, so if
  // it edited the config concurrently, preserve that edit and restore only our
  // one key instead of replacing (or deleting) the whole file.
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    let current: string;
    try {
      current = readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    if (current === mounted) {
      if (original === null) {
        unlinkSync(path);
        return;
      }
      writeFileSync(path, original, { mode: 0o600 });
      chmodSync(path, 0o600);
      return;
    }

    // A malformed concurrent edit is not safe to rewrite. Leaving a stale
    // Helmryth entry is preferable to destroying bytes we cannot interpret.
    let currentJson: unknown;
    try {
      currentJson = JSON.parse(current);
    } catch {
      return;
    }
    const parsed = mcpConfigFileSchema.safeParse(currentJson);
    if (!parsed.success) return;
    const currentConfig = parsed.data;
    const currentServers = { ...currentConfig.mcpServers };
    if (hadOriginalEntry) currentServers[ANTIGRAVITY_COMPUTER_MCP_KEY] = originalEntry;
    else delete currentServers[ANTIGRAVITY_COMPUTER_MCP_KEY];
    writeFileSync(
      path,
      `${JSON.stringify({ ...currentConfig, mcpServers: currentServers }, null, 2)}\n`,
      { mode: 0o600 },
    );
    chmodSync(path, 0o600);
  };
}

type AntigravityConfigWireInput = Parameters<ProviderDriver<AntigravityConfig>["decodeConfig"]>[0];

const antigravityConfigEnvelopeSchema = z.looseObject({
  cli: z.json().optional(),
  fullAuto: z.json().optional(),
});
const optionalCliSchema = z.string().optional();
const optionalFullAutoSchema = z.boolean().optional();
const resumeCursorSchema = z.string().nullable().catch(null);

const antigravityUsageSchema = z.looseObject({
  input_tokens: z.number().catch(0),
  cache_read_tokens: z.number().catch(0),
  output_tokens: z.number().catch(0),
});
const antigravityStepUpdateSchema = z.looseObject({
  step_type: z.string().optional().catch(undefined),
  step_index: z.union([z.string(), z.number()]).catch("unknown"),
  state: z.string().optional().catch(undefined),
  tool_name: z.string().optional().catch(undefined),
  usage: antigravityUsageSchema.optional().catch(undefined),
});
const antigravityResultSchema = z.looseObject({
  response: z.string().catch(""),
  status: z.string().nullable().catch(null),
  usage: antigravityUsageSchema.optional().catch(undefined),
});
const antigravityStreamEventSchema = z.discriminatedUnion("event", [
  z.looseObject({
    event: z.literal("init"),
    conversation_id: z.string().nullable().catch(null),
    init: z.looseObject({}).catch({}),
  }),
  z.looseObject({
    event: z.literal("step_update"),
    conversation_id: z.string().nullable().catch(null),
    step_update: antigravityStepUpdateSchema.catch({
      step_index: "unknown",
    }),
  }),
  z.looseObject({
    event: z.literal("result"),
    conversation_id: z.string().nullable().catch(null),
    result: antigravityResultSchema.catch({ response: "", status: null }),
  }),
]);
type AntigravityUsage = z.infer<typeof antigravityUsageSchema>;

function normalizedUsage(usage: AntigravityUsage) {
  return {
    input: usage.input_tokens + usage.cache_read_tokens,
    output: usage.output_tokens,
  };
}

function decodeConfig(raw: AntigravityConfigWireInput): AntigravityConfig {
  const envelope = antigravityConfigEnvelopeSchema.parse(raw ?? {});
  const cli = optionalCliSchema.safeParse(envelope.cli);
  if (!cli.success) {
    throw new Error(`antigravity: invalid cli ${JSON.stringify(envelope.cli)}`);
  }
  const fullAuto = optionalFullAutoSchema.safeParse(envelope.fullAuto);
  if (!fullAuto.success) {
    throw new Error(`antigravity: invalid fullAuto ${JSON.stringify(envelope.fullAuto)}`);
  }
  return {
    cli: cli.data ?? "agy",
    // Default fullAuto to TRUE: agy's headless print harness invokes tools even
    // for trivial prompts and, with no interactive approval channel, auto-denies
    // them — producing no output, so a non-fullAuto bot's turns frequently fail.
    // Default to fullAuto for a usable bot; per-action consent returns with the
    // ACP v2 path. Still throws above on a non-boolean fullAuto.
    fullAuto: fullAuto.data ?? true,
  };
}

export const AntigravityDriver: ProviderDriver<AntigravityConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Antigravity", supportsMultipleInstances: true },
  install: {
    command: {
      darwin: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      linux: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      win32: "irm https://antigravity.google/cli/install.ps1 | iex",
    },
    docsUrl: "https://github.com/google-antigravity/antigravity-cli#installation",
  },
  models: STATIC_ANTIGRAVITY_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<AntigravityConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const env = antigravityEnvironment(input.environment);
    const catalogEnv: Record<string, string | undefined> = env;
    let models = STATIC_ANTIGRAVITY_MODELS;
    const refreshModels = async () => {
      try {
        const resolved = await mergeLocalInject(readAntigravityModelCatalog(catalogEnv), catalogEnv);
        if (resolved.options.length) models = resolved;
      } catch {
        // Keep the last usable catalog when settings.json is unreadable.
      }
    };
    await refreshModels();
    const listeners = new Set<RuntimeEventListener>();
    // one active turn per thread; a second send while busy is a caller bug
    const active = new Map<string, { stop: () => void; turnId: string }>();
    const pending = new Set<string>();
    let disposed = false;
    // every live agy child, tracked independently of `active`: a child can
    // hang AFTER emitting `result` (so it's already removed from `active`), and
    // dispose()/stopAll() must still be able to reap it. Removed on process exit.
    const children = new Set<ChildProcess>();

    const emit = (event: RuntimeEvent) => {
      for (const l of listeners) l(event);
    };

    // Reap every tracked child's tree (mirrors the per-turn stop()) — POSIX
    // process group on mac/linux, taskkill /T on Windows. When escalate is
    // set a SIGKILL follows after a grace for anything that ignored the term;
    // on Windows killCliTree is already a force kill, so the retry is a no-op.
    const reapChildren = (escalate: boolean) => {
      for (const child of children) {
        killCliTree(child);
        if (escalate && process.platform !== "win32") {
          setTimeout(() => {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {}
          }, 2000).unref?.();
        }
      }
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (disposed) throw new Error("Antigravity instance is disposed");
      if (active.has(threadId) || pending.has(threadId)) throw new Error("a turn is already running on this thread");
      pending.add(threadId);
      const turnId = newId();

      // Default cwd to a per-thread workspace under DATA_DIR — deliberately
      // NOT homedir(): a bot running unattended should not get the whole home
      // as its default sandbox. `--add-dir` grants agy access to that dir.
      // strip filesystem-unsafe chars only — never truncate: a 36-char UUID
      // sliced to 32 would collide two threads sharing the first 32 chars onto
      // one workspace dir. replace() already keeps a UUID unique and safe.
      const tag = threadId.replace(/[^\w-]/g, "");
      const workspace = join(DATA_DIR, "workspaces", tag);
      try {
        mkdirSync(workspace, { recursive: true });
      } catch (error) {
        pending.delete(threadId);
        throw error;
      }
      const cwd = turn.cwd ?? workspace;

      // prompt is passed as the `--print` argv value: agy does NOT read the
      // prompt from piped stdin in print mode — a bare `--print` produces zero
      // output (verified against agy 1.1.12). Combine persona + text.
      // Trade-off: a very large prompt could exceed argv limits (E2BIG),
      // guarded below since stdin is not an option.
      const prompt = turn.system ? `${turn.system}\n\n${turn.text}` : turn.text;
      const resumeCursor = resumeCursorSchema.parse(turn.resumeCursor);

      let settled = false;
      // backstop watchdog: if agy hangs without emitting `result` and without
      // exiting, the bot would stay busy forever (agy's own --print-timeout 10m
      // is the only other net). Assigned just below; settle() always clears it.
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      // Assigned once the child exists. A child can emit `result` and then
      // hang, so settling must still arrange for process and MCP cleanup.
      let armPostSettleCleanup = () => {};
      const settle = (
        ok: boolean,
        stopReason: string | null,
        cost: number | null = null,
        usage?: { input: number; output: number },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        active.delete(threadId);
        armPostSettleCleanup();
        if (usage) {
          emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost, usage });
        } else {
          emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost });
        }
      };

      // agy's print mode is argv-only, so a prompt beyond ARG_MAX would fail the
      // spawn with E2BIG. Reject oversized prompts up front with a clear error
      // instead of a cryptic spawn failure.
      if (Buffer.byteLength(prompt) > 256 * 1024) {
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          message: `prompt too large for Antigravity's argv-only print mode (${Buffer.byteLength(prompt)} bytes)`,
        });
        settle(false, "prompt_too_large");
        pending.delete(threadId);
        return { turnId };
      }

      // agy's config is global, so every turn — including one without a
      // computer — owns the mount for its complete child lifetime. This keeps
      // overlapping turns from inheriting, replacing, or removing each
      // other's tools and credentials.
      const releaseMcpLease = await acquireAntigravityComputerMcpLease();
      if (disposed) {
        releaseMcpLease();
        pending.delete(threadId);
        settle(false, "disposed");
        return { turnId };
      }
      let restoreMcp = () => {};
      try {
        restoreMcp = ensureAntigravityComputerMcp(antigravityComputerMcpServer(turn.integrations), env);
      } catch (error) {
        releaseMcpLease();
        pending.delete(threadId);
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          message: `could not update Antigravity's MCP config (${join(".gemini", "config", "mcp_config.json")}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        settle(false, "mcp_config_error");
        return { turnId };
      }

      const args = [
        "--print", prompt, // print mode reads the prompt from this argv value
        "--output-format", "stream-json",
        "--print-timeout", "10m",
        "--add-dir", cwd,
        // fullAuto approves everything; otherwise accept-edits allows file
        // edits but auto-denies shell (no interactive channel in print mode)
        config.fullAuto ? "--dangerously-skip-permissions" : "--mode",
      ];
      if (!config.fullAuto) args.push("accept-edits");
      if (turn.model) args.push("--model", injectedApiModel(turn.model) ?? turn.model);
      if (resumeCursor) args.push("--conversation", resumeCursor);

      // spawnCli resolves npm .cmd shims / shebang scripts on Windows and
      // owns the process-group vs windowsHide difference (see procs.ts)
      let child: ReturnType<typeof spawnCli>;
      try {
        child = spawnCli(config.cli, args, {
          cwd,
          env,
          // spawnCli installs a cross-platform error handler on stdin even
          // though agy receives its prompt on argv, so retain the inert pipe.
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        try {
          restoreMcp();
        } finally {
          releaseMcpLease();
        }
        pending.delete(threadId);
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          ...describeSpawnFailure(error instanceof Error ? error : new Error(String(error)), config.cli),
        });
        settle(false, "spawn_error");
        return { turnId };
      }
      children.add(child);

      let childClosed = false;
      let postSettleReaper: ReturnType<typeof setTimeout> | undefined;
      let terminationEscalation: ReturnType<typeof setTimeout> | undefined;
      let mcpFinalized = false;
      const finalizeMcp = () => {
        if (mcpFinalized) return;
        mcpFinalized = true;
        try {
          restoreMcp();
        } catch (error) {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: `could not restore Antigravity's MCP config: ${error instanceof Error ? error.message : String(error)}`,
          });
        } finally {
          releaseMcpLease();
        }
      };
      const armTerminationEscalation = () => {
        if (childClosed || terminationEscalation) return;
        terminationEscalation = setTimeout(() => {
          if (childClosed) return;
          if (process.platform === "win32") {
            killCliTree(child); // taskkill /T /F is already forceful
            return;
          }
          try {
            const pid = child.pid;
            if (pid) process.kill(-pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {}
          }
        }, 3_000);
        terminationEscalation.unref?.();
      };
      const stop = () => {
        killCliTree(child); // process groups are POSIX-only
        armTerminationEscalation();
      };
      armPostSettleCleanup = () => {
        if (childClosed || postSettleReaper) return;
        // A normal agy process exits immediately after `result`. Give it a
        // short grace, then reap a zombie. Explicit stops use the same bounded
        // SIGKILL escalation so an uncooperative child cannot retain the lease.
        postSettleReaper = setTimeout(stop, 2_000);
        postSettleReaper.unref?.();
      };

      // conversation_id from the init event → the resumeCursor (session.started
      // is what the harness persists as the cursor). Also seeds tool item ids.
      let conversationId: string | null = null;

      const handleLine = (line: string) => {
        let nativeMessage: JsonValue;
        try {
          nativeMessage = parseJson(line);
        } catch {
          return;
        }
        appendNative(threadId, { dir: "in", source: "agy.stream", msg: nativeMessage });
        const parsedEvent = antigravityStreamEventSchema.safeParse(nativeMessage);
        if (!parsedEvent.success) return;
        const event = parsedEvent.data;
        switch (event.event) {
          case "init": {
            conversationId = event.conversation_id;
            emit({
              ...base(threadId, turnId),
              type: "session.started",
              sessionId: conversationId,
              model: turn.model ?? null,
            });
            break;
          }
          case "step_update": {
            const payload = event.step_update;
            if (payload.step_type === "tool") {
              const itemId = `${conversationId ?? event.conversation_id ?? "conv"}:${payload.step_index}`;
              if (payload.state === "ACTIVE") {
                emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", itemId, title: payload.tool_name });
              } else if (payload.state === "DONE") {
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId, ok: true });
              } else if (payload.state === "ERROR") {
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId, ok: false });
              }
            } else if (payload.step_type === "agent_response" && payload.usage) {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                ...normalizedUsage(payload.usage),
              });
            }
            break;
          }
          case "result": {
            const payload = event.result;
            // agy delivers the assistant text in result.response (not streamed)
            const { response } = payload;
            if (response) {
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: response });
              emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: response });
            }
            if (payload.usage) {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                ...normalizedUsage(payload.usage),
              });
            }
            // result.usage is the turn total (the per-step agent_response
            // figures above are its parts, not additions to it)
            settle(
              payload.status === "SUCCESS",
              payload.status ?? null,
              null,
              payload.usage ? normalizedUsage(payload.usage) : undefined,
            );
            break;
          }
        }
      };

      let buf = "";
      child.stdout.setEncoding("utf8"); // decode multibyte across chunk splits
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) handleLine(line);
        }
      });

      let stderr = "";
      child.stderr.on("data", (c) => {
        stderr += c;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });

      child.on("error", (e) => {
        emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
        settle(false, "spawn_error");
      });

      child.on("close", (code) => {
        childClosed = true;
        children.delete(child); // close is the true process-exit signal
        clearTimeout(postSettleReaper);
        clearTimeout(terminationEscalation);
        finalizeMcp();
        if (!settled) {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: `agy exited ${code} before result${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`,
          });
          settle(false, "exit_before_result");
        }
      });

      active.set(threadId, { stop, turnId });
      pending.delete(threadId);

      // 11 min — just above agy's own 10m --print-timeout, so agy normally
      // settles first; this is the backstop for a fully wedged child.
      watchdog = setTimeout(() => {
        if (!settled) {
          emit({ ...base(threadId, turnId), type: "runtime.error", message: "agy watchdog timeout" });
          stop();
          settle(false, "timeout");
        }
      }, 11 * 60_000);
      watchdog.unref?.();

      emit({ ...base(threadId, turnId), type: "turn.started" });

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const version = await new Promise<string | null>((resolve) => {
        execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) =>
          resolve(err ? null : stdout.trim()),
        );
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      // No auth field: agy auth is keyring-backed with no reliable file marker
      // (~/.gemini/antigravity-cli/ exists after first run even when logged
      // out), so any file heuristic would overstate "signed in". Leave undefined.
      return { state: "available", version };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return models;
      },
      refreshModels,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: {
          sessionModelSwitch: "in-session",
          images: true,
          // Cloud box, Local VM, and VPS computers all mount through the
          // global mcp_config.json above. Only full-auto instances advertise
          // it: print mode has no interactive approval channel, and outside
          // --dangerously-skip-permissions agy auto-denies tools that would
          // prompt (the accept-edits shell behavior in the header comment),
          // so a non-fullAuto mount could never fire. localComputerMcp stays
          // unset on purpose — the host desktop requires per-action human
          // approval (see contracts.ts), which print mode cannot deliver in
          // any mode; that returns with the native ACP path (agy issue #31).
          computerMcp: config.fullAuto,
        },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.stop(),
        respondToRequest: async () => "unavailable" as const, // this engine has no asks to answer
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { stop } of active.values()) stop();
          reapChildren(false); // also reap children that hung post-result
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: (prompt: string) =>
        new Promise((resolve, reject) => {
          execCli(
            config.cli,
            ["-p", prompt, "--output-format", "text", "--model", "gemini-3.6-flash-low"],
            { timeout: 60_000, env },
            (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
          );
        }),
      dispose: async () => {
        disposed = true;
        for (const { stop } of active.values()) stop();
        reapChildren(true); // escalate to SIGKILL — disposal must reap every child
        listeners.clear();
      },
    };
  },
};
