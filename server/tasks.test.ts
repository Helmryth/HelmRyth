// Tasks: a bot's separate contexts.
//
// The load-bearing property is isolation — each task keeps its own
// transcript AND its own provider session. If resume cursors leaked
// between tasks, a "fresh" task would silently resume the previous
// conversation, which is the exact thing tasks exist to prevent.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let home: string;

async function freshStore() {
  home = mkdtempSync(join(tmpdir(), "hry-tasks-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const { Store, UNTITLED_TASK, titleFromMessage } = await import("./store.ts");
  return { store: new Store(() => ({ instanceId: "claude", model: "m" })), UNTITLED_TASK, titleFromMessage };
}

afterEach(async () => {
  // freshStore resets the module graph, so this closes the same SQLite
  // module instance that the freshly imported Store used.
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("tasks", () => {
  it("gives every new bot one task pointing at its thread", async () => {
    const { store, UNTITLED_TASK } = await freshStore();
    const bot = store.createBot();
    expect(store.tasks(bot.id)).toHaveLength(1);
    expect(store.activeTask(bot.id)).toMatchObject({ threadId: bot.threadId, title: UNTITLED_TASK });
    expect(UNTITLED_TASK).toBe("Untitled run");
  });

  it("uses the run vocabulary for bot and channel defaults across restarts", async () => {
    const { store, UNTITLED_TASK } = await freshStore();
    const bot = store.createBot();
    const group = store.createGroup("Launch", [bot.id]);

    expect(store.activeTask(bot.id)?.title).toBe(UNTITLED_TASK);
    expect(store.activeGroupTask(group.id)?.title).toBe(UNTITLED_TASK);
    expect(store.renameTask(bot.id, bot.threadId, "   ")?.title).toBe(UNTITLED_TASK);
    expect(store.renameGroupTask(group.id, group.threadId, "   ")?.title).toBe(UNTITLED_TASK);

    const { Store } = await import("./store.ts");
    const reloaded = new Store(() => ({ instanceId: "claude", model: "m" }));
    expect(reloaded.activeTask(bot.id)?.title).toBe(UNTITLED_TASK);
    expect(reloaded.activeGroupTask(group.id)?.title).toBe(UNTITLED_TASK);
  });

  it("migrates persisted legacy default titles and keeps first-message naming live", async () => {
    const { store, UNTITLED_TASK } = await freshStore();
    const bot = store.createBot();
    const group = store.createGroup("Launch", [bot.id]);
    const { DATA_DIR } = await import("./config.ts");
    const botsFile = join(DATA_DIR, "bots.json");
    const groupsFile = join(DATA_DIR, "groups.json");
    const bots = JSON.parse(readFileSync(botsFile, "utf8"));
    const groups = JSON.parse(readFileSync(groupsFile, "utf8"));
    bots[0].tasks[0].title = "New task";
    groups[0].tasks[0].title = "New task";
    writeFileSync(botsFile, JSON.stringify(bots));
    writeFileSync(groupsFile, JSON.stringify(groups));

    const { Store } = await import("./store.ts");
    const reloaded = new Store(() => ({ instanceId: "claude", model: "m" }));
    expect(reloaded.activeTask(bot.id)?.title).toBe(UNTITLED_TASK);
    expect(reloaded.activeGroupTask(group.id)?.title).toBe(UNTITLED_TASK);
    expect(readFileSync(botsFile, "utf8")).not.toContain("New task");
    expect(readFileSync(groupsFile, "utf8")).not.toContain("New task");

    reloaded.titleTaskFromFirstMessage(bot.id, "Audit the launch ledger");
    reloaded.titleGroupTaskFromFirstMessage(group.id, "Coordinate the release fleet");
    expect(reloaded.activeTask(bot.id)?.title).toBe("Audit the launch ledger");
    expect(reloaded.activeGroupTask(group.id)?.title).toBe("Coordinate the release fleet");
  });

  it("starts a new task on a fresh thread and makes it active", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const firstThread = bot.threadId;
    const task = store.createTask(bot.id)!;

    expect(task.threadId).not.toBe(firstThread);
    expect(store.bot(bot.id)!.threadId).toBe(task.threadId);
    expect(store.tasks(bot.id).map((t) => t.threadId)).toEqual([task.threadId, firstThread]);
    // a brand new context: nothing carried over from the greeting thread
    expect(store.messagesFor(task.threadId)).toHaveLength(0);
    expect(store.messagesFor(firstThread).length).toBeGreaterThan(0);
  });

  it("can create a detached routine task without changing the visible conversation", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const visibleThread = bot.threadId;
    const routineTask = store.createTask(bot.id, "Morning brief", false)!;

    expect(routineTask.threadId).not.toBe(visibleThread);
    expect(store.bot(bot.id)!.threadId).toBe(visibleThread);
    expect(store.botByThread(routineTask.threadId)?.id).toBe(bot.id);

    store.setResumeCursor(bot.id, "claude", "routine-session", routineTask.threadId);
    expect(store.taskByThread(bot.id, routineTask.threadId)?.resumeCursors.claude).toBe("routine-session");
    expect(store.activeTask(bot.id)?.resumeCursors.claude).toBeUndefined();
  });

  it("keeps provider sessions apart — the whole point of a task", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const first = bot.threadId;
    store.setResumeCursor(bot.id, "claude", "session-one");

    const second = store.createTask(bot.id)!;
    // the new task must NOT inherit the old session
    expect(store.activeTask(bot.id)!.resumeCursors.claude).toBeUndefined();
    store.setResumeCursor(bot.id, "claude", "session-two");

    store.switchTask(bot.id, first);
    expect(store.activeTask(bot.id)!.resumeCursors.claude).toBe("session-one");
    store.switchTask(bot.id, second.threadId);
    expect(store.activeTask(bot.id)!.resumeCursors.claude).toBe("session-two");
  });

  it("names a task after the first thing you asked it", async () => {
    const { store, UNTITLED_TASK, titleFromMessage } = await freshStore();
    const bot = store.createBot();
    store.createTask(bot.id);
    expect(store.activeTask(bot.id)!.title).toBe(UNTITLED_TASK);

    store.titleTaskFromFirstMessage(bot.id, "Audit the payroll spreadsheet\nand flag anything odd");
    expect(store.activeTask(bot.id)!.title).toBe("Audit the payroll spreadsheet");

    // only the first message names it
    store.titleTaskFromFirstMessage(bot.id, "something else entirely");
    expect(store.activeTask(bot.id)!.title).toBe("Audit the payroll spreadsheet");
    expect(titleFromMessage("x".repeat(80))).toHaveLength(48);
  });

  it("deletes a task with its transcript, but never the last one", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const first = bot.threadId;
    const second = store.createTask(bot.id)!;
    store.appendMessage(second.threadId, { role: "user", kind: "text", text: "secret" });

    expect(store.deleteTask(bot.id, second.threadId)).toBeTruthy();
    expect(store.tasks(bot.id)).toHaveLength(1);
    // deleting the ACTIVE task falls back to one that still exists
    expect(store.bot(bot.id)!.threadId).toBe(first);
    expect(store.messagesFor(second.threadId)).toHaveLength(0);

    expect(store.deleteTask(bot.id, first)).toBeNull();
    expect(store.tasks(bot.id)).toHaveLength(1);
  });

  it("adopts a pre-tasks bot's endless thread as its first task", async () => {
    const { store, UNTITLED_TASK } = await freshStore();
    const bot = store.createBot();
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Plan the offsite" });
    // simulate a record saved before tasks existed
    const legacy = store.bot(bot.id)!;
    delete legacy.tasks;
    // patchBot persists, so what lands on disk is the pre-tasks shape
    store.patchBot(bot.id, { resumeCursors: { claude: "old-session" } });

    const { Store } = await import("./store.ts");
    const reloaded = new Store(() => ({ instanceId: "claude", model: "m" }));
    const migrated = reloaded.tasks(bot.id);
    expect(migrated).toHaveLength(1);
    expect(migrated[0]).toMatchObject({ threadId: bot.threadId, resumeCursors: { claude: "old-session" } });
    // and it is named from the conversation rather than left blank
    expect(migrated[0]!.title).not.toBe(UNTITLED_TASK);
  });
});
