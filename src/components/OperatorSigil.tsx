import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type CSSProperties,
} from "react";

export interface OperatorSigilTemplate {
  name: string;
  fit: string;
  body: string;
  clip: string;
  anchor: { x: number; y: number; scale: number };
}

export const DEFAULT_OPERATOR_SIGIL_TEMPLATE: OperatorSigilTemplate = {
  name: "operator-sigil",
  fit: "",
  body: "",
  clip: "",
  anchor: { x: 60, y: 60, scale: 1 },
};

export const OPERATOR_SIGIL_STATES = [
  "sleeping",
  "waking",
  "idle",
  "listening",
  "thinking",
  "searching",
  "working",
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
  "orbit",
  "radar",
  "progress",
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
] as const;

export type OperatorSigilState = (typeof OPERATOR_SIGIL_STATES)[number];

export const EXPRESSION_COUNT = 12;

export interface OperatorSigilHandle {
  blink: () => void;
  spin: (durationMs?: number) => void;
  setExpression: (index: number) => void;
}

interface OperatorSigilProps {
  state?: OperatorSigilState;
  expression?: number;
  size?: number;
  palette?: [string, string, string];
  title?: string | null;
  gaze?: { x?: number; y?: number };
  turn?: number;
  paused?: boolean;
}

const FRAME_VARIANTS = [
  {
    outer: "M24 10h72l14 14v72l-14 14H24L10 96V24L24 10Z",
    inner: "M34 26h50l10 10v48L84 94H34L24 84V36L34 26Z",
    notch: "M92 18h8l10 10v8h-8L92 26V18Z",
  },
  {
    outer: "M28 8h64l20 20v64l-20 20H28L8 92V28L28 8Z",
    inner: "M34 22h52l12 12v52L86 98H34L22 86V34L34 22Z",
    notch: "M18 84v10l8 8h10v-8L26 84H18Z",
  },
  {
    outer: "M20 12h76l12 12v76l-12 12H20L8 100V24L20 12Z",
    inner: "M30 24h56l10 10v52L86 96H30L20 86V34L30 24Z",
    notch: "M20 20h16v8H20z",
  },
  {
    outer: "M26 10h68l16 16v68l-16 16H26L10 94V26L26 10Z",
    inner: "M34 24h52l10 10v52L86 96H34L24 86V34L34 24Z",
    notch: "M84 94h12v-12H84z",
  },
];

const WEAVE_PATTERNS = [
  ["M33 78L78 33", "M42 87L87 42", "M28 60H92"],
  ["M30 34L86 90", "M34 86L90 30", "M26 58H94"],
  ["M38 28L82 72", "M28 72L72 28", "M40 92L92 40"],
  ["M28 40H92", "M28 58H92", "M40 26L92 78"],
  ["M32 86L86 32", "M26 44H94", "M38 94L94 38"],
  ["M28 30L90 92", "M28 90L90 28", "M32 60H88"],
] as const;

const PULSE_PATTERNS = [
  "M36 60H84",
  "M38 52H82M38 68H82",
  "M40 60H80M52 40V80",
  "M42 48H78M42 60H78M42 72H78",
] as const;

const DEFAULT_PALETTE: [string, string, string] = ["#D46836", "#A84323", "#5B261C"];

const MOTION_BY_STATE = {
  sleeping: "rest",
  waking: "arrive",
  idle: "idle",
  listening: "listening",
  thinking: "thinking",
  searching: "thinking",
  working: "working",
  excited: "working",
  surprised: "alert",
  suspicious: "thinking",
  angry: "alert",
  drowsy: "rest",
  happy: "idle",
  curious: "thinking",
  confused: "thinking",
  bored: "rest",
  proud: "idle",
  shy: "rest",
  sad: "rest",
  laughing: "working",
  scared: "alert",
  playful: "working",
  celebrate: "working",
  orbit: "working",
  radar: "listening",
  progress: "working",
  spawning: "arrive",
  humming: "idle",
  loading: "working",
  dictating: "listening",
  writing: "working",
  sending: "working",
  receiving: "listening",
  uploading: "working",
  notifying: "alert",
  alerting: "alert",
  dragging: "working",
  bouncing: "working",
  "powering-down": "rest",
} satisfies Record<OperatorSigilState, string>;

type OperatorSigilStyle = CSSProperties & Record<`--${string}`, string | number>;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeIndex(value: number, length: number) {
  return ((Math.trunc(value) % length) + length) % length;
}

function hashSeed(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function mix(hex: string, toward: string, amount: number) {
  const source = Number.parseInt(hex.slice(1), 16);
  const target = Number.parseInt(toward.slice(1), 16);
  const channel = (shift: number) => {
    const from = (source >> shift) & 0xff;
    const to = (target >> shift) & 0xff;
    return Math.round(from + (to - from) * amount);
  };
  return `#${[channel(16), channel(8), channel(0)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")}`;
}

function markerForState(state: OperatorSigilState) {
  if (
    state === "working" ||
    state === "loading" ||
    state === "writing" ||
    state === "sending" ||
    state === "uploading" ||
    state === "progress" ||
    state === "celebrate"
  ) {
    return (
      <>
        <path className="helmryth-sigil__marker" d="M88 36a28 28 0 0 1 0 48" />
        <path className="helmryth-sigil__marker helmryth-sigil__marker--soft" d="M32 84a28 28 0 0 1 0-48" />
      </>
    );
  }
  if (
    state === "alerting" ||
    state === "surprised" ||
    state === "angry" ||
    state === "scared" ||
    state === "notifying"
  ) {
    return <path className="helmryth-sigil__marker" d="M60 26l14 14-14 14-14-14 14-14Zm0 42 10 10-10 10-10-10 10-10Z" />;
  }
  if (state === "listening" || state === "dictating" || state === "radar" || state === "receiving") {
    return <path className="helmryth-sigil__marker" d="M28 60h12m40 0h12m-8-12 8 12-8 12M36 48l-8 12 8 12" />;
  }
  if (state === "sleeping" || state === "drowsy" || state === "bored" || state === "powering-down") {
    return <path className="helmryth-sigil__marker helmryth-sigil__marker--soft" d="M36 80h48M44 88h32" />;
  }
  return <path className="helmryth-sigil__marker helmryth-sigil__marker--soft" d="M34 34h18M68 34h18M34 86h18M68 86h18" />;
}

export const OperatorSigil = forwardRef<OperatorSigilHandle, OperatorSigilProps>(function OperatorSigil(
  props,
  ref,
) {
  const {
    state = "idle",
    expression,
    size = 44,
    palette = DEFAULT_PALETTE,
    title = null,
    gaze,
    turn = 0,
    paused = false,
  } = props;

  const [overrideExpression, setOverrideExpression] = useState<number | null>(null);
  const [blinkTick, setBlinkTick] = useState(0);
  const [spinUntil, setSpinUntil] = useState(0);
  const resolvedExpression = useMemo(() => {
    if (overrideExpression != null) return normalizeIndex(overrideExpression, EXPRESSION_COUNT);
    if (expression != null) return normalizeIndex(expression, EXPRESSION_COUNT);
    return normalizeIndex(hashSeed(`${title ?? state}:${palette.join(":")}`), EXPRESSION_COUNT);
  }, [expression, overrideExpression, palette, state, title]);

  useEffect(() => {
    if (spinUntil === 0) return;
    const remaining = spinUntil - Date.now();
    if (remaining <= 0) {
      setSpinUntil(0);
      return;
    }
    const timer = window.setTimeout(() => setSpinUntil(0), remaining);
    return () => window.clearTimeout(timer);
  }, [spinUntil]);

  useImperativeHandle(ref, () => ({
    blink: () => setBlinkTick((value) => value + 1),
    spin: (durationMs = 900) => setSpinUntil(Date.now() + durationMs),
    setExpression: (index: number) => setOverrideExpression(normalizeIndex(index, EXPRESSION_COUNT)),
  }));

  const frame = FRAME_VARIANTS[resolvedExpression % FRAME_VARIANTS.length];
  const weave = WEAVE_PATTERNS[resolvedExpression % WEAVE_PATTERNS.length];
  const pulse = PULSE_PATTERNS[resolvedExpression % PULSE_PATTERNS.length];
  const gazeX = clamp((gaze?.x ?? 0) * 6, -6, 6);
  const gazeY = clamp((gaze?.y ?? 0) * 6, -6, 6);
  const motion = paused ? "paused" : MOTION_BY_STATE[state];

  const style: OperatorSigilStyle = {
    width: size,
    height: size,
    "--sigil-shell": palette[1],
    "--sigil-edge": mix(palette[2], "#081218", 0.46),
    "--sigil-plate": mix(palette[0], "#ffffff", 0.76),
    "--sigil-line": mix(palette[2], "#081218", 0.36),
    "--sigil-line-soft": mix(palette[1], "#fdf8f2", 0.22),
    "--sigil-accent": mix(palette[1], "#13646c", 0.22),
  };

  return (
    <svg
      viewBox="0 0 120 120"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      data-sigil-state={state}
      data-sigil-motion={motion}
      data-sigil-blink={blinkTick > 0 ? "true" : undefined}
      className={spinUntil > Date.now() ? "helmryth-sigil helmryth-sigil--spin" : "helmryth-sigil"}
      style={style}
    >
      {title ? <title>{title}</title> : null}
      <g className="helmryth-sigil__carrier" transform={`rotate(${turn} 60 60)`}>
        <path d={frame.outer} fill="var(--sigil-shell)" stroke="var(--sigil-edge)" strokeWidth="3" />
        <path d={frame.inner} fill="var(--sigil-plate)" stroke="var(--sigil-edge)" strokeWidth="2.2" />
        <path d={frame.notch} fill="var(--sigil-accent)" opacity="0.78" />
        <g className="helmryth-sigil__braid-set">
          {weave.map((path, index) => (
            <path
              key={`${resolvedExpression}:${path}`}
              className={index === 0 ? "helmryth-sigil__braid" : "helmryth-sigil__braid helmryth-sigil__braid--soft"}
              d={path}
            />
          ))}
        </g>
        <g className="helmryth-sigil__pulse" transform={`translate(${gazeX} ${gazeY})`}>
          <path d={pulse} />
          <circle className="helmryth-sigil__node" cx="60" cy="60" r="4.5" />
        </g>
        {markerForState(state)}
      </g>
    </svg>
  );
});

export default OperatorSigil;
