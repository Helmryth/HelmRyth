#!/usr/bin/env node
// Model Context Protocol (MCP) Server for Helmryth
// Standard JSON-RPC 2.0 stdio transport for external agent orchestration (Hermes, Claude Desktop, Cursor, etc.).
import readline from "node:readline";

import { z } from "zod";

import { parseJson } from "../server/schema.ts";

type ProtocolPrimitive = string | number | boolean | null;
export interface ProtocolObject {
  [key: string]: ProtocolValue | undefined;
}
export type ProtocolValue = ProtocolPrimitive | ProtocolObject | ProtocolValue[];
export type ToolResult = ProtocolValue;
export type HelmrythFetcher = (path: string, options?: RequestInit) => Promise<ProtocolValue>;

const protocolObjectSchema = z.record(z.string(), z.custom<ProtocolValue>());
const protocolStringSchema = z.string();
const protocolNumberSchema = z.number();
const protocolStringListSchema = z.array(z.string());

function objectValue(value: ProtocolValue | undefined): ProtocolObject | null {
  const parsed = protocolObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function stringValue(value: ProtocolValue | undefined): string | undefined {
  const parsed = protocolStringSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function numberValue(value: ProtocolValue | undefined): number | undefined {
  const parsed = protocolNumberSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function validateBaseUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid Helmryth URL: '${url}'`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Helmryth URL must use http:// or https://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Helmryth URL must not contain credentials; use HELMRYTH_TOKEN instead");
  }
  if ((parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
    throw new Error("Helmryth URL must be an origin without a path, query, or fragment");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLoopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  if (parsed.protocol === "http:" && !isLoopback && process.env.ALLOW_INSECURE_HTTP !== "true") {
    throw new Error(
      `Insecure cleartext HTTP origin '${parsed.origin}' is rejected. Use https:// or set ALLOW_INSECURE_HTTP=true.`,
    );
  }
  return parsed.origin;
}

const configuredUrl = process.env.HELMRYTH_URL ||
  (process.env.HELMRYTH_PORT ? `http://127.0.0.1:${process.env.HELMRYTH_PORT}` : undefined);

export const HELMRYTH_BASE_URL = validateBaseUrl(configuredUrl || "http://127.0.0.1:8799");
const DISCOVERY_URLS = configuredUrl
  ? [HELMRYTH_BASE_URL]
  : [8799, 18799, 28799].map((port) => `http://127.0.0.1:${port}`);
let discoveredBaseUrl: string | undefined;

export function log(msg: string) {
  process.stderr.write(`[helmryth-mcp] ${msg}\n`);
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function requestTimeoutMs(): number {
  const raw = Number(process.env.HELMRYTH_MCP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1_000 && raw <= 120_000 ? Math.floor(raw) : DEFAULT_REQUEST_TIMEOUT_MS;
}

function requestHeaders(options: RequestInit): NonNullable<RequestInit["headers"]> {
  const token = process.env.HELMRYTH_TOKEN?.trim();
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

async function fetchJson(url: string, options: RequestInit = {}): Promise<ProtocolValue> {
  const timeout = AbortSignal.timeout(requestTimeoutMs());
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(url, {
    ...options,
    signal,
    headers: requestHeaders(options),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Helmryth API error (${response.status}): ${text || response.statusText}`);
  }
  try {
    return parseJson(await response.text());
  } catch {
    throw new Error(`Helmryth API returned a non-JSON response from ${url}`);
  }
}

export async function probeBaseUrls(candidates: string[]): Promise<string> {
  const failures: string[] = [];
  for (const unvalidated of candidates) {
    const candidate = validateBaseUrl(unvalidated);
    try {
      const health = objectValue(await fetchJson(`${candidate}/api/health`, {
        signal: AbortSignal.timeout(Math.min(requestTimeoutMs(), 2_000)),
      }));
      if (health?.app !== "helmryth") {
        failures.push(`${candidate} answered, but it was not Helmryth`);
        continue;
      }
      return candidate;
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Could not find a running Helmryth server. ${failures.join("; ")}`);
}

export async function resolveBaseUrl(): Promise<string> {
  if (discoveredBaseUrl) return discoveredBaseUrl;
  if (process.env.HELMRYTH_TOKEN?.trim() && !configuredUrl) {
    throw new Error("Set HELMRYTH_URL or HELMRYTH_PORT when using HELMRYTH_TOKEN so credentials are never sent during port discovery");
  }
  discoveredBaseUrl = await probeBaseUrls(DISCOVERY_URLS);
  return discoveredBaseUrl;
}

export async function request(path: string, options: RequestInit = {}, baseUrl?: string) {
  const target = baseUrl ? validateBaseUrl(baseUrl) : await resolveBaseUrl();
  return fetchJson(`${target}${path}`, options);
}

export interface McpToolDefinition extends ProtocolObject {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, JsonSchemaNode>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

type JsonSchemaType = "array" | "boolean" | "integer" | "null" | "number" | "object" | "string";

export interface JsonSchemaNode extends ProtocolObject {
  type?: JsonSchemaType | JsonSchemaType[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
  enum?: ProtocolValue[];
  const?: ProtocolValue;
  oneOf?: JsonSchemaNode[];
  items?: JsonSchemaNode;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  uniqueItems?: boolean;
}

interface JsonRpcErrorOptions {
  code?: number;
  message?: string;
}

type McpRequestId = string | number;

const initializeParamsSchema = z.object({
  protocolVersion: z.string(),
  capabilities: protocolObjectSchema,
  clientInfo: z.object({
    name: z.string(),
    version: z.string(),
  }),
});

function requestIdValue(value: ProtocolValue | undefined): McpRequestId | undefined {
  const text = stringValue(value);
  if (text !== undefined) return text;
  const number = numberValue(value);
  return number !== undefined && Number.isFinite(number) ? number : undefined;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const ADDITIVE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const MUTATING = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;
const AGENT_ACTION = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

export const TOOLS: McpToolDefinition[] = [
  {
    name: "get_system_health",
    description: "Check whether the Helmryth server is reachable.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "list_operators",
    description: "List operators, their current status, active run, and available runs without loading transcripts.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_operator_messages",
    description: "Retrieve a bounded page of recent messages from one operator run. Images are never returned inline.",
    inputSchema: {
      type: "object",
      properties: {
        operator_id: { type: "string", description: "The operator ID." },
        run_id: { type: "string", description: "Optional run/workstream ID. Defaults to the operator's active run." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Messages to retrieve (default: 30, max: 200)." },
      },
      required: ["operator_id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "send_operator_message",
    description: "Send an instruction to an operator's active run. Optionally name the expected run to prevent cross-run races. This may cause the operator to use external tools.",
    inputSchema: {
      type: "object",
      properties: {
        operator_id: { type: "string", description: "The operator ID to message." },
        run_id: { type: "string", description: "Optional expected active run/workstream ID." },
        text: { type: "string", description: "The message content/instruction to send." },
      },
      required: ["operator_id", "text"],
      additionalProperties: false,
    },
    annotations: AGENT_ACTION,
  },
  {
    name: "create_operator",
    description: "Create a new operator and optionally configure its profile, section, and exact model selection.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Operator display name." },
        title: { type: "string", description: "Optional short role title." },
        description: { type: "string", description: "Optional persona or responsibility description." },
        section: { type: "string", description: "Optional sidebar section." },
        instance_id: { type: "string", description: "Optional provider instance ID; model is required with it." },
        model: { type: "string", description: "Optional exact model ID; instance_id is required with it." },
        effort: { type: "string", enum: ["none", "low", "medium", "high", "xhigh", "max"] },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: ADDITIVE,
  },
  {
    name: "update_operator_profile",
    description: "Update safe operator profile fields. This cannot alter gates or Workbench access.",
    inputSchema: {
      type: "object",
      properties: {
        operator_id: { type: "string", description: "The operator ID." },
        name: { type: "string", description: "Optional operator display name." },
        title: { type: "string", description: "Optional short role title." },
        description: { type: "string", description: "Optional persona or responsibility description." },
        section: { type: ["string", "null"], description: "Optional sidebar section. Null clears it." },
      },
      required: ["operator_id"],
      additionalProperties: false,
    },
    annotations: MUTATING,
  },
  {
    name: "list_crews",
    description: "List crews, their operators, active run, and available runs without loading transcripts.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_crew_messages",
    description: "Retrieve a bounded page of recent messages from one crew run. Images are never returned inline.",
    inputSchema: {
      type: "object",
      properties: {
        crew_id: { type: "string", description: "The crew ID." },
        run_id: { type: "string", description: "Optional run/workstream ID. Defaults to the crew's active run." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Messages to retrieve (default: 30, max: 200)." },
      },
      required: ["crew_id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "send_crew_message",
    description: "Send an instruction to a crew's active run. Optionally name the expected run to prevent cross-run races. This may cause one or more operators to use external tools.",
    inputSchema: {
      type: "object",
      properties: {
        crew_id: { type: "string", description: "The crew ID." },
        run_id: { type: "string", description: "Optional expected active run/workstream ID." },
        text: { type: "string", description: "The message content to post." },
      },
      required: ["crew_id", "text"],
      additionalProperties: false,
    },
    annotations: AGENT_ACTION,
  },
  {
    name: "create_crew",
    description: "Create a crew from existing operators.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Crew name." },
        member_ids: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true },
        section: { type: "string", description: "Optional sidebar section." },
        bulletin: { type: "string", description: "Optional shared instructions for channel members." },
        default_responder: {
          oneOf: [
            { type: "object", properties: { kind: { const: "everyone" } }, required: ["kind"], additionalProperties: false },
            { type: "object", properties: { kind: { const: "mentions" } }, required: ["kind"], additionalProperties: false },
            { type: "object", properties: { kind: { const: "member" }, operator_id: { type: "string" } }, required: ["kind", "operator_id"], additionalProperties: false },
          ],
        },
      },
      required: ["name", "member_ids"],
      additionalProperties: false,
    },
    annotations: ADDITIVE,
  },
  {
    name: "update_crew",
    description: "Update a crew's name, operators, section, bulletin, or default responder.",
    inputSchema: {
      type: "object",
      properties: {
        crew_id: { type: "string", description: "The crew ID." },
        name: { type: "string" },
        member_ids: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true },
        section: { type: ["string", "null"], description: "Null clears the section." },
        bulletin: { type: "string" },
        default_responder: {
          oneOf: [
            { type: "object", properties: { kind: { const: "everyone" } }, required: ["kind"], additionalProperties: false },
            { type: "object", properties: { kind: { const: "mentions" } }, required: ["kind"], additionalProperties: false },
            { type: "object", properties: { kind: { const: "member" }, operator_id: { type: "string" } }, required: ["kind", "operator_id"], additionalProperties: false },
          ],
        },
      },
      required: ["crew_id"],
      additionalProperties: false,
    },
    annotations: MUTATING,
  },
  {
    name: "create_run",
    description: "Create and activate a fresh run for an operator or crew.",
    inputSchema: {
      type: "object",
      properties: {
        target_type: { type: "string", enum: ["operator", "crew"] },
        target_id: { type: "string" },
        title: { type: "string", description: "Optional run title." },
      },
      required: ["target_type", "target_id"],
      additionalProperties: false,
    },
    annotations: ADDITIVE,
  },
  {
    name: "switch_run",
    description: "Switch an operator or crew to an existing run. Active or gate-blocked workstreams are refused.",
    inputSchema: {
      type: "object",
      properties: {
        target_type: { type: "string", enum: ["operator", "crew"] },
        target_id: { type: "string" },
        run_id: { type: "string" },
      },
      required: ["target_type", "target_id", "run_id"],
      additionalProperties: false,
    },
    annotations: MUTATING,
  },
  {
    name: "rename_run",
    description: "Rename an existing operator or crew run.",
    inputSchema: {
      type: "object",
      properties: {
        target_type: { type: "string", enum: ["operator", "crew"] },
        target_id: { type: "string" },
        run_id: { type: "string" },
        title: { type: "string" },
      },
      required: ["target_type", "target_id", "run_id", "title"],
      additionalProperties: false,
    },
    annotations: MUTATING,
  },
  {
    name: "search_messages",
    description: "Search local workstreams, optionally within one run. Returns at most 100 compact hits.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        run_id: { type: "string", description: "Optional run/workstream ID." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum hits (default: 40)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "wait_for_conversation",
    description: "Wait for an operator or crew run to finish, stall, fail, or require user input.",
    inputSchema: {
      type: "object",
      properties: {
        target_type: { type: "string", enum: ["operator", "crew"] },
        target_id: { type: "string" },
        run_id: { type: "string", description: "Optional run/workstream ID. Defaults to the active run." },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 120, description: "Maximum wait (default: 30 seconds)." },
      },
      required: ["target_type", "target_id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "set_operator_model",
    description: "Change an idle operator to an exact configured provider instance and model.",
    inputSchema: {
      type: "object",
      properties: {
        operator_id: { type: "string", description: "The operator ID." },
        instance_id: { type: "string", description: "The configured provider instance ID." },
        model: { type: "string", description: "The exact model ID exposed by that instance." },
        effort: { type: "string", enum: ["none", "low", "medium", "high", "xhigh", "max"] },
      },
      required: ["operator_id", "instance_id", "model"],
      additionalProperties: false,
    },
    annotations: MUTATING,
  },
  {
    name: "list_available_models",
    description: "List configured model instances and capabilities without exposing local executable paths.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "interrupt_conversation",
    description: "Interrupt the active turn in an operator or crew workstream.",
    inputSchema: {
      type: "object",
      properties: {
        target_type: { type: "string", enum: ["operator", "crew"] },
        target_id: { type: "string" },
      },
      required: ["target_type", "target_id"],
      additionalProperties: false,
    },
    annotations: DESTRUCTIVE,
  },
];

function parsePositiveLimit(raw: ProtocolValue | undefined, fallback = 30, maximum = 200): number {
  const parsed = Math.floor(Number(raw));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function valueHasType(value: ProtocolValue, type: JsonSchemaType): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return objectValue(value) !== null;
  if (type === "integer") {
    const number = numberValue(value);
    return number !== undefined && Number.isInteger(number);
  }
  if (type === "number") return numberValue(value) !== undefined;
  if (type === "string") return stringValue(value) !== undefined;
  if (type === "boolean") return value === true || value === false;
  return false;
}

function schemaError(schema: JsonSchemaNode, value: ProtocolValue, path: string): string | null {
  if (schema.const !== undefined && value !== schema.const) return `${path} must equal ${JSON.stringify(schema.const)}`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(", ")}`;
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => !schemaError(candidate, value, path));
    return matches.length === 1 ? null : `${path} does not match exactly one supported shape`;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => valueHasType(value, type))) return `${path} must be ${types.join(" or ")}`;
  }
  const number = numberValue(value);
  if (number !== undefined) {
    if (schema.minimum !== undefined && number < schema.minimum) return `${path} must be at least ${schema.minimum}`;
    if (schema.maximum !== undefined && number > schema.maximum) return `${path} must be at most ${schema.maximum}`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} needs at least ${schema.minItems} item(s)`;
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      return `${path} must not contain duplicates`;
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const error = schemaError(schema.items, value[index], `${path}[${index}]`);
        if (error) return error;
      }
    }
  }
  const record = objectValue(value);
  if (record !== null) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in record)) return `${path}.${key} is required`;
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(record).find((key) => !(key in properties));
      if (extra) return `${path}.${extra} is not supported`;
    }
    for (const [key, child] of Object.entries(properties)) {
      const childValue = record[key];
      if (childValue === undefined) continue;
      const error = schemaError(child, childValue, `${path}.${key}`);
      if (error) return error;
    }
  }
  return null;
}

export class ToolInputError extends Error {}

export interface ValidatedToolCall {
  name: string;
  args: ProtocolObject;
}

export function validateToolArguments(
  nameValue: ProtocolValue | undefined,
  argsValue: ProtocolValue | undefined,
): ValidatedToolCall {
  const name = stringValue(nameValue);
  if (!name) throw new ToolInputError("tool name must be a non-empty string");
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new ToolInputError(`Unknown tool: ${name}`);
  const args = objectValue(argsValue);
  if (args === null) throw new ToolInputError("tool arguments must be an object");
  const error = schemaError(tool.inputSchema, args, "arguments");
  if (error) throw new ToolInputError(error);
  return { name, args };
}

function stringArg(args: ProtocolObject, key: string, options: { trim?: boolean; allowEmpty?: boolean; max?: number } = {}): string {
  const raw = stringValue(args[key]);
  if (raw === undefined) throw new ToolInputError(`${key} must be a string`);
  const value = options.trim === false ? raw : raw.trim();
  if (!options.allowEmpty && !value) throw new ToolInputError(`${key} must not be empty`);
  if (options.max && value.length > options.max) throw new ToolInputError(`${key} must be at most ${options.max} characters`);
  return value;
}

function optionalStringArg(
  args: ProtocolObject,
  key: string,
  options: { trim?: boolean; allowEmpty?: boolean; max?: number } = {},
): string | undefined {
  if (!(key in args)) return undefined;
  return stringArg(args, key, options);
}

function idArg(args: ProtocolObject, key: string): string {
  const value = stringArg(args, key);
  if (!/^[\w-]+$/.test(value)) throw new ToolInputError(`${key} is not a valid Helmryth ID`);
  return value;
}

function stringArrayArg(args: ProtocolObject, key: string): string[] {
  const parsed = protocolStringListSchema.safeParse(args[key]);
  if (!parsed.success || parsed.data.length === 0 || parsed.data.some((item) => !item.trim())) {
    throw new ToolInputError(`${key} must be a non-empty list of IDs`);
  }
  return [...new Set(parsed.data.map((item) => item.trim()))];
}

function records(value: ProtocolValue | undefined): ProtocolObject[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = objectValue(item);
    return record === null ? [] : [record];
  });
}

function copyValue(target: ProtocolObject, source: ProtocolObject, sourceKey: string, targetKey = sourceKey): void {
  const value = source[sourceKey];
  if (value !== undefined) target[targetKey] = value;
}

function projectTask(task: ProtocolObject, activeThreadId: string | undefined): ProtocolObject {
  const projected: ProtocolObject = {};
  copyValue(projected, task, "threadId", "taskId");
  copyValue(projected, task, "title");
  copyValue(projected, task, "createdAt");
  if (activeThreadId !== undefined) projected.active = task.threadId === activeThreadId;
  if (objectValue(task.usage) !== null) projected.usage = task.usage;
  return projected;
}

function projectBot(bot: ProtocolObject): ProtocolObject {
  const projected: ProtocolObject = {
    section: bot.section ?? null,
    chiefOfStaff: Boolean(bot.chiefOfStaff),
    busy: Boolean(bot.busy),
    unread: Boolean(bot.unread),
    tasks: records(bot.tasks).map((task) => projectTask(task, stringValue(bot.threadId))),
  };
  for (const key of ["id", "name", "title", "description", "modelSelection", "activity"] as const) {
    copyValue(projected, bot, key);
  }
  copyValue(projected, bot, "threadId", "activeTaskId");
  return projected;
}

function projectChannel(channel: ProtocolObject): ProtocolObject {
  const projected: ProtocolObject = {
    section: channel.section ?? null,
    directMessage: Boolean(channel.dm),
    working: Boolean(channel.working),
    busyBotId: channel.busyBotId ?? null,
    tasks: records(channel.tasks).map((task) => projectTask(task, stringValue(channel.threadId))),
  };
  for (const key of ["id", "name", "memberIds", "bulletin", "defaultResponder"] as const) {
    copyValue(projected, channel, key);
  }
  copyValue(projected, channel, "threadId", "activeTaskId");
  return projected;
}

function projectNested(source: ProtocolValue | undefined, keys: readonly string[]): ProtocolObject | undefined {
  const record = objectValue(source);
  if (record === null) return undefined;
  const projected: ProtocolObject = {};
  for (const key of keys) copyValue(projected, record, key);
  return projected;
}

function projectMessage(message: ProtocolObject): ProtocolObject {
  const projected: ProtocolObject = {};
  for (const key of ["id", "at", "role", "kind", "text", "from", "replyToId", "reactions", "steered", "queued"] as const) {
    copyValue(projected, message, key);
  }
  const tool = projectNested(message.tool, ["name", "ok", "spoken", "setup"]);
  const card = projectNested(message.card, ["title", "subtitle", "options", "answered", "dismissed"]);
  const connector = projectNested(message.connector, ["slug", "label", "description", "status", "dismissed", "resumed"]);
  const secret = projectNested(message.secret, ["target", "label", "description", "placeholder", "helpUrl", "provided", "dismissed", "resumed"]);
  if (tool !== undefined) projected.tool = tool;
  if (card !== undefined) projected.card = card;
  if (connector !== undefined) projected.connector = connector;
  if (secret !== undefined) projected.secret = secret;
  if (message.kind === "screen") projected.hasImage = Boolean(message.hasImage || message.png);
  return projected;
}

async function fleet(fetcher: HelmrythFetcher): Promise<ProtocolObject> {
  return objectValue(await fetcher("/api/bots?messages=0")) ?? {};
}

function taskBelongsTo(owner: ProtocolObject, taskId: string): boolean {
  return owner.threadId === taskId || records(owner.tasks).some((task) => task.threadId === taskId);
}

function messageNeedsInput(message: ProtocolObject): boolean {
  const cardRecord = objectValue(message.card);
  const connectorRecord = objectValue(message.connector);
  const secretRecord = objectValue(message.secret);
  const card = cardRecord !== null && Boolean(cardRecord.requestId) && !cardRecord.answered && !cardRecord.dismissed;
  const connector = connectorRecord !== null &&
    !connectorRecord.dismissed &&
    !connectorRecord.resumed &&
    connectorRecord.status !== "connected";
  const secret = secretRecord !== null && !secretRecord.provided && !secretRecord.dismissed;
  return Boolean(card || connector || secret);
}

function dispatchFailedAfterLatestUser(messages: ProtocolObject[]): boolean {
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  const turnMessages = messages.slice(lastUser + 1);
  if (turnMessages.some((message) => {
    const text = stringValue(message.text);
    return message.role === "bot" && message.kind === "text" && Boolean(text?.trim());
  })) {
    return false;
  }
  return turnMessages.some((message) => {
    const tool = objectValue(message.tool);
    const name = stringValue(tool?.name);
    return message.kind === "activity" && tool?.ok === false && name !== undefined && /^error:/i.test(name.trim());
  });
}

interface ConversationTail {
  raw: ProtocolObject[];
  messages: ProtocolObject[];
  hasMore: boolean;
}

async function conversationTail(
  fetcher: HelmrythFetcher,
  taskId: string,
  limit = 10,
): Promise<ConversationTail> {
  const page = objectValue(await fetcher(`/api/threads/${encodeURIComponent(taskId)}/messages?limit=${limit}`)) ?? {};
  const raw = records(page.messages);
  return {
    raw,
    messages: raw.map(projectMessage),
    hasMore: Boolean(page.hasMore),
  };
}

interface AudienceResponderSelection extends ProtocolObject {
  kind: "everyone" | "mentions";
}

interface MemberResponderSelection extends ProtocolObject {
  kind: "member";
  botId: string;
}

type ResponderSelection = AudienceResponderSelection | MemberResponderSelection;

function normalizeResponder(value: ProtocolValue | undefined): ResponderSelection | undefined {
  if (value === undefined) return undefined;
  const record = objectValue(value);
  if (record === null) throw new ToolInputError("default_responder must be an object");
  if (record.kind === "everyone" || record.kind === "mentions") return { kind: record.kind };
  const operatorId = stringValue(record.operator_id)?.trim();
  if (record.kind === "member" && operatorId) {
    return { kind: "member", botId: operatorId };
  }
  throw new ToolInputError("default_responder is invalid");
}

async function checkedModelSelection(
  args: ProtocolObject,
  fetcher: HelmrythFetcher,
): Promise<ProtocolObject> {
  const instanceId = stringArg(args, "instance_id");
  const model = stringArg(args, "model");
  const effort = optionalStringArg(args, "effort");
  const described = objectValue(await fetcher("/api/instances")) ?? {};
  const instance = records(described.instances).find((candidate) => candidate.instanceId === instanceId);
  if (!instance) throw new ToolInputError(`model instance not found: ${instanceId}`);
  if (objectValue(instance.snapshot)?.state !== "available") throw new ToolInputError(`model instance is unavailable: ${instanceId}`);
  const models = objectValue(instance.models) ?? {};
  const offered = records(models.options).flatMap((option) => {
    const id = stringValue(option.id);
    return id === undefined ? [] : [id];
  });
  if (models.default !== model && !offered.includes(model)) {
    throw new ToolInputError(`model '${model}' is not offered by instance '${instanceId}'`);
  }
  const effortsValue = objectValue(instance.capabilities)?.effortLevels;
  const efforts = protocolStringListSchema.safeParse(effortsValue);
  if (effort && (!efforts.success || !efforts.data.includes(effort))) {
    throw new ToolInputError(`effort '${effort}' is not offered by instance '${instanceId}'`);
  }
  const selection: ProtocolObject = { instanceId, model };
  if (effort) selection.effort = effort;
  return selection;
}

function taskRoute(targetType: ProtocolValue | undefined, targetId: string): string {
  if (targetType === "operator") return `/api/bots/${encodeURIComponent(targetId)}/tasks`;
  if (targetType === "crew") return `/api/groups/${encodeURIComponent(targetId)}/tasks`;
  throw new ToolInputError("target_type must be operator or crew");
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Request cancelled"));
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("Request cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function handleToolCall(
  name: string,
  args: ProtocolObject,
  baseFetcher: HelmrythFetcher = request,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const fetcher = signal
    ? (path: string, options: RequestInit = {}) => baseFetcher(path, { ...options, signal: options.signal ?? signal })
    : baseFetcher;
  validateToolArguments(name, args);
  switch (name) {
    case "get_system_health": {
      const res = objectValue(await fetcher("/api/health")) ?? {};
      if (res.app !== "helmryth") throw new Error("The configured endpoint is not an Helmryth server");
      return {
        status: "connected",
        endpoint: discoveredBaseUrl ?? HELMRYTH_BASE_URL,
        app: "helmryth",
        packaged: Boolean(res.static),
      };
    }

    case "list_operators": {
      const res = await fleet(fetcher);
      return { operators: records(res.bots).map(projectBot) };
    }

    case "get_operator_messages": {
      const botId = idArg(args, "operator_id");
      const res = await fleet(fetcher);
      const bot = records(res.bots).find((candidate) => candidate.id === botId);
      if (!bot) throw new Error(`Operator not found: ${botId}`);
      const taskId = args.run_id === undefined ? String(bot.threadId) : idArg(args, "run_id");
      if (!taskBelongsTo(bot, taskId)) throw new Error(`Run '${taskId}' does not belong to operator '${botId}'`);
      const limit = parsePositiveLimit(args.limit, 30, 200);
      const page = objectValue(await fetcher(`/api/threads/${encodeURIComponent(taskId)}/messages?limit=${limit}`)) ?? {};
      return {
        operator: projectBot(bot),
        runId: taskId,
        messages: records(page.messages).map(projectMessage),
        hasMore: Boolean(page.hasMore),
      };
    }

    case "send_operator_message": {
      const botId = idArg(args, "operator_id");
      const text = stringArg(args, "text", { trim: true, max: 100_000 });
      const state = await fleet(fetcher);
      const bot = records(state.bots).find((candidate) => candidate.id === botId);
      if (!bot) throw new Error(`Operator not found: ${botId}`);
      const taskId = args.run_id === undefined ? String(bot.threadId) : idArg(args, "run_id");
      if (!taskBelongsTo(bot, taskId)) throw new Error(`Run '${taskId}' does not belong to operator '${botId}'`);
      if (bot.threadId !== taskId) {
        throw new Error(`Run '${taskId}' is not active for operator '${botId}'. Switch to it before sending.`);
      }
      const busyChannel = records(state.groups).find((channel) => channel.busyBotId === botId);
      if (busyChannel) {
        throw new Error(`Operator '${botId}' is working in crew '${busyChannel.id}'. Send to or interrupt that crew instead.`);
      }
      await fetcher(`/api/bots/${encodeURIComponent(botId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ text, threadId: taskId }),
      });
      return { success: true, operatorId: botId, runId: taskId };
    }

    case "create_operator": {
      const name = stringArg(args, "name", { max: 100 });
      const title = optionalStringArg(args, "title", { trim: false, allowEmpty: true, max: 200 });
      const description = optionalStringArg(args, "description", { trim: false, allowEmpty: true, max: 4_000 });
      const section = optionalStringArg(args, "section", { max: 60 });
      const wantsModel = args.instance_id !== undefined || args.model !== undefined || args.effort !== undefined;
      if (wantsModel && (args.instance_id === undefined || args.model === undefined)) {
        throw new ToolInputError("instance_id and model must be provided together");
      }
      const selection = wantsModel ? await checkedModelSelection(args, fetcher) : undefined;
      const createBody: ProtocolObject = { name };
      if (title !== undefined) createBody.title = title;
      if (description !== undefined) createBody.description = description;
      if (section !== undefined) createBody.section = section;
      if (selection !== undefined) {
        createBody.modelSelection = selection;
        createBody.requireAvailableModel = true;
      }
      const created = objectValue(await fetcher("/api/bots", {
        method: "POST",
        body: JSON.stringify(createBody),
      })) ?? {};
      const createdBot = objectValue(created.bot);
      if (createdBot === null || stringValue(createdBot.id) === undefined) {
        throw new Error("Helmryth did not return the created operator");
      }
      return { success: true, operator: projectBot(createdBot) };
    }

    case "update_operator_profile": {
      const botId = idArg(args, "operator_id");
      const patch: ProtocolObject = {};
      if (args.name !== undefined) patch.name = stringArg(args, "name", { max: 100 });
      if (args.title !== undefined) patch.title = stringArg(args, "title", { trim: false, allowEmpty: true, max: 200 });
      if (args.description !== undefined) patch.description = stringArg(args, "description", { trim: false, allowEmpty: true, max: 4_000 });
      if ("section" in args) patch.section = args.section === null ? null : stringArg(args, "section", { max: 60 });
      if (!Object.keys(patch).length) throw new ToolInputError("provide at least one profile field to update");
      const result = objectValue(await fetcher(`/api/bots/${encodeURIComponent(botId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      })) ?? {};
      const updatedBot = objectValue(result.bot);
      if (updatedBot === null) {
        throw new Error("Helmryth did not return the updated operator");
      }
      return { success: true, operator: projectBot(updatedBot) };
    }

    case "list_crews": {
      const res = await fleet(fetcher);
      return { crews: records(res.groups).map(projectChannel) };
    }

    case "get_crew_messages": {
      const channelId = idArg(args, "crew_id");
      const res = await fleet(fetcher);
      const channel = records(res.groups).find((candidate) => candidate.id === channelId);
      if (!channel) throw new Error(`Crew not found: ${channelId}`);
      const taskId = args.run_id === undefined ? String(channel.threadId) : idArg(args, "run_id");
      if (!taskBelongsTo(channel, taskId)) throw new Error(`Run '${taskId}' does not belong to crew '${channelId}'`);
      const limit = parsePositiveLimit(args.limit, 30, 200);
      const page = objectValue(await fetcher(`/api/threads/${encodeURIComponent(taskId)}/messages?limit=${limit}`)) ?? {};
      return {
        crew: projectChannel(channel),
        runId: taskId,
        messages: records(page.messages).map(projectMessage),
        hasMore: Boolean(page.hasMore),
      };
    }

    case "send_crew_message": {
      const channelId = idArg(args, "crew_id");
      const text = stringArg(args, "text", { trim: true, max: 100_000 });
      const state = await fleet(fetcher);
      const channel = records(state.groups).find((candidate) => candidate.id === channelId);
      if (!channel) throw new Error(`Crew not found: ${channelId}`);
      const taskId = args.run_id === undefined ? String(channel.threadId) : idArg(args, "run_id");
      if (!taskBelongsTo(channel, taskId)) {
        throw new Error(`Run '${taskId}' does not belong to crew '${channelId}'`);
      }
      if (channel.threadId !== taskId) {
        throw new Error(`Run '${taskId}' is not active for crew '${channelId}'. Switch to it before sending.`);
      }
      await fetcher(`/api/groups/${encodeURIComponent(channelId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ text, threadId: taskId }),
      });
      return { success: true, crewId: channelId, runId: taskId };
    }

    case "create_crew": {
      const name = stringArg(args, "name", { max: 100 });
      const memberIds = stringArrayArg(args, "member_ids");
      const section = optionalStringArg(args, "section", { max: 60 });
      const bulletin = optionalStringArg(args, "bulletin", { trim: false, allowEmpty: true, max: 12_000 }) ?? "";
      const requestedResponder = normalizeResponder(args.default_responder);
      if (requestedResponder?.kind === "member" && !memberIds.includes(requestedResponder.botId)) {
        throw new ToolInputError("default_responder operator must be a crew member");
      }
      const firstMemberId = memberIds[0];
      if (firstMemberId === undefined) throw new ToolInputError("member_ids must contain at least one operator");
      const responder: ResponderSelection = requestedResponder ?? { kind: "member", botId: firstMemberId };
      const createBody: ProtocolObject = {
        name,
        memberIds,
        setup: { bulletin, defaultResponder: responder },
      };
      if (section) createBody.section = section;
      const created = objectValue(await fetcher("/api/groups", {
        method: "POST",
        body: JSON.stringify(createBody),
      })) ?? {};
      const createdGroup = objectValue(created.group);
      if (createdGroup === null || stringValue(createdGroup.id) === undefined) {
        throw new Error("Helmryth did not return the created crew");
      }
      return { success: true, crew: projectChannel(createdGroup) };
    }

    case "update_crew": {
      const channelId = idArg(args, "crew_id");
      const patch: ProtocolObject = {};
      let memberIds: string[] | undefined;
      let responder: ResponderSelection | undefined;
      if (args.name !== undefined) patch.name = stringArg(args, "name", { max: 100 });
      if (args.member_ids !== undefined) {
        memberIds = stringArrayArg(args, "member_ids");
        patch.memberIds = memberIds;
      }
      if (args.section !== undefined) patch.section = args.section === null ? null : stringArg(args, "section", { max: 60 });
      if (args.bulletin !== undefined) patch.bulletin = stringArg(args, "bulletin", { trim: false, allowEmpty: true, max: 12_000 });
      if (args.default_responder !== undefined) {
        responder = normalizeResponder(args.default_responder);
        if (responder !== undefined) patch.defaultResponder = responder;
      }
      if (Object.keys(patch).length === 0) throw new ToolInputError("Provide at least one crew field to update");
      if (memberIds && responder?.kind === "member" && !memberIds.includes(responder.botId)) {
        throw new ToolInputError("default_responder operator must be a crew member");
      }
      const result = objectValue(await fetcher(`/api/groups/${encodeURIComponent(channelId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      })) ?? {};
      const updatedGroup = objectValue(result.group);
      if (updatedGroup === null) {
        throw new Error("Helmryth did not return the updated crew");
      }
      return { success: true, crew: projectChannel(updatedGroup) };
    }

    case "create_run": {
      const targetId = idArg(args, "target_id");
      const title = optionalStringArg(args, "title", { max: 80 });
      const route = taskRoute(args.target_type, targetId);
      const result = objectValue(await fetcher(route, { method: "POST", body: JSON.stringify(title ? { title } : {}) })) ?? {};
      const createdTask = objectValue(result.task);
      if (createdTask === null || stringValue(createdTask.threadId) === undefined) {
        throw new Error("Helmryth did not return the created run");
      }
      const activeTaskId = stringValue(objectValue(result.bot)?.threadId) ??
        stringValue(objectValue(result.group)?.threadId) ??
        stringValue(createdTask.threadId);
      return {
        success: true,
        targetType: args.target_type,
        targetId,
        run: projectTask(createdTask, activeTaskId),
      };
    }

    case "switch_run": {
      const targetId = idArg(args, "target_id");
      const taskId = idArg(args, "run_id");
      const route = taskRoute(args.target_type, targetId);
      const result = objectValue(await fetcher(`${route}/${encodeURIComponent(taskId)}?messages=0`, {
        method: "POST",
        body: "{}",
      })) ?? {};
      const target = args.target_type === "operator" ? result.bot : result.group;
      const response: ProtocolObject = {
        success: true,
        targetType: args.target_type,
        targetId,
        runId: taskId,
      };
      const targetRecord = objectValue(target);
      if (targetRecord !== null) {
        response.target = args.target_type === "operator" ? projectBot(targetRecord) : projectChannel(targetRecord);
      }
      return response;
    }

    case "rename_run": {
      const targetId = idArg(args, "target_id");
      const taskId = idArg(args, "run_id");
      const title = stringArg(args, "title", { max: 80 });
      const route = taskRoute(args.target_type, targetId);
      const result = objectValue(await fetcher(`${route}/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      })) ?? {};
      const renamedTask = objectValue(result.task);
      if (renamedTask === null) {
        throw new Error("Helmryth did not return the renamed run");
      }
      return {
        success: true,
        targetType: args.target_type,
        targetId,
        run: projectTask(renamedTask, undefined),
      };
    }

    case "search_messages": {
      const query = stringArg(args, "query", { max: 500 });
      const limit = parsePositiveLimit(args.limit, 40, 100);
      const params = new URLSearchParams({ q: query, limit: String(limit) });
      if (args.run_id !== undefined) params.set("threadId", idArg(args, "run_id"));
      const result = objectValue(await fetcher(`/api/search?${params.toString()}`)) ?? {};
      return { hits: records(result.hits) };
    }

    case "wait_for_conversation": {
      const targetType = args.target_type;
      if (targetType !== "operator" && targetType !== "crew") {
        throw new ToolInputError("target_type must be operator or crew");
      }
      const targetId = idArg(args, "target_id");
      const timeoutSeconds = parsePositiveLimit(args.timeout_seconds, 30, 120);
      const deadline = Date.now() + timeoutSeconds * 1_000;
      const startupGraceDeadline = Math.min(deadline, Date.now() + 750);
      let state = await fleet(fetcher);
      const collection = targetType === "operator" ? records(state.bots) : records(state.groups);
      let target = collection.find((candidate) => candidate.id === targetId);
      if (!target) throw new Error(`${targetType === "operator" ? "Operator" : "Crew"} not found: ${targetId}`);
      const taskId = args.run_id === undefined ? String(target.threadId) : idArg(args, "run_id");
      if (!taskBelongsTo(target, taskId)) {
        throw new Error(`Run '${taskId}' does not belong to ${targetType} '${targetId}'`);
      }
      let sawBusy = false;
      while (true) {
        const liveCollection = targetType === "operator" ? records(state.bots) : records(state.groups);
        target = liveCollection.find((candidate) => candidate.id === targetId);
        if (!target) throw new Error(`${targetType === "operator" ? "Operator" : "Crew"} not found: ${targetId}`);
        if (!taskBelongsTo(target, taskId)) {
          throw new Error(`Run '${taskId}' no longer belongs to ${targetType} '${targetId}'`);
        }
        const projectedTarget = targetType === "operator" ? projectBot(target) : projectChannel(target);
        const terminal = async (status: string, existingTail?: Awaited<ReturnType<typeof conversationTail>>) => {
          const tail = existingTail ?? await conversationTail(fetcher, taskId);
          const needsInput = tail.raw.some(messageNeedsInput);
          const terminalStatus = status === "settled" && dispatchFailedAfterLatestUser(tail.raw)
            ? "failed"
            : status;
          return {
            status: needsInput ? "needs-user" : terminalStatus,
            targetType,
            targetId,
            runId: taskId,
            target: projectedTarget,
            messages: tail.messages,
            hasMore: tail.hasMore,
          };
        };

        // Historical tasks cannot be running: all provider turns are bound
        // to the owner's active thread, and task switching is blocked while busy.
        if (target.threadId !== taskId) return terminal("settled");

        if (targetType === "operator") {
          const busyChannel = records(state.groups).find((channel) => channel.busyBotId === targetId);
          if (busyChannel) {
            throw new Error(`Operator '${targetId}' is working in crew '${busyChannel.id}'. Wait on that crew instead.`);
          }
          if (target.activity === "waiting-on-you") return terminal("needs-user");
          if (target.activity === "dead") return terminal("failed");
          if (target.activity === "no-signal") return terminal("stalled");
          if (!target.busy) return terminal("settled");
          sawBusy = true;
        } else {
          const tail = await conversationTail(fetcher, taskId);
          if (tail.raw.some(messageNeedsInput)) {
            return terminal("needs-user", tail);
          }
          const channelWorking = target.working === true || Boolean(target.busyBotId);
          if (channelWorking) {
            sawBusy = true;
            const busyBotId = target.busyBotId;
            if (busyBotId) {
              const speaker = records(state.bots).find((bot) => bot.id === busyBotId);
              if (!speaker) return terminal("stalled");
              if (speaker.activity === "waiting-on-you") return terminal("needs-user");
              if (speaker.activity === "dead") return terminal("failed");
              if (speaker.activity === "no-signal") return terminal("stalled");
            }
          } else {
            const latest = tail.raw.at(-1);
            // New servers expose `working` synchronously before returning a
            // channel send. The short grace remains only for older servers
            // that have no operation-level field and report a user message
            // just before their first speaker becomes busy.
            if (sawBusy || target.working === false || latest?.role !== "user") {
              return terminal("settled", tail);
            }
            if (Date.now() >= startupGraceDeadline) {
              return terminal("settled", tail);
            }
          }
        }

        if (Date.now() >= deadline) return terminal("timed-out");
        await sleep(Math.min(500, Math.max(0, deadline - Date.now())), signal);
        state = await fleet(fetcher);
      }
    }

    case "set_operator_model": {
      const botId = idArg(args, "operator_id");
      const current = await fleet(fetcher);
      const bot = records(current.bots).find((candidate) => candidate.id === botId);
      if (!bot) throw new Error(`Operator not found: ${botId}`);
      if (bot.busy) throw new Error("Interrupt the operator or let it finish before changing its model");
      const selection = await checkedModelSelection(args, fetcher);
      const res = objectValue(await fetcher(`/api/bots/${encodeURIComponent(botId)}`, {
        method: "PATCH",
        body: JSON.stringify({ modelSelection: selection, requireAvailableModel: true }),
      })) ?? {};
      const updatedBot = objectValue(res.bot);
      if (updatedBot === null) throw new Error("Helmryth did not return the updated operator");
      return { success: true, operator: projectBot(updatedBot) };
    }

    case "list_available_models": {
      const res = objectValue(await fetcher("/api/instances")) ?? {};
      return {
        instances: records(res.instances).map((instance) => {
          const projected: ProtocolObject = {};
          for (const key of ["instanceId", "driverKind", "displayName", "models", "capabilities", "access"] as const) {
            copyValue(projected, instance, key);
          }
          const snapshot = objectValue(instance.snapshot);
          const projectedSnapshot: ProtocolObject = {};
          if (snapshot !== null) copyValue(projectedSnapshot, snapshot, "state");
          projected.snapshot = projectedSnapshot;
          return projected;
        }),
      };
    }

    case "interrupt_conversation": {
      const targetType = args.target_type;
      if (targetType !== "operator" && targetType !== "crew") {
        throw new ToolInputError("target_type must be operator or crew");
      }
      const targetId = idArg(args, "target_id");
      const current = await fleet(fetcher);
      const target = (targetType === "operator" ? records(current.bots) : records(current.groups))
        .find((candidate) => candidate.id === targetId);
      if (!target) throw new Error(`${targetType === "operator" ? "Operator" : "Crew"} not found: ${targetId}`);
      const taskId = String(target.threadId);
      if (targetType === "operator") {
        const busyChannel = records(current.groups).find((channel) => channel.busyBotId === targetId);
        if (busyChannel) {
          throw new Error(`Operator '${targetId}' is working in crew '${busyChannel.id}'. Interrupt that crew instead.`);
        }
      }
      const route = targetType === "operator" ? "bots" : "groups";
      await fetcher(`/api/${route}/${encodeURIComponent(targetId)}/interrupt`, {
        method: "POST",
        body: JSON.stringify({ threadId: taskId }),
      });
      return { success: true, targetType, targetId, runId: taskId };
    }

    default:
      throw new ToolInputError(`Unknown tool: ${name}`);
  }
}

export function formatResponse(id: McpRequestId | null, result?: ToolResult, error?: JsonRpcErrorOptions): string {
  const payload: ProtocolObject = { jsonrpc: "2.0", id: id ?? null };
  if (error) {
    payload.error = {
      code: error.code ?? -32603,
      message: error.message ?? "Internal error",
    };
  } else {
    payload.result = result;
  }
  return JSON.stringify(payload);
}

const activeMcpRequests = new Map<McpRequestId, AbortController>();
const activeMcpControllers = new Set<AbortController>();

export async function processMcpMessage(
  raw: string,
  toolHandler: typeof handleToolCall = handleToolCall,
): Promise<string | null> {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let decoded: ProtocolValue;
  try {
    decoded = parseJson(trimmed);
  } catch {
    return formatResponse(null, undefined, { code: -32700, message: "Parse error" });
  }

  const message = objectValue(decoded);
  if (message === null) {
    return formatResponse(null, undefined, { code: -32600, message: "Invalid Request" });
  }

  if (message.jsonrpc !== "2.0") {
    return formatResponse(null, undefined, { code: -32600, message: "Invalid Request: missing or invalid jsonrpc version" });
  }

  const hasId = "id" in message && message.id !== undefined;
  const parsedId = requestIdValue(message.id);
  if (hasId && parsedId === undefined) {
    return formatResponse(null, undefined, { code: -32600, message: "Invalid Request: id must be a string or number" });
  }

  const isNotification = !hasId;
  const id = isNotification ? null : parsedId ?? null;
  const method = stringValue(message.method);
  const params = message.params;

  if (method === undefined) {
    if (isNotification) return null;
    return formatResponse(id, undefined, { code: -32600, message: "Invalid Request: method is required" });
  }

  try {
    if (method === "notifications/cancelled") {
      const requestId = requestIdValue(objectValue(params)?.requestId);
      if (requestId !== undefined) {
        activeMcpRequests.get(requestId)?.abort(new DOMException("Request cancelled", "AbortError"));
      }
      return null;
    }

    if (method === "initialize") {
      if (isNotification) return null;
      const parsedParams = initializeParamsSchema.safeParse(params);
      if (!parsedParams.success) {
        return formatResponse(id, undefined, {
          code: -32602,
          message: "Invalid params: protocolVersion, capabilities, and clientInfo name/version are required",
        });
      }
      const supportedVersions = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
      const protocolVersion = supportedVersions.includes(parsedParams.data.protocolVersion)
        ? parsedParams.data.protocolVersion
        : supportedVersions[supportedVersions.length - 1];
      return formatResponse(id, {
        protocolVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "helmryth-mcp",
          version: "1.1.0",
        },
        instructions: "Use bounded read tools before mutating the Helmryth team. Approval grants, deletion, and computer lifecycle are intentionally unavailable.",
      });
    }

    if (method === "notifications/initialized") {
      log("MCP client initialized session");
      return null;
    }

    if (method === "ping") {
      if (isNotification) return null;
      return formatResponse(id, {});
    }

    if (method === "tools/list") {
      if (isNotification) return null;
      return formatResponse(id, { tools: TOOLS });
    }

    if (method === "tools/call") {
      const callParams = objectValue(params);
      if (callParams === null) {
        if (isNotification) return null;
        return formatResponse(id, undefined, { code: -32602, message: "Invalid params: tools/call expects an object" });
      }
      let call: ValidatedToolCall;
      try {
        call = validateToolArguments(callParams.name, callParams.arguments ?? {});
      } catch (error) {
        if (isNotification) return null;
        return formatResponse(id, undefined, {
          code: -32602,
          message: `Invalid params: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      const controller = new AbortController();
      activeMcpControllers.add(controller);
      if (!isNotification && id !== null) activeMcpRequests.set(id, controller);
      let result: ToolResult;
      try {
        result = await toolHandler(call.name, call.args, request, controller.signal);
      } finally {
        activeMcpControllers.delete(controller);
        if (!isNotification && id !== null && activeMcpRequests.get(id) === controller) {
          activeMcpRequests.delete(id);
        }
      }
      if (isNotification) return null;
      const toolResponse: ProtocolObject = {
        content: [
          {
            type: "text",
            text: stringValue(result) ?? JSON.stringify(result, null, 2),
          },
        ],
      };
      const structuredContent = objectValue(result);
      if (structuredContent !== null) toolResponse.structuredContent = structuredContent;
      return formatResponse(id, toolResponse);
    }

    if (isNotification) return null;
    return formatResponse(id, undefined, { code: -32601, message: `Method not found: ${method}` });
  } catch (error) {
    const caught = error instanceof Error ? error : new Error(String(error));
    if ((caught.name === "AbortError" || caught.message === "Request cancelled") && !isNotification) {
      return formatResponse(id, undefined, { code: -32800, message: "Request cancelled" });
    }
    log(`Error handling ${method}: ${caught.message}`);
    if (caught instanceof ToolInputError && !isNotification) {
      return formatResponse(id, undefined, { code: -32602, message: `Invalid params: ${caught.message}` });
    }
    if (!isNotification) {
      return formatResponse(id, {
        content: [
          {
            type: "text",
            text: `Error: ${caught.message}`,
          },
        ],
        isError: true,
      });
    }
    return null;
  }
}

// Start stdio interface when executed directly
if (process.argv[1] && (process.argv[1].endsWith("mcp-server.ts") || process.argv[1].endsWith("mcp-server.js"))) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  const activeRequests = new Set<Promise<void>>();

  rl.on("line", (line) => {
    const task = (async () => {
      try {
        const response = await processMcpMessage(line);
        if (response) {
          process.stdout.write(response + "\n");
        }
      } catch (err) {
        log(`Error processing line: ${err}`);
      }
    })();
    activeRequests.add(task);
    task.finally(() => {
      activeRequests.delete(task);
    });
  });

  rl.on("close", async () => {
    for (const controller of activeMcpControllers) {
      controller.abort(new DOMException("Request cancelled", "AbortError"));
    }
    if (activeRequests.size > 0) {
      await Promise.allSettled(Array.from(activeRequests));
    }
    // Do not force an exit here: stdout may still be flushing the final
    // JSON-RPC frame. With stdin and readline closed, Node exits naturally
    // once that buffered write has drained.
    process.exitCode = 0;
  });

  log("Helmryth MCP server running on stdio");
}
