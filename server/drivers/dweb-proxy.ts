// dweb MCP proxy — spawned as an MCP server inside a bot's agent process.
// Exposes dweb's HTTP API (the local Helmryth network daemon) as tools an
// agent can call to inspect the network and run model requests:
//
//   dweb_status          → ping dweb, summarize server + peer state
//   dweb_repo_status     → the Helmryth repo the daemon is tracking
//   dweb_opencode_models → models available on the opencode integration
//   dweb_opencode_run    → run a model command, wait up to 5 min for output
//
// Speaks raw JSON-RPC 2.0 over stdio (no MCP SDK — house style, matches
// agents-proxy / computer-proxy / permission-proxy). Config comes from env:
//   DWEB_URL  base URL of the local dweb daemon (http://127.0.0.1:49737)
import readline from "node:readline";
import { z } from "zod";
import { parseJson, type JsonObject } from "../schema.ts";

const jsonObjectSchema = z.record(z.string(), z.json());
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
const modelsSchema = z.object({
  models: z.array(z.union([z.string(), z.object({ id: z.string() })])).default([]),
});
const runArgsSchema = z.object({ command: z.string().trim().min(1), model: z.string().trim().optional() });
type JsonRpcId = z.infer<typeof rpcIdSchema>;

interface RunRequestBody {
  command: string;
  model?: string;
}

const DWEB = (process.env.DWEB_URL ?? "http://127.0.0.1:49737").replace(/\/+$/, "");
const DWEB_DISPLAY = (() => {
  try {
    const url = new URL(DWEB);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "(invalid DWEB_URL)";
  }
})();

const TOOLS = [
  {
    name: "dweb_status",
    description:
      "Ping the local dweb daemon and report its status: server id, hostname, platform, version, uptime, peer count, and the services it runs. Call this first to confirm the network is reachable and see what's available.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dweb_repo_status",
    description:
      "Report the state of the Helmryth repository the dweb daemon is tracking: repo name, checked-out branch, last commit, file count, and checkout path.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dweb_opencode_models",
    description:
      "List the models available on dweb's opencode integration. Each has an id you can pass to dweb_opencode_run. Returns a note if no models are available.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dweb_opencode_run",
    description:
      "Run a model on dweb's opencode integration and wait for the result. Give a command for the model to process; optionally pick a model with the 'model' arg (defaults to dweb's choice). Can take several minutes — use this for long-running model work and report the output back verbatim.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command/prompt to run on the model." },
        model: { type: "string", description: "Optional model id (from dweb_opencode_models)." },
      },
      required: ["command"],
    },
  },
];

interface StdioMessage {
  jsonrpc: "2.0";
  id: JsonRpcId | undefined;
  result?: unknown;
  error?: { code: number; message: string };
}
const send = (message: StdioMessage) => process.stdout.write(JSON.stringify(message) + "\n");
function ok<Result>(id: JsonRpcId | undefined, result: Result) {
  return send({ jsonrpc: "2.0", id, result });
}
const rpcErr = (id: JsonRpcId | undefined, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (id: JsonRpcId | undefined, text: string, isError = false) =>
  ok(id, { content: [{ type: "text", text }], isError });

async function api(path: string, init?: RequestInit): Promise<JsonObject> {
  const res = await fetch(DWEB + path, {
    signal: AbortSignal.timeout(30_000),
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = jsonObjectSchema.parse(await res.json().catch(() => ({})));
  if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`));
  return body;
}

async function callTool(name: string, args: JsonObject): Promise<{ text: string; isError?: boolean }> {
  if (name === "dweb_status") {
    const r = await api("/ping");
    const lines = [
      `status: ${String(r.status ?? "unknown")}`,
      `server: ${String(r.server ?? "unknown")}`,
      `id: ${String(r.id ?? "unknown")}`,
      `hostname: ${String(r.hostname ?? "unknown")}`,
      `platform: ${String(r.platform ?? "unknown")}`,
      `version: ${String(r.version ?? "unknown")}`,
      `uptime: ${String(r.uptime ?? "unknown")}`,
      `peers: ${String(r.peers ?? "unknown")}`,
      `services: ${String(r.services ?? "unknown")}`,
    ];
    return { text: `dweb status:\n${lines.join("\n")}` };
  }
  if (name === "dweb_repo_status") {
    const r = await api("/api/repo/status");
    const lines = [
      `repo: ${String(r.repo ?? "unknown")}`,
      `branch: ${String(r.branch ?? "unknown")}`,
      `commit: ${String(r.commit ?? "unknown")}`,
      `files: ${String(r.files ?? "unknown")}`,
      `path: ${String(r.path ?? "unknown")}`,
    ];
    return { text: `dweb repo status:\n${lines.join("\n")}` };
  }
  if (name === "dweb_opencode_models") {
    const models = modelsSchema.parse(await api("/api/opencode/models")).models;
    if (!models.length) return { text: "No models available on dweb's opencode integration." };
    const lines = models.map((model) => {
      const parsed = z.object({ id: z.string() }).safeParse(model);
      return `- ${parsed.success ? parsed.data.id : String(model)}`;
    });
    return { text: `Models available on dweb's opencode integration:\n${lines.join("\n")}` };
  }
  if (name === "dweb_opencode_run") {
    const parsed = runArgsSchema.safeParse(args);
    if (!parsed.success && parsed.error.issues.some((issue) => issue.path[0] === "command")) {
      return { text: "dweb_opencode_run needs a string command.", isError: true };
    }
    if (!parsed.success) {
      return { text: "dweb_opencode_run model must be a string.", isError: true };
    }
    const command = parsed.data.command;
    const model = parsed.data.model || undefined;
    const requestBody: RunRequestBody = { command };
    if (model !== undefined) requestBody.model = model;
    const r = await api("/api/opencode/run", {
      method: "POST",
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(300000),
    });
    if (r.status === "error") {
      return {
        text: `dweb request failed at ${DWEB_DISPLAY}: ${String(r.error ?? r.output ?? "opencode run failed")}`,
        isError: true,
      };
    }
    return { text: String(r.output ?? "(no output)") };
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
        serverInfo: { name: "dweb-proxy", version: "0.1.0" },
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
        const args = params.arguments ?? {};
        const { text, isError } = await callTool(name, args);
        textResult(id, text, isError);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        textResult(id, `dweb request failed at ${DWEB_DISPLAY}: ${message}`, true);
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
