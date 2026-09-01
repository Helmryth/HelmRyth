import { useState, type FormEvent } from "react";
import { Check, ExternalLink, KeyRound, Loader2, LockKeyhole, RefreshCw } from "lucide-react";

import { credentialConfigPatch, credentialResumeOutcome } from "../../shared/credential-request";
import { cn } from "@/lib/cn";
import { api, useStore, type ConfigStatus, type Message } from "@/state/store";

function helmrythCopy(text: string): string {
  const replacements = {
    bot: "operator",
    bots: "operators",
    agent: "operator",
    agents: "operators",
    task: "run",
    tasks: "runs",
    chat: "workstream",
  } satisfies Record<string, string>;
  const isReplacementKey = (value: string): value is keyof typeof replacements => value in replacements;
  return text.replace(/\b(bots?|agents?|tasks?|chat)\b/gi, (match) => {
    const key = match.toLowerCase();
    const replacement = isReplacementKey(key) ? replacements[key] : match;
    return /^[A-Z]/.test(match) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
  });
}

export function SecretRequestCard({
  botId,
  threadId,
  message,
}: {
  botId: string;
  threadId: string;
  message: Message;
}) {
  const { state, dispatch } = useStore();
  const secret = message.secret!;
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedLocally, setSavedLocally] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const endpoint = `/api/bots/${encodeURIComponent(botId)}/secret-cards/${encodeURIComponent(message.id)}`;
  const error = localError ?? secret.error;
  const outcome = credentialResumeOutcome(secret);
  const provided = outcome === "provided";
  const declined = outcome === "dismissed";
  const operator = state.bots.find((candidate) => candidate.id === botId)?.name
    ?? message.from?.name
    ?? "Current operator";
  const titleId = `credential-gate-${message.id}-title`;
  const inputId = `credential-gate-${message.id}-input`;
  const descriptionId = `credential-gate-${message.id}-description`;
  const assuranceId = `credential-gate-${message.id}-assurance`;
  const description = provided
    ? secret.resumed
      ? `Stored on this device. ${operator} is continuing the run.`
      : `Stored on this device. ${operator} will continue when the current run settles.`
    : declined
      ? `This gate was declined. ${operator} remains paused.`
      : helmrythCopy(secret.description);
  const footerLabel = declined
    ? "The run could not continue without this credential"
    : secret.resumed
      ? "Run resumed without exposing the credential"
      : error
        ? "Credential stored; the run did not resume"
        : "Credential stored; preparing to resume";

  // A successfully declined gate has no durable state to show. If its
  // continuation failed, restore the gate with the same recovery control.
  if (declined && (secret.resumed || !error)) return null;

  const notifyProvided = async () => {
    await api(`${endpoint}/provided`, {
      method: "POST",
      body: JSON.stringify({ threadId }),
    });
  };

  const retryResume = async () => {
    if (saving) return;
    setSaving(true);
    setLocalError(null);
    try {
      await api(`${endpoint}/resume`, {
        method: "POST",
        body: JSON.stringify({ threadId }),
      });
    } catch (requestError) {
      setLocalError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setSaving(false);
    }
  };

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (saving || (!value.trim() && !savedLocally)) return;
    setSaving(true);
    setLocalError(null);
    try {
      if (!savedLocally) {
        const next = value.trim();
        const status: ConfigStatus = window.helmryth?.setCredential
          ? await window.helmryth.setCredential(secret.target, next)
          : await api("/api/config", {
              method: "PUT",
              body: JSON.stringify(credentialConfigPatch(secret.target, next)),
            });
        dispatch({ type: "configStatus", config: status });
        setValue("");
        setSavedLocally(true);
      }
      await notifyProvided();
    } catch (requestError) {
      setLocalError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setSaving(false);
    }
  };

  const dismiss = () => {
    void api(`${endpoint}/dismiss`, {
      method: "POST",
      body: JSON.stringify({ threadId }),
    }).catch(() => {});
  };

  return (
    <section
      aria-labelledby={titleId}
      className="w-full max-w-[620px] border-y border-r border-l-2 border-hairline border-l-warning bg-card"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline/50 px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center border border-hairline bg-inset text-ink" aria-hidden="true">
            <KeyRound size={17} />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">
              Credential gate · {provided ? "Passed" : declined ? "Declined" : "Waiting"}
            </p>
            <h3 id={titleId} className="mt-0.5 text-[15px] font-semibold leading-snug text-ink">{secret.label}</h3>
          </div>
        </div>
        {!provided && !declined && (
          <button
            type="button"
            onClick={dismiss}
            className="min-h-9 rounded-md border border-hairline px-3 py-2 text-[12.5px] font-medium text-ink-secondary hover:bg-inset hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            Decline gate
          </button>
        )}
      </header>

      <dl className="divide-y divide-hairline/40 px-4">
        <div className="grid gap-1 py-2.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">Requested action</dt>
          <dd className="text-[13px] font-medium text-ink">Store a credential on this device</dd>
        </div>
        <div className="grid gap-1 py-2.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">Requested by</dt>
          <dd className="text-[13px] text-ink">{operator}</dd>
        </div>
        <div className="grid gap-1 py-2.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">Consequence</dt>
          <dd id={descriptionId} className="text-[12.5px] leading-relaxed text-ink">{description}</dd>
        </div>
      </dl>

      {error && <p role="alert" className="mx-4 border-l-2 border-danger bg-inset px-3 py-2 text-[12px] text-danger">{error}</p>}

      {!provided && !declined && (
        <form onSubmit={(event) => void save(event)} className="border-t border-hairline/50 bg-inset px-4 py-3">
          <label htmlFor={inputId} className="text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">
            Credential
          </label>
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
            <div className="min-w-0 flex-1">
              <input
                id={inputId}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={secret.placeholder}
                disabled={saving || savedLocally}
                aria-describedby={`${descriptionId} ${assuranceId}`}
                className="min-h-10 w-full border border-hairline bg-card px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-secondary focus:border-accent focus:ring-2 focus:ring-focus disabled:opacity-60"
              />
              <p id={assuranceId} className="mt-1.5 flex items-center gap-1.5 text-[11.5px] leading-relaxed text-ink-secondary">
                <LockKeyhole size={12} aria-hidden="true" /> Stored locally; never written into the workstream.
              </p>
            </div>
            <button
              type="submit"
              disabled={saving || (!value.trim() && !savedLocally)}
              className="flex min-h-10 items-center justify-center gap-1.5 rounded-md bg-accent px-4 py-2 text-[12.5px] font-medium text-[var(--color-accent-ink)] hover:bg-accent-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <LockKeyhole size={14} aria-hidden="true" />}
              {savedLocally ? "Resume run" : "Store and continue"}
            </button>
          </div>
          <a
            href={secret.helpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-[11.5px] font-medium text-accent-text underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            Find this credential <ExternalLink size={11} aria-hidden="true" />
          </a>
        </form>
      )}

      {(provided || declined) && (
        <div
          role="status"
          className={cn(
            "flex flex-wrap items-center justify-between gap-2 border-t border-hairline/50 bg-inset px-4 py-3 text-[12px]",
            declined || error ? "text-danger" : "text-success",
          )}
        >
          <span className="flex items-center gap-1.5">
            {secret.resumed ? <Check size={13} aria-hidden="true" /> : error ? <KeyRound size={13} aria-hidden="true" /> : <Loader2 size={13} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}
            {footerLabel}
          </span>
          {!secret.resumed && error && (
            <button
              type="button"
              onClick={() => void retryResume()}
              disabled={saving}
              className="flex min-h-9 items-center gap-1.5 rounded-md border border-hairline bg-card px-3 py-2 text-[12px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
            >
              {saving ? <Loader2 size={13} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <RefreshCw size={13} aria-hidden="true" />}
              Retry resume
            </button>
          )}
        </div>
      )}
    </section>
  );
}
