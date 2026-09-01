import { ChevronDown, ChevronLeft, FolderOpen, GitMerge, X } from "lucide-react";
import { useState } from "react";
import { api, useStore, type Bot } from "@/state/store";
import { stateForBot } from "@/lib/sigil";
import { CloudBackendPicker } from "./CloudBackendPicker";
import { ModelPicker } from "./ModelPicker";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { cn } from "@/lib/cn";
import { builtInBrowserEnabled } from "@/lib/feature-flags";
import { requestNotificationPermission } from "@/lib/notify";
import { botUsage, costCaption, formatTokens, formatUsd, hasFiniteCost } from "@/lib/usage";
import { shortPath } from "@/lib/short-path";
import { instanceSupportsLocalComputer, localComputerDisabledReason, localComputerSelectable } from "@/lib/local-computer";
import { BotProfileAvatarCard } from "./BotProfileAvatarCard";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { VoiceSettings } from "./VoiceSettings";
import { AgentSkillsPanel } from "./AgentSkillsPanel";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[13px] text-ink-secondary">{label}</div>
      {children}
    </label>
  );
}

/** What this operator has spent across its runs. Cost is captioned by how the
 * engine is billed — on a subscription the figure is an equivalent. Named
 * "Spend ledger", not "Run ledger": that name already belongs to the step
 * timeline in the transcript, and two surfaces sharing one name taught people
 * the wrong thing about both. */
function BotUsageCard({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const usage = botUsage(bot);
  const instance = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId);
  if (usage.turns === 0) return null;
  return (
    <section className="border-b border-hairline/50 py-4">
      <div className="flex items-baseline justify-between">
        <div className="text-[15px] font-semibold text-ink">Spend ledger</div>
        <button
          onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" })}
          className="text-[12px] text-ink-secondary hover:text-ink"
        >
          All operators →
        </button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3 border-y border-hairline/40 py-3 text-[13px]">
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">Steps</div>
          <div className="mt-0.5 tabular-nums text-ink">{usage.turns}</div>
        </div>
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">Tokens</div>
          <div className="mt-0.5 tabular-nums text-ink" title={`${formatTokens(usage.input)} in · ${formatTokens(usage.output)} out`}>
            {formatTokens(usage.input + usage.output)}
          </div>
        </div>
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">Cost</div>
          <div className="mt-0.5 tabular-nums text-ink">{hasFiniteCost(usage.costUsd) ? formatUsd(usage.costUsd) : "—"}</div>
        </div>
      </div>
      <div className="mt-2 text-[12px] text-ink-secondary">
        {hasFiniteCost(usage.costUsd) ? `Cost ${costCaption(instance?.snapshot.billing)}.` : "This engine doesn't report a price; tokens are counted."}
      </div>
    </section>
  );
}

const inputCls =
  "w-full rounded-md border border-hairline/60 bg-raised px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-signal focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/20";

/** Where an operator's shell capabilities run. Set per operator; each run pins its own copy
 * on its first contribution (the server does the pinning — Claude keeps sessions
 * per project folder, so a folder must not move under a live run). The
 * PATCH is made directly rather than through updateBot: the server
 * validates the path and a rejected folder must not stick in local state. */
function WorkingFolder({ bot }: { bot: Bot }) {
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host.homeDir;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canPick = Boolean(window.helmryth?.pickFolder);
  const task = bot.tasks?.find((t) => t.threadId === bot.threadId);
  const pinned = task?.cwd; // undefined = not yet, null = legacy home, string = folder
  const pinnedElsewhere = pinned !== undefined && (pinned ?? undefined) !== bot.cwd;

  const save = async (cwd: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ cwd }) });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const pick = async () => {
    const chosen = await window.helmryth?.pickFolder?.(bot.cwd);
    if (chosen) void save(chosen);
  };

  return (
    <section className="border-b border-hairline/50 py-4">
      <div className="text-[15px] font-semibold text-ink">Run folder</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">Where this operator invokes shell and file capabilities.</div>
      {canPick ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-md border border-hairline/60 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink" title={bot.cwd}>
            {bot.cwd ? shortPath(bot.cwd, home) : <span className="text-ink-secondary">Private operator workspace</span>}
          </div>
          <button onClick={() => void pick()} disabled={saving} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            <FolderOpen size={14} /> Choose…
          </button>
          {bot.cwd && (
            <button onClick={() => void save(null)} disabled={saving} className="shrink-0 rounded-lg px-2 py-2 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50">
              Clear
            </button>
          )}
        </div>
      ) : (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            // an emptied field clears the folder — the server wants null
            void save((draft ?? bot.cwd ?? "").trim() || null);
          }}
        >
          <input
            className={cn(inputCls, "font-mono text-[12.5px]")}
            placeholder="Private operator workspace or absolute path"
            aria-label="Operator run folder"
            value={draft ?? bot.cwd ?? ""}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" disabled={saving || draft === null} className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            Save
          </button>
        </form>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      {pinnedElsewhere && (
        <div className="mt-2 text-[12px] text-ink-secondary">
          New runs start here. This run remains pinned to {pinned ? <span className="font-mono">{shortPath(pinned, home)}</span> : "the home folder"}. Start a new run to use the new folder.
        </div>
      )}
    </section>
  );
}

interface MemoryTopic {
  name: string;
  bytes: number;
}

const formatBytes = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 102.4) / 10} KB`);

/** MEMORY.md + memory/ topic files, surfaced so the user can read and fix
 * what the operator retains. Fetched on expand, not on mount: settings opens for
 * every operator and most visits never look at memory — and an expand also
 * re-reads, so notes written mid-run show up on the next open. */
function MemoryCard({ bot }: { bot: Bot }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [topics, setTopics] = useState<MemoryTopic[]>([]);
  const [saving, setSaving] = useState(false);
  const [topic, setTopic] = useState<{ name: string; text: string } | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    setTopic(null);
    try {
      const result: { text: string; truncated: boolean; topics: MemoryTopic[] } = await api(
        `/api/bots/${bot.id}/memory`,
      );
      setText(result.text);
      setTruncated(result.truncated);
      setTopics(result.topics);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result: { truncated: boolean } = await api(`/api/bots/${bot.id}/memory`, {
        method: "PUT",
        body: JSON.stringify({ text }),
      });
      setTruncated(result.truncated);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const openTopic = async (name: string) => {
    setError(null);
    try {
      setTopic(await api(`/api/bots/${bot.id}/memory/topics/${encodeURIComponent(name)}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="border-b border-hairline/50 py-4">
      <button
        className="flex w-full items-center justify-between gap-4 text-left"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void load();
        }}
      >
        <div>
          <div className="text-[15px] font-semibold text-ink">Working memory</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            Evidence and decisions this operator keeps between runs. You can inspect and edit the plain files.
          </div>
        </div>
        <ChevronDown size={16} className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")} />
      </button>

      {open && loading && <div className="mt-3 text-[13px] text-ink-secondary">Loading…</div>}

      {open && !loading && topic && (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[12.5px] text-ink">memory/{topic.name}</span>
            <button
              onClick={() => setTopic(null)}
              className="shrink-0 rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
            >
              Back
            </button>
          </div>
          <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-lg border border-hairline/40 bg-inset p-3 font-mono text-[12.5px] leading-relaxed text-ink">
            {topic.text}
          </pre>
        </div>
      )}

      {open && !loading && !topic && (
        <div className="mt-3">
          <textarea
            className={cn(inputCls, "min-h-[160px] resize-y font-mono text-[12.5px] leading-relaxed")}
            value={text}
            placeholder="No durable notes recorded. Add evidence, decisions, or operating context."
            aria-label="Operator working memory"
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
            }}
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={() => void save()}
              disabled={saving || !dirty}
              className="rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {truncated && (
              <span className="text-[11.5px] text-ink-secondary">
                Over the budget — only the top of this file loads each turn.
              </span>
            )}
          </div>
          {topics.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                Topic files
              </div>
              <div className="overflow-hidden rounded-lg border border-hairline/40">
                {topics.map((entry) => (
                  <button
                    key={entry.name}
                    onClick={() => void openTopic(entry.name)}
                    className="flex w-full items-center justify-between gap-2 border-b border-hairline/40 px-3 py-2 text-left last:border-b-0 hover:bg-control/60"
                  >
                    <span className="truncate font-mono text-[12.5px] text-ink">{entry.name}</span>
                    <span className="shrink-0 text-[11.5px] text-ink-secondary">{formatBytes(entry.bytes)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </section>
  );
}

export function SettingsPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  const localSelectable = localComputerSelectable({ capabilities, providerSupportsLocal });
  const [localAutoWarning, setLocalAutoWarning] = useState<"auto" | "local" | null>(null);
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
  const patch = (
    p: Partial<
      Pick<
        Bot,
        | "name"
        | "title"
        | "description"
        | "notifications"
        | "computer"
        | "cloudBackend"
        | "autoStartVps"
        | "color"
        | "sigilExpression"
        | "avatarUrl"
        | "avatarCrop"
        | "autoApprove"
        | "autoReview"
        | "speakReplies"
        | "voice"
        | "chiefOfStaff"
        | "approvePeerComms"
        | "composio"
        | "browser"
        | "modelSelection"
      >
    > & { acknowledgeLocalAuto?: boolean },
  ) => dispatch({ type: "updateBot", botId: bot.id, patch: p });
  const activeState = stateForBot(bot);
  const sigilMotion = state.sigilMotion?.botId === bot.id ? state.sigilMotion : null;
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const canAutoReview = engine?.capabilities?.approvalReview === true;
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  const canUseConnectedApps = engine?.capabilities?.composioMcp === true;
  const canUseVps = engine?.capabilities?.computerMcp === true && engine.driverKind !== "boxAgent";
  const connectedAppsConfigured = state.config?.composio?.configured === true;
  const connectedAppsEnabled = bot.composio !== false;
  const canUseBrowser = engine?.capabilities?.browserMcp === true;
  const desktopBrowser = Boolean(window.helmryth?.browser);
  const browserFeature = builtInBrowserEnabled(state.config);
  const browserEnabled = bot.browser !== false;
  const sectionName = bot.section?.trim() || "Unassigned";
  const currentChief = state.bots.find(
    (candidate) =>
      candidate.chiefOfStaff &&
      (candidate.section?.trim() || "") === (bot.section?.trim() || ""),
  );

  return (
    <>
    <aside className="animate-panel-in relative z-20 flex h-full w-full max-w-full shrink-0 flex-col border-l border-hairline/60 bg-app sm:w-[420px]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-hairline/50 px-4 py-3">
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          aria-label="Collapse operator dossier"
          title="Collapse operator dossier"
          className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-[15px] font-semibold tracking-[-0.012em] text-ink">Operator dossier</span>
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          aria-label="Close operator dossier"
          title="Close operator dossier"
          className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        <div className="flex flex-col gap-4 pt-4">
          <BotProfileAvatarCard
            bot={bot}
            activeState={activeState}
            sigilMotion={sigilMotion}
            onPatch={patch}
          />

          <Field label="Name">
            <input
              className={inputCls}
              maxLength={BOT_PROFILE_LIMITS.name}
              value={bot.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field label="Title">
            <input
              className={inputCls}
              maxLength={BOT_PROFILE_LIMITS.title}
              placeholder="Name this operator&rsquo;s discipline"
              value={bot.title}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </Field>
          <Field label="Description">
            <textarea
              className={cn(inputCls, "min-h-[96px] resize-none")}
              maxLength={BOT_PROFILE_LIMITS.description}
              placeholder="State the work this operator owns"
              value={bot.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </Field>

          <div className={cn(
            "border-y border-hairline/50 py-4",
            bot.chiefOfStaff && "border-l-2 border-l-accent pl-3",
          )}>
            <div className="flex items-center gap-3">
              <span className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg",
                bot.chiefOfStaff ? "bg-accent text-accent-ink" : "bg-control text-ink-secondary",
              )}>
                <GitMerge size={17} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-semibold text-ink">Section helm</div>
                <div className="text-[11.5px] text-ink-secondary">One helm for the {sectionName} crew</div>
              </div>
              <button
                role="switch"
                aria-checked={Boolean(bot.chiefOfStaff)}
                aria-label="Section helm"
                disabled={!bot.chiefOfStaff && !canCoordinate}
                onClick={() => patch({ chiefOfStaff: !bot.chiefOfStaff })}
                title={!bot.chiefOfStaff && !canCoordinate ? "This engine cannot coordinate other operators" : undefined}
                className={cn(
                  "relative h-[26px] w-[44px] shrink-0 rounded-full disabled:cursor-not-allowed disabled:opacity-40",
                  bot.chiefOfStaff ? "bg-accent" : "bg-control",
                )}
              >
                <span
                  className={cn(
                    "absolute left-[3px] top-[3px] size-5 rounded-full bg-panel transition-transform",
                    bot.chiefOfStaff && "translate-x-[18px]",
                  )}
                />
              </button>
            </div>
            <div className="mt-3 text-[13px] leading-relaxed text-ink-secondary">
              {bot.chiefOfStaff && !canCoordinate
                ? "This operator still holds the helm, but its current engine cannot coordinate the crew. Choose an engine with coordination support."
                : bot.chiefOfStaff
                  ? `This operator holds the helm for the ${sectionName} crew. It can assign specialists and consolidate their work into one outcome.`
                : !canCoordinate
                  ? "Choose an engine with coordination support to activate the helm role."
                  : currentChief
                    ? `Make this operator the ${sectionName} helm and hand the role over from ${currentChief.name}.`
                    : `Make this operator the primary contact for the ${sectionName} crew.`}
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 border-b border-hairline/50 py-4">
            <div>
              <div className="text-[15px] font-medium text-ink">
                Gate operator handoffs
              </div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {bot.approvePeerComms
                  ? "This operator waits at a gate before contacting another operator."
                  : "This operator can coordinate with its crew without pausing for confirmation."}
              </div>
            </div>
            <button
              role="switch"
              aria-checked={Boolean(bot.approvePeerComms)}
              aria-label="Gate operator handoffs"
              disabled={!bot.approvePeerComms && !canCoordinate}
              onClick={() => patch({ approvePeerComms: !bot.approvePeerComms })}
              title={!bot.approvePeerComms && !canCoordinate ? "This engine cannot coordinate other operators" : undefined}
              className={cn(
                "relative h-[26px] w-[44px] shrink-0 rounded-full disabled:cursor-not-allowed disabled:opacity-40",
                bot.approvePeerComms ? "bg-accent" : "bg-control",
              )}
            >
              <span
                className={cn(
                  "absolute left-[3px] top-[3px] size-5 rounded-full bg-panel transition-transform",
                  bot.approvePeerComms && "translate-x-[18px]",
                )}
              />
            </button>
          </div>

          <div className="flex items-center justify-between gap-4 border-b border-hairline/50 py-4">
            <div>
              <div className="text-[15px] font-medium text-ink">Connected capabilities</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {!connectedAppsConfigured
                  ? "Add services under System → Connections before granting access."
                  : !canUseConnectedApps
                    ? "This operator&rsquo;s current engine cannot use connected services."
                    : connectedAppsEnabled
                      ? "This operator can use the services listed under Connections."
                      : "Connected services stay unavailable to this operator."}
              </div>
            </div>
            <button
              role="switch"
              aria-checked={connectedAppsEnabled}
              aria-label="Allow this operator to use connected capabilities"
              disabled={
                !connectedAppsEnabled && (!connectedAppsConfigured || !canUseConnectedApps)
              }
              onClick={() => patch({ composio: !connectedAppsEnabled })}
              title={
                !connectedAppsEnabled && !connectedAppsConfigured
                  ? "Add a service under System Connections first"
                  : !connectedAppsEnabled && !canUseConnectedApps
                    ? "This engine cannot use connected services"
                    : undefined
              }
              className={cn(
                "relative h-[26px] w-[44px] shrink-0 rounded-full disabled:cursor-not-allowed disabled:opacity-40",
                connectedAppsEnabled ? "bg-accent" : "bg-control",
              )}
            >
              <span
                className={cn(
                  "absolute left-[3px] top-[3px] size-5 rounded-full bg-panel transition-transform",
                  connectedAppsEnabled && "translate-x-[18px]",
                )}
              />
            </button>
          </div>

          <div className="flex items-center justify-between gap-4 border-b border-hairline/50 py-4">
            <div>
              <div className="text-[15px] font-medium text-ink">Browser</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {!desktopBrowser
                  ? "The built-in browser needs the Helmryth desktop app."
                  : !browserFeature
                    ? "The built-in browser is off under System → Field trials."
                    : !canUseBrowser
                      ? "This operator&rsquo;s current engine cannot use the built-in browser."
                      : browserEnabled
                        ? "This operator has a dedicated Browser surface in the Workbench, with isolated sign-ins and visible control."
                        : "The built-in browser stays unavailable to this operator."}
              </div>
            </div>
            <button
              role="switch"
              aria-checked={browserEnabled}
              aria-label="Give this operator a built-in browser"
              disabled={!browserEnabled && (!desktopBrowser || !browserFeature || !canUseBrowser)}
              onClick={() => patch({ browser: !browserEnabled })}
              className={cn(
                "relative h-[26px] w-[44px] shrink-0 rounded-full disabled:cursor-not-allowed disabled:opacity-40",
                browserEnabled ? "bg-accent" : "bg-control",
              )}
            >
              <span
                className={cn(
                  "absolute left-[3px] top-[3px] size-5 rounded-full bg-panel transition-transform",
                  browserEnabled && "translate-x-[18px]",
                )}
              />
            </button>
          </div>

          <div className="border-b border-hairline/50 py-4">
            <ModelPicker
              bot={bot}
              contained
              label={
                <div>
                  <div className="text-[15px] font-medium text-ink">Model</div>
                  <div className="mt-0.5 text-[13px] text-ink-secondary">
                    Runtime and model assigned to this operator
                  </div>
                </div>
              }
            />
          </div>

          {!!engine?.capabilities?.effortLevels?.length && (
            <div className="border-b border-hairline/50 py-4">
              <div className="text-[15px] font-medium text-ink">Deliberation</div>
              {/* Says what the app does, not what the engine ends up at:
                  Codex applies a level to the whole workstream session and has no way to
                  take one back, so "currently: engine default" was a promise
                  we could not keep for a workstream that had already been sent
                  one. Sending nothing is true on every engine. */}
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                Reasoning depth for this operator{bot.modelSelection.effort ? "" : " (default: engine decides)"}
              </div>
              <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
                {([undefined, ...engine.capabilities.effortLevels] as const).map((level, i) => (
                  <button
                    key={level ?? "default"}
                    aria-pressed={bot.modelSelection.effort === level}
                    onClick={() => patch({ modelSelection: { ...bot.modelSelection, effort: level } })}
                    className={cn(
                      "flex-1 py-1.5 text-[13px] capitalize",
                      i > 0 && "border-l border-hairline/40",
                      bot.modelSelection.effort === level
                        ? "bg-control text-ink"
                        : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                    )}
                  >
                    {/* the others capitalize cleanly; "xhigh" would read "Xhigh" */}
                    {level === "xhigh" ? "X-High" : (level ?? "Default")}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="border-b border-hairline/50 py-4">
            <div className="text-[15px] font-medium text-ink">Workbench</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              Where this operator&rsquo;s capabilities execute{bot.computer ? "" : " (automatic)"}
            </div>
            <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
              {([
                ["cloud", "Cloud"],
                ["vm", "Local VM"],
                ["local", "This machine"],
                ["off", "Off"],
              ] as const).map(([mode, label], i) => (
                <button
                  key={mode}
                  disabled={mode === "local" && !localSelectable}
                  title={mode === "local" && !localSelectable ? localDisabledReason ?? undefined : undefined}
                  onClick={() => {
                    if (mode === bot.computer) return;
                    if (mode === "local" && bot.autoApprove) setLocalAutoWarning("local");
                    else patch({ computer: mode });
                  }}
                  className={cn(
                    "flex-1 py-1.5 text-[13px] capitalize",
                    i > 0 && "border-l border-hairline/40",
                    mode === "local" && !localSelectable && "cursor-not-allowed opacity-40",
                    bot.computer === mode
                      ? "bg-control text-ink"
                      : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {(!bot.computer || bot.computer === "cloud") && (
              <>
                <CloudBackendPicker
                  value={bot.cloudBackend ?? "box"}
                  vpsSupported={canUseVps}
                  onChange={(backend) => patch({ cloudBackend: backend })}
                />
                {!bot.computer && bot.cloudBackend === "vps" && (
                  <div className="mt-3 flex items-center justify-between gap-4 rounded-lg bg-inset px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="text-[13px] text-ink">Start VPS automatically</div>
                      <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                        Allow automatic placement to create or wake this operator&rsquo;s managed container.
                      </div>
                    </div>
                    <button
                      role="switch"
                      aria-checked={Boolean(bot.autoStartVps)}
                      aria-label="Start VPS automatically"
                      onClick={() => patch({ autoStartVps: !bot.autoStartVps })}
                      className={cn(
                        "relative h-6 w-11 shrink-0 rounded-full",
                        bot.autoStartVps ? "bg-accent" : "bg-control",
                      )}
                    >
                      <span
                        className={cn(
                          "absolute left-[4px] top-[3px] size-[18px] rounded-full bg-panel transition-transform",
                          bot.autoStartVps && "translate-x-[18px]",
                        )}
                      />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          <BotUsageCard bot={bot} />
          <WorkingFolder bot={bot} />

          {/* keyed so switching operators never shows one operator's notes under another's name */}
          <MemoryCard key={bot.id} bot={bot} />

          {/* Imported methods are isolated per operator and always land disabled. */}
          <AgentSkillsPanel key={`methods-${bot.id}`} botId={bot.id} />

          <div className="flex items-center justify-between gap-4 border-b border-hairline/50 py-4">
            <div>
              <div className="text-[15px] font-medium text-ink">Continuous runs</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {bot.computer === "local"
                  ? bot.autoApprove
                    ? "Runs continue on this machine. Destructive actions and direct questions still wait at a gate."
                    : "Every Workbench action waits for you. Enable this to continue ordinary work between gates."
                  : bot.autoApprove
                  ? "Runs continue between gates. Destructive actions and direct questions still wait for you."
                  : "Every action waits for you. Enable this to continue ordinary work between gates."}
              </div>
            </div>
            <button
              role="switch"
              aria-checked={Boolean(bot.autoApprove)}
              aria-label="Continuous runs"
              onClick={() => {
                if (!bot.autoApprove && bot.computer === "local") setLocalAutoWarning("auto");
                else patch({ autoApprove: !bot.autoApprove });
              }}
              className={cn(
                "relative h-[26px] w-[44px] shrink-0 rounded-full",
                bot.autoApprove ? "bg-accent" : "bg-control",
              )}
            >
              <span
                className={cn(
                  "absolute left-[3px] top-[3px] size-5 rounded-full bg-panel transition-transform",
                  bot.autoApprove && "translate-x-[18px]",
                )}
              />
            </button>
          </div>

          <div className="border-b border-hairline/50 py-4">
            <div className="text-[15px] font-medium text-ink">Review cadence gates</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {canAutoReview
                ? "The same engine reviews ordinary gates in isolation. Safety rules, unattended runs, local Workbench access, and direct questions still wait for you."
                : "This engine cannot run an isolated review safely, so every gate continues to wait for you."}
            </div>
            <div className="mt-3 flex gap-1 rounded-lg bg-inset p-0.5">
              {(
                [
                  ["off", "Off", "Every undecided gate waits for you."],
                  ["shadow", "Watch", "Record the review without answering the card."],
                  ["enforce", "On", "Resolve only reviews that return a strict allow decision."],
                ] as const
              ).map(([value, label, hint]) => {
                const current = bot.autoReview === "shadow" || bot.autoReview === "enforce" ? bot.autoReview : "off";
                const disabled = value !== "off" && !canAutoReview;
                return (
                  <button
                    key={value}
                    title={disabled ? "Not supported by this engine" : hint}
                    disabled={disabled}
                    onClick={() => patch({ autoReview: value })}
                    className={cn(
                      "flex-1 rounded-md px-2.5 py-1.5 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-40",
                      current === value ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <VoiceSettings bot={bot} onPatch={patch} />

          <div className="flex items-center justify-between gap-4 border-b border-hairline/50 py-4">
            <div>
              <div className="text-[15px] font-medium text-ink">
                Notifications
              </div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                Signal when this operator finishes or waits for input
              </div>
            </div>
            <button
              role="switch"
              aria-checked={bot.notifications}
              aria-label="Operator notifications"
              onClick={() => {
                const enabled = !bot.notifications;
                if (enabled) void requestNotificationPermission();
                patch({ notifications: enabled });
              }}
              className={cn(
                "relative h-[26px] w-[44px] shrink-0 rounded-full",
                bot.notifications ? "bg-accent" : "bg-control",
              )}
            >
              <span
                className={cn(
                  "absolute left-[3px] top-[3px] size-5 rounded-full bg-panel transition-transform",
                  bot.notifications && "translate-x-[18px]",
                )}
              />
            </button>
          </div>
        </div>
      </div>
    </aside>
    <LocalComputerAutoWarning
      open={localAutoWarning !== null}
      onCancel={() => setLocalAutoWarning(null)}
      onConfirm={() => {
        if (localAutoWarning === "auto") patch({ autoApprove: true, acknowledgeLocalAuto: true });
        if (localAutoWarning === "local") patch({ computer: "local", acknowledgeLocalAuto: true });
        setLocalAutoWarning(null);
      }}
    />
    </>
  );
}
