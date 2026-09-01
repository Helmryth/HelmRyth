import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  keepSystemSectionVisible,
  normalizeOpenAiCompatibleEndpointUrl,
  restoreSystemFocus,
} from "./system-settings";
import { analyticsEnabled } from "./analytics";
import { StoreProvider, type ConfigStatus } from "@/state/store";
import {
  ExperimentalFeaturesRow,
  SECTIONS,
  profileEmailError,
  saveProfile,
  sectionMatches,
} from "@/components/SettingsModal";

describe("System settings helpers", () => {
  it.each([
    [" https://models.example.test/v1/ ", "https://models.example.test/v1"],
    ["https://models.example.test/v1///", "https://models.example.test/v1"],
    ["https://models.example.test/", "https://models.example.test"],
    ["http://127.0.0.1:11434/v1/", "http://127.0.0.1:11434/v1"],
    ["https://models.example.test/v1", "https://models.example.test/v1"],
    ["not yet a URL/", "not yet a URL/"],
    ["   ", ""],
  ])("canonicalizes compatible endpoint %j", (input, expected) => {
    expect(normalizeOpenAiCompatibleEndpointUrl(input)).toBe(expected);
  });

  it("restores the exact connected opener before considering a fallback", () => {
    const preferred = { isConnected: true, focus: vi.fn() };
    const fallback = { isConnected: true, focus: vi.fn() };

    restoreSystemFocus(preferred, { isConnected: false }, () => fallback, (callback) => callback());

    expect(preferred.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(fallback.focus).not.toHaveBeenCalled();
  });

  it("falls back to the persistent System launcher when an opener unmounts", () => {
    const preferred = { isConnected: false, focus: vi.fn() };
    const fallback = { isConnected: true, focus: vi.fn() };

    restoreSystemFocus(preferred, { isConnected: false }, () => fallback, (callback) => callback());

    expect(preferred.focus).not.toHaveBeenCalled();
    expect(fallback.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("does not move focus during Strict Mode cleanup rehearsal", () => {
    const preferred = { isConnected: true, focus: vi.fn() };
    const fallback = { isConnected: true, focus: vi.fn() };
    let scheduled: (() => void) | undefined;

    restoreSystemFocus(
      preferred,
      { isConnected: true },
      () => fallback,
      (callback) => { scheduled = callback; },
    );
    scheduled?.();

    expect(preferred.focus).not.toHaveBeenCalled();
    expect(fallback.focus).not.toHaveBeenCalled();
  });

  it.each([390, 430])("scrolls a focused section fully into view at %d px", () => {
    const target = { scrollIntoView: vi.fn() };

    keepSystemSectionVisible(target);

    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Helmryth System search", () => {
  it.each(["telemetry", "privacy", "analytics", "diagnostics"])(
    "reaches the privacy controls by searching %j",
    (query) => {
      expect(SECTIONS.filter((section) => sectionMatches(section, query)).map((section) => section.id)).toContain("general");
    },
  );

  it("keeps the spend surface reachable under the name it used to carry", () => {
    expect(SECTIONS.filter((section) => sectionMatches(section, "run ledger")).map((section) => section.id)).toEqual(["usage"]);
    expect(SECTIONS.find((section) => section.id === "usage")?.label).toBe("Spend ledger");
  });
});

describe("System profile save", () => {
  // SAFETY: saveProfile only forwards whatever the core returned; these tests
  // assert identity of that object, never any field on it.
  const config = {} as ConfigStatus;

  it("reports a failed write instead of leaving the profile looking saved", async () => {
    const put = async () => {
      throw new Error("Helmryth’s local service hit an unexpected error.");
    };

    await expect(saveProfile({ name: "Ada", email: "ada@example.com" }, put)).resolves.toEqual({
      ok: false,
      error: "Helmryth’s local service hit an unexpected error.",
    });
  });

  it("normalizes the address and hands back the config the core returned", async () => {
    const put = vi.fn(async () => config);

    await expect(saveProfile({ name: " Ada ", email: " Ada@Example.COM " }, put)).resolves.toEqual({ ok: true, config });
    expect(put).toHaveBeenCalledWith("/api/config", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ profile: { name: "Ada", email: "ada@example.com" } }),
    }));
  });

  it("refuses an address the email field only looked like it validated", async () => {
    const put = vi.fn(async () => config);

    const result = await saveProfile({ name: "Ada", email: "ada@example" }, put);

    expect(result.ok).toBe(false);
    expect(put).not.toHaveBeenCalled();
    expect(profileEmailError("ada@example")).toMatch(/you@example\.com/);
    expect(profileEmailError("ada example.com")).not.toBeNull();
    expect(profileEmailError("  ")).toBeNull(); // clearing the address is a real save
    expect(profileEmailError("ada@example.com")).toBeNull();
  });
});

describe("Field trials", () => {
  it("does not promise every trial is off while the built-in browser ships on", () => {
    vi.stubGlobal("window", { helmryth: {} });
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(ExperimentalFeaturesRow)));
    const browserSwitch = markup.split('aria-label="Enable the built-in browser"')[0].split("<button").pop() ?? "";

    expect(browserSwitch).toContain('aria-checked="true"');
    expect(markup).not.toContain("remain off until you enable them");
  });
});

describe("Product telemetry control", () => {
  it("is documented as the opt-in it actually is", () => {
    const source = readFileSync(new URL("../components/SettingsModal.tsx", import.meta.url), "utf8");
    const doc = source.slice(0, source.indexOf("function AnalyticsRow(")).split("/**").pop() ?? "";

    // A comment that lies about a privacy control is worse than no comment.
    expect(analyticsEnabled()).toBe(false);
    expect(doc).not.toMatch(/on by default/i);
    expect(doc).toMatch(/off/i);
  });
});
