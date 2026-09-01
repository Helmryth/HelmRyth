// Harness-owned Composio MCP bridge.
//
// Provider CLIs only see this stdio server. Ordinary MCP traffic is relayed
// to the configured Composio Session, but connection requests are converted
// into first-class Helmryth chat cards. The agent never authors an auth
// URL and credentials never pass through its transcript.
//
// stdout is the MCP transport. Never log there.
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseJson, type JsonObject, type JsonValue } from "./schema.ts";

const jsonObjectSchema = z.record(z.string(), z.json());
const jsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);
const connectorSlugSchema = z.string();
const connectorItemSchema = z.union([
  connectorSlugSchema,
  z.object({
    name: z.string().optional(),
    toolkit: z.string().optional(),
    action: z.string().optional(),
  }),
]);
const connectorArgumentsSchema = z.object({ toolkits: z.array(connectorItemSchema).optional() });
const mcpParamsSchema = z.object({
  protocolVersion: z.string().optional(),
  name: z.string().optional(),
  arguments: z.json().optional(),
}).passthrough();
const mcpMessageSchema = z.object({
  id: jsonRpcIdSchema.optional(),
  method: z.string(),
  params: mcpParamsSchema.optional(),
}).passthrough();

type JsonRpcId = z.infer<typeof jsonRpcIdSchema> | undefined;
type McpMessage = z.infer<typeof mcpMessageSchema>;

interface TextResult {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: {
    content: Array<{ type: "text"; text: string }>;
    isError?: true;
  };
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: -32000; message: string };
}

interface InitializeResult {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: {
    protocolVersion: string;
    capabilities: { tools: Record<string, never> };
    serverInfo: { name: "helmryth-connectors"; version: "1" };
  };
}

const UPSTREAM = process.env.HELMRYTH_CONNECTOR_UPSTREAM_URL ?? "";
const HARNESS = process.env.HELMRYTH_HARNESS_URL ?? "http://127.0.0.1:8799";
const BOT_ID = process.env.HELMRYTH_BOT_ID ?? "";
const THREAD_ID = process.env.HELMRYTH_THREAD_ID ?? "";
const TOKEN = process.env.HELMRYTH_COMMS_TOKEN ?? "";
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const INITIALIZE_RELAY_TIMEOUT_MS = 1_000;
const RELAY_TIMEOUT_MS = 10 * 60_000;

function parsedHeaders(): Record<string, string> {
  try {
    const parsed = z.record(z.string(), z.string()).safeParse(
      parseJson(process.env.HELMRYTH_CONNECTOR_UPSTREAM_HEADERS ?? "{}"),
    );
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

const upstreamHeaders = parsedHeaders();
let upstreamSessionId = "";
const send = <Message>(message: Message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function textResult(id: JsonRpcId, text: string, isError = false): TextResult {
  const result: TextResult = { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
  if (isError) result.result.isError = true;
  return result;
}

function jsonRpcError(id: JsonRpcId, message: string): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code: -32000, message } };
}

function initializeResult(id: JsonRpcId, protocolVersion = "2024-11-05"): InitializeResult {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "helmryth-connectors", version: "1" },
    },
  };
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) throw new Error("connector response exceeded 20 MB");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("connector response exceeded 20 MB");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseUpstream(text: string, id: JsonRpcId | undefined): JsonObject | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return jsonObjectSchema.parse(parseJson(trimmed));
  const frames = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .flatMap((line) => {
      try {
        const parsed = jsonObjectSchema.safeParse(parseJson(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  return frames.findLast((frame) => frame.id === id) ?? frames.at(-1) ?? null;
}

async function relay(message: McpMessage, timeoutMs = RELAY_TIMEOUT_MS): Promise<JsonObject | null> {
  if (!UPSTREAM) throw new Error("connected apps are unavailable");
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...upstreamHeaders,
  });
  if (upstreamSessionId) headers.set("mcp-session-id", upstreamSessionId);
  const response = await fetch(UPSTREAM, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const nextSession = response.headers.get("mcp-session-id");
  if (nextSession) upstreamSessionId = nextSession;
  if (!response.ok) throw new Error(`connector service returned HTTP ${response.status}`);
  return parseUpstream(await readBounded(response), message.id);
}

function connectorAdds(args: JsonValue | undefined): string[] {
  const parsed = connectorArgumentsSchema.safeParse(args);
  if (!parsed.success || !parsed.data.toolkits) return [];
  return [...new Set(parsed.data.toolkits.flatMap((item) => {
    const parsedSlug = connectorSlugSchema.safeParse(item);
    if (parsedSlug.success) return [parsedSlug.data.toLowerCase()];
    const row = z.object({
      name: z.string().optional(),
      toolkit: z.string().optional(),
      action: z.string().optional(),
    }).parse(item);
    const slug = row.toolkit ?? row.name;
    const action = (row.action ?? "add").toLowerCase();
    return slug && ["add", "connect", "initiate"].includes(action) ? [slug.toLowerCase()] : [];
  }))];
}

async function showConnectorCards(slugs: string[]): Promise<void> {
  const response = await fetch(`${HARNESS}/api/internal/connectors/request`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ botId: BOT_ID, threadId: THREAD_ID, slugs, resumeKey: randomUUID() }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = z.object({ error: z.string().optional() }).safeParse(await response.json().catch(() => ({})));
    throw new Error(body.success && body.data.error
      ? body.data.error
      : `could not show connection card (HTTP ${response.status})`);
  }
}

async function handle(message: McpMessage): Promise<void> {
  const id = message.id;
  const method = String(message.method ?? "");
  // OpenCode (and other MCP clients) mark a stdio server failed unless
  // initialize returns capabilities/serverInfo. Relaying that handshake to
  // Composio can time out, return a newer protocolVersion, or throw when the
  // upstream URL never reached the child env — all of which previously
  // surfaced as a tools/call-shaped {content,isError} payload.
  if (method === "notifications/initialized" || method === "initialized") {
    if (UPSTREAM) void relay(message).catch(() => {});
    return;
  }
  if (method === "initialize") {
    if (UPSTREAM) {
      try {
        // Capture the upstream session id when the service is healthy, but
        // never let a stalled provider prevent the local MCP client from
        // mounting the connector tools. The client sends initialized only
        // after this bounded attempt and the local initialize response.
        await relay(message, INITIALIZE_RELAY_TIMEOUT_MS);
      } catch {
        // Best-effort session setup. The client still needs a valid result.
      }
    }
    if (id !== undefined) {
      send(initializeResult(id, message.params?.protocolVersion));
    }
    return;
  }
  if (method === "tools/call") {
    const params = message.params ?? {};
    const name = String(params.name ?? "");
    const slugs = /MANAGE_CONNECTIONS$/i.test(name) ? connectorAdds(params.arguments) : [];
    if (slugs.length) {
      await showConnectorCards(slugs);
      send(textResult(
        id,
        `Helmryth showed the user a secure connection gate for ${slugs.join(", ")}. End this turn now. Helmryth will continue the run automatically after the connection finishes.`,
      ));
      return;
    }
    if (/WAIT_FOR_CONNECTIONS$/i.test(name)) {
      send(textResult(id, "Helmryth is handling connection completion and will continue the run automatically."));
      return;
    }
  }
  try {
    const response = await relay(message);
    if (response && id !== undefined) send(response);
  } catch (error) {
    if (id === undefined) return;
    const messageText = error instanceof Error ? error.message : String(error);
    if (method === "tools/call") send(textResult(id, messageText, true));
    else send(jsonRpcError(id, messageText));
  }
}

function parseMessage(line: string): McpMessage | null {
  try {
    const parsed = mcpMessageSchema.safeParse(parseJson(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const message = parseMessage(trimmed);
  if (!message) return;
  void handle(message).catch((error) => {
    if (message.id === undefined) return;
    const method = String(message.method ?? "");
    const messageText = error instanceof Error ? error.message : String(error);
    if (method === "tools/call") send(textResult(message.id, messageText, true));
    else send(jsonRpcError(message.id, messageText));
  });
});
input.on("close", () => process.exit(0));
