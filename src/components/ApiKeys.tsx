// Paste-a-key rows. Packaged Electron saves secrets in the OS-backed store;
// browser development falls back to PUT /api/config. Secrets are write-only
// either way — GET /api/config returns configured flags, never values.
import { useEffect, useId, useRef, useState } from "react";
import { Check, CircleHelp, ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { normalizeOpenAiCompatibleEndpointUrl } from "@/lib/system-settings";

export type ConfigSection = "composio" | "box" | "opencodeGo" | "openaiCompat";

type CredentialPatch =
  | { composio: { apiKey: string } }
  | { box: { token: string } }
  | { opencodeGo: { apiKey: string } }
  | { openaiCompat: { key: string } };

interface ConfigSectionDefinition {
  body: (value: string) => CredentialPatch;
  flag: (config: ConfigStatus) => boolean;
}

interface CredentialCopy {
  label: string;
  placeholder: string;
  description: string;
  href: string;
  linkLabel: string;
  optional: boolean;
  warning?: string;
}

const SECTIONS = {
  composio: {
    body: (v) => ({ composio: { apiKey: v } }),
    flag: (c) => c.composio.configured,
  },
  box: { body: (v) => ({ box: { token: v } }), flag: (c) => c.box.configured },
  opencodeGo: { body: (v) => ({ opencodeGo: { apiKey: v } }), flag: (c) => c.opencodeGo?.configured ?? false },
  openaiCompat: {
    body: (v) => ({ openaiCompat: { key: v } }),
    flag: (c) => c.openaiCompat?.configured ?? false,
  },
} satisfies Record<ConfigSection, ConfigSectionDefinition>;

const ELECTRON_CREDENTIAL = {
  composio: "composioApiKey",
  box: "boxToken",
  opencodeGo: "opencodeGoApiKey",
  openaiCompat: "openaiCompatApiKey",
} as const satisfies Record<ConfigSection, "composioApiKey" | "boxToken" | "opencodeGoApiKey" | "openaiCompatApiKey">;

const CREDENTIALS = {
  composio: {
    label: "Composio project key",
    placeholder: "ak_…",
    description: "Connect Gmail, GitHub, Slack, Notion, and other services through your own Composio project.",
    href: "https://dashboard.composio.dev",
    linkLabel: "Create or copy a project key",
    optional: true,
    warning: undefined,
  },
  box: {
    label: "Box API key",
    placeholder: "Paste your Box API key",
    description: "Give operators an isolated remote Linux Workbench with a desktop and terminal.",
    href: "https://docs.ascii.dev/box/api-keys",
    linkLabel: "Open Box API key guide",
    optional: true,
    warning: "Box is a paid service after its trial. Usage may incur charges.",
  },
  opencodeGo: {
    label: "OpenCode API key",
    placeholder: "Paste an OpenCode API key",
    description: "Optional. Existing OpenCode Zen, Go, and other provider connections are detected automatically.",
    href: "https://opencode.ai/docs/providers/",
    linkLabel: "Open the OpenCode provider guide",
    optional: true,
    warning: undefined,
  },
  openaiCompat: {
    label: "OpenAI-compatible API key",
    placeholder: "Paste the endpoint API key",
    description: "Authenticates an OpenAI-compatible endpoint such as OpenRouter, Groq, or an owned gateway.",
    href: "https://openrouter.ai/keys",
    linkLabel: "Open the OpenRouter key page",
    optional: true,
    warning: undefined,
  },
} satisfies Record<ConfigSection, CredentialCopy>;

function CredentialHelp({ section }: { section: ConfigSection }) {
  const credential = CREDENTIALS[section];
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative ml-auto">
      <button
        ref={buttonRef}
        type="button"
        aria-label={`About ${credential.label}`}
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((current) => !current)}
        className="flex size-6 items-center justify-center rounded-md text-ink-secondary outline-none hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-signal/70"
      >
        <CircleHelp size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={popoverId}
          role="group"
          aria-label={`${credential.label} help`}
          className="animate-pop-in absolute right-0 z-30 mt-1.5 w-[270px] rounded-md border border-hairline bg-panel p-3 text-left shadow-lg"
        >
          <div className="text-[12px] leading-[1.45] text-ink-secondary">{credential.description}</div>
          {credential.warning && (
            <div className="mt-2 flex gap-1.5 rounded-lg border border-warning/25 bg-warning/10 px-2 py-1.5 text-[11px] leading-[1.4] text-warning">
              <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden="true" />
              <span>{credential.warning}</span>
            </div>
          )}
          <a
            href={credential.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            className="mt-2.5 flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            {credential.linkLabel}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>
      )}
    </div>
  );
}

export function ApiKeyRow({
  section,
  onSaved,
}: {
  section: ConfigSection;
  /** Called after a successful save with the section's new configured flag. */
  onSaved?: (configured: boolean) => void;
}) {
  const { state, dispatch } = useStore();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = state.config ? SECTIONS[section].flag(state.config) : false;
  const clearing = !value.trim() && configured;
  const [confirmClear, setConfirmClear] = useState(false);
  const credential = CREDENTIALS[section];

  const save = () => {
    if (saving || (!value.trim() && !configured)) return;
    // Clearing removes a write-only credential the UI can never show again, so
    // it arms first. Saving a NEW value is not destructive and still goes
    // straight through.
    if (clearing && !confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    setSaving(true);
    setError(null);
    const request = window.helmryth?.setCredential
      ? window.helmryth.setCredential(ELECTRON_CREDENTIAL[section], value.trim())
      : api("/api/config", {
          method: "PUT",
          body: JSON.stringify(SECTIONS[section].body(value.trim())),
        });
    request
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setValue("");
        onSaved?.(SECTIONS[section].flag(status));
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
        <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
        <span>{credential.label}</span>
        {credential.optional && (
          <span className="rounded bg-control px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-secondary">
            Optional
          </span>
        )}
        {configured && <span className="text-[11px] text-success">Connected</span>}
        <CredentialHelp section={section} />
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={configured ? "••••••••  (paste to replace)" : credential.placeholder}
          aria-label={credential.label}
          autoComplete="off"
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <button
          type="submit"
          disabled={saving || (!value.trim() && !configured)}
          onBlur={() => setConfirmClear(false)}
          className={cn(
            "flex shrink-0 items-center justify-center gap-1.5 rounded-lg py-2 text-[13px]",
            confirmClear && clearing ? "w-[104px] bg-danger/10 text-danger" : "w-[72px]",
            !confirmClear && clearing
              ? "bg-control text-danger hover:bg-raised-hover"
              : !clearing
                ? "bg-control text-ink hover:bg-raised-hover"
                : "",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          aria-label={
            clearing
              ? confirmClear
                ? `Confirm removing the saved ${credential.label}`
                : `Remove the saved ${credential.label}`
              : `Save ${credential.label}`
          }
          title={clearing ? `Remove the saved ${credential.label} — it cannot be shown again` : "Save"}
        >
          {saving
            ? <Loader2 size={13} className="animate-spin" />
            : clearing
              ? (confirmClear ? "Confirm" : "Clear")
              : <><Check size={13} />Save</>}
        </button>
      </div>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </form>
  );
}

/** OpenAI-compatible routing is intentionally split from its write-only key:
 * these endpoint selections are non-secret and remain visible/editable, while
 * the key above follows the OS-encrypted credential path in packaged builds. */
export function OpenAiCompatibleConnection() {
  const { state, dispatch } = useStore();
  const current = state.config?.openaiCompat;
  const [url, setUrl] = useState(normalizeOpenAiCompatibleEndpointUrl(current?.url ?? ""));
  const [model, setModel] = useState(current?.model ?? "");
  const [provider, setProvider] = useState(current?.provider ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrl(normalizeOpenAiCompatibleEndpointUrl(current?.url ?? ""));
    setModel(current?.model ?? "");
    setProvider(current?.provider ?? "");
  }, [current?.model, current?.provider, current?.url]);

  const normalized = {
    url: normalizeOpenAiCompatibleEndpointUrl(url),
    model: model.trim(),
    provider: provider.trim(),
  };
  const changed =
    // Compare the canonical edit with the raw stored value. A legacy trailing
    // slash therefore remains a real, reversible save instead of looking
    // unchanged after the browser normalizes the visible URL.
    normalized.url !== (current?.url ?? "").trim() ||
    normalized.model !== (current?.model ?? "") ||
    normalized.provider !== (current?.provider ?? "");

  const [justSaved, setJustSaved] = useState(false);

  const saveRouting = async () => {
    if (saving || !changed) return;
    setSaving(true);
    setError(null);
    try {
      const status: ConfigStatus = await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ openaiCompat: normalized }),
      });
      dispatch({ type: "configStatus", config: status });
      // The button also disables itself once `changed` clears, but that is a
      // quiet signal to hang a destructive-feeling action on. Say it happened.
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 2_000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the compatible endpoint.");
    } finally {
      setSaving(false);
    }
  };

  const inputClass = "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-hairline/40 bg-inset/30 p-3">
      <ApiKeyRow section="openaiCompat" />
      <div className="text-[12px] leading-relaxed text-ink-secondary">
        Endpoint, model, and provider are ordinary routing settings. The API key remains write-only and OS-encrypted in the desktop app.
      </div>
      <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
        Endpoint URL
        <input
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onBlur={() => setUrl(normalizeOpenAiCompatibleEndpointUrl(url))}
          maxLength={2048}
          placeholder="https://openrouter.ai/api/v1"
          aria-label="OpenAI-compatible endpoint URL"
          autoComplete="url"
          className={inputClass}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
          Model
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            maxLength={512}
            placeholder="provider/model"
            aria-label="OpenAI-compatible model"
            autoComplete="off"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
          Provider preference
          <input
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            maxLength={512}
            placeholder="Optional provider"
            aria-label="OpenAI-compatible provider preference"
            autoComplete="off"
            className={inputClass}
          />
        </label>
      </div>
      <div className="flex items-center justify-end gap-3">
        {error ? <span role="alert" className="text-[12px] text-danger">{error}</span> : null}
        <span aria-live="polite" className="sr-only">{justSaved ? "Routing saved" : ""}</span>
        <button
          type="button"
          onClick={() => void saveRouting()}
          disabled={saving || !changed}
          className="flex min-h-9 min-w-[104px] items-center justify-center gap-1.5 rounded-lg bg-control px-3 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
          {saving ? "Saving…" : justSaved ? "Saved" : "Save routing"}
        </button>
      </div>
    </div>
  );
}

/** Non-secret Docker-over-SSH target. Keys and passwords stay with SSH. */
export function VpsConnection() {
  const { state, dispatch } = useStore();
  const [alias, setAlias] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = Boolean(state.config?.vps?.configured);

  useEffect(() => {
    setAlias(state.config?.vps?.sshAlias ?? "");
  }, [state.config?.vps?.sshAlias]);

  const save = () => {
    if (saving || (!alias.trim() && !configured)) return;
    setSaving(true);
    setError(null);
    api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ vps: { sshAlias: alias.trim() } }),
    })
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setAlias(status.vps?.sshAlias ?? "");
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
        <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
        <span>Self-hosted VPS</span>
        <span className="rounded bg-control px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-secondary">
          Optional
        </span>
        {configured && <span className="text-[11px] text-success">Connected</span>}
      </div>
      <div className="mb-1.5 text-[12px] leading-relaxed text-ink-secondary">
        SSH config alias for the Linux VPS. Helmryth uses your existing SSH configuration and credential helper; it never stores keys or passwords. See <span className="font-medium text-ink">docs/byo-vps.md</span> for the required alias shape.
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="my-vps"
          aria-label="Self-hosted VPS SSH config alias"
          autoComplete="off"
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <button
          onClick={save}
          disabled={saving || (!alias.trim() && !configured)}
          className={cn(
            "flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg py-2 text-[13px]",
            !alias.trim() && configured ? "bg-control text-danger hover:bg-raised-hover" : "bg-control text-ink hover:bg-raised-hover",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          title={!alias.trim() && configured ? "Remove the saved alias" : "Save"}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : !alias.trim() && configured ? "Clear" : <><Check size={13} />Save</>}
        </button>
      </div>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
