import { describe, expect, it } from "vitest";

import {
  exactCoreAuthority,
  isApplicationJson,
  publicMutationRequiresJson,
  rendererOrigin,
  requestHasExactCoreAuthority,
  requestHasTrustedRendererOrigin,
} from "./request-security.ts";

describe("loopback request security", () => {
  it("pins packaged mode to the exact same-origin IPv4 renderer", () => {
    expect(rendererOrigin({ port: 8799, staticDir: "/app/ui" })).toBe("http://127.0.0.1:8799");
    expect(rendererOrigin({
      port: 8799,
      staticDir: "/app/ui",
      uiOrigin: "http://127.0.0.1:8799",
    })).toBe("http://127.0.0.1:8799");
    expect(() => rendererOrigin({
      port: 8799,
      staticDir: "/app/ui",
      uiOrigin: "http://127.0.0.1:5199",
    })).toThrow("must be http://127.0.0.1:8799 in packaged mode");
  });

  it("uses one canonical development origin and rejects ambiguous URL forms", () => {
    expect(rendererOrigin({ port: 8799, staticDir: null })).toBe("http://127.0.0.1:5199");
    expect(rendererOrigin({ port: 8799, staticDir: null, uiPort: "5299" })).toBe("http://127.0.0.1:5299");
    expect(rendererOrigin({
      port: 8799,
      staticDir: null,
      uiOrigin: "https://ui.helmryth.test:5443",
    })).toBe("https://ui.helmryth.test:5443");

    for (const uiOrigin of [
      "null",
      "file:///tmp/index.html",
      "http://127.0.0.1:5199/",
      "http://127.0.0.1:5199/path",
      "http://127.0.0.1:5199?query=1",
      "http://127.0.0.1:5199#fragment",
      "http://user:secret@127.0.0.1:5199",
    ]) {
      expect(() => rendererOrigin({ port: 8799, staticDir: null, uiOrigin }), uiOrigin).toThrow();
    }
  });

  it("accepts only the exact core Host authority", () => {
    expect(exactCoreAuthority(8799)).toBe("127.0.0.1:8799");
    expect(requestHasExactCoreAuthority({ host: "127.0.0.1:8799" }, 8799)).toBe(true);
    for (const host of [
      undefined,
      "127.0.0.1",
      "127.0.0.1:8800",
      "127.0.0.2:8799",
      "localhost:8799",
      "localhost.:8799",
      "[::1]:8799",
      "evil.test:8799",
      "evil.test@127.0.0.1:8799",
    ]) {
      expect(requestHasExactCoreAuthority({ host }, 8799), String(host)).toBe(false);
    }
  });

  it("accepts the one renderer Origin plus documented originless native clients", () => {
    const trusted = "http://127.0.0.1:5199";
    expect(requestHasTrustedRendererOrigin({}, trusted)).toBe(true);
    expect(requestHasTrustedRendererOrigin({ origin: trusted }, trusted)).toBe(true);
    for (const origin of [
      "null",
      "file://",
      "http://127.0.0.1:5199/",
      "http://localhost:5199",
      "http://127.0.0.2:5199",
      "http://127.0.0.1:5200",
      "https://127.0.0.1:5199",
      "http://user@127.0.0.1:5199",
      "https://evil.test",
    ]) {
      expect(requestHasTrustedRendererOrigin({ origin }, trusted), origin).toBe(false);
    }
  });

  it("requires the exact JSON media type for every public mutation except raw upload", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(publicMutationRequiresJson(method, "/api/bots/example"), method).toBe(true);
    }
    for (const [method, path] of [
      ["GET", "/api/bots"],
      ["OPTIONS", "/api/bots"],
      ["POST", "/api/attachments"],
      ["POST", "/api/internal/ask-bot"],
      ["POST", "/not-api"],
    ]) {
      expect(publicMutationRequiresJson(method, path), `${method} ${path}`).toBe(false);
    }
    expect(isApplicationJson("application/json")).toBe(true);
    expect(isApplicationJson("Application/JSON; Charset=UTF-8")).toBe(true);
    for (const contentType of [undefined, "", "text/plain", "application/json-patch+json", "multipart/form-data"]) {
      expect(isApplicationJson(contentType), String(contentType)).toBe(false);
    }
  });
});
