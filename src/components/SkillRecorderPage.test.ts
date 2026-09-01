import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RecorderTranscriptionStatus } from "./SkillRecorderPage";

describe("recorded-method transcription readiness", () => {
  it("renders loading without flashing the unavailable-key message", () => {
    const markup = renderToStaticMarkup(createElement(RecorderTranscriptionStatus, {
      status: "loading",
      openSettings: vi.fn(),
    }));

    expect(markup).toContain("Checking transcription status");
    expect(markup).not.toContain("Add an AssemblyAI key");
  });

  it("renders ready and unavailable as distinct actionable states", () => {
    const ready = renderToStaticMarkup(createElement(RecorderTranscriptionStatus, {
      status: "ready",
      openSettings: vi.fn(),
    }));
    const unavailable = renderToStaticMarkup(createElement(RecorderTranscriptionStatus, {
      status: "unavailable",
      openSettings: vi.fn(),
    }));

    expect(ready).toContain("AssemblyAI is ready for live narration");
    expect(ready).toContain("Saved");
    expect(unavailable).toContain("Add an AssemblyAI key");
    expect(unavailable).toContain("Open Settings");
  });
});
