// System → Spend ledger: what every operator has spent. Figures are
// banked per settled contribution on each run and
// summed here; nothing is fetched.
import { useStore, type Bot, type InstanceInfo, type TaskUsage } from "@/state/store";
import { SigilAvatar } from "./Avatar";
import { Card } from "./SettingsPrimitives";
import { botUsage, cachedInput, costCaption, formatTokens, formatUsd, hasFiniteCost, sumUsage, usageDetail } from "@/lib/usage";

export interface LedgerRow {
  bot: Pick<Bot, "id" | "name" | "color" | "hidden">;
  usage: TaskUsage;
  billing: InstanceInfo["snapshot"]["billing"];
  /** Archived operators stay in the ledger, labelled. */
  archived: boolean;
}

/** Every operator that has settled at least one step, archived ones included.
 * Archiving hides an operator from the roster; it must never edit history.
 * Filtering `hidden` out here deleted that operator's spend from the rows AND
 * from the total below, so archiving one silently rewrote what the workspace
 * had already paid. Money that was spent was spent. */
export function ledgerRows(
  bots: readonly (Pick<Bot, "id" | "name" | "color" | "hidden" | "tasks"> & { modelSelection: Pick<Bot["modelSelection"], "instanceId"> })[],
  instances: readonly Pick<InstanceInfo, "instanceId" | "snapshot">[],
): LedgerRow[] {
  return bots
    .map((bot) => {
      const usage = botUsage(bot);
      const instance = instances.find((i) => i.instanceId === bot.modelSelection.instanceId);
      return { bot, usage, billing: instance?.snapshot.billing, archived: bot.hidden === true };
    })
    .filter((r) => r.usage.turns > 0)
    // money first, then volume. Non-finite/missing costs sort last.
    .sort((a, b) => {
      const costOf = (value: number | null | undefined) =>
        hasFiniteCost(value) ? value : Number.NEGATIVE_INFINITY;
      return costOf(b.usage.costUsd) - costOf(a.usage.costUsd) || b.usage.input + b.usage.output - (a.usage.input + a.usage.output);
    });
}

export function UsageSection() {
  const { state } = useStore();
  const rows = ledgerRows(state.bots, state.instances);
  const total = sumUsage(rows.map((r) => r.usage));
  const billings = new Set(rows.map((r) => r.billing));

  return (
    <Card title="Spend ledger" subtitle="Tokens and cost by operator, summed from settled run steps. Archived operators stay counted. Cost appears only when an engine reports a price.">
      {rows.length === 0 ? (
        <div className="border-l-2 border-signal pl-3 text-[13px] text-ink-secondary">No usage recorded. Figures appear after the first completed operator step.</div>
      ) : (
        <div className="flex flex-col">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-5 border-b border-hairline/40 pb-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">
            <span>Operator</span>
            <span className="text-right">Steps</span>
            <span className="text-right">Tokens</span>
            <span className="text-right">Cost</span>
          </div>
          {rows.map(({ bot, usage, archived }) => (
            <div key={bot.id} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-5 border-b border-hairline/20 py-2 text-[13px]">
              <span className="flex min-w-0 items-center gap-2 text-ink">
                <SigilAvatar color={bot.color} state="idle" size={22} animated={false} />
                <span className="truncate">{bot.name}</span>
                {archived && <span className="shrink-0 text-[11px] uppercase tracking-wide text-ink-secondary">archived</span>}
              </span>
              <span className="text-right tabular-nums text-ink-secondary">{usage.turns}</span>
              <span className="text-right tabular-nums text-ink" title={usageDetail(usage)}>
                {formatTokens(usage.input + usage.output)}
              </span>
              <span className="text-right tabular-nums text-ink">{hasFiniteCost(usage.costUsd) ? formatUsd(usage.costUsd) : <span className="text-ink-secondary">—</span>}</span>
            </div>
          ))}
          <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-5 pt-2.5 text-[13px] font-medium text-ink">
            <span>All operators</span>
            <span className="text-right tabular-nums">{total.turns}</span>
            <span className="text-right tabular-nums" title={usageDetail(total)}>{formatTokens(total.input + total.output)}</span>
            <span className="text-right tabular-nums">{hasFiniteCost(total.costUsd) ? formatUsd(total.costUsd) : "—"}</span>
          </div>
          {cachedInput(total) > 0 && (
            <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
              Tokens count everything the model read and wrote. Each step resends workstream context, operating instructions, and capability
              schemas, so {formatTokens(cachedInput(total))} of the input was context re-read from the provider&rsquo;s cache rather than new text —
              hover a figure for the split.
            </div>
          )}
          {hasFiniteCost(total.costUsd) && (
            <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
              Cost is {billings.size === 1 ? costCaption([...billings][0]) : "as each engine reports it — on a subscription it's an equivalent, not a charge"}.
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
