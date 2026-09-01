import { Check, ShieldAlert, X } from "lucide-react";
import { type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";

interface ToolLabels {
  [tool: string]: string;
}

const CADENCE_SETTLED_LABEL = {
  create: "Cadence scheduled",
  update: "Cadence updated",
  pause: "Cadence paused",
  resume: "Cadence resumed",
  run_now: "Cadence run queued",
  delete: "Cadence deleted",
} as const;

/** Translate provider method names into accountable actions without changing
 * the exact resource shown to the person deciding the gate. */
function actionLabel(tool?: string): string {
  if (!tool) return "Continue with the requested action";
  const bare = tool.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
  const nice: ToolLabels = {
    Bash: "Execute a shell command",
    shell: "Execute a shell command",
    Read: "Read a local file",
    Write: "Write to a local file",
    Edit: "Change a local file",
    edit: "Change a local file",
    WebFetch: "Retrieve a web resource",
    WebSearch: "Search the public web",
    schedule_routine: "Schedule a cadence",
    manage_routine: "Change a cadence",
  };
  return nice[tool] ?? `Use ${bare}`;
}

function consequenceLabel(tool?: string): string {
  const consequences: ToolLabels = {
    Bash: "The command can read, change, or remove data available to the current workbench.",
    shell: "The command can read, change, or remove data available to the current workbench.",
    Read: "The requested file contents will be available to the requesting operator.",
    Write: "The requested file will be created or replaced on the current workbench.",
    Edit: "The requested file will be changed on the current workbench.",
    edit: "The requested file will be changed on the current workbench.",
    WebFetch: "Data from the named web resource will enter this workstream.",
    WebSearch: "The search terms will be sent to the configured search provider.",
    schedule_routine: "A cadence will run on the displayed schedule until it is paused or removed.",
    manage_routine: "The displayed cadence and its future runs will change.",
  };
  return consequences[tool ?? ""] ?? "The requesting operator will be able to continue with this exact action.";
}

function cadenceCopy(text: string): string {
  return text.replace(/\broutines?\b/gi, (match) => {
    const replacement = match.toLowerCase().endsWith("s") ? "cadences" : "cadence";
    return /^[A-Z]/.test(match) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
  });
}

function methodLabel(tool: string): string {
  if (tool === "schedule_routine") return "cadence_schedule";
  if (tool === "manage_routine") return "cadence_manage";
  return tool;
}

function settledLabel(answered: string | undefined, cadenceAction?: keyof typeof CADENCE_SETTLED_LABEL): string {
  if (answered === "allow") return cadenceAction ? CADENCE_SETTLED_LABEL[cadenceAction] : "Allowed once";
  if (answered) return cadenceAction ? "Cadence unchanged" : "Gate denied";
  return "Decision required";
}

export function ApprovalCard({
  bot,
  message,
}: {
  /** Requesting operator. The internal Bot type is retained for compatibility. */
  bot?: Bot;
  message: Message;
}) {
  const card = message.card;
  if (!card) return null;

  const cadenceAction = card.routineRequest?.operation.action;
  const displayTool = card.routineRequest
    ? cadenceAction === "create" ? "schedule_routine" : "manage_routine"
    : card.tool;
  const settled = card.answered;
  const requester = bot?.name ?? message.from?.name ?? "Current operator";
  const titleId = `gate-${message.id}-title`;
  const status = settledLabel(settled, cadenceAction);

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        "w-full max-w-[840px] border-y border-r border-l-2 bg-card px-4 py-4",
        settled ? "border-hairline border-l-hairline" : "border-hairline border-l-warning",
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-hairline/50 pb-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">
            Gate · {status}
          </p>
          <h3 id={titleId} className="mt-1 text-[16px] font-semibold leading-snug text-ink">
            {requester} requests permission
          </h3>
        </div>
        {displayTool && (
          <span className="border border-hairline bg-inset px-2 py-1 text-[11px] text-ink-secondary">
            Method · {methodLabel(displayTool)}
          </span>
        )}
      </header>

      <dl className="divide-y divide-hairline/40">
        <div className="grid gap-1 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">Requested action</dt>
          <dd className="text-[14px] font-medium text-ink">{actionLabel(displayTool)}</dd>
        </div>
        <div className="grid gap-1 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">Resource</dt>
          <dd className="min-w-0">
            <pre
              tabIndex={0}
              aria-label={card.routineRequest ? "Cadence resource to review" : "Requested resource to review"}
              className="max-h-40 overflow-auto whitespace-pre-wrap break-words border border-hairline/60 bg-inset px-3 py-2 text-[12.5px] leading-relaxed text-ink"
            >
              {card.routineRequest ? cadenceCopy(card.subtitle) : card.subtitle}
            </pre>
          </dd>
        </div>
        <div className="grid gap-1 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">Consequence</dt>
          <dd className="text-[13px] leading-relaxed text-ink">{consequenceLabel(displayTool)}</dd>
        </div>
        <div className="grid gap-1 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">Requested by</dt>
          <dd className="text-[13px] text-ink">{requester}</dd>
        </div>
      </dl>

      {card.held && (
        <div role="note" className="border-l-2 border-warning bg-inset px-3 py-2 text-[12.5px] leading-relaxed text-ink">
          <span className="font-semibold">Why this gate stopped the run:</span> {cadenceCopy(card.held)}
        </div>
      )}

      <div role="status" className="mt-3 flex items-center gap-2 text-[13px] text-ink-secondary">
        {settled === "allow" ? (
          <Check size={15} aria-hidden="true" className="text-success" />
        ) : settled ? (
          <X size={15} aria-hidden="true" className="text-danger" />
        ) : (
          <ShieldAlert size={15} aria-hidden="true" className="text-warning" />
        )}
        <span>
          {settled
            ? status
            : card.routineRequest
              ? "Review the cadence below, then apply it or keep the current schedule."
              : "Review the exact resource and consequence below, then allow once or deny."}
        </span>
      </div>
    </section>
  );
}
