import { OPERATOR_SIGIL_STATES, type OperatorSigilState } from "@/components/OperatorSigil";

export type SigilState = OperatorSigilState;
export const SIGIL_STATES = OPERATOR_SIGIL_STATES;

export const STATE_GROUPS = {
  "Core modes": ["sleeping", "waking", "idle", "listening", "thinking", "searching", "working"],
  "Response tones": [
    "excited",
    "surprised",
    "suspicious",
    "angry",
    "drowsy",
    "happy",
    "curious",
    "confused",
    "bored",
    "proud",
    "shy",
    "sad",
    "laughing",
    "scared",
    "playful",
    "celebrate",
  ],
  "Signal forms": ["orbit", "radar", "progress"],
  "Action beats": [
    "spawning",
    "humming",
    "loading",
    "dictating",
    "writing",
    "sending",
    "receiving",
    "uploading",
    "notifying",
    "alerting",
    "dragging",
    "bouncing",
    "powering-down",
  ],
} satisfies Record<string, SigilState[]>;

export const OPERATOR_SIGNAL_COLOR_NAMES = [
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "yellow",
  "teal",
  "coral",
] as const;

const LEGACY_ALIAS_COLOR_NAMES = ["moss", "vermilion", "petrol"] as const;
export const SIGIL_COLOR_NAMES = [...OPERATOR_SIGNAL_COLOR_NAMES, ...LEGACY_ALIAS_COLOR_NAMES] as const;

export type SigilColor = (typeof SIGIL_COLOR_NAMES)[number];

export const OPERATOR_SIGNAL_COLORS = {
  green: "#67845b",
  blue: "#2f7684",
  red: "#bf4f2e",
  orange: "#b75d3a",
  purple: "#66554c",
  cyan: "#1f6670",
  pink: "#9b6848",
  yellow: "#b88a30",
  teal: "#3e8f87",
  coral: "#c86a4b",
  moss: "#67845b",
  vermilion: "#bf4f2e",
  petrol: "#1f6670",
} satisfies Record<SigilColor, string>;

export const SIGIL_COLORS = OPERATOR_SIGNAL_COLORS;

export const OPERATOR_SIGIL_MOTIONS = [
  "arrive",
  "switch",
  "customize",
  "alert",
  "thinking",
  "working",
  "launch",
  "success",
  "celebrate",
  "blink",
  "surprise",
  "failure",
] as const;

export type SigilMotion = "none" | (typeof OPERATOR_SIGIL_MOTIONS)[number];

const LEGACY_STATES = {
  deadpan: "idle",
  friendly: "happy",
  focused: "working",
  thinking: "thinking",
  excited: "excited",
  sleepy: "drowsy",
  surprised: "surprised",
  skeptical: "suspicious",
  worried: "scared",
  mischievous: "playful",
} satisfies Record<string, SigilState>;

function isSigilState(value: string): value is SigilState {
  return SIGIL_STATES.some((candidate) => candidate === value);
}

function isLegacyStateKey(value: string): value is keyof typeof LEGACY_STATES {
  return value in LEGACY_STATES;
}

export function normalizeState(value: string | null | undefined): SigilState | null {
  if (!value) return null;
  if (isSigilState(value)) return value;
  return isLegacyStateKey(value) ? LEGACY_STATES[value] : null;
}

export const PICKABLE_STATES: SigilState[] = [
  "idle",
  "happy",
  "curious",
  "drowsy",
  "working",
  "thinking",
  "listening",
  "sleeping",
  "suspicious",
  "proud",
];

type SigilMessage = {
  kind: string;
  tool?: { ok?: boolean };
};

export type SigilBotProfile = {
  name: string;
  title?: string;
  description?: string;
  sigilExpression?: string | null;
  busy?: boolean;
  unread?: boolean;
  messages?: SigilMessage[];
};

export function stateForBot(bot: SigilBotProfile): SigilState {
  const pinned = normalizeState(bot.sigilExpression);
  if (pinned) return pinned;

  const last = bot.messages?.[bot.messages.length - 1];

  if (last?.kind === "activity" && last.tool?.ok === false) return "alerting";
  if (bot.busy) return "working";
  if (bot.unread) return "notifying";
  if (last?.kind === "options") return "curious";

  const profile = `${bot.name} ${bot.title ?? ""} ${bot.description ?? ""}`.toLowerCase();
  const matches = (words: RegExp) => words.test(profile);

  if (matches(/\b(code|coding|developer|development|engineer|engineering|build|debug|program|software)\b/)) {
    return "working";
  }
  if (matches(/\b(research|researcher|search|investigate|strategy|strategist|study|learn|knowledge)\b/)) {
    return "searching";
  }
  if (matches(/\b(marketing|growth|launch|campaign|social|sales|outreach|brand)\b/)) {
    return "excited";
  }
  if (matches(/\b(overnight|night|background|async|queue|batch|long-running)\b/)) {
    return "drowsy";
  }
  if (matches(/\b(monitor|monitoring|incident|alert|watch|status|uptime)\b/)) {
    return "radar";
  }
  if (matches(/\b(review|reviewer|audit|critic|critique|quality|qa|test|legal)\b/)) {
    return "suspicious";
  }
  if (matches(/\b(security|secure|compliance|risk|privacy|finance|financial)\b/)) {
    return "scared";
  }
  if (matches(/\b(design|designer|creative|brainstorm|art|illustration|music|story)\b/)) {
    return "playful";
  }
  if (matches(/\b(support|help|success|onboarding|coach|teacher|guide|welcome)\b/)) {
    return "happy";
  }

  return "idle";
}
