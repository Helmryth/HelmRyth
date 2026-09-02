// Static host for the built renderer + transparent /api proxy to the core.
//
// The Vite dev server cannot be used for this run: its file watcher issues a
// full page reload whenever anything is written inside the repository, and the
// browser driver writes snapshot artifacts there. Those reloads silently reset
// application state mid-interaction, which makes every multi-step assertion
// unreliable. Serving the production bundle removes the watcher entirely and
// exercises the same asset graph an end user runs.

import { createServer, request as httpRequest } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

import { REPO } from "./paths.mjs";

// Serve the production bundle, resolved relative to this file so the harness
// runs from any clone.
const ROOT = process.env.HELMRYTH_STATIC_ROOT ?? `${REPO}/dist`;
const CORE_HOST = "127.0.0.1";
const CORE_PORT = Number(process.env.HELMRYTH_PORT) || 8799;
const PORT = Number(process.env.HELMRYTH_UI_PORT) || 5199;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

function proxy(req, res) {
  const headers = { ...req.headers };
  // The core authorises on its own Host authority but checks the renderer's
  // exact Origin, so rewrite one and preserve the other.
  headers.host = `${CORE_HOST}:${CORE_PORT}`;
  const upstream = httpRequest(
    { host: CORE_HOST, port: CORE_PORT, path: req.url, method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res); // piped, never buffered: streaming responses must stay live
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`core unreachable: ${err.message}`);
  });
  req.pipe(upstream);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname.startsWith("/api")) return proxy(req, res);

  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  // Unknown paths fall back to the SPA entry so client-side routes resolve.
  if (!existsSync(file)) file = join(ROOT, "index.html");

  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(res);
});

// Forward WebSocket upgrades so any live channel behaves as it does in the app.
server.on("upgrade", (req, socket, head) => {
  const headers = { ...req.headers, host: `${CORE_HOST}:${CORE_PORT}` };
  const upstream = httpRequest({
    host: CORE_HOST,
    port: CORE_PORT,
    path: req.url,
    method: req.method,
    headers,
  });
  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(upRes.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n")}\r\n\r\n`,
    );
    if (upHead?.length) socket.unshift(upHead);
    upSocket.pipe(socket).pipe(upSocket);
  });
  upstream.on("error", () => socket.destroy());
  if (head?.length) upstream.write(head);
  upstream.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`e2e static host on http://127.0.0.1:${PORT} -> core ${CORE_HOST}:${CORE_PORT}`);
});
