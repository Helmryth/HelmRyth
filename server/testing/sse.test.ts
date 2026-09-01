import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { openSse } from "./sse.ts";

describe("SSE recorder", () => {
  it("accepts nullable help reasons on computer-control frames", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"kind":"computer-control","botId":"operator-1","held":true,"helpReason":null}\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address) throw new Error("test server did not bind a TCP port");
    // SAFETY: this server was explicitly bound to an IPv4 address above.
    const port = (address as AddressInfo).port;

    const recorder = await openSse(`http://127.0.0.1:${port}`);
    try {
      const frame = await recorder.until((candidate) => candidate.kind === "computer-control");
      expect(frame).toMatchObject({ botId: "operator-1", held: true, helpReason: null });
    } finally {
      recorder.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects pending waits as soon as the remote stream ends", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      setTimeout(() => res.end(), 10);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address) throw new Error("test server did not bind a TCP port");
    // SAFETY: this server was explicitly bound to an IPv4 address above.
    const port = (address as AddressInfo).port;

    try {
      const recorder = await openSse(`http://127.0.0.1:${port}`);
      await expect(recorder.until(() => false, 5_000)).rejects.toThrow(/stream closed/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
