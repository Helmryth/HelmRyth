import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", {
    value: { helmryth: {} },
    configurable: true,
    writable: true,
  });
});

import { StoreProvider } from "@/state/store";
import { ApiKeyRow } from "./ApiKeys";
import { TranscriptionSettings } from "./TranscriptionSettings";

describe("System credential forms", () => {
  it("contains compatible endpoint password fields in a submit form", () => {
    const markup = renderToStaticMarkup(
      createElement(StoreProvider, null, createElement(ApiKeyRow, { section: "openaiCompat" })),
    );

    expect(markup).toMatch(/^<form>/);
    expect(markup).toContain('type="password"');
    expect(markup).toContain('type="submit"');
    expect(markup).toMatch(/<form>[\s\S]*type="password"[\s\S]*type="submit"[\s\S]*<\/form>$/);
  });

  it("contains the desktop transcription password field in a submit form", () => {
    const markup = renderToStaticMarkup(createElement(TranscriptionSettings));

    expect(markup).toMatch(/^<form>/);
    expect(markup).toContain('type="password"');
    expect(markup).toContain('type="submit"');
    expect(markup).toMatch(/<form>[\s\S]*type="password"[\s\S]*type="submit"[\s\S]*<\/form>$/);
  });
});
