import { useRef, useState } from "react";
import { Aperture, Check, ImagePlus, Loader2, Trash2 } from "lucide-react";

import { api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { imageAttachmentFromFile } from "@/lib/composer-attachments";
import { cn } from "@/lib/cn";
import {
  SIGIL_COLORS as HELMRYTH_SIGNAL_COLORS,
  OPERATOR_SIGNAL_COLOR_NAMES as STORED_SIGNAL_COLOR_NAMES,
  type SigilMotion,
  type SigilState,
} from "@/lib/sigil";
import {
  BOT_AVATAR_CROPS,
  botAvatarUrlFromStoredPath,
  type BotAvatarCrop,
} from "../../shared/bot-avatar";
import { BotAvatar, SigilAvatar } from "./Avatar";

type AvatarPatch = Partial<
  Pick<Bot, "avatarCrop" | "avatarUrl" | "color" | "sigilExpression">
>;

const CROP_LABEL = {
  sigil: "Signal",
  circle: "Circle",
  rounded: "Rounded",
  square: "Square",
} satisfies Record<BotAvatarCrop, string>;

type StoredSignalColor = (typeof STORED_SIGNAL_COLOR_NAMES)[number];

const SIGNAL_COLOR_LABELS = {
  green: "Moss",
  blue: "Harbor",
  red: "Vermilion",
  orange: "Ember",
  purple: "Cinder",
  cyan: "Petrol",
  pink: "Clay",
  yellow: "Gold",
  teal: "Tide",
  coral: "Fired clay",
} satisfies Record<StoredSignalColor, string>;

const PICKABLE_PULSES = [
  { state: "idle", label: "Standby" },
  { state: "happy", label: "Clear" },
  { state: "curious", label: "Scanning" },
  { state: "drowsy", label: "Low signal" },
  { state: "working", label: "Executing" },
  { state: "thinking", label: "Deliberating" },
  { state: "listening", label: "Receiving" },
  { state: "sleeping", label: "Dormant" },
  { state: "suspicious", label: "Reviewing" },
  { state: "proud", label: "Resolved" },
] as const satisfies ReadonlyArray<{ state: SigilState; label: string }>;

export function ImageKeyEntryForm({
  value,
  saving,
  placeholder,
  ariaLabel,
  inputClassName,
  buttonClassName,
  formClassName,
  onChange,
  onSubmit,
}: {
  value: string;
  saving: boolean;
  placeholder: string;
  ariaLabel: string;
  inputClassName: string;
  buttonClassName: string;
  formClassName?: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className={formClassName}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          autoComplete="off"
          className={inputClassName}
        />
        <button
          type="submit"
          disabled={saving || !value.trim()}
          className={buttonClassName}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} /> Save</>}
        </button>
      </div>
    </form>
  );
}

export function BotProfileAvatarCard({
  bot,
  activeState,
  sigilMotion,
  onPatch,
}: {
  bot: Bot;
  activeState: SigilState;
  sigilMotion: { kind: Exclude<SigilMotion, "none">; nonce: number } | null;
  onPatch: (patch: AvatarPatch) => void;
}) {
  const { state, dispatch, flushBotPatches } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [imageKey, setImageKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [direction, setDirection] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const crop = bot.avatarCrop ?? "sigil";
  const cropRef = useRef(crop);
  cropRef.current = crop;
  const imageConfigured = state.config?.imageGen?.configured === true;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const saved = await imageAttachmentFromFile(file);
      if (!saved) throw new Error("Choose a PNG, JPEG, GIF, or WebP image");
      const avatarUrl = botAvatarUrlFromStoredPath(saved.path);
      if (!avatarUrl) throw new Error("The uploaded image could not be used as an identity mark");
      const latestCrop = cropRef.current;
      onPatch({ avatarUrl, avatarCrop: latestCrop === "sigil" ? "circle" : latestCrop });
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeImage = () => {
    setError(null);
    onPatch({ avatarUrl: null, avatarCrop: "sigil" });
  };

  const saveImageKey = async () => {
    if (savingKey) return;
    const key = imageKey.trim();
    if (!key) return;
    setSavingKey(true);
    setError(null);
    try {
      const status: ConfigStatus = window.helmryth?.setCredential
        ? await window.helmryth.setCredential("openaiImageApiKey", key)
        : await api("/api/config", {
            method: "PUT",
            body: JSON.stringify({ imageGen: { key } }),
          });
      dispatch({ type: "configStatus", config: status });
      setImageKey("");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSavingKey(false);
    }
  };

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      // Generation reads the bot's identity and crop server-side. Commit any
      // debounced profile edits first, then feed the generated avatar back
      // through the same serialized mutation lane as upload/remove.
      const cropAtStart = cropRef.current;
      await flushBotPatches(bot.id);
      const result: { avatarUrl: string; bot: Bot } = await api(`/api/bots/${bot.id}/avatar/generate`, {
        method: "POST",
        body: JSON.stringify({ prompt: direction.trim() }),
      });
      const latestCrop = cropRef.current;
      onPatch({
        avatarUrl: result.avatarUrl,
        avatarCrop:
          latestCrop === cropAtStart
            ? (result.bot.avatarCrop ?? "circle")
            : latestCrop,
      });
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : String(generateError));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <section className="overflow-hidden border-y border-hairline/50">
      <div className="flex items-center justify-between border-b border-hairline/40 px-3 py-2.5">
        <span className="border-l-2 border-signal pl-2 text-[14px] font-semibold text-ink">Identity mark</span>
        <button
          onClick={() => onPatch({ avatarCrop: "sigil", color: "red", sigilExpression: null })}
          className="rounded-md px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
        >
          Restore signal mark
        </button>
      </div>

      <div className="p-3">
        <div className="flex justify-center py-3">
          <BotAvatar
            bot={bot}
            state={activeState}
            size={112}
            motion={sigilMotion?.kind ?? "none"}
            motionKey={sigilMotion?.nonce ?? 0}
          />
        </div>

        <div className="mt-2 flex gap-2">
          {/* `hidden`, not `sr-only`: sr-only keeps the element rendered, so it
              stayed in the tab order as a nameless 1x1 stop with no visible
              focus, announced as an unlabelled "Choose File". The visible
              button below is the real control and opens it via ref — the same
              pattern as the composer's attachment input. */}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            onChange={(event) => void upload(event.target.files?.[0])}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading || generating}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />}
            Upload image
          </button>
          {bot.avatarUrl && (
            <button
              type="button"
              onClick={removeImage}
              disabled={uploading || generating}
              aria-label="Remove custom identity image"
              title="Remove custom identity image"
              className="flex size-10 items-center justify-center rounded-lg text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
        <div className="mt-1.5 text-[11.5px] text-ink-secondary">PNG, JPEG, GIF, or WebP · up to 10 MB</div>

        <div className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
          Shape
        </div>
        <div className="grid grid-cols-4 overflow-hidden rounded-lg border border-hairline/40">
          {BOT_AVATAR_CROPS.map((candidate, index) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={crop === candidate}
              onClick={() => onPatch({ avatarCrop: candidate })}
              className={cn(
                "py-1.5 text-[12.5px]",
                index > 0 && "border-l border-hairline/40",
                crop === candidate ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink",
              )}
            >
              {CROP_LABEL[candidate]}
            </button>
          ))}
        </div>

        {crop === "sigil" && (
          <>
            <div className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
              Pulse state
            </div>
            <div className="grid grid-cols-5 gap-2">
              {PICKABLE_PULSES.map(({ state: expression, label }) => (
                <button
                  key={expression}
                  type="button"
                  aria-pressed={activeState === expression}
                  onClick={() => onPatch({ sigilExpression: expression })}
                  className={cn(
                    "flex h-[58px] items-center justify-center rounded-md bg-inset hover:bg-control",
                    activeState === expression && "ring-2 ring-accent-border",
                  )}
                  title={label}
                  aria-label={`Use ${label} pulse state`}
                >
                  <SigilAvatar color={bot.color} state={expression} size={42} animated={false} />
                </button>
              ))}
            </div>

            <div className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
              Signal color
            </div>
            <div className="flex flex-wrap gap-2.5">
              {STORED_SIGNAL_COLOR_NAMES.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-pressed={bot.color === color}
                  onClick={() => onPatch({ color })}
                  className={cn(
                    "size-9 rounded-md border-2 border-transparent transition-transform hover:scale-105",
                    bot.color === color && "ring-2 ring-accent-border ring-offset-2 ring-offset-card",
                  )}
                  style={{ backgroundColor: HELMRYTH_SIGNAL_COLORS[color] }}
                  title={SIGNAL_COLOR_LABELS[color]}
                  aria-label={`Use ${SIGNAL_COLOR_LABELS[color]} signal color`}
                />
              ))}
            </div>
          </>
        )}

        <div className="mt-5 border-t border-hairline/40 pt-4">
          <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
            <Aperture size={14} className="text-signal" /> Generated identity image
          </div>
          <div className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">
            Uses a low-quality square draft to keep cost down. OpenAI bills your API account.
          </div>

          {!imageConfigured ? (
            <div className="mt-3">
              <ImageKeyEntryForm
                value={imageKey}
                saving={savingKey}
                placeholder="Paste OpenAI image API key"
                ariaLabel="OpenAI image API key"
                inputClassName="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[12.5px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
                buttonClassName="flex w-[72px] items-center justify-center gap-1.5 rounded-lg bg-control text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-50"
                onChange={setImageKey}
                onSubmit={() => void saveImageKey()}
              />
              <div className="mt-1.5 text-[11px] text-ink-secondary">Stored in the operating system's encrypted credential store in the installed app.</div>
            </div>
          ) : (
            <div className="mt-3">
              <textarea
                value={direction}
                onChange={(event) => setDirection(event.target.value.slice(0, 400))}
                maxLength={400}
                placeholder={`Optional direction, e.g. “a precise navigation instrument for ${bot.title || bot.name}”`}
                aria-label="Identity image direction"
                className="min-h-[72px] w-full resize-none rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[12.5px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-[11px] tabular-nums text-ink-secondary">{direction.length}/400</span>
                <button
                  type="button"
                  onClick={() => void generate()}
                  disabled={generating || uploading}
                  className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-accent-ink hover:brightness-95 disabled:opacity-50"
                >
                  {generating ? <Loader2 size={13} className="animate-spin" /> : <Aperture size={13} />}
                  {generating ? "Generating…" : "Generate image"}
                </button>
              </div>
              <details className="mt-3 rounded-lg border border-hairline/40 bg-inset px-3 py-2">
                <summary className="cursor-pointer text-[11.5px] text-ink-secondary">Replace OpenAI image key</summary>
                <ImageKeyEntryForm
                  value={imageKey}
                  saving={savingKey}
                  placeholder="Paste replacement key"
                  ariaLabel="Replacement OpenAI image API key"
                  formClassName="mt-2"
                  inputClassName="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-card px-3 py-2 text-[12px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
                  buttonClassName="flex w-[72px] items-center justify-center gap-1.5 rounded-lg bg-control text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50"
                  onChange={setImageKey}
                  onSubmit={() => void saveImageKey()}
                />
              </details>
            </div>
          )}
        </div>

        {error && <div role="alert" className="mt-3 text-[12px] text-danger">{error}</div>}
      </div>
    </section>
  );
}
