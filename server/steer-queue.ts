// Queue-and-steer for busy 1:1 bots.
//
// A message sent to a bot mid-turn used to bounce with a 409. Now it waits
// here until the bot settles, then lands in the thread and runs as ONE
// follow-up turn whose prompt is the queued texts joined with newlines.
//
// The queue is durable but is NOT in `messages[]` while the current turn is
// running: appending immediately would make the queued line the active leaf,
// so remaining tool/assistant events of *this* turn would hang off a user line
// the model has not seen. On restart the queue is loaded, ownership-checked,
// appended idempotently by queueId, and dispatched once.
//
// Unlike the delegation drain, an interrupted or failed turn does NOT
// discard this queue: delegations are a bot's fan-out (dropping them on
// Stop is a safety property), but these are the user's own words —
// stop-then-steer (queue a correction, hit Stop, the correction runs) is
// the feature.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { newId } from "./contracts.ts";
import { parseJson } from "./schema.ts";
import type { BotRecord, Message } from "./store.ts";

/** The slice of Store this module needs — narrow so tests can fake it. */
export interface SteerStore {
  bot(id: string): BotRecord | null;
  ownsThread(botId: string, threadId: string): boolean;
  messageByQueueId(threadId: string, queueId: string): Message | null;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
}

interface QueueItem {
  messageId: string;
  text: string;
  prompt: string;
  replyToId?: string;
  sendId?: string;
}

interface QueueEntry {
  /** Kept beside the threadId because the settle that frees the bot can
   * happen on a DIFFERENT thread (a room turn) — drain matches on "this
   * queue's bot is idle now", which needs the bot, not the settling thread. */
  botId: string;
  items: QueueItem[];
}

const queues = new Map<string, QueueEntry>(); // threadId → waiting sends
const drainingThreads = new Set<string>();
let persistenceFile: string | null = null;
const queueItemSchema = z.object({
  messageId: z.string().min(1),
  text: z.string(),
  prompt: z.string(),
  replyToId: z.string().optional(),
  sendId: z.string().optional(),
}).strict();
const queueFileSchema = z.object({
  version: z.literal(1),
  queues: z.array(z.object({
    threadId: z.string().min(1),
    botId: z.string().min(1),
    items: z.array(queueItemSchema).min(1),
  }).strict()),
}).strict();

function persistQueues(): void {
  if (!persistenceFile) return;
  writeFileAtomic(
    persistenceFile,
    JSON.stringify({
      version: 1,
      queues: [...queues].map(([threadId, entry]) => ({ threadId, botId: entry.botId, items: entry.items })),
    }, null, 2),
  );
}

/** Bind the process-global queue to one Helmryth data directory and load the
 * last atomically committed snapshot. Invalid files fail closed: no unparsed
 * text is ever dispatched as a user direction. */
export function initializeSteeredMessageQueue(dataDir: string): void {
  persistenceFile = join(dataDir, "steer-queue.json");
  queues.clear();
  drainingThreads.clear();
  if (!existsSync(persistenceFile)) return;
  try {
    const stored = queueFileSchema.parse(parseJson(readFileSync(persistenceFile, "utf8")));
    const messageIds = new Set<string>();
    for (const entry of stored.queues) {
      if (queues.has(entry.threadId)) throw new Error(`duplicate queued thread ${entry.threadId}`);
      const sendIds = new Set<string>();
      for (const item of entry.items) {
        if (messageIds.has(item.messageId)) throw new Error(`duplicate queue id ${item.messageId}`);
        messageIds.add(item.messageId);
        if (item.sendId && sendIds.has(item.sendId)) throw new Error(`duplicate send id ${item.sendId}`);
        if (item.sendId) sendIds.add(item.sendId);
      }
      queues.set(entry.threadId, { botId: entry.botId, items: entry.items.map((item) => ({ ...item })) });
    }
  } catch (error) {
    queues.clear();
    console.error(`steer queue: ignored invalid durable state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface QueuedSteer {
  id: string;
}

/** Hold a mid-turn send off the transcript until drain. */
export function queueSteeredMessage(
  botId: string,
  threadId: string,
  text: string,
  options: { prompt?: string; replyToId?: string; sendId?: string } = {},
): QueuedSteer {
  const id = newId();
  const entry = queues.get(threadId) ?? { botId, items: [] };
  // A thread cannot legitimately change owners. Refuse to merge unrelated
  // queues even if a corrupt caller reuses a thread id.
  if (entry.botId !== botId) throw new Error("Queued run belongs to another operator");
  const item: QueueItem = {
    messageId: id,
    text,
    prompt: options.prompt ?? text,
  };
  if (options.replyToId) item.replyToId = options.replyToId;
  if (options.sendId) item.sendId = options.sendId;
  entry.items.push(item);
  queues.set(threadId, entry);
  try {
    persistQueues();
  } catch (error) {
    entry.items.pop();
    if (entry.items.length === 0) queues.delete(threadId);
    throw error;
  }
  return { id };
}

/** Drain every queue whose bot is idle: append the held lines (leaf is now
 * the finished turn's last item), then one run per thread whose prompt is
 * the texts joined with newlines. `userMessage` is the last appended line
 * so startTurn does not duplicate it; `excludeIds` is every drained line
 * so transcript-replay adapters do not also see earlier queued texts.
 * Entries leave the map BEFORE running so a settle racing another settle
 * can never fire the same queue twice. */
export async function drainSteeredMessages(
  store: SteerStore,
  run: (
    botId: string,
    threadId: string,
    prompt: string,
    userMessage: Message,
    excludeIds: string[],
  ) => void | Promise<void>,
): Promise<void> {
  // deleting only the entry being visited is safe under Map iteration
  for (const [threadId, entry] of queues) {
    if (drainingThreads.has(threadId)) continue;
    const bot = store.bot(entry.botId);
    if (!bot || !store.ownsThread(entry.botId, threadId)) {
      // The bot or exact task was deleted while messages waited.
      queues.delete(threadId);
      persistQueues();
      continue;
    }
    if (bot.busy) continue; // still working — the next settle tries again
    drainingThreads.add(threadId);
    try {
      const appended: Message[] = [];
      for (const item of entry.items) {
        // A crash may happen after transcript append but before queue commit.
        // Reuse the stable queueId on recovery instead of duplicating text.
        const existing = store.messageByQueueId(threadId, item.messageId);
        appended.push(existing ?? store.appendMessage(threadId, {
          role: "user",
          kind: "text",
          text: item.text,
          replyToId: item.replyToId,
          sendId: item.sendId,
          queueId: item.messageId,
        }));
      }
      const last = appended.at(-1);
      if (!last) continue;
      const prompt = entry.items.map((item) => item.prompt).join("\n");
      await run(
        entry.botId,
        threadId,
        prompt,
        last,
        appended.map((message) => message.id),
      );
      if (queues.get(threadId) === entry) {
        queues.delete(threadId);
        persistQueues();
      }
    } finally {
      drainingThreads.delete(threadId);
    }
  }
}

/** Find the receipt for a retry whose message is still waiting to drain. */
export function queuedSteeredMessage(
  botId: string,
  threadId: string,
  sendId: string,
): { id: string; text: string; replyToId?: string } | null {
  const entry = queues.get(threadId);
  if (!entry || entry.botId !== botId) return null;
  const item = entry.items.find((candidate) => candidate.sendId === sendId);
  return item ? { id: item.messageId, text: item.text, replyToId: item.replyToId } : null;
}

/** Drop one waiting send owned by this bot so it never drains. The queue id
 * is stable even if the bot switches away from the task while the request is
 * in flight. Returns false when it was already drained, belongs to another
 * bot, or a restart lost the in-memory auto-run intent. */
export function cancelSteeredMessage(botId: string, messageId: string): boolean {
  for (const [threadId, entry] of queues) {
    if (entry.botId !== botId) continue;
    const items = entry.items.filter((item) => item.messageId !== messageId);
    if (items.length === entry.items.length) continue;
    if (items.length === 0) queues.delete(threadId);
    else queues.set(threadId, { botId: entry.botId, items });
    try {
      persistQueues();
    } catch (error) {
      queues.set(threadId, entry);
      throw error;
    }
    return true;
  }
  return false;
}

export function discardSteeredMessagesForThread(botId: string, threadId: string): boolean {
  const entry = queues.get(threadId);
  if (!entry || entry.botId !== botId) return false;
  queues.delete(threadId);
  try {
    persistQueues();
  } catch (error) {
    queues.set(threadId, entry);
    throw error;
  }
  return true;
}

export function discardSteeredMessagesForBot(botId: string): number {
  const removed = [...queues].filter(([, entry]) => entry.botId === botId);
  if (removed.length === 0) return 0;
  for (const [threadId] of removed) queues.delete(threadId);
  try {
    persistQueues();
  } catch (error) {
    for (const [threadId, entry] of removed) queues.set(threadId, entry);
    throw error;
  }
  return removed.length;
}

/** Test helper: how many messages remain queued for a thread. */
export function _queuedCount(threadId: string): number {
  return queues.get(threadId)?.items.length ?? 0;
}
