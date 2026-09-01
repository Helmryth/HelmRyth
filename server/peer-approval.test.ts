// The approval card's LIFECYCLE, as opposed to its verdict. A card that is
// raised but never settled keeps matching the client's "unanswered" filter,
// and the composer stays disabled behind it — so a gate that works
// perfectly can still make a thread unusable. These tests pin the settle.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import {
  cancelPeerApprovalsFor,
  cancelPeerApprovalsForThread,
  dismissStalePeerCards,
  peerAllowKey,
  requestPeerApproval,
  resolvePeerComms,
  type ApprovalBus,
} from "./peer-approval.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

function pendingCard(store: Store, bot: BotRecord) {
  return store
    .messagesFor(bot.threadId)
    .find((m) => m.kind === "options" && m.card?.requestId && !m.card.answered && !m.card.dismissed);
}

describe("peer approval card lifecycle", () => {
  let store: Store;
  let bus: ApprovalBus;
  let from: BotRecord;
  let target: BotRecord;

  beforeEach(() => {
    store = new Store(selection);
    from = store.patchBot(store.createBot().id, { name: "Asker", approvePeerComms: true })!;
    target = store.patchBot(store.createBot().id, { name: "Helper" })!;
    bus = { store, broadcast: () => {} };
  });

  afterEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("settles the card when the user allows, so the composer unblocks", async () => {
    store.setActivity(from.id, "working");
    const verdict = requestPeerApproval(bus, from, target, "ping", "ask_bot");
    const card = pendingCard(store, from);
    expect(card).toBeTruthy();
    expect(store.bot(from.id)).toMatchObject({ activity: "waiting-on-you", busy: true });

    expect(resolvePeerComms(bus, card!.card!.requestId!, "allow")).toBe(true);
    expect(await verdict).toBe("allow");
    expect(store.bot(from.id)).toMatchObject({ activity: "working", busy: true });

    // the card the client renders must now be answered — this is the bit
    // whose absence bricked the thread
    const settled = store.messagesFor(from.threadId).find((m) => m.id === card!.id);
    expect(settled?.card?.answered).toBe("allow");
    expect(settled?.card?.dismissed).toBe(false);
    expect(pendingCard(store, from)).toBeUndefined();
  });

  it("settles the card on deny too", async () => {
    const verdict = requestPeerApproval(bus, from, target, "ping", "delegate_bot");
    const card = pendingCard(store, from)!;
    expect(store.bot(from.id)).toMatchObject({ activity: "waiting-on-you", busy: true });
    resolvePeerComms(bus, card.card!.requestId!, "deny");
    expect(await verdict).toBe("deny");
    expect(store.messagesFor(from.threadId).find((m) => m.id === card.id)?.card?.answered).toBe("deny");
    expect(store.bot(from.id)).toMatchObject({ activity: "idle", busy: false });
  });

  it("stays at the gate until every concurrent peer approval settles", async () => {
    store.setActivity(from.id, "working");
    const first = requestPeerApproval(bus, from, target, "one", "ask_bot");
    const other = store.patchBot(store.createBot().id, { name: "Other helper" })!;
    const second = requestPeerApproval(bus, from, other, "two", "delegate_bot");
    const cards = store.messagesFor(from.threadId).filter((message) => message.card?.requestId && !message.card.answered);

    expect(cards).toHaveLength(2);
    expect(store.bot(from.id)?.activity).toBe("waiting-on-you");
    resolvePeerComms(bus, cards[0]!.card!.requestId!, "allow");
    await expect(first).resolves.toBe("allow");
    expect(store.bot(from.id)?.activity).toBe("waiting-on-you");

    resolvePeerComms(bus, cards[1]!.card!.requestId!, "deny");
    await expect(second).resolves.toBe("deny");
    expect(store.bot(from.id)?.activity).toBe("working");
  });

  it("does not resurrect work when the turn settles while its gate is open", async () => {
    store.setActivity(from.id, "working");
    const verdict = requestPeerApproval(bus, from, target, "ping", "ask_bot");
    const card = pendingCard(store, from)!;
    expect(store.bot(from.id)?.activity).toBe("waiting-on-you");

    // A turn.completed or interrupt path may settle runtime ownership before
    // the human answer reaches the server.
    store.setActivity(from.id, "idle");
    resolvePeerComms(bus, card.card!.requestId!, "allow");
    await expect(verdict).resolves.toBe("allow");
    expect(store.bot(from.id)).toMatchObject({ activity: "idle", busy: false });
  });

  it("resumes work when a peer gate opened while a provider gate was already waiting", async () => {
    store.setActivity(from.id, "waiting-on-you");
    const verdict = requestPeerApproval(bus, from, target, "parallel ask", "ask_bot");
    const card = pendingCard(store, from)!;

    resolvePeerComms(bus, card.card!.requestId!, "deny");
    await expect(verdict).resolves.toBe("deny");
    expect(store.bot(from.id)).toMatchObject({ activity: "working", busy: true });
  });

  it("answers an unknown requestId as not-ours, so provider cards still route", () => {
    expect(resolvePeerComms(bus, "not-a-peer-request", "allow")).toBe(false);
  });

  it("keys persistent grants by target identity, not mutable or duplicate names", async () => {
    const originalName = target.name;
    store.patchBot(from.id, { alwaysAllow: [peerAllowKey("ask_bot", target.id)] });
    store.patchBot(target.id, { name: "Renamed helper" });

    await expect(requestPeerApproval(bus, from, target, "ping", "ask_bot")).resolves.toBe("allow");
    expect(pendingCard(store, from)).toBeUndefined();

    const impostor = store.patchBot(store.createBot().id, { name: originalName })!;
    const verdict = requestPeerApproval(bus, from, impostor, "ping", "ask_bot");
    const card = pendingCard(store, from);
    expect(card).toBeTruthy();
    cancelPeerApprovalsFor(impostor.id);
    await expect(verdict).resolves.toBe("deny");
  });

  it("denies and settles when the bot on either side is deleted", async () => {
    store.setActivity(from.id, "working");
    const verdict = requestPeerApproval(bus, from, target, "ping", "ask_bot");
    const card = pendingCard(store, from)!;

    cancelPeerApprovalsFor(target.id);

    expect(await verdict).toBe("deny");
    const settled = store.messagesFor(from.threadId).find((m) => m.id === card.id);
    expect(settled?.card?.answered).toBe("deny");
    expect(settled?.card?.dismissed).toBe(true); // not the user's answer
    expect(store.bot(from.id)?.activity).toBe("working");
  });

  it("denies and settles approvals owned by an interrupted thread", async () => {
    store.setActivity(from.id, "working");
    const verdict = requestPeerApproval(bus, from, target, "ping", "ask_bot");
    const card = pendingCard(store, from)!;

    cancelPeerApprovalsForThread(from.threadId);

    expect(await verdict).toBe("deny");
    const settled = store.messagesFor(from.threadId).find((m) => m.id === card.id);
    expect(settled?.card?.answered).toBe("deny");
    expect(settled?.card?.dismissed).toBe(true);
    expect(pendingCard(store, from)).toBeUndefined();
    expect(store.bot(from.id)?.activity).toBe("working");
  });

  it("dismisses cards left by a previous run, which nothing can answer", () => {
    // a card on disk whose in-memory approval died with the process
    const orphan = store.appendMessage(from.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "@Asker wants to contact @Helper",
        subtitle: "ping",
        options: ["Allow", "Deny"],
        requestId: "from-a-dead-process",
        tool: "ask_bot",
      },
    });

    expect(dismissStalePeerCards(bus)).toBe(1);
    const settled = store.messagesFor(from.threadId).find((m) => m.id === orphan.id);
    expect(settled?.card?.dismissed).toBe(true);
    // and it is idempotent — a second boot must not re-dismiss or double count
    expect(dismissStalePeerCards(bus)).toBe(0);
  });

  it("dismisses stale cards in non-active task threads", () => {
    const background = store.createTask(from.id, "Background", false)!;
    const orphan = store.appendMessage(background.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "@Asker wants to contact @Helper",
        subtitle: "ping",
        options: ["Allow", "Deny"],
        requestId: "background-dead-process",
        tool: "ask_bot",
      },
    });

    expect(dismissStalePeerCards(bus)).toBe(1);
    expect(
      store.messagesFor(background.threadId).find((message) => message.id === orphan.id)?.card?.dismissed,
    ).toBe(true);
  });

  it("leaves a live card alone at boot", async () => {
    void requestPeerApproval(bus, from, target, "ping", "ask_bot");
    expect(pendingCard(store, from)).toBeTruthy();
    expect(dismissStalePeerCards(bus)).toBe(0);
    expect(pendingCard(store, from)).toBeTruthy();
    cancelPeerApprovalsFor(from.id); // don't leave a timer pending
  });
});
