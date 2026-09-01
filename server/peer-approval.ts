// Harness-native peer-comm approval gate.
//
// A bot with `approvePeerComms = true` may not call ask_bot or
// delegate_bot without a human approving the specific contact. The
// approval rides on the same options-card flow provider permissions
// already use: a card pushed into the SOURCE bot's thread with a
// `requestId`, answered by the user via /api/bots/:id/respond (or
// /api/threads/:id/respond) which the harness intercepts via
// `resolvePeerComms` BEFORE forwarding to the provider adapter. That
// way nothing front-end has to learn about peer comms.
//
// "Always allow" rides on the existing per-bot `alwaysAllow` list. The
// card carries an ID-based `allowKey` and
// the user-facing Always-allow flow already mirrors that key back into
// `alwaysAllow`, so the two sides never disagree about what was granted.

import { newId } from "./contracts.ts";
import type { CommsBroadcastFrame } from "./comms-visibility.ts";
import { peerAllowKey, type PeerAction } from "./peer-approval-key.ts";
import type { BotActivity, BotRecord, Message, Store } from "./store.ts";

export { peerAllowKey } from "./peer-approval-key.ts";

/** What a peer-approval helper needs from the outside world: the store
 * for thread append + persist, and the SSE broadcaster so the chat
 * updates without waiting for a refresh. */
export interface ApprovalBus {
  store: Store;
  /** SSE broadcast (kind: "message" envelope). */
  broadcast: (payload: CommsBroadcastFrame) => void;
}

interface Pending {
  resolve: (result: "allow" | "deny") => void;
  /** Frees the requestId if the user never answers. */
  timer: ReturnType<typeof setTimeout>;
  fromBotId: string;
  toBotId: string;
  message: string;
  /** Where the card lives, so answering it can settle it. A card that is
   * never settled keeps matching the client's "unanswered" filter, and the
   * composer stays disabled behind it — the thread is unusable from then on. */
  threadId: string;
  messageId: string;
  bus: ApprovalBus;
  /** Activity to return to once the last peer gate on this source thread
   * settles. A direct ask_bot runs inside an active turn (working), while a
   * queued delegation may open after that turn has already gone idle. */
  resumeActivity: BotActivity;
}

/** Mark the card answered so the UI stops treating it as pending. Mirrors
 * what the `request.resolved` fold does for provider cards; a harness-native
 * card never emits that event, so it has to settle itself. */
function settleCard(pending: Pending, behavior: string, source: "user" | "system"): void {
  const existing = pending.bus.store
    .messagesFor(pending.threadId)
    .find((m) => m.id === pending.messageId);
  if (!existing?.card || existing.card.answered) return;
  pending.bus.store.patchMessage(pending.threadId, pending.messageId, {
    card: { ...existing.card, answered: behavior, dismissed: source !== "user" },
  });
}

/** A peer card is appended directly by this harness helper, so it never
 * passes through index.ts's provider request.opened/request.resolved fold.
 * Keep the source operator's runtime activity synchronized here instead.
 *
 * Multiple peer gates on one thread share the activity they should resume;
 * settling either one must not hide the other. If the turn independently
 * completed or was interrupted while the card was open, its idle/dead state
 * wins and is never resurrected by a late answer. */
function resumeActivityAfterSettlement(pending: Pending): void {
  const anotherPeerGate = [...pendingComms.values()].some(
    (candidate) =>
      candidate.fromBotId === pending.fromBotId &&
      candidate.threadId === pending.threadId,
  );
  if (anotherPeerGate) return;

  // A provider-owned request can coexist with a peer gate. Its own resolved
  // event will restore working; until then the operator is still waiting on
  // the human and Operations must continue to count the gate.
  const anotherRuntimeGate = pending.bus.store.messagesFor(pending.threadId).some((message) => {
    const card = message.card;
    return Boolean(
      card?.requestId &&
      !card.answered &&
      !card.dismissed &&
      !card.routineRequest,
    );
  });
  if (anotherRuntimeGate) return;

  const current = pending.bus.store.bot(pending.fromBotId);
  if (current?.activity === "waiting-on-you") {
    pending.bus.store.setActivity(current.id, pending.resumeActivity);
  }
}

/** requestId → pending ask. Lives only in memory — restarting the
 * server cancels every in-flight approval, like provider permissions do. */
const pendingComms = new Map<string, Pending>();

const APPROVAL_TIMEOUT_MS = 15 * 60_000;

/** The narrow grant "always allow" remembers for a peer comm. Mirrored
 * back into `bot.alwaysAllow` when the user picks "Always allow" on the
 * card. */
function allowKeyAllowed(from: BotRecord, allowKey: string): boolean {
  return from.alwaysAllow?.includes(allowKey) ?? false;
}

function pushApprovalCard(
  bus: ApprovalBus,
  from: BotRecord,
  target: BotRecord,
  message: string,
  action: PeerAction,
  requestId: string,
  sourceThreadId: string,
): Message {
  const subtitle = message.length > 200 ? `${message.slice(0, 200)}…` : message;
  const note = bus.store.appendMessage(sourceThreadId, {
    role: "bot",
    kind: "options",
    card: {
      title: `@${from.name} wants to ${action === "ask_bot" ? "contact" : "delegate to"} @${target.name}`,
      subtitle,
      options: ["Allow", "Deny", "Always allow"],
      requestId,
      tool: action,
      allowKey: peerAllowKey(action, target.id),
    },
  });
  return note;
}

/** Ask the user (in the source task thread) whether `from` may `action` `target`.
 * Resolves with `"allow"` or `"deny"`. If `from.alwaysAllow` already
 * covers the (action, target) pair, returns `"allow"` immediately
 * without a card. */
export function requestPeerApproval(
  bus: ApprovalBus,
  from: BotRecord,
  target: BotRecord,
  message: string,
  action: PeerAction,
  sourceThreadId = from.threadId,
): Promise<"allow" | "deny"> {
  if (allowKeyAllowed(from, peerAllowKey(action, target.id))) {
    return Promise.resolve("allow");
  }
  return new Promise((resolve) => {
    const existingGate = [...pendingComms.values()].find(
      (pending) => pending.fromBotId === from.id && pending.threadId === sourceThreadId,
    );
    const liveFrom = bus.store.bot(from.id);
    const resumeActivity = existingGate?.resumeActivity ??
      (liveFrom?.activity === "waiting-on-you" ? "working" : liveFrom?.activity) ??
      (liveFrom?.busy ? "working" : "idle");
    const requestId = newId();
    // the card has to exist before the entry, so a timeout or an answer can
    // always find it to settle
    const card = pushApprovalCard(bus, from, target, message, action, requestId, sourceThreadId);
    const timer = setTimeout(() => {
      // 15 minutes without an answer → deny. Keeps an unattended bot from
      // stalling its own turn forever (matches the Claude broker timeout).
      const pending = pendingComms.get(requestId);
      if (!pending) return;
      pendingComms.delete(requestId);
      settleCard(pending, "deny", "system");
      resumeActivityAfterSettlement(pending);
      resolve("deny");
    }, APPROVAL_TIMEOUT_MS);
    timer.unref?.(); // a waiting card must never hold the process open
    pendingComms.set(requestId, {
      resolve,
      timer,
      fromBotId: from.id,
      toBotId: target.id,
      message,
      threadId: sourceThreadId,
      messageId: card.id,
      bus,
      resumeActivity,
    });
    // Provider permissions get this transition from the request.opened
    // fold. Peer approvals bypass that fold, so make the same state change
    // after the pending entry is fully registered.
    if (liveFrom && liveFrom.activity !== "waiting-on-you") {
      bus.store.setActivity(liveFrom.id, "waiting-on-you");
    }
  });
}

/** Called by the respond endpoints BEFORE forwarding to the provider
 * adapter. Returns true if the requestId belonged to a pending peer
 * approval (and resolves it); false if it was a provider request and
 * the endpoint should keep going. */
export function resolvePeerComms(
  _bus: ApprovalBus,
  requestId: string,
  behavior: string | undefined,
): boolean {
  const pending = pendingComms.get(requestId);
  if (!pending) return false;
  pendingComms.delete(requestId);
  clearTimeout(pending.timer);
  const allow = behavior === "allow";
  settleCard(pending, allow ? "allow" : "deny", "user");
  resumeActivityAfterSettlement(pending);
  pending.resolve(allow ? "allow" : "deny");
  return true;
}

/** Drop every approval waiting on a bot that no longer exists (or is being
 * deleted), denying it so the caller's turn doesn't wait out the timeout. */
export function cancelPeerApprovalsFor(botId: string): void {
  for (const [requestId, pending] of pendingComms) {
    if (pending.fromBotId !== botId && pending.toBotId !== botId) continue;
    pendingComms.delete(requestId);
    clearTimeout(pending.timer);
    settleCard(pending, "deny", "system");
    resumeActivityAfterSettlement(pending);
    pending.resolve("deny");
  }
}

/** Deny every peer-communication approval owned by a thread whose turn was
 * interrupted. Patching the card alone is not enough: the in-memory promise
 * must resolve too, or the delegation queue waits until its 15-minute timer. */
export function cancelPeerApprovalsForThread(threadId: string): void {
  for (const [requestId, pending] of pendingComms) {
    if (pending.threadId !== threadId) continue;
    pendingComms.delete(requestId);
    clearTimeout(pending.timer);
    settleCard(pending, "deny", "system");
    resumeActivityAfterSettlement(pending);
    pending.resolve("deny");
  }
}

/** Cards left on disk by a previous run can never be answered — their
 * in-memory approval died with the process. Settle them at boot so a
 * crashed run doesn't leave a thread with a permanently blocked composer. */
export function dismissStalePeerCards(bus: ApprovalBus): number {
  let dismissed = 0;
  for (const bot of bus.store.bots) {
    const threadIds = new Set([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)]);
    for (const threadId of threadIds) {
      for (const message of bus.store.messagesFor(threadId)) {
        const card = message.card;
        if (!card?.requestId || card.answered || card.dismissed) continue;
        if (card.tool !== "ask_bot" && card.tool !== "delegate_bot") continue;
        if (pendingComms.has(card.requestId)) continue;
        const patched = bus.store.patchMessage(threadId, message.id, {
          card: { ...card, answered: "deny", dismissed: true },
        });
        if (patched) dismissed += 1;
      }
    }
  }
  return dismissed;
}
