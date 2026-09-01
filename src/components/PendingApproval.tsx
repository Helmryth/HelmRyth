import { memo } from "react";
import { useStore, type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";

interface GateLabels {
  [tool: string]: string;
}

export interface Pending {
  message: Message;
  requestId: string;
  tool: string;
  /** The narrow persistent grant computed server-side. */
  allowKey?: string;
  detail: string;
  held?: string;
}

/** The persisted payload is authoritative; provider method labels can collide. */
export function isRoutineApproval(pending: Pending): boolean {
  return Boolean(pending.message.card?.routineRequest);
}

/** Unresolved gates in a workstream, oldest first. */
export function pendingApprovals(messages: Message[]): Pending[] {
  return messages
    .filter((message) =>
      message.kind === "options"
      && message.card?.requestId
      && message.card.tool
      && !message.card.answered
      && !message.card.dismissed)
    .map((message) => ({
      message,
      requestId: message.card!.requestId!,
      tool: message.card!.tool!,
      allowKey: message.card!.allowKey,
      detail: message.card!.subtitle,
      held: message.card!.held,
    }));
}

/** Keep spoken gates concise: the full resource remains visible on screen. */
export function spokenApprovalPrompt(pending: Pending, requester: string): string {
  if (!isRoutineApproval(pending)) {
    return `${requester} is waiting at a gate to ${requestedAction(pending).toLowerCase()}. Review the resource and consequence on screen. Allow once or deny.`;
  }
  const rawTitle = pending.message.card?.title.trim() || "Review this cadence";
  const title = cadenceCopy(rawTitle);
  return `${requester} proposes: ${title}${/[.!?]$/.test(title) ? "" : "."} Review the schedule and instructions on screen. Apply the cadence or keep the current schedule.`;
}

function cadenceCopy(text: string): string {
  return text.replace(/\broutines?\b/gi, (match) => {
    const replacement = match.toLowerCase().endsWith("s") ? "cadences" : "cadence";
    return /^[A-Z]/.test(match) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
  });
}

function requestedAction(pending: Pending): string {
  if (isRoutineApproval(pending)) {
    const action = pending.message.card?.routineRequest?.operation.action;
    switch (action) {
      case "create": return "Schedule a cadence";
      case "update": return "Update a cadence";
      case "pause": return "Pause a cadence";
      case "resume": return "Resume a cadence";
      case "run_now": return "Queue a cadence run";
      case "delete": return "Delete a cadence";
      default: return "Change a cadence";
    }
  }
  const labels: GateLabels = {
    Bash: "Execute a shell command",
    shell: "Execute a shell command",
    Read: "Read a local file",
    Write: "Write to a local file",
    Edit: "Change a local file",
    edit: "Change a local file",
  };
  return labels[pending.tool] ?? `Use ${pending.tool.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ")}`;
}

function consequence(pending: Pending): string {
  if (isRoutineApproval(pending)) {
    const action = pending.message.card?.routineRequest?.operation.action;
    if (action === "delete") return "The cadence and its future scheduled runs will be removed.";
    if (action === "run_now") return "A new run will be queued immediately with the displayed instructions.";
    return "The cadence and its future scheduled runs will change as displayed.";
  }
  const labels: GateLabels = {
    Bash: "The command can read, change, or remove data available to this workbench.",
    shell: "The command can read, change, or remove data available to this workbench.",
    Read: "The file contents will become available inside this workstream.",
    Write: "A file on this workbench will be created or replaced.",
    Edit: "A file on this workbench will be changed.",
    edit: "A file on this workbench will be changed.",
  };
  return labels[pending.tool] ?? "The requesting operator will continue with this exact action.";
}

function gateLabel(pending: Pending): string {
  if (isRoutineApproval(pending)) return "Cadence change";
  const labels: GateLabels = {
    Bash: "Shell command",
    shell: "Shell command",
    Read: "File access",
    Write: "File change",
    Edit: "File change",
    edit: "File change",
  };
  return labels[pending.tool] ?? "Method request";
}

export const PendingApprovalPanel = memo(function PendingApprovalPanel({
  pending,
  count,
  index,
}: {
  pending: Pending;
  count: number;
  index: number;
}) {
  const requester = pending.message.from?.name ?? "Active operator";
  const titleId = `pending-gate-${pending.requestId}-title`;

  return (
    <section aria-labelledby={titleId} className="border-l-2 border-l-warning bg-card px-4 py-3">
      <span className="sr-only" role="status" aria-live="polite">
        Gate waiting. {requester} needs a decision.
      </span>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-hairline/50 pb-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">
            Gate {count > 1 ? `${index + 1} of ${count}` : "waiting"}
          </p>
          <h3 id={titleId} className="mt-0.5 text-[15px] font-semibold text-ink">{gateLabel(pending)}</h3>
        </div>
        <span className="border border-hairline bg-inset px-2 py-1 text-[11px] text-ink-secondary">
          Method · {isRoutineApproval(pending)
            ? pending.message.card?.routineRequest?.operation.action === "create"
              ? "cadence_schedule"
              : "cadence_manage"
            : pending.tool}
        </span>
      </header>

      <dl className="divide-y divide-hairline/40">
        <div className="grid gap-1 py-2 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-3">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">Requested action</dt>
          <dd className="text-[13px] font-medium text-ink">{requestedAction(pending)}</dd>
        </div>
        <div className="grid gap-1 py-2 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-3">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">Resource</dt>
          <dd className="min-w-0">
            <pre
              tabIndex={0}
              aria-label={isRoutineApproval(pending) ? "Cadence resource to review" : "Requested resource to review"}
              className="max-h-40 overflow-auto whitespace-pre-wrap break-words border border-hairline/60 bg-inset px-3 py-2 text-[12px] leading-relaxed text-ink"
            >
              {isRoutineApproval(pending) ? cadenceCopy(pending.detail) : pending.detail}
            </pre>
          </dd>
        </div>
        <div className="grid gap-1 py-2 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-3">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">Consequence</dt>
          <dd className="text-[12.5px] leading-relaxed text-ink">{consequence(pending)}</dd>
        </div>
        <div className="grid gap-1 py-2 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-3">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">Requested by</dt>
          <dd className="text-[12.5px] text-ink">{requester}</dd>
        </div>
      </dl>

      {pending.held && (
        <p role="note" className="border-l-2 border-warning bg-inset px-3 py-2 text-[12px] leading-relaxed text-ink">
          <span className="font-semibold">Why this gate stopped the run:</span> {cadenceCopy(pending.held)}
        </p>
      )}
    </section>
  );
});

function cadenceAllowLabel(pending: Pending): string {
  const action = pending.message.card?.routineRequest?.operation.action;
  switch (action) {
    case "create": return "Schedule cadence";
    case "update": return "Apply cadence change";
    case "pause": return "Pause cadence";
    case "resume": return "Resume cadence";
    case "run_now": return "Queue cadence run";
    case "delete": return "Delete cadence";
    default: return "Apply cadence change";
  }
}

export function PendingApprovalActions({
  pending,
  threadId,
  bot,
  onCancelTurn,
}: {
  pending: Pending;
  threadId: string;
  /** Requesting operator. The internal Bot type is retained for compatibility. */
  bot?: Bot;
  onCancelTurn: () => void;
}) {
  const { dispatch } = useStore();
  const isCadenceRequest = isRoutineApproval(pending);
  const decide = (behavior: "allow" | "deny", always = false) =>
    dispatch({
      type: "decideRequest",
      threadId,
      requestId: pending.requestId,
      behavior,
      message: behavior === "deny" ? "Denied by the user." : undefined,
      alwaysAllow: always && bot && pending.allowKey ? { botId: bot.id, key: pending.allowKey } : undefined,
    });

  const base = "min-h-9 rounded-md px-3.5 py-2 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <div role="group" aria-label="Gate decisions" className="flex flex-wrap items-center justify-end gap-2 border-l-2 border-l-warning bg-card px-3 py-3">
      {!isCadenceRequest && (
        <button type="button" onClick={onCancelTurn} className={cn(base, "mr-auto text-ink-secondary hover:bg-inset hover:text-ink")}>
          Stop run
        </button>
      )}
      <button
        type="button"
        onClick={() => decide("deny")}
        className={cn(base, "border border-danger text-danger hover:bg-inset")}
      >
        {isCadenceRequest ? "Keep current cadence" : "Deny request"}
      </button>
      {!isCadenceRequest && bot && pending.allowKey && (
        <details className="group">
          <summary className={cn(base, "flex cursor-pointer list-none items-center border border-hairline text-ink hover:bg-inset [&::-webkit-details-marker]:hidden")}>
            Grant options
          </summary>
          <div className="mt-2 border border-hairline bg-inset p-2">
            <p className="max-w-64 text-[11.5px] leading-relaxed text-ink-secondary">
              Future requests matching <strong className="font-semibold text-ink">{pending.allowKey}</strong> from {bot.name} will proceed without a gate.
            </p>
            <button
              type="button"
              onClick={() => decide("allow", true)}
              className={cn(base, "mt-2 w-full border border-hairline bg-card text-ink hover:bg-raised-hover")}
            >
              Always allow {pending.allowKey}
            </button>
          </div>
        </details>
      )}
      <button
        type="button"
        onClick={() => decide("allow")}
        className={cn(base, "bg-accent text-[var(--color-accent-ink)] hover:bg-accent-border")}
      >
        {isCadenceRequest ? cadenceAllowLabel(pending) : "Allow once"}
      </button>
    </div>
  );
}
