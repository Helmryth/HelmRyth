// pi-mcp-extension — the Pi-side half of "hands" for the pi engine.
//
// Pi core deliberately ships no MCP client (see pi's docs: "does not include
// built-in MCP"). This extension is that client: loaded into the per-turn
// `pi --mode rpc --no-session` process via `-e`, it reads a JSON file whose
// path is handed in through HELMRYTH_MCP_CONFIG and mounts every server described
// there as first-class pi tools (pi.registerTool). Helmryth ships this file
// and the pi driver spawns it — the pi repo itself is never touched.
//
// Protocol: the Helmryth proxies speak raw JSON-RPC 2.0 over stdio, one
// frame per line (no MCP SDK, no Content-Length framing) — see
// server/mcp-bridge.ts and server/drivers/agents-proxy.ts. This client matches
// that exactly.
import { Type, type TObjectOptions, type TSchema, type TSchemaOptions } from "typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";

type JsonPrimitive = string | number | boolean | null;

interface JsonObject {
  [key: string]: JsonValue;
}

type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

interface McpServerDef {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** "local-computer" marks the user's real host desktop: every tool on such
   * a server is gated behind a permission card before it executes. */
  scope?: string;
}

interface McpConfig {
  mcpServers: Record<string, McpServerDef>;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: JsonValue;
}

interface PiTextContent {
  type: "text";
  text: string;
}

interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

type PiToolContent = PiTextContent | PiImageContent;

type PiToolArguments = JsonObject;

interface PiToolUpdate {
  content: PiToolContent[];
  details: JsonObject;
}

type PiToolUpdateHandler = (update: PiToolUpdate) => void;

interface PiToolResult {
  content: PiToolContent[];
  details: Record<string, never>;
}

interface PiToolContext {
  ui: {
    confirm(title: string, message: string): Promise<boolean>;
  };
}

interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute(
    toolCallId: string,
    params: PiToolArguments,
    signal: AbortSignal | undefined,
    onUpdate: PiToolUpdateHandler | undefined,
    context: PiToolContext,
  ): Promise<PiToolResult>;
}

/** Structural slice of Pi 0.84's ExtensionAPI used by this standalone file.
 * Keeping it local avoids bundling Pi into Helmryth; the extension is
 * loaded by the user's installed Pi, which supplies the real implementation. */
interface PiExtensionApi {
  registerTool(definition: PiToolDefinition): void;
  on(event: "session_shutdown", handler: () => void): void;
}

const MCP_STARTUP_TIMEOUT_MS = 8_000;
const MCP_TOOL_TIMEOUT_MS = 10 * 60_000;
const MCP_MAX_LIST_PAGES = 100;
const MCP_MAX_FRAME_BYTES = 32 * 1024 * 1024;
const TOOL_OUTPUT_MAX_BYTES = 50 * 1024;
const TOOL_OUTPUT_MAX_LINES = 2_000;
const TOOL_NAME_MAX_LENGTH = 64;

type JsonRpcId = string | number | null;
type McpCallResult = JsonValue | undefined;

interface PendingMcpRequest {
  resolve(value: McpCallResult): void;
  reject(error: Error): void;
}

interface McpInboundFrame {
  id?: JsonRpcId;
  method?: string;
  hasError: boolean;
  errorMessage?: string;
  result?: JsonValue;
}

interface JsonRpcRequestFrame {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: JsonObject;
}

interface JsonRpcNotificationFrame {
  jsonrpc: "2.0";
  method: string;
  params?: JsonObject;
}

interface JsonRpcErrorResponseFrame {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
  };
}

type JsonRpcOutboundFrame = JsonRpcRequestFrame | JsonRpcNotificationFrame | JsonRpcErrorResponseFrame;

interface McpToolsPage {
  tools: Array<McpTool | null>;
  nextCursor?: string;
}

interface McpToolCallResult {
  content: JsonValue[];
  isError: boolean;
}

/** JSON.parse without a reviver can only produce JSON-compatible values. */
function parseJson(text: string): JsonValue {
  return JSON.parse(text);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && !Array.isArray(value) && Object.prototype.toString.call(value) === "[object Object]";
}

function isJsonString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isJsonNumber(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]";
}

function isJsonBoolean(value: JsonValue | undefined): value is boolean {
  return Object.prototype.toString.call(value) === "[object Boolean]";
}

function jsonString(value: JsonValue | undefined): string | undefined {
  return isJsonString(value) ? value : undefined;
}

function jsonStringArray(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value) || !value.every(isJsonString)) return undefined;
  return value;
}

function isJsonRpcId(value: JsonValue | undefined): value is JsonRpcId {
  return value === null || isJsonString(value) || isJsonNumber(value);
}

function parseMcpInboundFrame(value: JsonValue): McpInboundFrame | null {
  if (!isJsonObject(value)) return null;
  const frame: McpInboundFrame = { hasError: isJsonObject(value.error) };
  if (isJsonRpcId(value.id)) frame.id = value.id;
  const method = jsonString(value.method);
  if (method !== undefined) frame.method = method;
  if (isJsonObject(value.error)) {
    const message = jsonString(value.error.message);
    if (message !== undefined) frame.errorMessage = message;
  }
  if (value.result !== undefined) frame.result = value.result;
  return frame;
}

function parseMcpTool(value: JsonValue): McpTool | null {
  if (!isJsonObject(value)) return null;
  const name = jsonString(value.name);
  if (!name?.trim()) return null;
  const tool: McpTool = { name };
  const description = jsonString(value.description);
  if (description !== undefined) tool.description = description;
  if (value.inputSchema !== undefined) tool.inputSchema = value.inputSchema;
  return tool;
}

function parseMcpToolsPage(value: McpCallResult): McpToolsPage {
  if (!isJsonObject(value) || !Array.isArray(value.tools)) {
    throw new Error("MCP tools/list returned no tools array");
  }
  const page: McpToolsPage = { tools: value.tools.map(parseMcpTool) };
  const nextCursor = jsonString(value.nextCursor);
  if (nextCursor) page.nextCursor = nextCursor;
  return page;
}

function parseMcpToolCallResult(value: McpCallResult): McpToolCallResult {
  if (!isJsonObject(value)) return { content: [], isError: false };
  return {
    content: Array.isArray(value.content) ? value.content : [],
    isError: value.isError === true,
  };
}

/** A minimal stdio JSON-RPC 2.0 MCP client, matched to Helmryth's
 * newline-delimited house protocol. */
export class StdioMcp {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private nextId = 1;
  private disposed = false;
  private pending = new Map<number, PendingMcpRequest>();

  constructor(def: McpServerDef) {
    this.child = spawn(def.command, def.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...def.env },
    });
    this.child.stderr.on("data", () => {
      /* best-effort drain so a chatty server never blocks */
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.on("error", (err) => this.closeWithError(err));
    // A server that starts and then dies emits `exit`, never `error`; without
    // settling on it, an in-flight init/listTools would hang the extension
    // load for the whole turn.
    this.child.on("exit", (code) => this.closeWithError(new Error(`MCP server exited (code ${code ?? "?"})`)));
    // A write to a dead child errors asynchronously on the stream; an
    // unhandled stream error would kill the pi process (the same hazard
    // spawnCli documents for driver-spawned children in procs.ts).
    this.child.stdin.on("error", () => this.closeWithError(new Error("MCP server stdin closed")));
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private closeWithError(err: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(err);
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MCP_MAX_FRAME_BYTES) {
        this.closeWithError(new Error(`MCP frame exceeded ${MCP_MAX_FRAME_BYTES} bytes`));
        return;
      }
      let decoded: JsonValue;
      try {
        decoded = parseJson(line);
      } catch {
        continue;
      }
      const msg = parseMcpInboundFrame(decoded);
      if (msg === null) continue;
      if (isJsonNumber(msg.id) && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        this.pending.delete(msg.id);
        if (msg.hasError) pending.reject(new Error(msg.errorMessage ?? "MCP error"));
        else pending.resolve(msg.result);
        continue;
      }
      // This minimal client does not implement server→client requests. Reply
      // explicitly instead of leaving a conforming server waiting forever.
      if (msg.id !== undefined && msg.method !== undefined) {
        try {
          this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Client method not supported" } });
        } catch (err) {
          this.closeWithError(err instanceof Error ? err : new Error(String(err)));
          return;
        }
      }
      // Notifications (e.g. notifications/tools/list_changed) are intentionally
      // ignored for this single-shot mount.
    }
    if (Buffer.byteLength(this.buf, "utf8") > MCP_MAX_FRAME_BYTES) {
      this.closeWithError(new Error(`MCP frame exceeded ${MCP_MAX_FRAME_BYTES} bytes without a newline`));
    }
  }

  private write(frame: JsonRpcOutboundFrame): void {
    if (this.disposed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new Error("MCP server stdin is closed");
    }
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }

  private call(method: string, params: JsonObject, timeoutMs: number, signal?: AbortSignal): Promise<McpCallResult> {
    if (this.disposed) return Promise.reject(new Error("MCP client is closed"));
    if (signal?.aborted) return Promise.reject(new Error(`MCP ${method} aborted`));

    const id = this.nextId++;
    return new Promise<McpCallResult>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const cancel = (reason: string) => {
        this.pending.delete(id);
        try {
          this.notify("notifications/cancelled", { requestId: id, reason });
        } catch {
          /* the transport may already be gone */
        }
        settle(() => reject(new Error(reason)));
      };
      const onAbort = () => cancel(`MCP ${method} aborted`);
      const timer = setTimeout(() => cancel(`MCP ${method} timed out after ${timeoutMs}ms`), timeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => settle(() => resolve(value)),
        reject: (err) => settle(() => reject(err)),
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        settle(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });
  }

  private notify(method: string, params?: JsonObject): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async init(): Promise<void> {
    await this.call(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "helmryth-pi", version: "1" },
      },
      MCP_STARTUP_TIMEOUT_MS,
    );
    this.notify("notifications/initialized");
  }

  async listTools(): Promise<Array<McpTool | null>> {
    const tools: Array<McpTool | null> = [];
    const seenCursors = new Set<string>();
    const deadline = Date.now() + MCP_STARTUP_TIMEOUT_MS;
    let cursor: string | undefined;
    for (let page = 0; page < MCP_MAX_LIST_PAGES; page += 1) {
      const remainingMs = Math.max(1, deadline - Date.now());
      const response = await this.call(
        "tools/list",
        cursor ? { cursor } : {},
        remainingMs,
      );
      const pageResult = parseMcpToolsPage(response);
      tools.push(...pageResult.tools);
      if (!pageResult.nextCursor) return tools;
      if (seenCursors.has(pageResult.nextCursor)) throw new Error("MCP tools/list repeated a pagination cursor");
      seenCursors.add(pageResult.nextCursor);
      cursor = pageResult.nextCursor;
    }
    throw new Error(`MCP tools/list exceeded ${MCP_MAX_LIST_PAGES} pages`);
  }

  /** tools/call → Pi content, preserving screenshots and bounding text so a
   * remote server cannot flood the model context. */
  async callTool(name: string, args: PiToolArguments, signal?: AbortSignal): Promise<{ content: PiToolContent[]; isError: boolean }> {
    const response = await this.call(
      "tools/call",
      { name, arguments: args },
      MCP_TOOL_TIMEOUT_MS,
      signal,
    );
    const result = parseMcpToolCallResult(response);
    const textParts: string[] = [];
    const images: PiImageContent[] = [];
    let unsupported = 0;
    for (const content of result.content) {
      if (!isJsonObject(content)) {
        unsupported += 1;
        continue;
      }
      const contentType = jsonString(content.type);
      if (contentType === "text") {
        textParts.push(String(content.text ?? ""));
        continue;
      }
      const data = jsonString(content.data);
      const mimeType = jsonString(content.mimeType);
      if (contentType === "image" && data !== undefined && mimeType !== undefined) {
        images.push({ type: "image", data, mimeType });
        continue;
      }
      unsupported += 1;
    }
    const text = textParts.join("\n");
    let boundedText = truncateToolText(text || (images.length ? "" : "(empty result)"));
    if (unsupported > 0) boundedText += `${boundedText ? "\n" : ""}[${unsupported} unsupported MCP content item(s) omitted]`;
    return {
      content: [...(boundedText ? [{ type: "text" as const, text: boundedText }] : []), ...images],
      isError: result.isError,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(new Error("MCP client disposed"));
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
  }
}

interface ParsedJsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  defaultValue?: JsonValue;
  constValue?: JsonValue;
  enumValues?: JsonValue[];
  nullable: boolean;
  anyOf?: JsonValue[];
  oneOf?: JsonValue[];
  allOf?: JsonValue[];
  items?: JsonValue;
  prefixItems?: JsonValue[];
  properties?: JsonObject;
  required?: string[];
  additionalProperties?: JsonValue;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
}

interface ObjectSchemaFields {
  properties: JsonObject;
  required: Set<string>;
}

function parseJsonSchema(value: JsonValue | undefined): ParsedJsonSchema | null {
  if (!isJsonObject(value)) return null;
  const schema: ParsedJsonSchema = { nullable: value.nullable === true };

  const scalarType = jsonString(value.type);
  const unionTypes = jsonStringArray(value.type);
  if (scalarType !== undefined) schema.type = scalarType;
  else if (unionTypes !== undefined) schema.type = unionTypes;

  const title = jsonString(value.title);
  if (title !== undefined) schema.title = title;
  const description = jsonString(value.description);
  if (description !== undefined) schema.description = description;
  if (value.default !== undefined) schema.defaultValue = value.default;
  if (value.const !== undefined) schema.constValue = value.const;
  if (Array.isArray(value.enum)) schema.enumValues = value.enum;

  if (Array.isArray(value.anyOf)) schema.anyOf = value.anyOf;
  if (Array.isArray(value.oneOf)) schema.oneOf = value.oneOf;
  if (Array.isArray(value.allOf)) schema.allOf = value.allOf;
  if (value.items !== undefined) schema.items = value.items;
  if (Array.isArray(value.prefixItems)) schema.prefixItems = value.prefixItems;
  if (isJsonObject(value.properties)) schema.properties = value.properties;
  schema.required = jsonStringArray(value.required);
  if (value.additionalProperties !== undefined) schema.additionalProperties = value.additionalProperties;

  if (isJsonNumber(value.minimum)) schema.minimum = value.minimum;
  if (isJsonNumber(value.maximum)) schema.maximum = value.maximum;
  if (isJsonNumber(value.exclusiveMinimum)) schema.exclusiveMinimum = value.exclusiveMinimum;
  if (isJsonNumber(value.exclusiveMaximum)) schema.exclusiveMaximum = value.exclusiveMaximum;
  if (isJsonNumber(value.multipleOf)) schema.multipleOf = value.multipleOf;
  if (isJsonNumber(value.minLength)) schema.minLength = value.minLength;
  if (isJsonNumber(value.maxLength)) schema.maxLength = value.maxLength;
  const pattern = jsonString(value.pattern);
  if (pattern !== undefined) schema.pattern = pattern;
  const format = jsonString(value.format);
  if (format !== undefined) schema.format = format;
  if (isJsonNumber(value.minItems)) schema.minItems = value.minItems;
  if (isJsonNumber(value.maxItems)) schema.maxItems = value.maxItems;
  if (isJsonBoolean(value.uniqueItems)) schema.uniqueItems = value.uniqueItems;
  if (isJsonNumber(value.minProperties)) schema.minProperties = value.minProperties;
  if (isJsonNumber(value.maxProperties)) schema.maxProperties = value.maxProperties;
  return schema;
}

function schemaOptions(schema: ParsedJsonSchema): TSchemaOptions {
  const options: TSchemaOptions = {};
  if (schema.title !== undefined) options.title = schema.title;
  if (schema.description !== undefined) options.description = schema.description;
  if (schema.defaultValue !== undefined) options.default = schema.defaultValue;
  if (schema.minimum !== undefined) options.minimum = schema.minimum;
  if (schema.maximum !== undefined) options.maximum = schema.maximum;
  if (schema.exclusiveMinimum !== undefined) options.exclusiveMinimum = schema.exclusiveMinimum;
  if (schema.exclusiveMaximum !== undefined) options.exclusiveMaximum = schema.exclusiveMaximum;
  if (schema.multipleOf !== undefined) options.multipleOf = schema.multipleOf;
  if (schema.minLength !== undefined) options.minLength = schema.minLength;
  if (schema.maxLength !== undefined) options.maxLength = schema.maxLength;
  if (schema.pattern !== undefined) options.pattern = schema.pattern;
  if (schema.format !== undefined) options.format = schema.format;
  if (schema.minItems !== undefined) options.minItems = schema.minItems;
  if (schema.maxItems !== undefined) options.maxItems = schema.maxItems;
  if (schema.uniqueItems !== undefined) options.uniqueItems = schema.uniqueItems;
  if (schema.minProperties !== undefined) options.minProperties = schema.minProperties;
  if (schema.maxProperties !== undefined) options.maxProperties = schema.maxProperties;
  return options;
}

function primitiveLiteral(value: JsonValue | undefined): TSchema | null {
  if (isJsonString(value) || isJsonNumber(value) || isJsonBoolean(value)) {
    return Type.Literal(value);
  }
  if (value === null) return Type.Null();
  return null;
}

function withNullable(schema: TSchema, nullable: boolean): TSchema {
  return nullable ? Type.Union([schema, Type.Null()]) : schema;
}

function collectObjectFields(schema: ParsedJsonSchema): ObjectSchemaFields {
  const properties: JsonObject = {};
  const required = new Set<string>();

  const visit = (candidate: ParsedJsonSchema, mode: "root" | "all" | "choice") => {
    for (const branch of candidate.allOf ?? []) {
      const parsed = parseJsonSchema(branch);
      if (parsed !== null) visit(parsed, mode === "choice" ? "choice" : "all");
    }
    for (const branch of [...(candidate.anyOf ?? []), ...(candidate.oneOf ?? [])]) {
      const parsed = parseJsonSchema(branch);
      if (parsed !== null) visit(parsed, "choice");
    }
    for (const [key, value] of Object.entries(candidate.properties ?? {})) {
      // The root declaration is authoritative; branch-only properties are
      // still retained so the model knows which arguments exist.
      if (mode === "root" || properties[key] === undefined) properties[key] = value;
    }
    if (mode !== "choice") {
      for (const key of candidate.required ?? []) required.add(key);
    }
  };

  visit(schema, "root");
  return { properties, required };
}

function objectSchema(schema: ParsedJsonSchema, root = false): TSchema {
  const { properties, required } = collectObjectFields(schema);
  const converted: Record<string, TSchema> = {};
  for (const [key, value] of Object.entries(properties)) {
    const nested = nestedTypebox(value);
    converted[key] = required.has(key) ? nested : Type.Optional(nested);
  }
  const options: TObjectOptions = schemaOptions(schema);
  if (isJsonBoolean(schema.additionalProperties)) {
    options.additionalProperties = schema.additionalProperties;
  } else if (isJsonObject(schema.additionalProperties)) {
    options.additionalProperties = nestedTypebox(schema.additionalProperties);
  }
  const object = Type.Object(converted, options);
  return root ? object : withNullable(object, schema.nullable);
}

function convertJsonSchema(schema: ParsedJsonSchema): TSchema {
  const options = schemaOptions(schema);

  const literal = primitiveLiteral(schema.constValue);
  if (literal) return withNullable(literal, schema.nullable);

  if (schema.enumValues && schema.enumValues.length > 0) {
    if (schema.enumValues.every(isJsonString)) {
      // `{type:"string", enum:[...]}` works across Google/OpenAI/Anthropic;
      // Type.Union(Type.Literal(...)) does not work with Google's tool API.
      return withNullable(Type.String({ ...options, enum: schema.enumValues }), schema.nullable);
    }
    const literals = schema.enumValues.map(primitiveLiteral).filter((value): value is TSchema => value !== null);
    if (literals.length === schema.enumValues.length) {
      const union = literals.length === 1 ? literals[0] : Type.Union(literals, options);
      return withNullable(union, schema.nullable);
    }
  }

  if (Array.isArray(schema.type)) {
    const variants = schema.type.map((type) => convertJsonSchema({ ...schema, type, nullable: false }));
    return variants.length === 1 ? variants[0] : Type.Union(variants, options);
  }

  if (schema.type === "object" || schema.properties !== undefined) return objectSchema(schema);

  const choice = schema.anyOf ?? schema.oneOf;
  if (choice && choice.length > 0) {
    const variants = choice.map(nestedTypebox);
    return withNullable(variants.length === 1 ? variants[0] : Type.Union(variants, options), schema.nullable);
  }
  if (schema.allOf && schema.allOf.length > 0) {
    const variants = schema.allOf.map(nestedTypebox);
    return withNullable(variants.length === 1 ? variants[0] : Type.Intersect(variants, options), schema.nullable);
  }

  switch (schema.type) {
    case "string":
      return withNullable(Type.String(options), schema.nullable);
    case "number":
      return withNullable(Type.Number(options), schema.nullable);
    case "integer":
      return withNullable(Type.Integer(options), schema.nullable);
    case "boolean":
      return withNullable(Type.Boolean(options), schema.nullable);
    case "null":
      return Type.Null();
    case "array": {
      const tupleItems = schema.prefixItems ?? (Array.isArray(schema.items) ? schema.items : undefined);
      const value = tupleItems
        ? Type.Tuple(tupleItems.map(nestedTypebox), options)
        : Type.Array(schema.items ? nestedTypebox(schema.items) : Type.Any(), options);
      return withNullable(value, schema.nullable);
    }
    default:
      return Type.Any();
  }
}

function nestedTypebox(value: JsonValue): TSchema {
  const schema = parseJsonSchema(value);
  return schema === null ? Type.Any() : convertJsonSchema(schema);
}

/** Best-effort JSON Schema → TypeBox. MCP tool parameters must always expose
 * an object at the root; Pi/provider tool serialization rejects a root schema
 * without `type: "object"`. Nested schemas retain unions, nullability and
 * constraints instead of being incorrectly rewritten as objects. */
export function toTypebox(value: JsonValue | undefined): TSchema {
  const schema = parseJsonSchema(value) ?? { nullable: false };
  return objectSchema(schema, true);
}

/** pi tool names are lowercase snake identifiers; MCP tool names are not
 * (COMPOSIO_SEARCH_TOOLS, browser_navigate, mcp__x…). Normalize and prefix
 * with the server so two servers can never collide. */
function sanitizeToolName(server: string, tool: string): string {
  const raw = `${server}_${tool}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return raw.slice(0, TOOL_NAME_MAX_LENGTH) || "mcp_tool";
}

export function allocateToolName(server: string, tool: string, used: Set<string>): string {
  const base = sanitizeToolName(server, tool);
  let candidate = base;
  for (let suffixNumber = 2; used.has(candidate); suffixNumber += 1) {
    const suffix = `_${suffixNumber}`;
    candidate = `${base.slice(0, Math.max(1, TOOL_NAME_MAX_LENGTH - suffix.length))}${suffix}`;
  }
  return candidate;
}

export function truncateToolText(text: string): string {
  const lines = text.split("\n");
  const lineLimited = lines.slice(0, TOOL_OUTPUT_MAX_LINES).join("\n");
  const bytes = Buffer.from(lineLimited, "utf8");
  let byteEnd = Math.min(bytes.length, TOOL_OUTPUT_MAX_BYTES);
  // Avoid returning a replacement character when the byte limit lands in the
  // middle of a UTF-8 code point.
  while (byteEnd > 0 && byteEnd < bytes.length && (bytes[byteEnd] & 0xc0) === 0x80) byteEnd -= 1;
  const content = bytes.subarray(0, byteEnd).toString("utf8");
  const truncatedByLines = lines.length > TOOL_OUTPUT_MAX_LINES;
  const truncatedByBytes = bytes.length > TOOL_OUTPUT_MAX_BYTES;
  if (!truncatedByLines && !truncatedByBytes) return content;
  const reasons = [
    ...(truncatedByLines ? [`${TOOL_OUTPUT_MAX_LINES}-line limit`] : []),
    ...(truncatedByBytes ? [`${TOOL_OUTPUT_MAX_BYTES / 1024}KB limit`] : []),
  ];
  return `${content}\n\n[MCP output truncated: ${reasons.join(" and ")}. Refine the request for less output.]`;
}

/** A short human-readable line for the permission card's detail. */
function summarizeParams(params: PiToolArguments): string {
  try {
    const s = JSON.stringify(params);
    return s === "{}" ? "" : s.slice(0, 300);
  } catch {
    return "";
  }
}

function parseStringRecord(value: JsonValue | undefined): Record<string, string> | undefined {
  if (!isJsonObject(value)) return undefined;
  const parsed: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(value)) {
    const text = jsonString(candidate);
    if (text !== undefined) parsed[key] = text;
  }
  return parsed;
}

function parseMcpServerDef(value: JsonValue): McpServerDef | null {
  if (!isJsonObject(value)) return null;
  const command = jsonString(value.command);
  if (!command?.trim()) return null;
  const definition: McpServerDef = { command };
  const args = jsonStringArray(value.args);
  if (args !== undefined) definition.args = args;
  const env = parseStringRecord(value.env);
  if (env !== undefined) definition.env = env;
  const scope = jsonString(value.scope);
  if (scope !== undefined) definition.scope = scope;
  return definition;
}

function parseMcpConfig(text: string): McpConfig {
  const value = parseJson(text);
  const config: McpConfig = { mcpServers: {} };
  if (!isJsonObject(value) || !isJsonObject(value.mcpServers)) return config;
  for (const [name, candidate] of Object.entries(value.mcpServers)) {
    const definition = parseMcpServerDef(candidate);
    if (definition !== null) config.mcpServers[name] = definition;
  }
  return config;
}

export default async function (pi: PiExtensionApi): Promise<void> {
  const configPath = process.env.HELMRYTH_MCP_CONFIG;
  if (!configPath) return;

  let config: McpConfig;
  try {
    config = parseMcpConfig(readFileSync(configPath, "utf8"));
  } catch {
    return;
  }

  const used = new Set<string>();
  const clients: StdioMcp[] = [];
  const serverEntries = Object.entries(config.mcpServers);

  // Mount independent servers concurrently so one slow integration cannot
  // consume the startup timeout once per server. Registration remains in
  // config order below for deterministic tool names and collision suffixes.
  const mounts = await Promise.all(
    serverEntries.map(async ([serverName, def]) => {
      let client: StdioMcp | undefined;
      try {
        client = new StdioMcp(def);
        await client.init();
        return { serverName, def, client, tools: await client.listTools() };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[helmryth-pi-mcp] ${serverName}: ${message}\n`);
        client?.dispose();
        return { serverName };
      }
    }),
  );

  for (const mount of mounts) {
    if (!mount.client || !mount.def || !mount.tools) continue;
    const { serverName, def, client, tools } = mount;
    const gated = def.scope === "local-computer";
    let registered = 0;

    for (const tool of tools) {
      if (!tool) {
        process.stderr.write(`[helmryth-pi-mcp] ${serverName}: skipped a tool with no valid name\n`);
        continue;
      }
      const toolName = tool.name;
      const name = allocateToolName(serverName, toolName, used);
      try {
        const parameters = toTypebox(tool.inputSchema);
        pi.registerTool({
          name,
          label: `${serverName}:${toolName}`,
          description: tool.description ?? `${toolName} (MCP tool from ${serverName})`,
          parameters,
          async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            // Host tools ask first, using pi's native permission card
            // (ctx.ui.confirm → extension_ui_request → Allow/Deny card). This
            // mirrors ACP's session/request_permission and Codex's elicitation.
            if (gated) {
              const detail = summarizeParams(params);
              const allowed = await ctx.ui.confirm(
                `Allow ${toolName} on your computer?`,
                detail || `Run ${serverName}:${toolName}`,
              );
              if (!allowed) {
                return { content: [{ type: "text", text: "Blocked by the user." }], details: {} };
              }
            }
            const res = await client.callTool(toolName, params, signal);
            if (res.isError) {
              const message = res.content
                .filter((item): item is { type: "text"; text: string } => item.type === "text")
                .map((item) => item.text)
                .join("\n");
              // Pi marks a custom tool as failed only when execute throws;
              // returning error-looking text incorrectly produces isError=false.
              throw new Error(message || `MCP tool ${serverName}:${toolName} returned an error`);
            }
            return { content: res.content, details: {} };
          },
        });
        used.add(name);
        registered += 1;
      } catch (err) {
        // One malformed tool must not dispose the client behind tools that
        // were already registered from the same server.
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[helmryth-pi-mcp] ${serverName}:${toolName}: ${message}\n`);
      }
    }

    if (registered > 0) clients.push(client);
    else client.dispose();
  }

  pi.on("session_shutdown", () => {
    for (const c of clients) c.dispose();
    clients.length = 0;
  });
}
