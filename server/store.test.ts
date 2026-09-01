// Store persistence contract: bots.json + messages-<threadId>.json are
// the durable record — everything here must survive a process restart
// except `busy`, which never does (no turn survives one either).
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { peerAllowKey } from "./peer-approval-key.ts";
import { parseJson } from "./schema.ts";
import { Store, type BotRecord, type StoreChange } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const persistedBotTestIdentitySchema = z.looseObject({ id: z.string(), threadId: z.string() });
const persistedBotsSchema = z.array(
  z.custom<BotRecord>(
    (value) => persistedBotTestIdentitySchema.safeParse(value).success,
    "Invalid persisted operator fixture",
  ),
);
const persistedCloudBackendBotsSchema = z.array(
  z.looseObject({ id: z.string(), cloudBackend: z.string().optional() }),
);

describe("Store", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("createBot seeds a greeting and an onboarding card", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(bot.name).toBe("Rivet");

    const messages = store.messagesFor(bot.threadId);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "bot", kind: "text" });
    expect(messages[0]?.text).toBe("I’m Rivet. Set the outcome; I’ll move the work and surface every gate.");
    expect(messages[1].kind).toBe("options");
    expect(messages[1].card).toMatchObject({
      title: "What should move first?",
      subtitle: "Choose one outcome. Your operator will shape it into a visible run with clear gates.",
      options: ["Build or ship", "Investigate and decide", "Plan and coordinate", "Clear a backlog"],
    });
    expect(bot.modelSelection).toEqual(selection());
  });

  it.skipIf(process.platform === "win32")("repairs private bot/group files on restart without losing records", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Private operator" });
    const group = store.createGroup("Private crew", [bot.id]);
    const botsFile = join(DATA_DIR, "bots.json");
    const groupsFile = join(DATA_DIR, "groups.json");
    chmodSync(DATA_DIR, 0o755);
    chmodSync(botsFile, 0o644);
    chmodSync(groupsFile, 0o644);

    const restarted = new Store(selection);

    expect(restarted.bot(bot.id)?.name).toBe("Private operator");
    expect(restarted.group(group.id)?.name).toBe("Private crew");
    expect(statSync(DATA_DIR).mode & 0o777).toBe(0o700);
    expect(statSync(botsFile).mode & 0o777).toBe(0o600);
    expect(statSync(groupsFile).mode & 0o777).toBe(0o600);
  });

  it("dismisses the onboarding quiz when the user talks, and leaves live asks", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const quiz = store.messagesFor(bot.threadId)[1]!;
    expect(quiz.card?.dismissed).toBeUndefined();

    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    expect(store.messagesFor(bot.threadId).find((m) => m.id === quiz.id)?.card?.dismissed).toBe(true);

    const reloaded = new Store(selection);
    expect(reloaded.messagesFor(bot.threadId).find((m) => m.id === quiz.id)?.card?.dismissed).toBe(true);

    const ask = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "Approval needed",
        subtitle: "run rm",
        options: ["Allow", "Deny"],
        requestId: "req-1",
        tool: "Bash",
      },
    });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "later" });
    expect(store.messagesFor(bot.threadId).find((m) => m.id === ask.id)?.card?.dismissed).toBeUndefined();
  });

  it("does not dismiss the quiz for bot-authored messages", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "still here" });
    expect(store.messagesFor(bot.threadId)[1]?.card?.dismissed).toBeUndefined();
  });

  it("createBot with seedMessages:false starts with an empty transcript", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Imported" }, { seedMessages: false });
    expect(store.messagesFor(bot.threadId)).toHaveLength(0);
  });

  it("preserves an explicitly supplied operator name", () => {
    const store = new Store(selection);
    expect(store.createBot({ name: "My Existing Name" }).name).toBe("My Existing Name");
  });

  it("addTaskUsage accumulates settled-turn totals per task and survives a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 1200, output: 300, cachedInput: 1000, costUsd: null })).toEqual({
      input: 1200,
      output: 300,
      cachedInput: 1000,
      costUsd: null,
      turns: 1,
    });
    // a driver that never reports the cached share leaves it unchanged
    store.addTaskUsage(bot.id, bot.threadId, { input: 800, output: 100, costUsd: null });
    store.addTaskUsage(bot.id, bot.threadId, { input: Number.NaN, output: -20, cachedInput: -5, costUsd: null });
    // Providers occasionally report a cache count larger than input; keep the
    // persisted share physically possible so percentages cannot exceed 100%.
    store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 0, cachedInput: 20, costUsd: null });
    // a different thread never inherits another task's tally
    expect(store.addTaskUsage(bot.id, "no-such-thread", { input: 5, output: 5, costUsd: null })).toBeNull();

    const reloaded = new Store(selection);
    expect(reloaded.taskByThread(bot.id, bot.threadId)?.usage).toEqual({
      input: 2010,
      output: 400,
      cachedInput: 1010,
      costUsd: null,
      turns: 4,
    });
  });

  it("persists the per-bot composio gate", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { composio: false });
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.composio).toBe(false);
  });

  it("rotates colors across created bots", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    expect(first.color).not.toBe(second.color);
  });

  it("defaults a room to its first member and repairs the lead when membership changes", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    const group = store.createGroup("Team", [first.id, second.id]);

    expect(group.defaultResponder).toEqual({ kind: "member", botId: first.id });
    store.patchGroup(group.id, { memberIds: [second.id] });
    expect(group.defaultResponder).toEqual({ kind: "member", botId: second.id });

    const reloaded = new Store(selection);
    expect(reloaded.group(group.id)?.defaultResponder).toEqual({ kind: "member", botId: second.id });
  });

  it("persists a channel's context when it is created", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const channel = store.createGroup("Website launch", [bot.id], false, "Work");

    expect(channel.section).toBe("Work");
    expect(new Store(selection).group(channel.id)?.section).toBe("Work");
  });

  it("persists a channel's completed setup in the same create write", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const channel = store.createGroup("Launch", [bot.id], false, "Work", {
      bulletin: "Ship carefully.",
      defaultResponder: { kind: "mentions" },
      completed: true,
    });

    expect(channel).toMatchObject({
      bulletin: "Ship carefully.",
      defaultResponder: { kind: "mentions" },
      setupSkippedAt: null,
    });
    expect(channel.setupCompletedAt).toEqual(expect.any(Number));
    expect(new Store(selection).group(channel.id)).toMatchObject({
      bulletin: "Ship carefully.",
      defaultResponder: { kind: "mentions" },
      setupCompletedAt: channel.setupCompletedAt,
    });
  });

  it("migrates old rooms without routing to their first member", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    const group = store.createGroup("Legacy team", [first.id, second.id]);
    const groupsFile = join(DATA_DIR, "groups.json");
    const saved = JSON.parse(readFileSync(groupsFile, "utf8"));
    delete saved[0].defaultResponder;
    writeFileSync(groupsFile, JSON.stringify(saved));

    const reloaded = new Store(selection);
    expect(reloaded.group(group.id)?.defaultResponder).toEqual({ kind: "member", botId: first.id });
  });

  it("persists bots and messages across a restart, resetting busy", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { name: "Testy", busy: true });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi there" });

    const reloaded = new Store(selection);
    const back = reloaded.bot(bot.id)!;
    expect(back.name).toBe("Testy");
    expect(back.busy).toBe(false);
    const messages = reloaded.messagesFor(bot.threadId);
    expect(messages.at(-1)).toMatchObject({ role: "user", text: "hi there" });
  });

  it("normalizes persisted cloud backends without changing valid or absent values", () => {
    const store = new Store(selection);
    const box = store.createBot();
    const vps = store.createBot();
    const invalid = store.createBot();
    const absent = store.createBot();
    const raw = persistedCloudBackendBotsSchema.parse(parseJson(readFileSync(join(DATA_DIR, "bots.json"), "utf8")));
    raw.find((bot) => bot.id === box.id)!.cloudBackend = "box";
    raw.find((bot) => bot.id === vps.id)!.cloudBackend = "vps";
    raw.find((bot) => bot.id === invalid.id)!.cloudBackend = "daytona";
    delete raw.find((bot) => bot.id === absent.id)!.cloudBackend;
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(raw));

    const reloaded = new Store(selection);
    expect(reloaded.bot(box.id)?.cloudBackend).toBe("box");
    expect(reloaded.bot(vps.id)?.cloudBackend).toBe("vps");
    expect(reloaded.bot(invalid.id)?.cloudBackend).toBeUndefined();
    expect(reloaded.bot(absent.id)?.cloudBackend).toBeUndefined();

    const saved = persistedCloudBackendBotsSchema.parse(parseJson(readFileSync(join(DATA_DIR, "bots.json"), "utf8")));
    expect(saved.find((bot) => bot.id === box.id)?.cloudBackend).toBe("box");
    expect(saved.find((bot) => bot.id === vps.id)?.cloudBackend).toBe("vps");
    expect(saved.find((bot) => bot.id === invalid.id)).not.toHaveProperty("cloudBackend");
    expect(saved.find((bot) => bot.id === absent.id)).not.toHaveProperty("cloudBackend");
  });

  it("migrates unambiguous legacy peer grants without guessing duplicate names", () => {
    const store = new Store(selection);
    const requester = store.createBot();
    const helper = store.patchBot(store.createBot().id, { name: "Helper" })!;
    store.patchBot(store.createBot().id, { name: "Twin" });
    store.patchBot(store.createBot().id, { name: "Twin" });
    store.patchBot(requester.id, {
      alwaysAllow: ["ask_bot:@Helper", "delegate_bot:@Twin", "Bash:git status"],
    });

    const reloaded = new Store(selection);
    expect(reloaded.bot(requester.id)?.alwaysAllow).toEqual([
      peerAllowKey("ask_bot", helper.id),
      "delegate_bot:@Twin",
      "Bash:git status",
    ]);

    const persisted = persistedBotsSchema.parse(parseJson(readFileSync(join(DATA_DIR, "bots.json"), "utf8")));
    expect(persisted.find((bot) => bot.id === requester.id)?.alwaysAllow).toEqual(
      reloaded.bot(requester.id)?.alwaysAllow,
    );
  });

  it("persists a bot's effort level across a restart, defaulting to unset", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(bot.modelSelection.effort).toBeUndefined();

    store.patchBot(bot.id, { modelSelection: { ...bot.modelSelection, effort: "high" } });

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.modelSelection.effort).toBe("high");
  });

  it("keeps one persisted Chief of Staff per section and supports handoff", () => {
    const store = new Store(selection);
    const first = store.createBot({ section: "Work" });
    const second = store.createBot({ section: "Work" });
    const personal = store.createBot({ section: "Personal" });

    expect(store.setChiefOfStaff(first.id)?.map((bot) => bot.id)).toEqual([first.id]);
    expect(store.bot(first.id)?.chiefOfStaff).toBe(true);
    expect(store.setChiefOfStaff(personal.id)?.map((bot) => bot.id)).toEqual([personal.id]);

    const changed = store.setChiefOfStaff(second.id)!;
    expect(changed.map((bot) => bot.id).sort()).toEqual([first.id, second.id].sort());
    expect(store.bot(first.id)?.chiefOfStaff).toBe(false);
    expect(store.bot(second.id)?.chiefOfStaff).toBe(true);
    expect(store.bot(personal.id)?.chiefOfStaff).toBe(true);

    const reloaded = new Store(selection);
    expect(reloaded.bots.filter((bot) => bot.chiefOfStaff).map((bot) => bot.id).sort()).toEqual(
      [second.id, personal.id].sort(),
    );
    expect(reloaded.setChiefOfStaff(null, "Work")?.map((bot) => bot.id)).toEqual([second.id]);
    expect(reloaded.bot(personal.id)?.chiefOfStaff).toBe(true);
    expect(reloaded.bot(second.id)?.chiefOfStaff).toBe(false);
  });

  it("patchMessage merges card patches and returns null for unknown ids", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const card = store.messagesFor(bot.threadId)[1];

    const patched = store.patchMessage(bot.threadId, card.id, {
      card: { ...card.card!, answered: "Build or ship" },
    });
    expect(patched?.card?.answered).toBe("Build or ship");
    expect(store.patchMessage(bot.threadId, "nope", {})).toBeNull();
  });


  it("setResumeCursor persists per-instance continuations", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.setResumeCursor(bot.id, "claude", "sess-abc");
    store.setResumeCursor(bot.id, "codex", "thread-xyz");

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.resumeCursors).toEqual({ claude: "sess-abc", codex: "thread-xyz" });
  });

  it("seedIfEmpty creates exactly one starter bot, once", () => {
    const store = new Store(selection);
    store.seedIfEmpty();
    expect(store.bots).toHaveLength(1);
    store.seedIfEmpty();
    expect(store.bots).toHaveLength(1);

    const reloaded = new Store(selection);
    reloaded.seedIfEmpty();
    expect(reloaded.bots).toHaveLength(1);
  });

  it("chains appended messages and keeps the newest as active leaf", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const user = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });

    const messages = store.messagesFor(bot.threadId);
    expect(user.parentId).toBe(messages[1].id); // follows the onboarding card
    expect(store.activeLeaf(bot.threadId)).toBe(user.id);
    expect(store.activePath(bot.threadId).map((m) => m.id)).toEqual(messages.map((m) => m.id));
  });

  it("branchMessage forks at the edited message and hides the old tail", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v1" });

    const edited = store.branchMessage(bot.threadId, original.id, "v2")!;
    expect(edited.parentId).toBe(original.parentId); // sibling, not child
    expect(store.activeLeaf(bot.threadId)).toBe(edited.id);

    const path = store.activePath(bot.threadId);
    expect(path.map((m) => m.text)).toContain("v2");
    expect(path.map((m) => m.text)).not.toContain("v1");
    expect(path.map((m) => m.id)).not.toContain(reply.id);
    // the abandoned branch still exists in the tree
    expect(store.messagesFor(bot.threadId).map((m) => m.id)).toContain(original.id);

    expect(store.branchMessage(bot.threadId, "nope", "x")).toBeNull();
  });

  it("setActiveLeaf switches branches and descends to the newest leaf", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v1" });
    store.branchMessage(bot.threadId, original.id, "v2");
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v2" });

    // back to the original branch: the leaf is v1's reply, not v1 itself
    expect(store.setActiveLeaf(bot.threadId, original.id)).toBe(reply.id);
    const path = store.activePath(bot.threadId);
    expect(path.map((m) => m.text)).toContain("v1");
    expect(path.map((m) => m.text)).not.toContain("v2");

    expect(store.setActiveLeaf(bot.threadId, "nope")).toBeNull();
  });

  it("persists the branch tree and active leaf across a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    const edited = store.branchMessage(bot.threadId, original.id, "v2")!;

    const reloaded = new Store(selection);
    expect(reloaded.activeLeaf(bot.threadId)).toBe(edited.id);
    expect(reloaded.messagesFor(bot.threadId).map((m) => m.text)).toContain("v1");
    expect(reloaded.activePath(bot.threadId).map((m) => m.text)).not.toContain("v1");
  });


  it("tolerates a corrupt bots.json by starting empty", () => {
    const store = new Store(selection);
    store.createBot();
    writeFileSync(join(DATA_DIR, "bots.json"), "{not json");

    const reloaded = new Store(selection);
    expect(reloaded.bots).toEqual([]);
  });

  it("preserves a bots.json that exists but cannot be read, instead of discarding it", () => {
    // Unparseable was already handled. UNREADABLE was not: the loader treated
    // every readFileSync failure as "no file yet" and started empty, and the
    // next save then overwrote the roster it had failed to read. The file is
    // right there on disk, so that is silent data loss, and it contradicts the
    // contract atomic.ts states for exactly this case.
    const store = new Store(selection);
    store.createBot({ name: "Keeper" });
    const path = join(DATA_DIR, "bots.json");
    const original = readFileSync(path, "utf8");
    expect(original).toContain("Keeper");

    // A directory in the file's place fails readFileSync with EISDIR — the same
    // shape as a permission change or an oversized file, without needing to
    // write 600MB in a unit test.
    rmSync(path);
    mkdirSync(path);

    const reloaded = new Store(selection);
    expect(reloaded.bots).toEqual([]);

    const quarantined = readdirSync(DATA_DIR).filter((f) => f.startsWith("bots.json.corrupt-"));
    expect(quarantined).toHaveLength(1);

    rmSync(path, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("does not hang forever when bots.json is a named pipe", () => {
    // readFileSync opens before it reads, and open(2) on a FIFO blocks until a
    // writer arrives — so a named pipe here used to wedge boot with no error,
    // no log and no bound port. A hang is worse than a crash: there is nothing
    // to act on. It is checked in a child process because a blocking syscall
    // cannot be interrupted by a test timeout; it would wedge this worker too.
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    execFileSync("mkfifo", [join(DATA_DIR, "bots.json")]);

    const bootStore = `
      const { Store } = await import(${JSON.stringify(new URL("./store.ts", import.meta.url).href)});
      new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
      console.log("booted");
    `;
    const out = execFileSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--no-warnings", "-e", bootStore],
      { env: { ...process.env, HELMRYTH_DATA_DIR: DATA_DIR }, timeout: 20_000, encoding: "utf8" },
    );

    expect(out).toContain("booted");
    expect(readdirSync(DATA_DIR).filter((f) => f.startsWith("bots.json.corrupt-"))).toHaveLength(1);
  });

  it("starts with a corrupt operator workspace erasure journal quarantined, not by dying at boot", () => {
    // The journal is read inside the manager's constructor, so an unparseable
    // one threw out of `new Store` and killed the process before it could bind
    // a port — on every restart, from a bookkeeping file the app writes itself.
    mkdirSync(DATA_DIR, { recursive: true });
    const journal = join(DATA_DIR, "bot-workspace-erasures.json");
    writeFileSync(journal, '{"version":1,"entries":');

    const store = new Store(selection);
    expect(store.createBot({ name: "Still boots" }).name).toBe("Still boots");
    const quarantined = readdirSync(DATA_DIR).filter((f) => f.startsWith("bot-workspace-erasures.json.corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(DATA_DIR, quarantined[0]), "utf8")).toBe('{"version":1,"entries":');
  });

  it("starts with a corrupt thread erasure journal quarantined, not by dying at boot", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    const journal = join(DATA_DIR, "thread-erasures.json");
    writeFileSync(journal, '{"version":2,"entries":[');

    const store = new Store(selection);
    expect(store.createBot({ name: "Still boots too" }).name).toBe("Still boots too");
    expect(readdirSync(DATA_DIR).filter((f) => f.startsWith("thread-erasures.json.corrupt-"))).toHaveLength(1);
  });

  it("does not quarantine anything on a genuinely first run", () => {
    // ENOENT is the ordinary empty-workspace case; it must stay silent.
    rmSync(join(DATA_DIR, "bots.json"), { force: true });
    const fresh = new Store(selection);
    expect(fresh.bots).toEqual([]);
    expect(readdirSync(DATA_DIR).filter((f) => f.includes(".corrupt-"))).toEqual([]);
  });

  it("busy is wiped even when bots.json says otherwise", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const raw = persistedBotsSchema.parse(parseJson(readFileSync(join(DATA_DIR, "bots.json"), "utf8")));
    raw.find((b) => b.id === bot.id)!.busy = true;
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(raw));

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.busy).toBe(false);
  });
  it("createBot with seedMessages:false starts with an empty transcript", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Imported" }, { seedMessages: false });
    expect(store.messagesFor(bot.threadId)).toHaveLength(0);
  });

  it("persists the per-bot composio gate", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { composio: false });
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.composio).toBe(false);
  });

  it("deleteBot removes the bot and its durable transcript", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    // the transcript is durable — a fresh Store sees the seeded messages
    expect(new Store(selection).messagesFor(bot.threadId).length).toBeGreaterThan(0);

    expect(store.deleteBot(bot.id)).toBe(true);
    expect(store.bot(bot.id)).toBeNull();
    expect(new Store(selection).messagesFor(bot.threadId)).toHaveLength(0);
    expect(store.deleteBot(bot.id)).toBe(false);
  });

  it("journals private workspace cleanup before removing the bot owner record", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const prepared: string[] = [];
    store.setBotWorkspaceDeletionLifecycle({
      prepare: (botId) => {
        // This is the kill boundary: a process death immediately after this
        // callback still has a live owner and a durable cleanup intent.
        expect(store.bot(botId)).not.toBeNull();
        prepared.push(botId);
      },
    });

    expect(store.deleteBot(bot.id)).toBe(true);
    expect(prepared).toEqual([bot.id]);
    expect(store.bot(bot.id)).toBeNull();
  });
  it("migrates a pre-branching flat transcript file", () => {
    const store = new Store(selection);
    // seedMessages:false — a legacy-era thread has its history ONLY in the
    // JSON file; any DB rows would (correctly) take precedence over it
    const bot = store.createBot({}, { seedMessages: false });
    const legacy = [
      { id: "m1", role: "bot", kind: "text", text: "hello", at: 1 },
      { id: "m2", role: "user", kind: "text", text: "hi", at: 2 },
    ];
    writeFileSync(join(DATA_DIR, `messages-${bot.threadId}.json`), JSON.stringify(legacy));

    const reloaded = new Store(selection);
    const messages = reloaded.messagesFor(bot.threadId);
    expect(messages.map((m) => m.parentId)).toEqual([null, "m1"]);
    expect(reloaded.activeLeaf(bot.threadId)).toBe("m2");
    expect(reloaded.activePath(bot.threadId).map((m) => m.id)).toEqual(["m1", "m2"]);
  });
});

describe("Store change stream", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  const record = (store: Store) => {
    const events: StoreChange[] = [];
    store.onChange((event) => events.push(event));
    return events;
  };

  it("emits once per write, after the write, with the record it wrote", () => {
    const store = new Store(selection);
    // no first-run quiz: a user append is exactly one write
    const bot = store.createBot({ name: "Quiet" }, { seedMessages: false });
    const events = record(store);
    const m = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    expect(events).toEqual([{ type: "message", threadId: bot.threadId, message: m }]);
    // the emitted record is the stored one (redacted, id'd) — not the input
    expect(store.messagesFor(bot.threadId).at(-1)).toBe(m);
  });

  it("emits a card patch after a user message hides the onboarding quiz", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const quiz = store.messagesFor(bot.threadId)[1]!;
    const events = record(store);
    const m = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    expect(events.map((event) => event.type)).toEqual(["message", "message.patch"]);
    expect(events[0]).toEqual({ type: "message", threadId: bot.threadId, message: m });
    expect(events[1]).toMatchObject({
      type: "message.patch",
      threadId: bot.threadId,
      message: { id: quiz.id, card: { dismissed: true } },
    });
  });

  it("announces a new bot before its onboarding messages", () => {
    const store = new Store(selection);
    const events = record(store);
    const bot = store.createBot();
    expect(events.map((event) => event.type)).toEqual(["bot", "message", "message"]);
    expect(events[0]).toEqual({ type: "bot", botId: bot.id });
    expect(events.slice(1).every((event) => "threadId" in event && event.threadId === bot.threadId)).toBe(true);
  });

  it("every message-tree write emits a message or thread event", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "a" });
    const events = record(store);
    store.patchMessage(bot.threadId, first.id, { text: "a2" });
    store.branchMessage(bot.threadId, first.id, "b");
    store.setActiveLeaf(bot.threadId, first.id);
    store.toggleReaction(bot.threadId, first.id, "👍", "user");
    expect(events.map((e) => e.type)).toEqual(["message.patch", "message", "thread", "message.patch"]);
    expect(events[2]).toMatchObject({ type: "thread", threadId: bot.threadId, activeLeafId: expect.any(String) });
  });

  // The cap used to return the message unchanged, so the route answered 200
  // and the renderer kept an optimistic mark for a reaction nobody stored.
  it("refuses a reaction past the cap loudly instead of answering with an unchanged message", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const message = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "a" });
    for (let i = 0; i < 50; i += 1) store.toggleReaction(bot.threadId, message.id, `e${i}`, "user");
    const atCap = () => store.messagesFor(bot.threadId).find((m) => m.id === message.id)!.reactions ?? [];
    expect(atCap()).toHaveLength(50);

    const events = record(store);
    let thrown: unknown;
    try {
      store.toggleReaction(bot.threadId, message.id, "🎉", "user");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    // SAFETY: proven to be an Error by the assertion immediately above.
    expect((thrown as Error).message).toContain("already has 50 reactions");
    // SAFETY: the cap failure carries a numeric `status` the route boundary
    // turns into a real 409; the assertion below is what proves it is present.
    expect((thrown as { status?: number }).status).toBe(409);
    expect(events).toEqual([]);
    expect(atCap()).toHaveLength(50);
    expect(atCap().some((reaction) => reaction.emoji === "🎉")).toBe(false);

    // removing at the cap still works, and toggling an existing one is not growth
    expect(store.toggleReaction(bot.threadId, message.id, "e0", "user")?.reactions).toHaveLength(49);
  });

  it("announces screen frames whose pixels are pruned", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = store.appendMessage(bot.threadId, { role: "bot", kind: "screen", png: "frame-1" });
    for (let i = 2; i <= 4; i += 1) {
      store.appendMessage(bot.threadId, { role: "bot", kind: "screen", png: `frame-${i}` });
    }
    const events = record(store);
    const newest = store.appendMessage(bot.threadId, { role: "bot", kind: "screen", png: "frame-5" });
    expect(events).toEqual([
      { type: "message.patch", threadId: bot.threadId, message: { ...first, png: undefined } },
      { type: "message", threadId: bot.threadId, message: newest },
    ]);
  });

  it("every bot write emits a bot event carrying only the id (the wire shape is the caller's)", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const events = record(store);
    store.patchBot(bot.id, { name: "Zed" });
    store.createTask(bot.id, "t2");
    store.switchTask(bot.id, bot.threadId);
    store.renameTask(bot.id, bot.threadId, "renamed");
    store.setResumeCursor(bot.id, "claude", "s1", bot.threadId);
    store.pinTaskCwd(bot.id, bot.threadId, "/private/workspace");
    store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 5, costUsd: null });
    expect(events.every((e) => e.type === "bot" && e.botId === bot.id)).toBe(true);
    expect(events).toHaveLength(7);
    store.deleteBot(bot.id);
    expect(events).toContainEqual({ type: "thread.deleted", threadId: bot.threadId });
    expect(events.at(-1)).toEqual({ type: "bot.deleted", botId: bot.id });
  });

  it("group writes emit group events; a listener that throws never breaks the write", () => {
    const store = new Store(selection);
    const a = store.createBot();
    const b = store.createBot();
    const events = record(store);
    store.onChange(() => {
      throw new Error("bad listener");
    });
    const g = store.createGroup("ops", [a.id, b.id]);
    store.patchGroup(g.id, { unread: true });
    expect(events.map((e) => e.type)).toEqual(["group", "group"]);
    expect(store.group(g.id)?.unread).toBe(true);
    store.deleteGroup(g.id);
    expect(events).toContainEqual({ type: "thread.deleted", threadId: g.threadId });
    expect(events.at(-1)).toEqual({ type: "group.deleted", groupId: g.id });
  });

  it("records an erasure intent with app-owned image candidates before every Store transcript delete path", () => {
    const store = new Store(selection);
    const name = "123e4567-e89b-42d3-a456-426614174000.png";
    const imageText = `<attached-image path="${join(DATA_DIR, "attachments", name)}" />`;
    const intents: Array<{ threadId: string; candidates: readonly string[]; messageCount: number }> = [];
    store.setThreadDeletionLifecycle({
      prepare: (threadId, candidates) => intents.push({
        threadId,
        candidates,
        // Reading here proves preparation precedes SQLite/legacy mutation.
        messageCount: store.messagesFor(threadId).length,
      }),
    });

    const bot = store.createBot();
    const task = store.createTask(bot.id)!;
    store.appendMessage(task.threadId, { role: "user", kind: "text", text: imageText });
    expect(store.deleteTask(bot.id, task.threadId)).toBeTruthy();

    const group = store.createGroup("Privacy", [bot.id]);
    const groupTask = store.createGroupTask(group.id)!;
    store.appendMessage(groupTask.threadId, { role: "user", kind: "text", text: imageText });
    expect(store.deleteGroupTask(group.id, groupTask.threadId)).toBeTruthy();
    store.appendMessage(group.threadId, { role: "user", kind: "text", text: imageText });
    expect(store.deleteGroup(group.id)).toBe(true);

    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: imageText });
    expect(store.deleteBot(bot.id)).toBe(true);

    expect(intents.map((intent) => intent.threadId)).toEqual(expect.arrayContaining([
      task.threadId,
      groupTask.threadId,
      group.threadId,
      bot.threadId,
    ]));
    expect(intents.every((intent) => intent.candidates.includes(name) || intent.messageCount === 0)).toBe(true);
    expect(intents.every((intent) => intent.messageCount >= 0)).toBe(true);
  });

  it("does not treat a generated image as orphaned while another cold task or avatar still owns it", () => {
    const store = new Store(selection);
    const name = "123e4567-e89b-42d3-a456-426614174000.png";
    const path = join(DATA_DIR, "attachments", name);
    const first = store.createBot();
    const firstThreadId = first.threadId;
    const secondTask = store.createTask(first.id)!;
    store.appendMessage(firstThreadId, { role: "user", kind: "text", text: `<attached-image path="${path}" />` });
    store.appendMessage(secondTask.threadId, { role: "user", kind: "text", text: `<attached-image path="${path}" />` });
    expect(store.attachmentReferencedBySurvivor(name)).toBe(true);

    const second = store.createBot();
    store.patchBot(second.id, { avatarUrl: `/api/attachments/${name}` });
    expect(store.attachmentReferencedBySurvivor(name)).toBe(true);
    // Removing one transcript and one profile must leave the other task as
    // a durable reference, including after its messages leave the cache.
    expect(store.deleteTask(first.id, firstThreadId)).toBeTruthy();
    expect(store.deleteBot(second.id)).toBe(true);
    expect(store.attachmentReferencedBySurvivor(name)).toBe(true);
  });

  it("commits the owner deletion and emits durable retry work when a post-commit transcript purge faults", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const task = store.createTask(bot.id)!;
    const events = record(store);
    // A directory where a legacy file belongs makes unlink fail with EISDIR.
    // The Store must not undo/throw after bots.json has committed the owner
    // removal; its thread.deleted event wakes the retry manager instead.
    mkdirSync(join(DATA_DIR, `messages-${task.threadId}.json`));
    expect(store.deleteTask(bot.id, task.threadId)).toBeTruthy();
    expect(store.tasks(bot.id).some((candidate) => candidate.threadId === task.threadId)).toBe(false);
    expect(events).toContainEqual({ type: "thread.deleted", threadId: task.threadId });
  });

  it("delivers each change to the listener snapshot captured before emission", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const seen: string[] = [];
    let removeSecond = () => {};
    store.onChange(() => {
      seen.push("first");
      removeSecond();
      store.onChange(() => seen.push("late"));
    });
    removeSecond = store.onChange(() => seen.push("second"));

    store.patchBot(bot.id, { name: "Snapshot" });

    expect(seen).toEqual(["first", "second"]);
  });

  it("unsubscribe stops delivery", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const seen: unknown[] = [];
    const off = store.onChange((e) => seen.push(e));
    off();
    store.patchBot(bot.id, { name: "x" });
    expect(seen).toEqual([]);
  });
});

describe("Store bot activity state", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("derives busy from activity, so every existing busy reader keeps working", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(bot.activity ?? "idle").toBe("idle");
    expect(Boolean(bot.busy)).toBe(false);
    for (const [state, busy] of [
      ["working", true],
      ["waiting-on-you", true],
      ["no-signal", true],
      ["idle", false],
      ["dead", false],
    ] as const) {
      store.setActivity(bot.id, state);
      expect(store.bot(bot.id)?.activity).toBe(state);
      expect(Boolean(store.bot(bot.id)?.busy)).toBe(busy);
    }
  });

  it("emits a bot change per transition and skips a no-op", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const seen: string[] = [];
    store.onChange((c) => seen.push(c.type));
    store.setActivity(bot.id, "working");
    store.setActivity(bot.id, "working");
    store.setActivity(bot.id, "idle");
    expect(seen).toEqual(["bot", "bot"]);
  });

  it("neither activity nor busy survives a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.setActivity(bot.id, "waiting-on-you");
    const again = new Store(selection);
    expect(again.bot(bot.id)?.activity).toBe("idle");
    expect(Boolean(again.bot(bot.id)?.busy)).toBe(false);
  });
});

describe("Store redacts bot-authored secrets on write", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("masks a key in bot text, tools and cards — but never in what the user typed", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const key = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `Your key is ${key}` });
    expect(reply.text).not.toContain(key);
    expect(reply.text).toContain("«redacted");
    const chip = store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: `Bash: export TOKEN=${key}`, ok: true } });
    expect(chip.tool?.name).not.toContain(key);
    const card = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "Run this?",
        subtitle: "",
        summary: `curl -H "Authorization: Bearer ${key}"`,
        held: `Blocked ${key}`,
        options: [],
        requestId: "r1",
        tool: "Bash",
      },
    });
    expect(card.card?.summary).not.toContain(key);
    expect(card.card?.held).not.toContain(key);
    const routineCard = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "Confirm routine",
        subtitle: "Every morning",
        options: ["Confirm", "Cancel"],
        requestId: "routine-request",
        tool: "schedule_routine",
        routineRequest: {
          version: 1,
          requestId: "routine-request",
          botId: bot.id,
          threadId: bot.threadId,
          createdAt: 1,
          operation: {
            action: "create",
            routine: {
              name: `Use ${key}`,
              instructions: `Send a request with ${key}`,
              schedule: { type: "daily", time: "09:00", weekdays: [1] },
              runOn: "local",
              durationMinutes: 30,
            },
          },
        },
      },
    });
    expect(routineCard.card?.routineRequest?.operation.action).toBe("create");
    if (routineCard.card?.routineRequest?.operation.action !== "create") throw new Error("missing routine payload");
    expect(routineCard.card.routineRequest.operation.routine.name).not.toContain(key);
    expect(routineCard.card.routineRequest.operation.routine.instructions).not.toContain(key);
    const runCard = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "routine.run",
      text: `Routine ${key} completed`,
      routineRun: {
        runId: "run-1",
        routineId: "routine-1",
        routineName: `Report ${key}`,
        status: "completed",
        executionThreadId: "execution-1",
        summary: `Finished with ${key}`,
        error: `Ignored ${key}`,
      },
    });
    expect(runCard.routineRun?.routineName).not.toContain(key);
    expect(runCard.routineRun?.summary).not.toContain(key);
    expect(runCard.routineRun?.error).not.toContain(key);
    const secretCard = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "secret",
      secret: {
        target: "xaiApiKey",
        label: "xAI API key",
        description: `The agent accidentally included ${key}`,
        placeholder: "xai-…",
        helpUrl: "https://console.x.ai/",
        requestKey: "credential-request",
      },
    });
    expect(secretCard.secret?.description).not.toContain(key);
    // the user's own words are theirs
    const mine = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `use ${key} for the api` });
    expect(mine.text).toContain(key);
    // and the stored copy is what was masked, not just the returned one
    const again = new Store(selection);
    expect(again.messagesFor(bot.threadId).find((m) => m.id === reply.id)?.text).not.toContain(key);
  });
});

describe("Store task usage", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("banks each turn's tokens and cost on the task, counting turns", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 100, output: 20, costUsd: 0.01 })).toEqual({
      input: 100,
      output: 20,
      costUsd: 0.01,
      turns: 1,
    });
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 50, output: 5, costUsd: 0.005 })).toEqual({
      input: 150,
      output: 25,
      costUsd: 0.015,
      turns: 2,
    });
    expect(store.taskByThread(bot.id, bot.threadId)?.usage).toEqual({ input: 150, output: 25, costUsd: 0.015, turns: 2 });
  });

  it("keeps cost null until some turn reports one, then sums only reported costs", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 1, costUsd: null })?.costUsd).toBeNull();
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 1, costUsd: 0.02 })?.costUsd).toBe(0.02);
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 1, costUsd: null })?.costUsd).toBe(0.02);
  });

  it("counts a turn that reported no tokens at all", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.addTaskUsage(bot.id, bot.threadId, { costUsd: null })).toEqual({ input: 0, output: 0, costUsd: null, turns: 1 });
  });

  it("ignores an unknown task", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.addTaskUsage(bot.id, "nope", { input: 1, output: 1, costUsd: null })).toBeNull();
  });
});

describe("Store task working folder", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("pins the bot's folder onto a task on its first turn, and never again", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { cwd: "/tmp/project-a" });

    // first turn: nothing pinned yet → takes the bot's folder
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBe("/tmp/project-a");
    expect(store.taskByThread(bot.id, bot.threadId)?.cwd).toBe("/tmp/project-a");

    // the bot's folder moves on; this task stays where its session started
    store.patchBot(bot.id, { cwd: "/tmp/project-b" });
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBe("/tmp/project-a");

    // a new task starts in the bot's current folder
    const next = store.createTask(bot.id, "second")!;
    expect(store.pinTaskCwd(bot.id, next.threadId)).toBe("/tmp/project-b");
  });

  it("pins the default (null) when the bot has no folder, so a later folder can't move a live session", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBeNull();
    store.patchBot(bot.id, { cwd: "/tmp/project-a" });
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBeNull();
    expect(store.taskByThread(bot.id, bot.threadId)?.cwd).toBeNull();
  });

  it("pins a supplied private workspace when the bot has no custom folder", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.pinTaskCwd(bot.id, bot.threadId, "/private/bot-workspace")).toBe("/private/bot-workspace");
    expect(store.taskByThread(bot.id, bot.threadId)?.cwd).toBe("/private/bot-workspace");
  });

  it("a legacy task that already has a session pins to the default, not the bot's new folder", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    // an older build ran turns here before folders existed
    store.setResumeCursor(bot.id, "claude", "sess-1", bot.threadId);
    store.patchBot(bot.id, { cwd: "/tmp/project-a" });
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBeNull();
  });
});

describe("Store room working folder", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("pins the room's folder on its first turn, and never again", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const group = store.createGroup("Team", [bot.id]);
    store.patchGroup(group.id, { cwd: "/tmp/project-a" });

    // first turn: nothing pinned yet → takes the room's folder
    expect(store.pinGroupCwd(group.id)).toBe("/tmp/project-a");
    expect(store.group(group.id)?.pinnedCwd).toBe("/tmp/project-a");

    // the room's folder moves on; the thread stays where it started working
    store.patchGroup(group.id, { cwd: "/tmp/project-b" });
    expect(store.pinGroupCwd(group.id)).toBe("/tmp/project-a");

    // the pin is durable — a restart must not re-pin from the new folder
    const reloaded = new Store(selection);
    expect(reloaded.pinGroupCwd(group.id)).toBe("/tmp/project-a");
  });

  it("pins the default (null) when the room has no folder, so a later folder can't move a running room", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const group = store.createGroup("Team", [bot.id]);
    expect(store.pinGroupCwd(group.id)).toBeNull();
    store.patchGroup(group.id, { cwd: "/tmp/project-a" });
    expect(store.pinGroupCwd(group.id)).toBeNull();
    expect(store.group(group.id)?.pinnedCwd).toBeNull();
  });
});

describe("Store task working folder — cloud runs", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });
  it("a cloud run pins the default so the bot's host folder never shows for that task", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { cwd: "/tmp/project-a" });
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBe("/tmp/project-a");
    expect(store.pinTaskCwd(bot.id, bot.threadId, undefined, { none: true })).toBeNull();
    expect(store.taskByThread(bot.id, bot.threadId)?.cwd).toBeNull();
    // and it stays pinned even if a host run follows
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBeNull();
  });
});
