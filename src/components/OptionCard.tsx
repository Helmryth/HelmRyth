import { useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { useStore, visibleMessages, type Message } from "@/state/store";
import { cn } from "@/lib/cn";

function helmrythCopy(text: string): string {
  const replacements = {
    bot: "operator",
    bots: "operators",
    agent: "operator",
    agents: "operators",
    group: "crew",
    groups: "crews",
    room: "crew",
    rooms: "crews",
    task: "run",
    tasks: "runs",
    thread: "workstream",
    threads: "workstreams",
    plugin: "capability",
    plugins: "capabilities",
    routine: "cadence",
    routines: "cadences",
    approval: "gate",
    approvals: "gates",
  } satisfies Record<string, string>;
  const isReplacementKey = (value: string): value is keyof typeof replacements => value in replacements;
  return text.replace(/\b(bots?|agents?|groups?|rooms?|tasks?|threads?|plugins?|routines?|approvals?)\b/gi, (match) => {
    const key = match.toLowerCase();
    const replacement = isReplacementKey(key) ? replacements[key] : match;
    return /^[A-Z]/.test(match) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
  });
}

/** First-run direction prompt, distinct from a live provider gate. */
export function isOnboardingCard(message: Message): boolean {
  return message.kind === "options" && !!message.card && !message.card.requestId;
}

/** Remove a direction prompt after a choice, dismissal, or later user line. */
export function shouldHideOnboardingCard(message: Message, transcript: Message[]): boolean {
  if (!isOnboardingCard(message) || !message.card) return false;
  if (message.card.dismissed || message.card.answered) return true;
  const index = transcript.findIndex((entry) => entry.id === message.id);
  if (index < 0) return false;
  return transcript.slice(index + 1).some((later) => later.role === "user" && later.kind === "text");
}

export function OptionCard({
  botId,
  message,
}: {
  botId: string;
  message: Message;
}) {
  const { state, dispatch } = useStore();
  const [custom, setCustom] = useState("");
  const card = message.card;
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const transcript = bot ? visibleMessages(bot) : [];
  // Use the complete workstream: a search window can omit the later user line
  // that means this opening prompt has already served its purpose.
  if (!card || shouldHideOnboardingCard(message, transcript)) return null;

  const answer = (text: string) => {
    if (!text.trim()) return;
    dispatch({ type: "answerCard", botId, messageId: message.id, answer: text.trim() });
  };
  const submitCustom = (event: FormEvent) => {
    event.preventDefault();
    answer(custom);
  };
  const titleId = `direction-${message.id}-title`;
  const detailId = `direction-${message.id}-detail`;
  const customId = `direction-${message.id}-custom`;

  return (
    <section aria-labelledby={titleId} aria-describedby={detailId} className="w-full max-w-[840px] border-y border-hairline bg-card px-4 py-4">
      <header className="flex items-start justify-between gap-4 border-b border-hairline/50 pb-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">Opening brief</p>
          <h3 id={titleId} className="mt-1 text-[17px] font-semibold leading-snug text-ink">{helmrythCopy(card.title)}</h3>
          <p id={detailId} className="mt-1 text-[13.5px] leading-relaxed text-ink-secondary">{helmrythCopy(card.subtitle)}</p>
        </div>
        <button
          type="button"
          onClick={() => dispatch({ type: "dismissCard", botId, messageId: message.id })}
          aria-label="Dismiss this opening brief"
          title="Dismiss"
          className="flex size-9 shrink-0 items-center justify-center rounded-md border border-hairline text-ink-secondary hover:bg-inset hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      <fieldset className="mt-3">
        <legend className="sr-only">Choose one direction</legend>
        <ol className="divide-y divide-hairline/50 border-y border-hairline/60">
          {card.options.map((option, index) => (
            <li key={option}>
              <button
                type="button"
                disabled={!!card.answered}
                onClick={() => answer(option)}
                className={cn(
                  "group flex min-h-12 w-full items-center gap-3 px-2 py-2.5 text-left text-[14px] text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-60",
                  card.answered === option ? "bg-inset" : "hover:bg-inset",
                )}
              >
                <span className="w-8 shrink-0 border-r border-hairline pr-2 text-[11px] font-semibold tabular-nums text-ink-secondary group-hover:text-ink">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span>{helmrythCopy(option)}</span>
              </button>
            </li>
          ))}
        </ol>
      </fieldset>

      {/* Provider gates accept only explicit allow/deny outcomes; free-form
          direction remains exclusive to this opening brief. */}
      {!card.answered && !card.tool && (
        <form onSubmit={submitCustom} className="mt-4 border-l-2 border-hairline pl-3">
          <label htmlFor={customId} className="text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">
            Different direction
          </label>
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
            <input
              id={customId}
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              placeholder="Describe the work you want to move first"
              className="min-h-10 min-w-0 flex-1 border border-hairline bg-inset px-3 py-2 text-[14px] text-ink outline-none placeholder:text-ink-secondary focus:border-accent focus:ring-2 focus:ring-focus"
            />
            <button
              type="submit"
              disabled={!custom.trim()}
              className="min-h-10 rounded-md bg-accent px-4 py-2 text-[13px] font-medium text-[var(--color-accent-ink)] hover:bg-accent-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Use this direction
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
