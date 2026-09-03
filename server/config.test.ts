import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DATA_DIR,
  EVENTS_DIR,
  ensureDirs,
  instanceConfigs,
  isValidSshAlias,
  loadConfig,
  localVmMaxInstances,
  localVmMode,
  managedServiceStatus,
  NATIVE_DIR,
  parseConfigPatch,
  parseStoredConfig,
  roomTurnTimeoutMinutes,
  saveConfig,
  showToolCallsEnabled,
  skillRecorderEnabled,
  builtInBrowserEnabled,
  stripWorkspaceCredentialEnv,
  syncCredentialEnv,
  vpsSshAlias,
  withInstanceCli,
  WORKSPACE_CREDENTIAL_ENV,
  type AppConfig,
} from "./config.ts";

describe("configuration boundaries", () => {
  it("validates OpenAI-compatible endpoint settings while retaining non-secret routing fields", () => {
    expect(parseConfigPatch({
      openaiCompat: {
        key: "secret",
        url: " https://models.example.test/v1 ",
        model: " vendor/model ",
        provider: " vendor ",
      },
    })).toEqual({
      openaiCompat: {
        key: "secret",
        url: "https://models.example.test/v1",
        model: "vendor/model",
        provider: "vendor",
      },
    });
    expect(parseConfigPatch({
      openaiCompat: { url: "http://127.0.0.1:11434/v1", model: "local/model" },
    })).toEqual({
      openaiCompat: { url: "http://127.0.0.1:11434/v1", model: "local/model" },
    });
    for (const url of [
      "http://models.example.test/v1",
      "https://user:secret@models.example.test/v1",
      "https://models.example.test/v1?token=secret",
      "https://models.example.test/v1#fragment",
    ]) {
      expect(() => parseConfigPatch({ openaiCompat: { url } })).toThrow(/openaiCompat\.url/i);
    }
  });

  it("decodes managed-service status from allowlisted non-secret child configuration", () => {
    expect(managedServiceStatus({
      HELMRYTH_MANAGED_CONFIG_SOURCE: "packaged",
      HELMRYTH_MANAGED_CONFIG_STATE: "ready",
      HELMRYTH_MANAGED_REGISTRY_ORIGIN: "https://registry.example.test",
      HELMRYTH_MANAGED_CONDUIT_ORIGIN: "https://conduit.example.test",
      HELMRYTH_CONDUIT_TOKEN: "must-not-pass",
    })).toEqual({
      source: "packaged",
      state: "ready",
      registry: { configured: true, origin: "https://registry.example.test" },
      conduit: { configured: true, origin: "https://conduit.example.test" },
    });
    expect(managedServiceStatus({
      HELMRYTH_MANAGED_CONFIG_SOURCE: "packaged",
      HELMRYTH_MANAGED_CONFIG_STATE: "ready",
      HELMRYTH_MANAGED_REGISTRY_ORIGIN: "http://registry.invalid",
      HELMRYTH_MANAGED_CONDUIT_ORIGIN: "https://conduit.example.test",
    })).toEqual({
      source: "packaged",
      state: "invalid",
      registry: { configured: false, origin: "" },
      conduit: { configured: true, origin: "https://conduit.example.test" },
    });
  });

  it("creates Helmryth storage without moving another product's data", () => {
    const legacyDir = join(dirname(DATA_DIR), ".another-product");
    const marker = join(legacyDir, "keep-me.txt");
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(legacyDir, { recursive: true, force: true });
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(marker, "source remains independent");

    ensureDirs();

    expect(existsSync(DATA_DIR)).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("source remains independent");
    rmSync(legacyDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("repairs legacy storage modes at startup without changing contents", () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(EVENTS_DIR, { recursive: true, mode: 0o755 });
    mkdirSync(NATIVE_DIR, { recursive: true, mode: 0o755 });
    const config = join(DATA_DIR, "config.json");
    const event = join(EVENTS_DIR, "thread.ndjson");
    const native = join(NATIVE_DIR, "thread.ndjson");
    writeFileSync(config, JSON.stringify({ profile: { name: "Ada" } }), { mode: 0o644 });
    writeFileSync(event, "event\n", { mode: 0o644 });
    writeFileSync(native, "native\n", { mode: 0o644 });

    ensureDirs();

    for (const directory of [DATA_DIR, EVENTS_DIR, NATIVE_DIR]) {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
    for (const file of [config, event, native]) expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadConfig().profile?.name).toBe("Ada");
    expect(readFileSync(event, "utf8")).toBe("event\n");
    expect(readFileSync(native, "utf8")).toBe("native\n");
  });

  it("keeps supported stored settings and drops unrelated top-level data", () => {
    expect(
      parseStoredConfig({
        profile: { name: "Ada", email: "ada@example.com" },
        instances: { claude: { driver: "claudeAgent", config: { cli: "/opt/claude" } } },
        unrelated: { secret: "not part of the config contract" },
      }),
    ).toEqual({
      profile: { name: "Ada", email: "ada@example.com" },
      instances: { claude: { driver: "claudeAgent", config: { cli: "/opt/claude" } } },
    });
  });

  it("holds the profile address to a real shape for every client, not just the desktop form", () => {
    // The renderer checks this field, but it is not the only writer: the paired
    // phone and any direct PUT /api/config reach the same schema. Accepting any
    // string there meant those clients silently persisted what the UI refused.
    for (const email of ["garbage-not-an-email", "no@dot", "@nope.com", "two@@at.com", "trailing@space .com"]) {
      expect(() => parseConfigPatch({ profile: { name: "Ada", email } }), email).toThrow("profile.email");
    }
    // Clearing an address is a legitimate save, and a real one still passes.
    expect(parseConfigPatch({ profile: { name: "Ada", email: "" } })).toEqual({ profile: { name: "Ada", email: "" } });
    expect(parseConfigPatch({ profile: { name: "Ada", email: "ada@example.com" } }))
      .toEqual({ profile: { name: "Ada", email: "ada@example.com" } });
  });

  it("rejects malformed stored instances and API patches", () => {
    expect(() => parseStoredConfig({ instances: { claude: { driver: 42 } } })).toThrow("instances.claude.driver");
    expect(() => parseConfigPatch({ opencodeGo: { apiKey: 42 } })).toThrow("opencodeGo.apiKey");
    expect(() => parseConfigPatch({ profile: [] })).toThrow("profile");
  });

  it("accepts only a simple VPS SSH config alias and exposes no credentials", () => {
    expect(isValidSshAlias("production-vps")).toBe(true);
    expect(isValidSshAlias("prod; reboot")).toBe(false);
    expect(() => parseConfigPatch({ vps: { sshAlias: "prod; reboot" } })).toThrow("vps.sshAlias");
    expect(parseConfigPatch({ vps: { sshAlias: "production-vps" } })).toEqual({
      vps: { sshAlias: "production-vps" },
    });
    expect(vpsSshAlias({ vps: { sshAlias: "production-vps" } })).toBe("production-vps");
    expect(vpsSshAlias({ vps: { sshAlias: "-bad" } })).toBeNull();
  });

  it("accepts a persisted global room turn timeout and supplies the legacy default", () => {
    expect(parseStoredConfig({ rooms: { turnTimeoutMinutes: 20 } })).toEqual({
      rooms: { turnTimeoutMinutes: 20 },
    });
    expect(roomTurnTimeoutMinutes({ rooms: { turnTimeoutMinutes: 20 } })).toBe(20);
    expect(roomTurnTimeoutMinutes({})).toBe(5);
  });

  it.each([0, 1.5, 1441, "20", null])(
    "rejects an invalid room turn timeout: %j",
    (turnTimeoutMinutes) => {
      expect(() => parseConfigPatch({ rooms: { turnTimeoutMinutes } })).toThrow(
        "rooms.turnTimeoutMinutes",
      );
    },
  );

  it("preserves shared Local VM behavior by default and accepts bounded per-bot mode", () => {
    expect(localVmMode({})).toBe("shared");
    expect(localVmMaxInstances({})).toBe(2);
    expect(parseConfigPatch({ localVm: { mode: "per-bot", maxInstances: 4 } })).toEqual({
      localVm: { mode: "per-bot", maxInstances: 4 },
    });
    expect(localVmMode({ localVm: { mode: "per-bot" } })).toBe("per-bot");
    expect(localVmMaxInstances({ localVm: { maxInstances: 3 } })).toBe(3);
  });

  it("keeps experimental features off by default and accepts an explicit opt-in", () => {
    expect(skillRecorderEnabled({})).toBe(false);
    expect(parseConfigPatch({ features: { skillRecorder: true } })).toEqual({
      features: { skillRecorder: true },
    });
    expect(skillRecorderEnabled({ features: { skillRecorder: true } })).toBe(true);
    // the built-in browser is on unless switched off — an independent flag
    expect(builtInBrowserEnabled({})).toBe(true);
    expect(builtInBrowserEnabled({ features: { skillRecorder: true } })).toBe(true);
    expect(parseConfigPatch({ features: { browser: false } })).toEqual({ features: { browser: false } });
    expect(builtInBrowserEnabled({ features: { browser: false } })).toBe(false);
    expect(builtInBrowserEnabled({ features: { browser: true } })).toBe(true);
    // named browser profiles: the list is the unit, ids are partition-safe
    expect(parseConfigPatch({ browserProfiles: [{ id: "work", name: " Work " }] })).toEqual({
      browserProfiles: [{ id: "work", name: "Work" }],
    });
    expect(() => parseConfigPatch({ browserProfiles: [{ id: "../evil", name: "x" }] })).toThrow(/browserProfiles.*id/i);
    expect(() => parseConfigPatch({ browserProfiles: [{ id: "ok", name: "" }] })).toThrow(/browserProfiles.*name/i);
    expect(() => parseConfigPatch({ features: { skillRecorder: "yes" } })).toThrow(
      "features.skillRecorder",
    );
  });

  it("keeps tool-call chips off by default and accepts an explicit opt-in", () => {
    expect(showToolCallsEnabled({})).toBe(false);
    expect(parseConfigPatch({ features: { showToolCalls: true } })).toEqual({
      features: { showToolCalls: true },
    });
    expect(showToolCallsEnabled({ features: { showToolCalls: true } })).toBe(true);
  });

  it.each([0, 1.5, 5, "2", null])("rejects an invalid per-bot VM limit: %j", (maxInstances) => {
    expect(() => parseConfigPatch({ localVm: { maxInstances } })).toThrow("localVm.maxInstances");
  });

  it.each(["one-per-bot", "windows", 1, null])("rejects an invalid Local VM mode: %j", (mode) => {
    expect(() => parseConfigPatch({ localVm: { mode } })).toThrow("localVm.mode");
  });
});

describe("default fleet", () => {
  it("ships Qwen and Hermes as custom-only engines", () => {
    const map = instanceConfigs({});
    expect(map.qwen).toEqual({ driver: "qwenAgent", environment: {} });
    expect(map.hermes).toEqual({ driver: "hermesAgent", environment: {} });
  });

  it("ships Cursor as a default-fleet subscription engine", () => {
    const map = instanceConfigs({});
    expect(map.cursor).toEqual({ driver: "cursorAgent", environment: {} });
  });

  it("carries the saved OpenAI-compatible URL into the live default instance", () => {
    const map = instanceConfigs({
      openaiCompat: { key: "secret", url: "https://models.example.test/v1" },
    });
    expect(map.openaiCompat.config).toEqual({ url: "https://models.example.test/v1" });
    expect(map.openaiCompat.environment).toEqual({
      OPENAI_COMPAT_API_KEY: "secret",
      OPENAI_COMPAT_URL: "https://models.example.test/v1",
    });
  });

  it("preserves a per-instance OpenAI-compatible URL override", () => {
    const map = instanceConfigs({
      openaiCompat: { url: "https://workspace.example.test/v1" },
      instances: {
        custom: {
          driver: "openai-compat",
          config: { url: "https://instance.example.test/v1", apiKeyEnv: "CUSTOM_KEY" },
        },
      },
    });
    expect(map.custom.config).toEqual({
      url: "https://instance.example.test/v1",
      apiKeyEnv: "CUSTOM_KEY",
    });
  });

  it("does not retain an injected OpenAI-compatible URL across config refreshes", () => {
    const config: AppConfig = {
      openaiCompat: { url: "https://first.example.test/v1" },
      instances: {
        custom: { driver: "openai-compat" },
      },
    };

    expect(instanceConfigs(config).custom.config).toEqual({
      url: "https://first.example.test/v1",
    });
    config.openaiCompat = { url: "https://second.example.test/v1" };
    expect(instanceConfigs(config).custom.config).toEqual({
      url: "https://second.example.test/v1",
    });
    expect(config.instances?.custom.config).toBeUndefined();
  });

  it("adds missing custom-only engines onto an existing product fleet", () => {
    const map = instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } });
    expect(map.claude.driver).toBe("claudeAgent");
    expect(map.qwen?.driver).toBe("qwenAgent");
    expect(map.hermes?.driver).toBe("hermesAgent");
    expect(map.cursor?.driver).toBe("cursorAgent");
    expect(map.openaiCompat?.driver).toBe("openai-compat");
  });

  it("does not expand a one-off shadow fleet", () => {
    const map = instanceConfigs({ instances: { ghost: { driver: "not-a-real-driver" } } });
    expect(Object.keys(map)).toEqual(["ghost"]);
  });
});

describe("Instance CLI override", () => {
  it("sets, replaces, and clears config.cli on a default-fleet instance", () => {
    const cfg: AppConfig = {};
    const set = withInstanceCli(cfg, "claude", "/opt/claude-2.1/bin/claude");
    expect(set.ok).toBe(true);
    expect(set.config.instances!.claude.config).toEqual({ cli: "/opt/claude-2.1/bin/claude" });

    const replaced = withInstanceCli(set.config, "claude", "~/bin/claude");
    expect(replaced.config.instances!.claude.config).toEqual({ cli: "~/bin/claude" });

    const cleared = withInstanceCli(replaced.config, "claude", "");
    expect(cleared.config.instances!.claude.config).toBeUndefined();
  });

  it("preserves sibling config keys when clearing only cli", () => {
    const cfg: AppConfig = {
      instances: { claude: { driver: "claudeAgent", config: { cli: "/x/claude", permissionMode: "bypassPermissions" } } },
    };
    const cleared = withInstanceCli(cfg, "claude", "");
    expect(cleared.config.instances!.claude.config).toEqual({ permissionMode: "bypassPermissions" });
  });

  it("leaves the original config untouched and rejects unknown instances", () => {
    const cfg: AppConfig = { instances: { codex: { driver: "codex" } } };
    const result = withInstanceCli(cfg, "codex", "/new/codex");
    expect(result.config.instances!.codex.config).toEqual({ cli: "/new/codex" });
    expect(cfg.instances!.codex.config).toBeUndefined();

    expect(withInstanceCli(cfg, "nope", "/x").ok).toBe(false);
  });

  it("never persists the credential env instanceConfigs injects", () => {
    // instanceConfigs() copies each credential into its consuming driver's
    // environment for the live fleet; withInstanceCli must strip those pairs
    // back out, or saving a CLI override would copy secrets into the
    // instances section of config.json.
    const cfg: AppConfig = {
      xai: { key: "SECRET-XAI" },
      box: { token: "SECRET-BOX" },
      opencodeGo: { apiKey: "SECRET-OCG" },
      instances: {
        claude: { driver: "claudeAgent" },
        grokApi: { driver: "grok" },
        computer: { driver: "boxAgent" },
        opencode: { driver: "opencodeGo" },
      },
    };
    const set = withInstanceCli(cfg, "claude", "/opt/claude");
    expect(set.ok).toBe(true);
    for (const entry of Object.values(set.config.instances!)) {
      expect(entry.environment ?? {}).toEqual({});
    }
    // user-authored env survives
    const custom = { instances: { claude: { driver: "claudeAgent", environment: { MY_FLAG: "1" } } } };
    const kept = withInstanceCli(custom, "claude", "/x");
    expect(kept.config.instances!.claude.environment).toEqual({ MY_FLAG: "1" });
  });
});

describe("OpenCode Go configuration", () => {
  it("injects the key only into OpenCode Go instances", () => {
    const cfg: AppConfig = {
      opencodeGo: { apiKey: "secret-value" },
      instances: {
        opencode: { driver: "opencodeGo" },
        grok: { driver: "grokAgent" },
      },
    };

    const instances = instanceConfigs(cfg);
    expect(instances.opencode.environment).toEqual({ OPENCODE_API_KEY: "secret-value" });
    expect(instances.grok.environment).toEqual({});
  });
});

describe("credential env narrowing", () => {
  it("injects each credential only into the driver that consumes it", () => {
    const cfg: AppConfig = {
      xai: { key: "SECRET-XAI" },
      box: { token: "SECRET-BOX" },
      opencodeGo: { apiKey: "SECRET-OCG" },
      instances: {
        grokApi: { driver: "grok" },
        computer: { driver: "boxAgent" },
        opencode: { driver: "opencodeGo" },
        claude: { driver: "claudeAgent" },
        codex: { driver: "codex" },
      },
    };
    const instances = instanceConfigs(cfg);
    expect(instances.grokApi.environment).toEqual({ XAI_API_KEY: "SECRET-XAI" });
    expect(instances.computer.environment).toEqual({ BOX_TOKEN: "SECRET-BOX" });
    expect(instances.opencode.environment).toEqual({ OPENCODE_API_KEY: "SECRET-OCG" });
    // engines that bring their own login receive NO workspace credential
    expect(instances.claude.environment).toEqual({});
    expect(instances.codex.environment).toEqual({});
  });

  it("hands no credential to any default-fleet CLI engine except the Computer", () => {
    // the default `grok` instance is the CLI-login grokAgent, not the
    // API-key driver, so a configured xai key reaches nobody by default
    const cfg: AppConfig = { xai: { key: "SECRET-XAI" }, box: { token: "SECRET-BOX" } };
    const instances = instanceConfigs(cfg);
    for (const [id, entry] of Object.entries(instances)) {
      if (id === "computer") expect(entry.environment).toEqual({ BOX_TOKEN: "SECRET-BOX" });
      else expect(entry.environment).toEqual({});
    }
  });

  it("keeps a per-instance environment while layering the credential on top", () => {
    const cfg: AppConfig = {
      box: { token: "SECRET-BOX" },
      instances: { computer: { driver: "boxAgent", environment: { MY_FLAG: "1" } } },
    };
    expect(instanceConfigs(cfg).computer.environment).toEqual({ MY_FLAG: "1", BOX_TOKEN: "SECRET-BOX" });
  });
});

describe("credential env preference", () => {
  const VARS = [
    "XAI_API_KEY",
    "OPENAI_COMPAT_API_KEY",
    "OPENAI_COMPAT_URL",
    "OPENAI_COMPAT_MODEL",
    "OPENAI_COMPAT_PROVIDER",
    "BOX_TOKEN",
    "OPENCODE_API_KEY",
    "HELMRYTH_TTS_KEY",
    "HELMRYTH_OPENAI_IMAGE_KEY",
    "COMPOSIO_API_KEY",
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
    for (const name of VARS) delete process.env[name];
    mkdirSync(DATA_DIR, { recursive: true });
    rmSync(join(DATA_DIR, "config.json"), { force: true });
  });
  afterEach(() => {
    for (const name of VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    rmSync(join(DATA_DIR, "config.json"), { force: true });
  });

  it("prefers env over the config file for every credential", () => {
    // the desktop shell hands secrets to this process as env (from its
    // OS-encrypted store) and leaves the file without them — env must win
    // even over a leftover plaintext value
    writeFileSync(
      join(DATA_DIR, "config.json"),
      JSON.stringify({
        xai: { key: "file-xai", url: "https://api.example.test/v1" },
        box: { token: "file-box" },
        opencodeGo: { apiKey: "file-ocg" },
        tts: { key: "file-tts", voice: "narrator" },
        imageGen: { key: "file-image" },
      }),
    );
    process.env.XAI_API_KEY = "env-xai";
    process.env.BOX_TOKEN = "env-box";
    process.env.OPENCODE_API_KEY = "env-ocg";
    process.env.HELMRYTH_TTS_KEY = "env-tts";
    process.env.HELMRYTH_OPENAI_IMAGE_KEY = "env-image";
    const cfg = loadConfig();
    expect(cfg.xai).toEqual({ key: "env-xai", url: "https://api.example.test/v1" });
    expect(cfg.box).toEqual({ token: "env-box" });
    expect(cfg.opencodeGo).toEqual({ apiKey: "env-ocg" });
    expect(cfg.tts).toEqual({ key: "env-tts", voice: "narrator" });
    expect(cfg.imageGen).toEqual({ key: "env-image" });
  });

  it("rejects unsafe OpenAI-compatible routing from the development environment", () => {
    process.env.OPENAI_COMPAT_URL = "https://user:secret@models.example.test/v1";
    expect(() => loadConfig()).toThrow(/OPENAI_COMPAT_URL/i);
  });

  it("falls back to the config file when the env var is unset (dev mode)", () => {
    writeFileSync(
      join(DATA_DIR, "config.json"),
      JSON.stringify({ xai: { key: "file-xai" }, tts: { key: "file-tts" }, imageGen: { key: "file-image" } }),
    );
    const cfg = loadConfig();
    expect(cfg.xai?.key).toBe("file-xai");
    expect(cfg.tts?.key).toBe("file-tts");
    expect(cfg.imageGen?.key).toBe("file-image");
  });

  it("treats a blanked file field as absent when env supplies the secret", () => {
    // after migration the desktop shell may leave "" behind (a cleared key
    // that was saved mid-session); the env-injected value must still win
    writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ xai: { key: "" } }));
    process.env.XAI_API_KEY = "env-xai";
    expect(loadConfig().xai?.key).toBe("env-xai");
  });

  it("syncCredentialEnv keeps process.env in step with a credential save", () => {
    process.env.XAI_API_KEY = "boot-injected";
    process.env.BOX_TOKEN = "boot-injected";
    process.env.COMPOSIO_API_KEY = "boot-injected";
    syncCredentialEnv({
      xai: { key: "just-saved" },
      composio: { apiKey: "ak_just_saved" },
      box: { token: "" },
      profile: { name: "Ada" },
    });
    // a saved value replaces the boot-time one; a cleared value drops it;
    // untouched sections change nothing
    expect(process.env.XAI_API_KEY).toBe("just-saved");
    expect(process.env.COMPOSIO_API_KEY).toBe("ak_just_saved");
    expect(process.env.BOX_TOKEN).toBeUndefined();
    expect(process.env.HELMRYTH_TTS_KEY).toBeUndefined();
  });

  it("syncCredentialEnv keeps model and provider env in step with a save", () => {
    // loadConfig() prefers OPENAI_COMPAT_MODEL/PROVIDER over the file, so a
    // mid-session save must update them like key/url or the boot-injected
    // values shadow the save until relaunch
    process.env.OPENAI_COMPAT_MODEL = "boot-model";
    process.env.OPENAI_COMPAT_PROVIDER = "boot-provider";
    syncCredentialEnv({
      openaiCompat: { model: "vendor/just-saved", provider: "fireworks" },
    });
    expect(process.env.OPENAI_COMPAT_MODEL).toBe("vendor/just-saved");
    expect(process.env.OPENAI_COMPAT_PROVIDER).toBe("fireworks");
  });

  it("syncCredentialEnv clears model and provider env on an empty-string save", () => {
    process.env.OPENAI_COMPAT_MODEL = "boot-model";
    process.env.OPENAI_COMPAT_PROVIDER = "boot-provider";
    syncCredentialEnv({ openaiCompat: { model: "", provider: "" } });
    expect(process.env.OPENAI_COMPAT_MODEL).toBeUndefined();
    expect(process.env.OPENAI_COMPAT_PROVIDER).toBeUndefined();
  });

  it("syncCredentialEnv leaves model and provider env untouched when absent from the patch", () => {
    process.env.OPENAI_COMPAT_MODEL = "boot-model";
    process.env.OPENAI_COMPAT_PROVIDER = "boot-provider";
    syncCredentialEnv({ openaiCompat: { key: "just-saved" } });
    expect(process.env.OPENAI_COMPAT_MODEL).toBe("boot-model");
    expect(process.env.OPENAI_COMPAT_PROVIDER).toBe("boot-provider");
  });
});

describe("corrupt config.json", () => {
  const path = () => join(DATA_DIR, "config.json");

  beforeEach(() => {
    mkdirSync(DATA_DIR, { recursive: true });
    for (const entry of readdirSync(DATA_DIR)) {
      if (entry.startsWith("config.json")) rmSync(join(DATA_DIR, entry), { force: true });
    }
    delete process.env.XAI_API_KEY;
  });
  afterEach(() => {
    for (const entry of readdirSync(DATA_DIR)) {
      if (entry.startsWith("config.json")) rmSync(join(DATA_DIR, entry), { force: true });
    }
  });

  const quarantined = () => readdirSync(DATA_DIR).filter((f) => f.startsWith("config.json.corrupt-"));

  it("preserves an unparseable config.json instead of silently reporting nothing configured", () => {
    // The API answers 200 with every credential "unconfigured" and the next
    // save writes a fresh object over the file, so a single stray byte used to
    // destroy the stored keys, profile and per-instance overrides outright.
    const original = '{"xai":{"key":"xai-keep-me"},"profile":{"name":"Ada"';
    writeFileSync(path(), original);

    expect(loadConfig().xai?.key).toBeUndefined();

    const preserved = quarantined();
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(DATA_DIR, preserved[0]), "utf8")).toBe(original);
  });

  it("preserves a config.json that fails validation, not just one that fails to parse", () => {
    const original = JSON.stringify({ rooms: { turnTimeoutMinutes: "not a number" } });
    writeFileSync(path(), original);

    expect(loadConfig().rooms).toBeUndefined();
    expect(quarantined()).toHaveLength(1);
  });

  it("preserves the file saveConfig is about to overwrite", () => {
    // saveConfig re-reads the file to merge onto; when that read fails it
    // starts from {} and writeFileAtomic replaces the original wholesale.
    const original = '{"xai":{"key":"xai-keep-me"';
    writeFileSync(path(), original);

    saveConfig({ profile: { name: "Ada" } });

    expect(loadConfig().profile?.name).toBe("Ada");
    const preserved = quarantined();
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(DATA_DIR, preserved[0]), "utf8")).toBe(original);
  });

  it("stays silent on a genuinely first run", () => {
    expect(loadConfig().xai?.key).toBeUndefined();
    expect(quarantined()).toEqual([]);
  });
});

describe("workspace credential env strip", () => {
  it("removes every workspace credential from a child env in place", () => {
    const env = {
      PATH: "/usr/bin",
      MY_FLAG: "1",
      ...Object.fromEntries(WORKSPACE_CREDENTIAL_ENV.map((name) => [name, "secret"])),
    };
    stripWorkspaceCredentialEnv(env);
    expect(env).toEqual({ PATH: "/usr/bin", MY_FLAG: "1" });
  });

  it("covers the box token and voice key, which no engine CLI may inherit", () => {
    // these two have no per-driver ACP allowlist entry anywhere — they are
    // consumed in-process (Computer driver / voice module), never by a CLI
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("BOX_TOKEN");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("HELMRYTH_TTS_KEY");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("HELMRYTH_OPENAI_IMAGE_KEY");
  });
});
