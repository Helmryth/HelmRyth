import { describe, expect, it, vi } from "vitest";

import {
  api,
  configStatusFromFrame,
  erasureNotice,
  initialState,
  loadSnapshotBoundary,
  openNotificationTarget,
  reducer,
  visibleNotificationThread,
  type Bot,
  type Group,
  crewJoinRequests,
  interruptRequest,
  type Message,
} from "./store";
import { openLiveEvents, type LiveEventSourceLike, type LiveEventsPlatform } from "../lib/live-events";

type SnapshotFrame =
  | { kind: "hello"; resumed: boolean; cursor: string }
  | { kind: "message"; threadId: string; message: { id: string } };

class SnapshotEventSource implements LiveEventSourceLike {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {}

  message(frame: SnapshotFrame, lastEventId = "") {
    this.onmessage?.({ data: JSON.stringify(frame), lastEventId });
  }
}

describe("replacement snapshot boundary", () => {
  it("flushes bot frames without reconnecting when a peripheral snapshot fails", async () => {
    const sources: SnapshotEventSource[] = [];
    const applied: unknown[] = [];
    const pending: unknown[] = [];
    const scheduleRetry = vi.fn();
    let hydrated = false;
    const platform: LiveEventsPlatform = {
      createEventSource: (url) => {
        const source = new SnapshotEventSource(url);
        sources.push(source);
        return source;
      },
      isOnline: () => true,
      isVisible: () => true,
      now: Date.now,
    };
    const stop = openLiveEvents(
      {
        onSnapshotRequired: async () => {
          const chatReady = await loadSnapshotBoundary(
            async () => {},
            [{ key: "webhooks", load: async () => Promise.reject(new Error("webhooks unavailable")) }],
            (part, error) => scheduleRetry(part.key, error),
          );
          if (chatReady) {
            hydrated = true;
            applied.push(...pending.splice(0));
          }
          return chatReady;
        },
        onFrame: (frame) => {
          if (hydrated) applied.push(frame);
          else pending.push(frame);
        },
        retryMinMs: 1,
        retryMaxMs: 1,
      },
      platform,
    );

    sources[0]!.message({ kind: "hello", resumed: false, cursor: "stream00:4" });
    sources[0]!.message(
      { kind: "message", threadId: "bot-thread", message: { id: "user-1" } },
      "stream00:5",
    );
    await vi.waitFor(() => expect(applied).toHaveLength(1));

    expect(applied).toEqual([
      { kind: "message", threadId: "bot-thread", message: { id: "user-1" } },
    ]);
    expect(scheduleRetry).toHaveBeenCalledWith("webhooks", expect.any(Error));
    expect(sources).toHaveLength(1);
    expect(sources[0]!.close).not.toHaveBeenCalled();
    stop();
  });
});

describe("notification routing", () => {
  const bots = [{ id: "bot-1", threadId: "main-thread", tasks: [{ threadId: "detached-thread" }] }];
  const groups = [{
    id: "room-1",
    threadId: "room-thread",
    tasks: [
      { threadId: "room-thread", title: "Current", createdAt: 1 },
      { threadId: "older-room-thread", title: "Older", createdAt: 0 },
    ],
  }];

  it("selects the bot and switches to the notification's exact task", () => {
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "detached-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "bot-1" },
      { type: "switchTask", botId: "bot-1", threadId: "detached-thread" },
    ]);
  });

  it("opens the room when the thread is a group's — never a bot task switch that would 404", () => {
    // room approval/question notifications carry the asker bot with the
    // GROUP's thread id; the exact destination is the room itself
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "room-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "room-1" }]);
  });

  it("opens the room and restores the exact inactive channel task", () => {
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "older-room-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "room-1" },
      { type: "switchGroupTask", groupId: "room-1", threadId: "older-room-thread" },
    ]);
  });

  it("lands on a plain bot select for a thread it cannot place, not an error", () => {
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "deleted-task-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "bot-1" }]);
  });

  it("identifies only the exact chat thread currently on screen", () => {
    expect(visibleNotificationThread({
      activeView: "chat",
      selectedId: "bot-1",
      bots,
      groups,
    })).toBe("main-thread");
    expect(visibleNotificationThread({
      activeView: "chat",
      selectedId: "room-1",
      bots,
      groups,
    })).toBe("room-thread");
    expect(visibleNotificationThread({
      activeView: "routines",
      selectedId: "bot-1",
      bots,
      groups,
    })).toBeNull();
  });
});

describe("System overlay panel lifecycle", () => {
  it("keeps an open Workbench mounted beneath System and restores it when System closes", () => {
    const workbenchOpen = { ...initialState, computerOpen: true };

    const systemOpen = reducer(workbenchOpen, { type: "toggleAppSettings", open: true });
    expect(systemOpen.appSettingsOpen).toBe(true);
    expect(systemOpen.computerOpen).toBe(true);

    const systemClosed = reducer(systemOpen, { type: "toggleAppSettings", open: false });
    expect(systemClosed.appSettingsOpen).toBe(false);
    expect(systemClosed.computerOpen).toBe(true);
  });

  it("does not resurrect a Workbench that was explicitly closed", () => {
    const workbenchOpen = { ...initialState, computerOpen: true };
    const systemOpen = reducer(workbenchOpen, { type: "toggleAppSettings", open: true });
    const panelClosed = reducer(systemOpen, { type: "toggleComputer", open: false });

    const systemClosed = reducer(panelClosed, { type: "toggleAppSettings", open: false });
    expect(systemClosed.appSettingsOpen).toBe(false);
    expect(systemClosed.computerOpen).toBe(false);
  });
});

describe("config status frames", () => {
  it("keeps the room turn timeout with the existing config fields", () => {
    expect(
      configStatusFromFrame({
        xai: { configured: true },
        openaiCompat: {
          configured: true,
          url: "https://models.example.test/v1",
          model: "vendor/model",
          provider: "vendor",
        },
        managedServices: {
          source: "packaged",
          state: "ready",
          registry: { configured: true, origin: "https://registry.example.test" },
          conduit: { configured: true, origin: "https://conduit.example.test" },
        },
        composio: { configured: true, mode: "managed" },
        box: { configured: false },
        vps: { configured: true, sshAlias: "homelab" },
        rooms: { turnTimeoutMinutes: 20 },
        localVm: { mode: "per-bot", maxInstances: 3 },
        opencodeGo: { configured: true },
        tts: { configured: true, ready: true, voice: "Ada" },
        profile: { name: "Ian", email: "ian@example.test" },
        features: { skillRecorder: true },
      }),
    ).toEqual({
      xai: { configured: true },
      openaiCompat: {
        configured: true,
        url: "https://models.example.test/v1",
        model: "vendor/model",
        provider: "vendor",
      },
      managedServices: {
        source: "packaged",
        state: "ready",
        registry: { configured: true, origin: "https://registry.example.test" },
        conduit: { configured: true, origin: "https://conduit.example.test" },
      },
      composio: { configured: true, mode: "managed" },
      box: { configured: false },
      vps: { configured: true, sshAlias: "homelab" },
      rooms: { turnTimeoutMinutes: 20 },
      localVm: { mode: "per-bot", maxInstances: 3 },
      opencodeGo: { configured: true },
      tts: { configured: true, ready: true, voice: "Ada" },
      profile: { name: "Ian", email: "ian@example.test" },
      features: { skillRecorder: true },
    });
  });
});

describe("erasure notices", () => {
  it("deduplicates repeated summaries across multi-thread erasures", () => {
    expect(erasureNotice({
      erasures: [
        { state: "complete", summary: "Checkpoint history was retained." },
        { state: "complete", summary: "Checkpoint history was retained." },
      ],
    })).toEqual({ level: "info", message: "Checkpoint history was retained." });
  });

  it("elevates pending cleanup to a warning notice", () => {
    expect(erasureNotice({
      erasure: {
        state: "pending",
        summary: "The workstream was deleted, but some private-data cleanup is pending and will retry after restart.",
      },
    })).toEqual({
      level: "warning",
      message: "The workstream was deleted, but some private-data cleanup is pending and will retry after restart.",
    });
  });

  it("includes the bot workspace cleanup report returned by operator deletion", () => {
    expect(erasureNotice({
      erasures: [{ state: "complete", summary: "The operator transcript was erased." }],
      workspaceErasure: {
        state: "pending",
        summary: "The operator was deleted, but private workspace cleanup is pending and will retry after restart.",
      },
    })).toEqual({
      level: "warning",
      message: "The operator transcript was erased. The operator was deleted, but private workspace cleanup is pending and will retry after restart.",
    });
  });
});

describe("task rename", () => {
  it("updates the task title in local state immediately", () => {
    const bot = {
      id: "echo",
      threadId: "t1",
      name: "Echo",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "x", model: "y" },
      messages: [],
      tasks: [
        { threadId: "t1", title: "Untitled run", createdAt: 1 },
        { threadId: "t2", title: "Other", createdAt: 2 },
      ],
    } satisfies Bot;
    const next = reducer(
      { ...initialState, bots: [bot] },
      { type: "renameTask", botId: bot.id, threadId: "t1", title: "Renamed" },
    );
    expect(next.bots[0]?.tasks?.find((task) => task.threadId === "t1")?.title).toBe("Renamed");
    expect(next.bots[0]?.tasks?.find((task) => task.threadId === "t2")?.title).toBe("Other");
  });

  it("updates a channel task title in local state immediately", () => {
    const group = {
      id: "room",
      threadId: "room-task-1",
      name: "Launch",
      memberIds: [],
      defaultResponder: { kind: "everyone" },
      bulletin: "",
      unread: false,
      createdAt: 1,
      messages: [],
      tasks: [
        { threadId: "room-task-1", title: "Untitled run", createdAt: 1 },
        { threadId: "room-task-2", title: "Other", createdAt: 2 },
      ],
    } satisfies Group;
    const next = reducer(
      { ...initialState, groups: [group] },
      { type: "renameGroupTask", groupId: group.id, threadId: "room-task-1", title: "Renamed" },
    );
    expect(next.groups[0]?.tasks?.find((task) => task.threadId === "room-task-1")?.title).toBe("Renamed");
    expect(next.groups[0]?.tasks?.find((task) => task.threadId === "room-task-2")?.title).toBe("Other");
  });
});

describe("Teach a skill feature flag", () => {
  const config = configStatusFromFrame({
    composio: { configured: false },
    box: { configured: false },
    vps: { configured: false, sshAlias: "" },
    rooms: { turnTimeoutMinutes: 5 },
    localVm: { mode: "shared", maxInstances: 2 },
    features: { skillRecorder: true },
  });

  it("does not open the recorder while the experiment is disabled", () => {
    expect(reducer(initialState, { type: "showSkillRecorder" }).activeView).toBe("chat");
  });

  it("opens after opt-in and returns to chat when disabled", () => {
    const enabled = reducer({ ...initialState, config }, { type: "showSkillRecorder" });
    expect(enabled.activeView).toBe("skill-recorder");

    const disabled = reducer(enabled, {
      type: "configStatus",
      config: { ...config, features: { skillRecorder: false } },
    });
    expect(disabled.activeView).toBe("chat");
  });
});

describe("onboarding quiz", () => {
  const quizCard = {
    title: "What do you mostly want help with?",
    subtitle: "Pick whatever's closest; we can always expand from there.",
    options: ["Work & projects"],
  };
  const bot = {
    id: "echo",
    threadId: "t1",
    name: "Echo",
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "x", model: "y" },
    messages: [
      { id: "g", role: "bot", kind: "text", text: "Hey", at: 1 },
      { id: "q", role: "bot", kind: "options", card: quizCard, at: 2 },
    ],
    activeLeafId: "q",
  } satisfies Bot;

  it("hides the quiz as soon as the person sends a message", () => {
    const state = { ...initialState, bots: [bot], selectedId: bot.id };
    const next = reducer(state, { type: "send", botId: bot.id, text: "Hi bro" });
    expect(next.bots[0]?.messages.find((message) => message.id === "q")?.card?.dismissed).toBe(true);
  });

  it("hides the quiz when they pick an option", () => {
    const state = { ...initialState, bots: [bot], selectedId: bot.id };
    const next = reducer(state, { type: "answerCard", botId: bot.id, messageId: "q", answer: "Work & projects" });
    expect(next.bots[0]?.messages.find((message) => message.id === "q")?.card).toMatchObject({
      answered: "Work & projects",
      dismissed: true,
    });
  });

  it("leaves a live permission card in place", () => {
    const askBot: Bot = {
      ...bot,
      messages: [
        ...bot.messages,
        {
          id: "ask",
          role: "bot",
          kind: "options",
          card: {
            title: "Approval needed",
            subtitle: "rm",
            options: ["Allow", "Deny"],
            requestId: "r1",
            tool: "Bash",
          },
          at: 3,
        },
      ],
      activeLeafId: "ask",
    };
    const state = { ...initialState, bots: [askBot], selectedId: askBot.id };
    const next = reducer(state, { type: "send", botId: askBot.id, text: "ok" });
    expect(next.bots[0]?.messages.find((message) => message.id === "ask")?.card?.dismissed).toBeUndefined();
    expect(next.bots[0]?.messages.find((message) => message.id === "q")?.card?.dismissed).toBe(true);
  });

  it("restores a failed first opening brief only on its owning run", () => {
    const hidden = reducer(
      { ...initialState, bots: [bot], selectedId: bot.id },
      { type: "answerCard", botId: bot.id, messageId: "q", answer: "Work & projects" },
    );
    const restored = reducer(hidden, {
      type: "restoreOpeningCard",
      botId: bot.id,
      threadId: bot.threadId,
      message: bot.messages[1]!,
    });

    expect(restored.bots[0]?.messages.find((message) => message.id === "q")?.card)
      .toEqual(quizCard);
    expect(reducer(hidden, {
      type: "restoreOpeningCard",
      botId: bot.id,
      threadId: "another-run",
      message: bot.messages[1]!,
    })).toBe(hidden);
  });
});

describe("authoritative optimistic rollback", () => {
  const message = {
    id: "marked",
    role: "bot",
    kind: "text",
    text: "Evidence",
    at: 1,
    reactions: [
      { emoji: "👍", by: "peer" },
      { emoji: "❤️", by: "user" },
    ],
  } satisfies Message;
  const bot = {
    id: "rollback-bot",
    threadId: "rollback-thread",
    name: "Rivet",
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "fake", model: "fake" },
    messages: [message],
    activeLeafId: message.id,
  } satisfies Bot;
  const group = {
    id: "rollback-group",
    threadId: "group-thread",
    name: "Forge",
    memberIds: [bot.id],
    defaultResponder: { kind: "member", botId: bot.id },
    bulletin: "Original",
    unread: false,
    createdAt: 1,
    messages: [],
  } satisfies Group;

  it("rolls back only the current user's failed mark and preserves peer marks", () => {
    const optimistic = reducer(
      { ...initialState, bots: [bot] },
      { type: "toggleReaction", threadId: bot.threadId, messageId: message.id, emoji: "👍" },
    );
    const withLatePeer = reducer(optimistic, {
      type: "messagePatched",
      threadId: bot.threadId,
      message: {
        ...optimistic.bots[0]!.messages[0]!,
        reactions: [...(optimistic.bots[0]!.messages[0]!.reactions ?? []), { emoji: "🎉", by: "late-peer" }],
      },
    });
    const rolledBack = reducer(withLatePeer, {
      type: "reactionRollback",
      threadId: bot.threadId,
      messageId: message.id,
      emoji: "👍",
      selected: false,
    });

    expect(rolledBack.bots[0]?.messages[0]?.reactions).toEqual([
      { emoji: "👍", by: "peer" },
      { emoji: "❤️", by: "user" },
      { emoji: "🎉", by: "late-peer" },
    ]);
  });

  it("reconciles a rejected branch and only the patched crew fields", () => {
    const optimisticBranch = reducer(
      { ...initialState, bots: [bot], groups: [group] },
      { type: "switchBranch", botId: bot.id, messageId: message.id },
    );
    const branch = reducer(optimisticBranch, {
      type: "branchReconciled",
      botId: bot.id,
      activeLeafId: null,
    });
    expect(branch.bots[0]?.activeLeafId).toBeNull();

    const optimisticGroup = reducer(branch, {
      type: "patchGroup",
      groupId: group.id,
      patch: { bulletin: "Optimistic" },
    });
    const renamedByPeer = reducer(optimisticGroup, {
      type: "groupPatched",
      group: { id: group.id, name: "Peer rename" },
    });
    const rolledBack = reducer(renamedByPeer, {
      type: "groupPatchRollback",
      groupId: group.id,
      patch: { bulletin: "Original" },
    });
    expect(rolledBack.groups[0]).toMatchObject({ name: "Peer rename", bulletin: "Original" });
  });

  it("serializes exact-thread interrupt requests", () => {
    expect(interruptRequest({
      type: "interrupt",
      botId: "operator-1",
      threadId: "run-1",
    })).toMatchObject({
      path: "/api/bots/operator-1/interrupt",
      init: { method: "POST", body: JSON.stringify({ threadId: "run-1" }) },
    });
    expect(interruptRequest({
      type: "interruptGroup",
      groupId: "crew-1",
      threadId: "crew-run-1",
    })).toMatchObject({
      path: "/api/groups/crew-1/interrupt",
      init: { method: "POST", body: JSON.stringify({ threadId: "crew-run-1" }) },
    });
  });
});

describe("duplicating an operator", () => {
  const crew = (id: string, memberIds: string[], dm = false): Group => ({
    id,
    threadId: `${id}-thread`,
    name: id,
    memberIds,
    defaultResponder: { kind: "everyone" },
    bulletin: "",
    unread: false,
    createdAt: 1,
    dm,
    messages: [],
  });

  it("joins the copy to every crew its source belongs to", () => {
    const requests = crewJoinRequests(
      [crew("forge", ["source", "other"]), crew("anvil", ["source"]), crew("kiln", ["other"])],
      "source",
      "copy",
    );
    expect(requests).toEqual([
      {
        path: "/api/groups/forge",
        init: { method: "PATCH", body: JSON.stringify({ memberIds: ["source", "other", "copy"] }) },
      },
      {
        path: "/api/groups/anvil",
        init: { method: "PATCH", body: JSON.stringify({ memberIds: ["source", "copy"] }) },
      },
    ]);
  });

  it("leaves DM channels and already-joined rooms alone", () => {
    expect(
      crewJoinRequests(
        [crew("dm", ["source", "other"], true), crew("forge", ["source", "copy"])],
        "source",
        "copy",
      ),
    ).toEqual([]);
  });
});

describe("cross-client bot creation", () => {
  it("adds an announced bot before its greeting frames arrive", () => {
    const announced = {
      id: "phone-bot",
      threadId: "phone-thread",
      name: "Scout",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "codex", model: "default" },
    } satisfies Omit<Bot, "messages">;

    const added = reducer(initialState, { type: "botPatched", bot: announced });

    expect(added.bots).toEqual([{ ...announced, messages: [] }]);

    const greeting = {
      id: "greeting",
      role: "bot",
      kind: "text",
      text: "Hey — I'm Scout. Nice to meet you.",
      at: 2,
    } satisfies Message;
    const greeted = reducer(added, {
      type: "messageAdded",
      threadId: announced.threadId,
      message: greeting,
    });

    expect(greeted.bots[0]?.messages).toEqual([greeting]);
  });
});

describe("canonical message races", () => {
  it("does not rewind the active branch when POST repeats a user message after the reply", () => {
    const sent = {
      id: "sent",
      role: "user",
      kind: "text",
      text: "Ship it",
      at: 1,
      parentId: null,
    } satisfies Message;
    const reply = {
      id: "reply",
      role: "bot",
      kind: "text",
      text: "Done",
      at: 2,
      parentId: sent.id,
    } satisfies Message;
    const bot = {
      id: "race-bot",
      threadId: "race-thread",
      name: "Race",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "codex", model: "default" },
      messages: [sent, reply],
      activeLeafId: reply.id,
    } satisfies Bot;
    const state = { ...initialState, bots: [bot] };

    const next = reducer(state, {
      type: "messageAdded",
      threadId: bot.threadId,
      message: sent,
    });

    expect(next).toBe(state);
    expect(next.bots[0]?.activeLeafId).toBe(reply.id);
    expect(next.bots[0]?.messages).toEqual([sent, reply]);
  });
});

describe("section Chiefs", () => {
  const bot = (id: string, section: string, chiefOfStaff = false) => ({
    id,
    threadId: `thread-${id}`,
    name: id,
    title: "",
    description: "",
    notifications: true,
    color: "green" as const,
    unread: false,
    modelSelection: { instanceId: "codex", model: "default" },
    section,
    chiefOfStaff,
  });

  it("hands off only within the patched bot's section", () => {
    const workChief = bot("work-a", "Work", true);
    const workCandidate = bot("work-b", "Work");
    const personalChief = bot("personal", "Personal", true);
    const state = {
      ...initialState,
      bots: [workChief, workCandidate, personalChief].map((candidate) => ({ ...candidate, messages: [] })),
    };

    const next = reducer(state, {
      type: "botPatched",
      bot: { ...workCandidate, chiefOfStaff: true },
    });

    expect(next.bots.find((candidate) => candidate.id === workChief.id)?.chiefOfStaff).toBe(false);
    expect(next.bots.find((candidate) => candidate.id === workCandidate.id)?.chiefOfStaff).toBe(true);
    expect(next.bots.find((candidate) => candidate.id === personalChief.id)?.chiefOfStaff).toBe(true);
  });

  it("keeps other section Chiefs during an optimistic settings update", () => {
    const workChief = bot("work-a", "Work", true);
    const workCandidate = bot("work-b", "Work");
    const personalChief = bot("personal", "Personal", true);
    const state = {
      ...initialState,
      bots: [workChief, workCandidate, personalChief].map((candidate) => ({ ...candidate, messages: [] })),
    };

    const next = reducer(state, {
      type: "updateBot",
      botId: workCandidate.id,
      patch: { chiefOfStaff: true },
    });

    expect(next.bots.find((candidate) => candidate.id === workChief.id)?.chiefOfStaff).toBe(false);
    expect(next.bots.find((candidate) => candidate.id === workCandidate.id)?.chiefOfStaff).toBe(true);
    expect(next.bots.find((candidate) => candidate.id === personalChief.id)?.chiefOfStaff).toBe(true);
  });
});

describe("pending queued chip", () => {
  const bot = {
    id: "b1",
    threadId: "t1",
    name: "Ada",
    title: "",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "acp", model: "fake" },
  } satisfies Omit<Bot, "messages">;

  it("records queue-fallback text and drops it when that user line lands", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q1",
      text: "later",
    });
    expect(queued.pendingQueued).toEqual({ t1: [{ queueId: "q1", text: "later" }] });
    const landed = reducer(queued, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q1",
    });
    expect(landed.pendingQueued).toEqual({});
  });

  it("keeps a Shift+Enter multiline message as one entry", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-ml",
      text: "line one\nline two",
    });
    expect(queued.pendingQueued).toEqual({ t1: [{ queueId: "q-ml", text: "line one\nline two" }] });
    const landed = reducer(queued, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q-ml",
    });
    expect(landed.pendingQueued).toEqual({});
  });

  it("leaves the chip on the old thread after a task switch", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-stay",
      text: "stay here",
    });
    const switched = reducer(queued, {
      type: "botPatched",
      bot: { ...bot, threadId: "t2", messages: [] },
    });
    expect(switched.pendingQueued).toEqual({ t1: [{ queueId: "q-stay", text: "stay here" }] });
    expect(switched.pendingQueued[switched.bots[0]!.threadId]).toBeUndefined();
    const drained = reducer(switched, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q-stay",
    });
    expect(drained.pendingQueued).toEqual({});
  });

  it("consumes only the matching queue id when two pending lines share text", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const first = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "qa",
      text: "same",
    });
    const both = reducer(first, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "qb",
      text: "same",
    });
    expect(both.pendingQueued).toEqual({
      t1: [
        { queueId: "qa", text: "same" },
        { queueId: "qb", text: "same" },
      ],
    });
    const afterOther = reducer(both, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "qa",
    });
    expect(afterOther.pendingQueued).toEqual({ t1: [{ queueId: "qb", text: "same" }] });
  });

  it("does not add a chip when the drain frame arrives before the POST continuation", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const drained = reducer(withBot, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q1",
    });
    expect(drained.pendingQueued).toEqual({});
    const late = reducer(drained, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q1",
      text: "later",
    });
    expect(late.pendingQueued).toEqual({});
    expect(late.consumedQueueIds).toEqual({});
  });

  it("reconciles a missed drain from hydration and rejects its late POST continuation", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-snapshot",
      text: "already ran",
    });
    const canonical = {
      id: "m-snapshot",
      at: 100,
      role: "user",
      kind: "text",
      text: "already ran",
      queueId: "q-snapshot",
    } satisfies Message;
    const hydrated = reducer(queued, {
      type: "hydrate",
      bots: [{ ...bot, messages: [canonical] }],
      groups: [],
      computerControl: {},
    });

    expect(hydrated.pendingQueued).toEqual({});
    expect(hydrated.consumedQueueIds["q-snapshot"]).toBe(true);
    const late = reducer(hydrated, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-snapshot",
      text: "already ran",
    });
    expect(late.pendingQueued).toEqual({});
    expect(late.consumedQueueIds["q-snapshot"]).toBeUndefined();
  });

  it("bounds unmatched queue tombstones from other clients", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    let state = withBot;
    for (let index = 0; index < 100; index += 1) {
      state = reducer(state, {
        type: "consumePendingQueued",
        threadId: "t1",
        queueId: `foreign-${index}`,
      });
    }

    expect(Object.keys(state.consumedQueueIds)).toHaveLength(64);
    expect(state.consumedQueueIds["foreign-0"]).toBeUndefined();
    expect(state.consumedQueueIds["foreign-99"]).toBe(true);

    const late = reducer(state, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "foreign-99",
      text: "already drained",
    });
    expect(late.pendingQueued).toEqual({});
    expect(late.consumedQueueIds["foreign-99"]).toBeUndefined();
  });

  it("drops a cancelled pending chip without waiting for drain", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-drop",
      text: "never mind",
    });
    const cancelled = reducer(queued, {
      type: "cancelQueued",
      botId: "b1",
      queueId: "q-drop",
    });
    expect(cancelled.pendingQueued).toEqual({});
  });
});

describe("api() header defaults", () => {
  const call = async (init?: RequestInit) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await api("/api/teams/import", init);
    } finally {
      vi.unstubAllGlobals();
    }
    // SAFETY: api() always calls fetch with an init object, so call 0 arg 1 is one.
    return new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
  };

  it("keeps the JSON content-type when the caller adds a header of its own", async () => {
    // A caller passing `headers` used to replace the whole set, so fetch labelled
    // the string body text/plain and every mutating core route answered 415.
    const headers = await call({
      method: "POST",
      headers: { "idempotency-key": "abc" },
      body: JSON.stringify({ format: "helmryth.crew" }),
    });
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBe("abc");
  });

  it("lets a caller choose a different content-type", async () => {
    const headers = await call({ method: "POST", headers: { "content-type": "text/markdown" } });
    expect(headers.get("content-type")).toBe("text/markdown");
  });

  it("defaults the content-type when the caller passes no headers", async () => {
    expect((await call()).get("content-type")).toBe("application/json");
  });
});

describe("api() failure copy", () => {
  const failWith = async (status: number, statusText: string, body: { error?: string }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status, statusText, json: async () => body,
    }));
    try {
      return await api("/api/routines", { method: "POST" }).then(() => null, (e: Error) => e.message);
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it("always prefers the message the core wrote", async () => {
    expect(await failWith(409, "Conflict", { error: "That crew is mid-turn." })).toBe("That crew is mid-turn.");
  });

  it("never shows a raw HTTP status line when the service is unreachable", async () => {
    // A dead or still-starting core answers with no JSON body at all, and the
    // cadence editor used to render the bare string "502 Bad Gateway".
    for (const status of [502, 503, 504]) {
      const message = await failWith(status, "Bad Gateway", {});
      expect(message).toContain("can’t reach its local service");
      expect(message).not.toMatch(/\d{3}|Gateway/);
    }
  });

  it("explains the other bodyless failures in plain words", async () => {
    expect(await failWith(500, "Internal Server Error", {})).toContain("unexpected error");
    expect(await failWith(404, "Not Found", {})).toContain("no longer exists");
    expect(await failWith(429, "Too Many Requests", {})).toContain("Wait a moment");
  });
});
