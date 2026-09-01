import { z } from "zod";

/**
 * Credentials an operator may ask the person to provide through an inline
 * card. The id is the entire authority surface: operators never choose a
 * config path, label, URL, or arbitrary field name.
 */
export const CREDENTIAL_TARGET_IDS = [
  "xaiApiKey",
  "openaiCompatApiKey",
  "boxToken",
  "opencodeGoApiKey",
  "ttsKey",
  "openaiImageApiKey",
] as const;

export type CredentialTargetId = (typeof CREDENTIAL_TARGET_IDS)[number];

export const CREDENTIAL_TARGETS = {
  xaiApiKey: {
    label: "xAI API key",
    description: "Used by the built-in Grok provider.",
    placeholder: "xai-…",
    helpUrl: "https://console.x.ai/",
  },
  openaiCompatApiKey: {
    label: "OpenAI-compatible API key",
    description: "Used by the configured OpenAI-compatible engine endpoint.",
    placeholder: "Paste the endpoint API key",
    helpUrl: "https://openrouter.ai/keys",
  },
  boxToken: {
    label: "Box API key",
    description: "Gives operators an isolated cloud Workbench when Box is selected.",
    placeholder: "Paste your Box API key",
    helpUrl: "https://docs.ascii.dev/box/api-keys",
  },
  opencodeGoApiKey: {
    label: "OpenCode API key",
    description: "Used for OpenCode Go and other key-backed OpenCode providers.",
    placeholder: "Paste your OpenCode API key",
    helpUrl: "https://opencode.ai/docs/providers/",
  },
  ttsKey: {
    label: "ElevenLabs API key",
    description: "Enables text-to-speech voices in calls.",
    placeholder: "Paste your ElevenLabs API key",
    helpUrl: "https://elevenlabs.io/app/settings/api-keys",
  },
  openaiImageApiKey: {
    label: "OpenAI API key",
    description: "Used only to generate custom Helmryth operator sigils.",
    placeholder: "sk-…",
    helpUrl: "https://platform.openai.com/api-keys",
  },
} as const satisfies Record<CredentialTargetId, {
  label: string;
  description: string;
  placeholder: string;
  helpUrl: string;
}>;

export type CredentialConfig = {
  xai?: { key?: string };
  openaiCompat?: { key?: string };
  box?: { token?: string };
  opencodeGo?: { apiKey?: string };
  tts?: { key?: string };
  imageGen?: { key?: string };
};

const credentialTargetIdSchema = z.enum(CREDENTIAL_TARGET_IDS);

export function isCredentialTargetId<Candidate>(value: Candidate): value is Candidate & CredentialTargetId {
  return credentialTargetIdSchema.safeParse(value).success;
}

export function credentialConfigPatch(id: CredentialTargetId, value: string): CredentialConfig {
  switch (id) {
    case "xaiApiKey":
      return { xai: { key: value } };
    case "openaiCompatApiKey":
      return { openaiCompat: { key: value } };
    case "boxToken":
      return { box: { token: value } };
    case "opencodeGoApiKey":
      return { opencodeGo: { apiKey: value } };
    case "ttsKey":
      return { tts: { key: value } };
    case "openaiImageApiKey":
      return { imageGen: { key: value } };
  }
}

export function credentialIsConfigured(config: CredentialConfig, id: CredentialTargetId): boolean {
  switch (id) {
    case "xaiApiKey":
      return Boolean(config.xai?.key);
    case "openaiCompatApiKey":
      return Boolean(config.openaiCompat?.key);
    case "boxToken":
      return Boolean(config.box?.token);
    case "opencodeGoApiKey":
      return Boolean(config.opencodeGo?.apiKey);
    case "ttsKey":
      return Boolean(config.tts?.key);
    case "openaiImageApiKey":
      return Boolean(config.imageGen?.key);
  }
}

export function isReusableCredentialRequest(
  message: {
    kind?: unknown;
    secret?: { target?: unknown; provided?: unknown; dismissed?: unknown };
    from?: { botId?: unknown };
  },
  target: CredentialTargetId,
  requestingBotId: string,
  roomThread: boolean,
): boolean {
  return (
    message.kind === "secret" &&
    message.secret?.target === target &&
    message.secret.provided !== true &&
    message.secret.dismissed !== true &&
    (!roomThread || message.from?.botId === requestingBotId)
  );
}

export function credentialResumeOutcome(state: {
  provided?: unknown;
  dismissed?: unknown;
}): "provided" | "dismissed" | null {
  const provided = state.provided === true;
  const dismissed = state.dismissed === true;
  if (provided === dismissed) return null;
  return provided ? "provided" : "dismissed";
}
