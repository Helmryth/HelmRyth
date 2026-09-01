import { describe, expect, it } from "vitest";

import { resolveHighlightedLanguage } from "./code-highlighter";

describe("code highlighter language resolution", () => {
  it("maps common aliases onto supported grammars", () => {
    expect(resolveHighlightedLanguage("ts")).toBe("typescript");
    expect(resolveHighlightedLanguage("tsx")).toBe("tsx");
    expect(resolveHighlightedLanguage("sh")).toBe("bash");
    expect(resolveHighlightedLanguage("cpp")).toBe("c");
    expect(resolveHighlightedLanguage("ps1")).toBe("powershell");
  });

  it("falls back to plain rendering for unsupported or empty languages", () => {
    expect(resolveHighlightedLanguage("")).toBeNull();
    expect(resolveHighlightedLanguage("emacs-lisp")).toBeNull();
    expect(resolveHighlightedLanguage("wasm")).toBeNull();
  });
});
