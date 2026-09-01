import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from "react";
import { SIGIL_COLORS, type SigilColor, type SigilMotion, type SigilState } from "@/lib/sigil";
import { OperatorSigil, type OperatorSigilHandle } from "./OperatorSigil";
import { botAvatarProfile, type BotAvatarCrop } from "../../shared/bot-avatar";

export const FACE_X = 60;
export const FACE_Y = 60;
export const FACE_SCALE = 1;
export const EYE_SCALE = 1;
export const MOUTH_WEIGHT = 4;

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

function paletteFor(color: SigilColor): [string, string, string] {
  const fill = SIGIL_COLORS[color] ?? SIGIL_COLORS.red;
  return [mix(fill, "#fff6ec", 0.56), fill, mix(fill, "#112027", 0.4)];
}

function stateForMotion(state: SigilState, motion: SigilMotion): SigilState {
  switch (motion) {
    case "arrive":
      return "spawning";
    case "switch":
      return "waking";
    case "customize":
      return "proud";
    case "alert":
      return "alerting";
    case "thinking":
      return "thinking";
    case "working":
      return "working";
    case "launch":
      return "loading";
    case "success":
      return "proud";
    case "celebrate":
      return "celebrate";
    case "surprise":
      return "surprised";
    case "failure":
      return "sad";
    default:
      return state;
  }
}

export type SigilAvatarHandle = OperatorSigilHandle;

export type SigilAvatarProps = {
  color: SigilColor;
  state?: SigilState;
  expression?: number;
  size?: number;
  label?: string;
  motion?: SigilMotion;
  motionKey?: number;
  turn?: number;
  gaze?: { x?: number; y?: number };
  spring?: number;
  eyeScale?: number;
  showMouth?: boolean;
  mouthStroke?: number;
  forward?: boolean;
  lookAround?: number;
  trackPointer?: boolean;
  animated?: boolean;
  eyeSpacing?: number;
  faceX?: number;
  faceY?: number;
  faceScale?: number;
};

function SigilAvatarComponent(
  {
    color,
    state = "idle",
    expression,
    size = 44,
    label,
    motion = "none",
    motionKey = 0,
    turn,
    gaze,
    spring: _spring,
    eyeScale: _eyeScale,
    showMouth: _showMouth,
    mouthStroke: _mouthStroke,
    forward,
    lookAround: _lookAround,
    trackPointer,
    animated = true,
    eyeSpacing,
    faceX,
    faceY,
    faceScale,
  }: SigilAvatarProps,
  ref: React.Ref<SigilAvatarHandle>,
) {
  void motionKey;
  void forward;
  void trackPointer;
  void _spring;
  void _eyeScale;
  void _showMouth;
  void _mouthStroke;
  void _lookAround;
  void eyeSpacing;
  void faceX;
  void faceY;
  void faceScale;
  const inner = useRef<OperatorSigilHandle>(null);

  useImperativeHandle(ref, () => ({
    blink: () => inner.current?.blink(),
    spin: (durationMs?: number) => inner.current?.spin(durationMs),
    setExpression: (index: number) => inner.current?.setExpression(index),
  }));

  useEffect(() => {
    if (!animated) return;
    if (motion === "blink") inner.current?.blink();
    if (motion === "celebrate") inner.current?.spin(1100);
    if (motion === "switch") inner.current?.spin(700);
  }, [animated, motion, motionKey]);

  return (
    <span className="inline-flex shrink-0">
      <OperatorSigil
        ref={inner}
        state={stateForMotion(state, motion)}
        expression={expression}
        size={size}
        palette={paletteFor(color)}
        title={label ?? null}
        gaze={gaze}
        turn={turn}
        paused={!animated}
      />
    </span>
  );
}

export const SigilAvatar = memo(forwardRef(SigilAvatarComponent));

export type BotAvatarProps = Omit<SigilAvatarProps, "color"> & {
  bot: {
    name?: string;
    color: SigilColor;
    avatarUrl?: string | null;
    avatarCrop?: BotAvatarCrop;
  };
};

export function BotAvatar({ bot, size = 44, label, ...sigilProps }: BotAvatarProps) {
  const profile = botAvatarProfile(bot);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => setImageFailed(false), [profile.avatarUrl]);

  if (profile.avatarCrop === "sigil" || !profile.avatarUrl || imageFailed) {
    return <SigilAvatar {...sigilProps} color={bot.color} size={size} label={label ?? bot.name} />;
  }

  const radius =
    profile.avatarCrop === "circle"
      ? "50%"
      : profile.avatarCrop === "rounded"
        ? "22%"
        : "0";
  return (
    <img
      src={profile.avatarUrl}
      alt={label ?? (bot.name ? `${bot.name} portrait` : "Operator portrait")}
      width={size}
      height={size}
      draggable={false}
      onError={() => setImageFailed(true)}
      className="block shrink-0 bg-raised object-cover"
      style={{ width: size, height: size, borderRadius: radius }}
    />
  );
}

export function InitialsAvatar({ initials, size = 32 }: { initials: string; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-[10px] border border-hairline/60 bg-raised font-semibold text-ink-secondary"
      style={{ width: size, height: size, fontSize: size * 0.34 }}
    >
      {initials}
    </div>
  );
}
