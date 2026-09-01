import { describe, expect, it } from "vitest";

import { developmentRendererOrigin, packagedRendererOrigin } from "./renderer-origin.mjs";

describe("desktop renderer origin wiring", () => {
  it("pins packaged windows to the selected core port", () => {
    expect(packagedRendererOrigin(8799)).toBe("http://127.0.0.1:8799");
    expect(() => packagedRendererOrigin(0)).toThrow("invalid core port");
  });

  it("uses one exact origin for Vite and Electron development", () => {
    expect(developmentRendererOrigin({})).toBe("http://127.0.0.1:5199");
    expect(developmentRendererOrigin({ HELMRYTH_UI_PORT: "5299" })).toBe("http://127.0.0.1:5299");
    expect(developmentRendererOrigin({ HELMRYTH_UI_ORIGIN: "http://127.0.0.1:5299" })).toBe("http://127.0.0.1:5299");
    expect(developmentRendererOrigin({
      HELMRYTH_DESKTOP_URL: "https://ui.helmryth.test",
      HELMRYTH_UI_ORIGIN: "https://ui.helmryth.test",
    })).toBe("https://ui.helmryth.test");
    expect(() => developmentRendererOrigin({
      HELMRYTH_DESKTOP_URL: "http://127.0.0.1:5199",
      HELMRYTH_UI_ORIGIN: "http://127.0.0.1:5299",
    })).toThrow("same exact origin");
  });

  it("rejects URL credentials, opaque schemes, and non-origin suffixes", () => {
    for (const value of [
      "null",
      "file:///tmp/index.html",
      "http://127.0.0.1:5199/",
      "http://127.0.0.1:5199/path",
      "http://127.0.0.1:5199?query=1",
      "http://127.0.0.1:5199#fragment",
      "http://user:secret@127.0.0.1:5199",
    ]) {
      expect(() => developmentRendererOrigin({ HELMRYTH_DESKTOP_URL: value }), value).toThrow();
    }
  });
});
