// Operator-to-operator comms MCP proxy, spawned inside an operator process.
// It exposes the Helmryth collaboration tools and routes them back through
// the harness so one operator can work with another while the
// harness stays the single owner of turns, permissions, and recursion
// limits:
//
//   list_operators()                          → peers in this section + their status
//   ask_operator(operator_id, msg)            → send msg to a peer, wait, return its reply
//   delegate_operator(operator_id, msg, reason?) → hand a run to a peer asynchronously
//                                          immediately, the peer runs after your
//                                          current turn finishes, the user sees
//                                          the peer's reply as its own turn
//   create_operator(name, role, instructions) → leads can add a specialist to
//                                          their own section
//   request_credential(id, reason?)       → show a secure, allowlisted key card
//   list_cadences()                       → inspect this operator's scheduled work
//   propose_cadence(...)                  → show a gate for a new cadence
//   propose_cadence_action(...)           → show a gate for a cadence change
//
// Speaks raw JSON-RPC 2.0 over stdio (no MCP SDK — house style, matches
// computer-proxy / permission-proxy). All state comes from env, injected by
// the harness when it builds the integration:
//   HELMRYTH_HARNESS_URL  base URL of the harness (http://127.0.0.1:8799)
//   HELMRYTH_BOT_ID       internal ID for the calling operator
//   HELMRYTH_COMMS_TOKEN  shared secret for the localhost-only internal endpoints
//   HELMRYTH_TURN_DEPTH   this turn's comms depth (the harness refuses recursion)
import readline from "node:readline";
import { z } from "zod";

import { CREDENTIAL_TARGET_IDS, CREDENTIAL_TARGETS } from "../../shared/credential-request.ts";
import { parseJson, type JsonObject, type JsonValue } from "../schema.ts";

const HARNESS = process.env.HELMRYTH_HARNESS_URL ?? "http://127.0.0.1:8799";
const BOT_ID = process.env.HELMRYTH_BOT_ID ?? "";
const THREAD_ID = process.env.HELMRYTH_THREAD_ID ?? "";
const TOKEN = process.env.HELMRYTH_COMMS_TOKEN ?? "";
const DEPTH = Number(process.env.HELMRYTH_TURN_DEPTH ?? "0") || 0;
const MAX_CREATED_PER_TURN = 4;
let createdThisTurn = 0;

const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

// One flat object, deliberately free of oneOf/const/format: several provider
// CLIs flatten or drop JSON-Schema composition keywords when converting MCP
// tools into their provider's function-call format, and a model that never
// saw the branches guesses shapes forever. The
// per-type rules live in descriptions and are enforced with guiding errors
// in normalizeScheduleInput below.
const ROUTINE_SCHEDULE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description:
    'Either {"type":"once","at":RFC3339} for one future run, {"type":"weekly","time":"HH:MM","weekdays":[...]} for chosen days, or {"type":"daily","time":"HH:MM"} to run every day. Sub-day intervals (every N minutes/hours) are not supported.',
  properties: {
    type: {
      type: "string",
      enum: ["once", "weekly", "daily"],
      description: "once = a single future run; weekly = chosen weekdays; daily = every day of the week.",
    },
    at: {
      type: "string",
      description:
        "Only for type once: future RFC3339 date-time with an explicit timezone offset, for example 2026-09-01T09:00:00+05:30 or 2026-09-01T03:30:00Z.",
    },
    time: {
      type: "string",
      description: "For type weekly or daily: local computer time in 24-hour HH:MM format, for example 09:00.",
    },
    weekdays: {
      type: "array",
      items: { type: "string", enum: WEEKDAYS },
      description: "Only for type weekly: which days the cadence runs, in the Workbench's local timezone.",
    },
  },
  required: ["type"],
} as const;

const FULL_WEEKDAYS = new Set<string>(WEEKDAYS);
const SHORT_WEEKDAYS = new Map<string, (typeof WEEKDAYS)[number]>([
  ["mon", "monday"],
  ["tue", "tuesday"],
  ["tues", "tuesday"],
  ["wed", "wednesday"],
  ["thu", "thursday"],
  ["thur", "thursday"],
  ["thurs", "thursday"],
  ["fri", "friday"],
  ["sat", "saturday"],
  ["sun", "sunday"],
]);

const jsonObjectSchema = z.record(z.string(), z.json());
const scheduleInputSchema = z.object({
  type: z.string().optional(),
  at: z.string().optional(),
  time: z.string().optional(),
  weekdays: z.array(z.json()).optional(),
});
const cadenceFieldInputSchema = z.object({
  name: z.string().optional(),
  instructions: z.string().optional(),
  schedule: z.json().optional(),
  run_on: z.string().optional(),
  duration_minutes: z.number().optional(),
});
const routineActionSchema = z.enum(["update", "pause", "resume", "run_now", "delete"]);
const credentialIdSchema = z.enum(CREDENTIAL_TARGET_IDS);
const operatorListSchema = z.array(z.object({
  id: z.string(),
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  model: z.string().optional(),
  busy: z.boolean().optional(),
}));
const routinesResponseSchema = z.object({
  routines: z.array(z.json()).default([]),
  now: z.string().optional(),
  timeZone: z.string().optional(),
});
const rpcIdSchema = z.union([z.string(), z.number(), z.null()]);
const rpcMessageSchema = z.object({
  id: rpcIdSchema.optional(),
  method: z.string(),
  params: z.object({
    protocolVersion: z.string().optional(),
    name: z.string().optional(),
    arguments: jsonObjectSchema.optional(),
  }).optional(),
});
type JsonRpcId = z.infer<typeof rpcIdSchema>;

const SUPPORTED_SCHEDULES =
  'Supported schedules: {"type":"once","at":"2026-09-01T09:00:00+05:30"} (future RFC3339 with explicit offset), ' +
  '{"type":"weekly","time":"09:00","weekdays":["monday","friday"]}, or {"type":"daily","time":"09:00"} for every day.';

/** The outcome of coercing a model-sent schedule: the harness-dialect
 * schedule, or a message telling the model exactly what to send instead. */
interface NormalizedSchedule {
  schedule?: JsonObject;
  error?: string;
}

/** A schedule as the harness accepts it, or a message telling the model
 * exactly what to send instead. Coercion first, error second: models
 * routinely stringify nested objects, say "daily", or shorten weekday
 * names, and each of those has one obvious meaning. */
function normalizeScheduleInput(args: JsonObject): NormalizedSchedule {
  let raw = args.schedule;
  const encoded = z.string().safeParse(raw);
  if (encoded.success) {
    // Some models deliver nested objects as JSON strings.
    try {
      raw = parseJson(encoded.data);
    } catch {
      return { error: `The schedule must be a JSON object, not text. ${SUPPORTED_SCHEDULES}` };
    }
  }
  const parsed = scheduleInputSchema.safeParse(raw);
  if (!parsed.success) return { error: `The schedule must be a JSON object. ${SUPPORTED_SCHEDULES}` };
  const type = parsed.data.type?.trim().toLowerCase() ?? "";
  if (type === "once") {
    if (!parsed.data.at?.trim()) {
      return { error: `A once schedule needs "at": a future RFC3339 date-time with an explicit offset, for example 2026-09-01T09:00:00+05:30.` };
    }
    return { schedule: { type: "once", at: parsed.data.at.trim() } };
  }
  if (type === "weekly" || type === "daily") {
    const time = parsed.data.time?.trim() ?? "";
    if (!time) return { error: `A ${type} schedule needs "time" in 24-hour HH:MM, for example 09:00.` };
    let weekdays: string[];
    if (type === "daily") {
      // daily = weekly on all seven days; an explicit weekdays list narrows it.
      weekdays = parsed.data.weekdays?.length ? parsed.data.weekdays.map(String) : [...WEEKDAYS];
    } else {
      if (!parsed.data.weekdays?.length) {
        return { error: `A weekly schedule needs "weekdays", for example ["monday","friday"] — or use {"type":"daily"} to run every day.` };
      }
      weekdays = parsed.data.weekdays.map(String);
    }
    const normalized: string[] = [];
    for (const day of weekdays) {
      const lower = String(day).trim().toLowerCase();
      const full = FULL_WEEKDAYS.has(lower)
        ? lower
        : SHORT_WEEKDAYS.get(lower);
      if (!full) return { error: `Unsupported weekday "${String(day)}". Use full names: ${WEEKDAYS.join(", ")}.` };
      if (!normalized.includes(full)) normalized.push(full);
    }
    return { schedule: { type: "weekly", time, weekdays: normalized } };
  }
  if (type === "interval" || type === "cron" || type === "hourly" || type === "minutes") {
    return { error: `Cadences cannot run on sub-day intervals. ${SUPPORTED_SCHEDULES} Pick the closest daily or weekly time and tell the user about this limit.` };
  }
  return { error: `Unknown schedule type "${type || "(missing)"}". ${SUPPORTED_SCHEDULES}` };
}

const CADENCE_FIELDS_SCHEMA = {
  name: { type: "string", minLength: 1, maxLength: 80, description: "Short name shown in Cadences." },
  instructions: {
    type: "string",
    minLength: 1,
    maxLength: 20_000,
    description: "The complete instructions the operator should follow each time the cadence runs.",
  },
  schedule: ROUTINE_SCHEDULE_SCHEMA,
  run_on: {
    type: "string",
    enum: ["local", "cloud"],
    description: "Where the cadence runs. Defaults to local (this Helmryth installation).",
  },
  duration_minutes: {
    type: "integer",
    minimum: 15,
    maximum: 240,
    description: "Maximum run duration in minutes. Defaults to 30.",
  },
} as const;

const TOOLS = [
  {
    name: "list_operators",
    description:
      "List the other operators in your Helmryth section, including their model and whether they are working. Call this before ask_operator to discover who is available.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ask_operator",
    description:
      "Send a message to another operator in your section and wait for its reply. Use it to ask a specialist or peer a focused question. The other operator runs a full turn under its own model and gates; the reply is returned as text. Returns promptly when that operator is already working.",
    inputSchema: {
      type: "object",
      properties: {
        operator_id: { type: "string", description: "The target operator ID from list_operators." },
        message: { type: "string", description: "What to ask the operator." },
      },
      required: ["operator_id", "message"],
    },
  },
  {
    name: "delegate_operator",
    description:
      "Hand a run to another operator asynchronously. It returns immediately, and the peer starts after your current turn finishes. Use it to keep working while a specialist handles a bounded workstream. The user sees the peer's result as its own turn; you do not receive the reply inline.",
    inputSchema: {
      type: "object",
      properties: {
        operator_id: { type: "string", description: "The target operator ID from list_operators." },
        message: { type: "string", description: "What the peer should do / answer." },
        reason: { type: "string", description: "Optional one-line reason for the delegation (shown to the user as a chip)." },
      },
      required: ["operator_id", "message"],
    },
  },
  {
    name: "check_delegation",
    description:
      "Check a delegation queued with delegate_operator without waiting: queued, running, or finished, with the peer's result when complete.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "The run ID returned by delegate_operator." },
      },
      required: ["run_id"],
    },
  },
  {
    name: "wait_delegation",
    description:
      "Wait until a queued delegation finishes and return the peer's result in one call. Use it after your own remaining work is done; it returns immediately if the run already finished.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "The run ID returned by delegate_operator." },
        timeout_seconds: { type: "integer", description: "give up waiting after this many seconds; default 60, max 240" },
      },
      required: ["run_id"],
    },
  },
  {
    name: "create_operator",
    description:
      "Create a specialist operator in your section. Only the section's lead operator may use this. The new operator inherits the lead's engine, starts with connected apps and automatic gates disabled, and can receive work through delegate_operator. Create only the smallest useful crew, with at most four operators per turn.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short, unique display name for the specialist." },
        role: { type: "string", description: "The specialist's job title or role." },
        instructions: { type: "string", description: "What this specialist is responsible for and how it should work." },
      },
      required: ["name", "role", "instructions"],
    },
  },
  {
    name: "request_credential",
    description:
      "Ask the user for a supported API key through Helmryth's secure credential gate. Never ask them to paste a secret into the workstream. The secret is saved by Helmryth and never returned to you. After calling this tool, end the turn; Helmryth resumes the run after the user saves or declines.",
    inputSchema: {
      type: "object",
      properties: {
        credential_id: {
          type: "string",
          enum: Object.keys(CREDENTIAL_TARGETS),
          description: "The credential the current run requires.",
        },
        reason: {
          type: "string",
          description: "Optional short, non-sensitive explanation of why the run needs it.",
        },
      },
      required: ["credential_id"],
    },
  },
  {
    name: "list_cadences",
    description:
      "List cadences owned by this operator, including their IDs, schedules, status, and next run. The result includes the Workbench's authoritative time and timezone. Only call this when the user asks about cadences or wants to change one.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "propose_cadence",
    description:
      "Prepare a new cadence after the user explicitly asks to schedule future or recurring work. Call list_cadences first for relative dates or times. This only creates a durable gate; it does not enable the cadence. Resolve ambiguous dates, times, timezone, destination, or instructions first, and give one-time schedules an explicit RFC3339 offset. After calling it, end the turn and do not claim the cadence exists until the user confirms the gate.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: CADENCE_FIELDS_SCHEMA,
      required: ["name", "instructions", "schedule"],
    },
  },
  {
    name: "propose_cadence_action",
    description:
      "Prepare a user-requested change to one of this operator's cadences. This only creates a durable gate; it does not apply the change. Use list_cadences first to get the cadence ID. After calling it, end the turn and do not claim the action completed until the user confirms the gate.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cadence_id: { type: "string", minLength: 1, description: "Cadence ID from list_cadences." },
        action: {
          type: "string",
          enum: ["update", "pause", "resume", "run_now", "delete"],
          description: "The requested action. Supply changes only for update.",
        },
        changes: {
          type: "object",
          additionalProperties: false,
          properties: CADENCE_FIELDS_SCHEMA,
          description: "Fields to change when action is update. Omit for every other action.",
        },
      },
      required: ["cadence_id", "action"],
    },
  },
];

type RoutineAction = "update" | "pause" | "resume" | "run_now" | "delete";

interface StdioMessage {
  jsonrpc: "2.0";
  id: JsonRpcId | undefined;
  result?: unknown;
  error?: { code: number; message: string };
}
interface CadenceFieldsResult {
  fields: JsonObject;
  error?: string;
}
interface ConfirmationResult {
  text: string;
}
interface DelegateRequestBody {
  fromBotId: string;
  fromThreadId: string;
  toBotId: string;
  message: string;
  depth: number;
  reason?: string;
}
interface CredentialRequestBody {
  fromBotId: string;
  fromThreadId: string;
  credentialId: string;
  reason?: string;
}
const send = (message: StdioMessage) => process.stdout.write(JSON.stringify(message) + "\n");
function ok<Result>(id: JsonRpcId | undefined, result: Result) {
  return send({ jsonrpc: "2.0", id, result });
}
const rpcErr = (id: JsonRpcId | undefined, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (id: JsonRpcId | undefined, text: string, isError = false) =>
  ok(id, { content: [{ type: "text", text }], isError });

async function api(path: string, init?: RequestInit): Promise<JsonObject> {
  const res = await fetch(HARNESS + path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...init?.headers },
  });
  const body = jsonObjectSchema.parse(await res.json().catch(() => ({})));
  if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`));
  return body;
}

function routineAction(value: JsonValue | undefined): RoutineAction | null {
  const parsed = routineActionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function cadenceFields(args: JsonObject): CadenceFieldsResult {
  const parsed = cadenceFieldInputSchema.parse(args);
  const fields: JsonObject = {};
  if (parsed.name !== undefined) fields.name = parsed.name.trim();
  if (parsed.instructions !== undefined) fields.instructions = parsed.instructions.trim();
  if (parsed.schedule !== undefined && parsed.schedule !== null) {
    const normalized = normalizeScheduleInput(args);
    if (normalized.error) return { fields, error: normalized.error };
    if (normalized.schedule) fields.schedule = normalized.schedule;
  }
  if (parsed.run_on !== undefined) fields.runOn = parsed.run_on;
  if (parsed.duration_minutes !== undefined) fields.durationMinutes = parsed.duration_minutes;
  return { fields };
}

function confirmationResult(r: JsonObject, fallback: string): ConfirmationResult {
  const parsedSummary = z.string().safeParse(r.summary);
  const summary = parsedSummary.success && parsedSummary.data.trim() ? `\n\n${parsedSummary.data.trim()}` : "";
  return {
    text: `A gate is now visible to the user for ${fallback}.${summary}\n\nThis change has not been applied. End this turn and wait for the user to confirm or deny the gate; do not claim the cadence was created or changed before confirmation.`,
  };
}

async function callTool(name: string, args: JsonObject): Promise<{ text: string; isError?: boolean }> {
  if (name === "list_operators") {
    const r = await api(`/api/internal/agents?self=${encodeURIComponent(BOT_ID)}`);
    const bots = operatorListSchema.catch([]).parse(r.bots);
    if (!bots.length) return { text: "No other operators are in this section yet." };
    const lines = bots.map((b) => {
      const role = b.title ? ` — ${b.title}` : "";
      const about = b.description ? ` (${String(b.description).slice(0, 120)})` : "";
      return `- ${b.name}${role}${about} [id: ${b.id}, model: ${b.model}${b.busy ? ", busy" : ""}]`;
    });
    return { text: `Other operators you can message with ask_operator:\n${lines.join("\n")}` };
  }
  if (name === "ask_operator") {
    const toBotId = String(args.operator_id ?? "").trim();
    const message = String(args.message ?? "").trim();
    if (!toBotId || !message) return { text: "ask_operator needs operator_id and message.", isError: true };
    const r = await api(`/api/internal/ask-bot`, {
      method: "POST",
      body: JSON.stringify({ fromBotId: BOT_ID, fromThreadId: THREAD_ID, toBotId, message, depth: DEPTH }),
    });
    if (r.busy) return { text: "That operator is working. Try again after it finishes." };
    if (r.error) return { text: `Could not reach that operator: ${r.error}`, isError: true };
    return { text: `${r.botName ?? "Operator"} replied:\n${r.text ?? "(no reply)"}` };
  }
  if (name === "delegate_operator") {
    const toBotId = String(args.operator_id ?? "").trim();
    const message = String(args.message ?? "").trim();
    const parsedReason = z.string().safeParse(args.reason);
    const reason = parsedReason.success ? parsedReason.data.trim() : "";
    if (!toBotId || !message) return { text: "delegate_operator needs operator_id and message.", isError: true };
    const body: DelegateRequestBody = {
      fromBotId: BOT_ID,
      fromThreadId: THREAD_ID,
      toBotId,
      message,
      depth: DEPTH,
    };
    if (reason) body.reason = reason;
    const r = await api(`/api/internal/delegate-bot`, { method: "POST", body: JSON.stringify(body) });
    if (r.error) return { text: `Couldn't queue the delegation: ${r.error}`, isError: true };
    // Fire-and-forget by contract: the harness returns immediately, the
    // Peer turn runs after our current turn finishes. The run ID is the
    // operator's claim ticket for the outcome.
    const responseMessage = z.string().safeParse(r.message);
    const responseTaskId = z.string().safeParse(r.taskId);
    const note = responseMessage.success ? responseMessage.data : "Delegation queued.";
    const suffix = responseTaskId.success && responseTaskId.data
      ? ` Run ID: ${responseTaskId.data}. After your own work is done, read the outcome with check_delegation or block on it with wait_delegation.`
      : "";
    return { text: `${note}${suffix}` };
  }
  if (name === "check_delegation" || name === "wait_delegation") {
    const taskId = String(args.run_id ?? "").trim();
    if (!/^[\w-]{4,64}$/.test(taskId)) {
      return { text: `${name} needs the "run_id" returned by delegate_operator, for example {"run_id":"1f0c2f4e-..."}.`, isError: true };
    }
    const timeout = Math.min(Math.max(Math.trunc(Number(args.timeout_seconds) || 60), 1), 240);
    const waitMs = name === "wait_delegation" ? timeout * 1000 : 0;
    const query = new URLSearchParams({ fromBotId: BOT_ID, fromThreadId: THREAD_ID, wait_ms: String(waitMs) });
    const r = await api(`/api/internal/delegations/${encodeURIComponent(taskId)}?${query.toString()}`);
    const toBotName = z.string().safeParse(r.toBotName);
    const who = toBotName.success && toBotName.data ? `@${toBotName.data}` : "the peer";
    if (r.status === "done") return { text: `${who} finished run ${taskId}:\n${String(r.result || "(no reply text)")}` };
    if (r.status === "queued") {
      return { text: `Run ${taskId} is still queued. ${who} has not picked it up${waitMs ? ` after ${timeout}s` : ""}. Keep working and check again later.` };
    }
    if (r.status === "running") {
      return { text: `Run ${taskId} is active with ${who}${waitMs ? ` after ${timeout}s` : ""}. Check again shortly.` };
    }
    return { text: `Run ${taskId} ended without a reply: ${String(r.status ?? "unknown")}${r.result ? `: ${String(r.result)}` : ""}.`, isError: true };
  }
  if (name === "create_operator") {
    const botName = String(args.name ?? "").trim();
    const role = String(args.role ?? "").trim();
    const instructions = String(args.instructions ?? "").trim();
    if (!botName || !role || !instructions) {
      return { text: "create_operator needs name, role, and instructions.", isError: true };
    }
    if (createdThisTurn >= MAX_CREATED_PER_TURN) {
      return { text: `You can create at most ${MAX_CREATED_PER_TURN} operators in one turn. Use the crew you have before adding more.`, isError: true };
    }
    const r = await api(`/api/internal/create-bot`, {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        fromThreadId: THREAD_ID,
        name: botName,
        role,
        instructions,
      }),
    });
    createdThisTurn += 1;
    return {
      text: `Created @${r.name ?? botName} in ${r.section ?? "General"} [id: ${r.id}]. Assign work with delegate_operator.`,
    };
  }
  if (name === "request_credential") {
    const credentialId = credentialIdSchema.safeParse(args.credential_id);
    if (!credentialId.success) {
      return { text: "request_credential needs a supported credential_id.", isError: true };
    }
    const parsedReason = z.string().safeParse(args.reason);
    const reason = parsedReason.success ? parsedReason.data.trim().slice(0, 240) : "";
    const requestBody: CredentialRequestBody = {
      fromBotId: BOT_ID,
      fromThreadId: THREAD_ID,
      credentialId: credentialId.data,
    };
    if (reason) requestBody.reason = reason;
    const r = await api("/api/internal/request-credential", {
      method: "POST",
      body: JSON.stringify(requestBody),
    });
    if (r.alreadyConfigured) {
      return { text: `${r.label ?? CREDENTIAL_TARGETS[credentialId.data].label} is already configured. Continue the run.` };
    }
    return {
      text: `A secure ${r.label ?? CREDENTIAL_TARGETS[credentialId.data].label} gate is now visible to the user. End this turn; Helmryth will resume the run after they save or decline. Never ask them to paste the key into the workstream.`,
    };
  }
  if (name === "list_cadences") {
    const query = new URLSearchParams({ fromBotId: BOT_ID, fromThreadId: THREAD_ID });
    const r = await api(`/api/internal/routines?${query.toString()}`);
    const cadenceState = routinesResponseSchema.parse(r);
    const routines = cadenceState.routines;
    const now = cadenceState.now ?? new Date().toISOString();
    const timeZone = cadenceState.timeZone || "local computer timezone";
    if (!routines.length) {
      return { text: `This operator has no cadences. Current time: ${now}. Timezone: ${timeZone}.` };
    }
    return {
      text: `This operator's cadences (current time: ${now}; timezone: ${timeZone}):\n${JSON.stringify(routines, null, 2)}`,
    };
  }
  if (name === "propose_cadence") {
    const { fields: routine, error: scheduleError } = cadenceFields(args);
    if (scheduleError) return { text: scheduleError, isError: true };
    if (!routine.name || !routine.instructions || !routine.schedule) {
      return { text: "propose_cadence needs name, instructions, and schedule.", isError: true };
    }
    const r = await api("/api/internal/routine-requests", {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        fromThreadId: THREAD_ID,
        action: "create",
        routine,
      }),
    });
    return confirmationResult(r, `the new cadence “${routine.name}”`);
  }
  if (name === "propose_cadence_action") {
    const routineId = String(args.cadence_id ?? "").trim();
    const action = routineAction(args.action);
    if (!routineId || !action) {
      return { text: "propose_cadence_action needs a cadence_id and supported action.", isError: true };
    }
    const body: JsonObject = {
      fromBotId: BOT_ID,
      fromThreadId: THREAD_ID,
      action,
      routineId,
    };
    if (action === "update") {
      const parsedChanges = jsonObjectSchema.safeParse(args.changes);
      if (!parsedChanges.success) {
        return { text: "The update action needs at least one field in changes.", isError: true };
      }
      const { fields: changes, error: scheduleError } = cadenceFields(parsedChanges.data);
      if (scheduleError) return { text: scheduleError, isError: true };
      if (!Object.keys(changes).length) {
        return { text: "The update action needs at least one supported field in changes.", isError: true };
      }
      body.changes = changes;
    } else if (args.changes !== undefined) {
      return { text: `The ${action} action does not accept changes.`, isError: true };
    }
    const r = await api("/api/internal/routine-requests", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return confirmationResult(r, `${action.replace("_", " ")} on cadence ${routineId}`);
  }
  return { text: `Unknown tool: ${name}`, isError: true };
}

async function handle(msg: z.infer<typeof rpcMessageSchema>) {
  const id = msg.id;
  const method = msg.method;
  const params = msg.params ?? {};
  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: params.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "helmryth-operators", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params.name ?? "";
      if (!TOOLS.some((t) => t.name === name)) return rpcErr(id, -32602, `Unknown tool: ${name}`);
      try {
        const { text, isError } = await callTool(name, params.arguments ?? {});
        textResult(id, text, isError);
      } catch (error) {
        textResult(id, error instanceof Error ? error.message : String(error), true);
      }
      return;
    }
    default:
      if (id !== undefined) rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg: z.infer<typeof rpcMessageSchema>;
  try {
    msg = rpcMessageSchema.parse(parseJson(t));
  } catch {
    return;
  }
  void handle(msg).catch((error) => {
    if (msg.id !== undefined) rpcErr(msg.id, -32603, error instanceof Error ? error.message : String(error));
  });
});
rl.on("close", () => process.exit(0));
