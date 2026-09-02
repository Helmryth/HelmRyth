# Helmryth MCP server

The Helmryth desktop app includes a local stdio MCP server. It lets another MCP client coordinate your
Helmryth team while the desktop app and its harness are running.

## What it can do

- list operators and crews, including their active run and current activity;
- read bounded transcript pages and search local transcripts without returning screenshot pixels;
- create and safely edit operator profiles, crews, and separate run conversations;
- send work to an operator or crew, wait for either conversation to settle or need help, and interrupt its active turn;
- list configured model instances and switch an idle operator to an exact available model.

The v1 server intentionally cannot approve requests, remember permission grants, delete data, import teams,
change credentials, or control workstation/VM lifecycle. Those actions stay in the human-facing app.

## From a source checkout

Start Helmryth, then configure the MCP client to run:

```json
{
  "mcpServers": {
    "helmryth": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/Helmryth", "mcp"]
    }
  }
}
```

## From the installed desktop app

Release builds bundle `server/mcp-server.js` and can run it with Electron's embedded Node runtime, so users do
not need Node.js or pnpm installed.

macOS example:

```json
{
  "mcpServers": {
    "helmryth": {
      "command": "/Applications/Helmryth.app/Contents/MacOS/Helmryth",
      "args": ["/Applications/Helmryth.app/Contents/Resources/server/mcp-server.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

On Windows, use the installed `Helmryth.exe` as `command`, the adjacent
`resources\\server\\mcp-server.js` as the argument, and the same `ELECTRON_RUN_AS_NODE=1` environment value.
The usual per-user install is under `%LOCALAPPDATA%\\Programs\\Helmryth`.

On Ubuntu `.deb` installs, the executable is normally `/opt/Helmryth/helmryth` and the script is
`/opt/Helmryth/resources/server/mcp-server.js`. Use the same environment value.

## Connection discovery

With no configuration, the MCP process probes Helmryth's three desktop ports (`8799`, `18799`, and `28799`)
and accepts only a health response that identifies itself as Helmryth. This handles the desktop's normal
fallback when another local process already owns port 8799.

Set `HELMRYTH_PORT` to force one local port, or `HELMRYTH_URL` to use an explicit HTTP(S) origin. Cleartext remote
HTTP is rejected unless `ALLOW_INSECURE_HTTP=true`; HTTPS should be used outside loopback. An optional
`HELMRYTH_TOKEN` is sent as a bearer token for authenticated reverse proxies. When a token is set, an
explicit `HELMRYTH_URL` or `HELMRYTH_PORT` is required so the credential is never sent while probing unrelated
local ports. `HELMRYTH_MCP_TIMEOUT_MS` can set an HTTP timeout between 1,000 and 120,000 milliseconds.

## Tools

| Purpose | Tools |
|---|---|
| Inspect | `get_system_health`, `list_operators`, `list_crews`, `get_operator_messages`, `get_crew_messages`, `search_messages`, `list_available_models` |
| Create and organize | `create_operator`, `update_operator_profile`, `create_crew`, `update_crew`, `create_run`, `switch_run`, `rename_run` |
| Run work | `send_operator_message`, `send_crew_message`, `wait_for_conversation`, `interrupt_conversation`, `set_operator_model` |

`wait_for_conversation` returns `settled`, `needs-user`, `failed`, `stalled`, or `timed-out`, along with a
small redacted transcript tail. MCP cancellation is honored while a tool is waiting.

## Safety and data scope

Transcript reads are paged and capped at 200 messages. Search is capped at 100 hits. Screenshot pixels and
permission grant keys are removed from MCP results. Tool schemas reject unknown fields and malformed values,
and model changes are refused while an operator is working.

The harness itself is local-first and normally binds to loopback. If you expose it through a reverse proxy,
authentication and TLS at that proxy are part of your deployment's security boundary.
