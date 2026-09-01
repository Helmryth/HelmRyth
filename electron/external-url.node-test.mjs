import assert from "node:assert/strict";
import test from "node:test";

import { createExternalWebWindowOpenHandler, openExternalWebUrl, parseExternalWebUrl } from "./external-url.mjs";

test("desktop external URLs accept only explicit http and https links", () => {
  assert.equal(parseExternalWebUrl("https://example.com/docs?q=1").toString(), "https://example.com/docs?q=1");
  assert.equal(parseExternalWebUrl("  http://example.com/path  ").toString(), "http://example.com/path");
  assert.throws(() => parseExternalWebUrl(""), /web address is required/i);
  assert.throws(() => parseExternalWebUrl("example.com"), /web address is invalid/i);
  assert.throws(() => parseExternalWebUrl("javascript:alert(1)"), /Only web links can be opened/);
  assert.throws(() => parseExternalWebUrl("file:///etc/passwd"), /Only web links can be opened/);
  assert.throws(() => parseExternalWebUrl("mailto:test@example.com"), /Only web links can be opened/);
  assert.throws(() => parseExternalWebUrl("helmryth://pair"), /Only web links can be opened/);
});

test("desktop:open-external opens only validated web links", async () => {
  const opened = [];
  await assert.doesNotReject(() => openExternalWebUrl(async (url) => opened.push(url), "https://example.com/a#b"));
  await assert.rejects(() => openExternalWebUrl(async () => {}, "data:text/html,boom"), /Only web links can be opened/);
  assert.deepEqual(opened, ["https://example.com/a#b"]);
});

test("window-open handler denies every popup and never forwards rejected input to the shell", async () => {
  const opened = [];
  const failures = [];
  const handler = createExternalWebWindowOpenHandler(
    async (url) => {
      opened.push(url);
    },
    { reportError: (error) => failures.push(error) },
  );

  assert.deepEqual(handler({ url: "https://example.com/path" }), { action: "deny" });
  assert.deepEqual(handler({ url: "javascript:alert(1)" }), { action: "deny" });
  assert.deepEqual(handler({ url: "file:///tmp/secret.txt" }), { action: "deny" });
  assert.deepEqual(handler({ url: "helmryth://pair" }), { action: "deny" });
  assert.deepEqual(handler({ url: "not a url" }), { action: "deny" });

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(opened, ["https://example.com/path"]);
  assert.equal(failures.length, 0);
});
