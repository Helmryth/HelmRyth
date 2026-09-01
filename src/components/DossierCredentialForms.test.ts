import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ImageKeyEntryForm } from "./BotProfileAvatarCard";
import { VoiceKeyEntryForm } from "./VoiceSettings";

describe("operator dossier credential forms", () => {
  it("wraps the initial OpenAI image key entry in a submit form", () => {
    const markup = renderToStaticMarkup(createElement(ImageKeyEntryForm, {
      value: "sk-test",
      saving: false,
      placeholder: "Paste OpenAI image API key",
      ariaLabel: "OpenAI image API key",
      inputClassName: "input",
      buttonClassName: "button",
      onChange: () => undefined,
      onSubmit: () => undefined,
    }));

    expect(markup).toMatch(/^<form>/);
    expect(markup).toContain('aria-label="OpenAI image API key"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('type="submit"');
  });

  it("wraps the replacement OpenAI image key entry in a submit form", () => {
    const markup = renderToStaticMarkup(createElement(ImageKeyEntryForm, {
      value: "sk-test",
      saving: false,
      placeholder: "Paste replacement key",
      ariaLabel: "Replacement OpenAI image API key",
      formClassName: "mt-2",
      inputClassName: "input",
      buttonClassName: "button",
      onChange: () => undefined,
      onSubmit: () => undefined,
    }));

    expect(markup).toMatch(/^<form class="mt-2">/);
    expect(markup).toContain('aria-label="Replacement OpenAI image API key"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('type="submit"');
  });

  it("wraps the ElevenLabs key entry in a submit form", () => {
    const markup = renderToStaticMarkup(createElement(VoiceKeyEntryForm, {
      configured: false,
      value: "eleven",
      saving: false,
      onChange: () => undefined,
      onSubmit: () => undefined,
    }));

    expect(markup).toMatch(/^<form>/);
    expect(markup).toContain('aria-label="ElevenLabs key"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('type="submit"');
  });
});
