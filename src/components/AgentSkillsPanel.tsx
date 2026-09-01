import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  Github,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import {
  agentSkillsClient,
  type AgentSkillsClient,
  type ImportedMethodEnablement,
  type ImportedMethod,
  type ImportedMethodBatch,
} from "@/lib/agent-skills-api";
import { cn } from "@/lib/cn";

type ReviewStatus = "idle" | "loading" | "ready" | "error";

export interface MethodReview {
  open: boolean;
  status: ReviewStatus;
  text: string;
  error: string | null;
  acknowledged: boolean;
}

type ImportNotice = ImportedMethodBatch;

interface DeleteTarget {
  method: ImportedMethod;
  trigger: HTMLButtonElement;
}

const EMPTY_REVIEW: MethodReview = {
  open: false,
  status: "idle",
  text: "",
  error: null,
  acknowledged: false,
};

const inputClass =
  "w-full rounded-md border border-hairline/60 bg-raised px-3 py-2.5 text-[14px] text-ink placeholder:text-ink-secondary focus:border-signal focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/20";

export function methodSourceHref(source: string): string | null {
  const candidate = source.startsWith("github.com/") ? `https://${source}` : source;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && ["github.com", "raw.githubusercontent.com"].includes(url.hostname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function importedMethodDate(importedAt: string): string {
  const date = new Date(importedAt);
  if (!Number.isFinite(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export function canEnableImportedMethod(review: MethodReview): boolean {
  return review.status === "ready" && review.acknowledged;
}

export function beginMethodReviewRequest(epochs: Map<string, number>, name: string): number {
  const epoch = (epochs.get(name) ?? 0) + 1;
  epochs.set(name, epoch);
  return epoch;
}

export function isCurrentMethodReviewRequest(epochs: Map<string, number>, name: string, epoch: number): boolean {
  return epochs.get(name) === epoch;
}

export interface ReconciledMethodReviews {
  reviews: Record<string, MethodReview>;
  revisions: Map<string, string>;
}

export function reconcileMethodReviews(
  methods: ImportedMethod[],
  current: Record<string, MethodReview>,
  previousRevisions: Map<string, string>,
): ReconciledMethodReviews {
  const reviews: Record<string, MethodReview> = {};
  const revisions = new Map<string, string>();
  for (const method of methods) {
    revisions.set(method.name, method.reviewRevision);
    const review = current[method.name];
    if (!review) continue;
    reviews[method.name] = previousRevisions.get(method.name) === method.reviewRevision
      ? { ...review, acknowledged: false }
      : EMPTY_REVIEW;
  }
  return { reviews, revisions };
}

function MethodMetadata({ method }: { method: ImportedMethod }) {
  const sourceHref = methodSourceHref(method.source);
  return (
    <dl className="mt-3 grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[11.5px] leading-relaxed">
      <dt className="text-ink-secondary">Source</dt>
      <dd className="min-w-0 truncate font-mono text-ink" title={method.source}>
        {sourceHref ? (
          <a className="underline decoration-hairline underline-offset-2 hover:text-signal" href={sourceHref} target="_blank" rel="noreferrer">
            {method.source}
          </a>
        ) : method.source}
      </dd>
      <dt className="text-ink-secondary">Imported</dt>
      <dd className="text-ink">{importedMethodDate(method.importedAt)}</dd>
      <dt className="text-ink-secondary">License</dt>
      <dd className="text-ink">{method.license || "Not declared"}</dd>
      <dt className="text-ink-secondary">Compatibility</dt>
      <dd className="text-ink">{method.compatibility || "Not declared"}</dd>
      <dt className="text-ink-secondary">SHA-256</dt>
      <dd className="truncate font-mono text-ink" title={method.sha256}>{method.sha256}</dd>
      <dt className="text-ink-secondary">Review</dt>
      <dd className="text-ink">
        {method.reviewedRevision === method.reviewRevision && method.reviewedAt
          ? `Acknowledged ${importedMethodDate(method.reviewedAt)}`
          : "Not acknowledged"}
      </dd>
    </dl>
  );
}

export interface ImportedMethodCardProps {
  method: ImportedMethod;
  review: MethodReview;
  busy: boolean;
  onToggleReview(): void;
  onRetryReview(): void;
  onAcknowledge(acknowledged: boolean): void;
  onSetEnabled(enabled: boolean): void;
  onDelete(trigger: HTMLButtonElement): void;
}

export function ImportedMethodCard({
  method,
  review,
  busy,
  onToggleReview,
  onRetryReview,
  onAcknowledge,
  onSetEnabled,
  onDelete,
}: ImportedMethodCardProps) {
  const reviewId = `imported-method-${method.name}-review`;
  const hasWarnings = method.warnings.length > 0 || method.skippedFiles.length > 0;
  return (
    <article className="rounded-lg border border-hairline/50 bg-raised/40 p-3.5" aria-labelledby={`imported-method-${method.name}`}>
      <div className="flex items-start gap-3">
        <span className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
          method.enabled ? "bg-success/10 text-success" : "bg-control text-ink-secondary",
        )}>
          {method.enabled ? <CheckCircle2 size={16} aria-hidden="true" /> : <BookOpen size={16} aria-hidden="true" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 id={`imported-method-${method.name}`} className="font-mono text-[13px] font-semibold text-ink">{method.name}</h4>
            <span className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em]",
              method.enabled ? "bg-success/10 text-success" : "bg-control text-ink-secondary",
            )}>
              {method.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{method.description}</p>
        </div>
      </div>

      {hasWarnings && (
        <div className="mt-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2.5 text-[11.5px] text-ink" role="note" aria-label="Import review warnings">
          <div className="flex items-center gap-1.5 font-medium text-warning">
            <AlertTriangle size={13} aria-hidden="true" /> Review before enabling
          </div>
          {method.warnings.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-1 pl-4">
              {method.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          )}
          {method.skippedFiles.length > 0 && (
            <p className="mt-1.5 text-ink-secondary">
              Not imported: {method.skippedFiles.join(", ")}. Helmryth imports Markdown only.
            </p>
          )}
        </div>
      )}

      <MethodMetadata method={method} />

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline/40 pt-3">
        <button
          type="button"
          aria-expanded={review.open}
          aria-controls={reviewId}
          onClick={onToggleReview}
          className="flex min-h-9 items-center gap-1.5 rounded-md bg-control px-3 text-[12px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/30"
        >
          <BookOpen size={13} aria-hidden="true" />
          {review.open ? "Close full method" : "Read full method"}
          <ChevronDown size={13} aria-hidden="true" className={cn("transition-transform", review.open && "rotate-180")} />
        </button>
        {method.enabled && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onSetEnabled(false)}
            className="min-h-9 rounded-md px-3 text-[12px] font-medium text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50"
          >
            {busy ? "Disabling…" : "Disable"}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          aria-label={`Remove imported method ${method.name}`}
          onClick={(event) => onDelete(event.currentTarget)}
          className="ml-auto flex min-h-9 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-danger hover:bg-danger/10 disabled:opacity-50"
        >
          <Trash2 size={13} aria-hidden="true" /> Remove
        </button>
      </div>

      {review.open && (
        <div id={reviewId} className="mt-3 border-t border-hairline/40 pt-3">
          {review.status === "loading" && (
            <div className="flex items-center gap-2 py-3 text-[12px] text-ink-secondary" role="status">
              <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> Loading the complete SKILL.md…
            </div>
          )}
          {review.status === "error" && (
            <div className="rounded-md border border-danger/30 bg-danger/5 p-3" role="alert">
              <p className="text-[12px] text-danger">{review.error}</p>
              <button type="button" onClick={onRetryReview} className="mt-2 flex min-h-8 items-center gap-1.5 rounded-md bg-control px-2.5 text-[11.5px] text-ink hover:bg-raised-hover">
                <RefreshCw size={12} aria-hidden="true" /> Retry full method
              </button>
            </div>
          )}
          {review.status === "ready" && (
            <>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h5 className="text-[12px] font-medium text-ink">Complete SKILL.md</h5>
                <span className="text-[10.5px] text-ink-secondary">{review.text.length.toLocaleString()} characters</span>
              </div>
              <pre
                tabIndex={0}
                aria-label={`Full Markdown for ${method.name}`}
                className="max-h-[320px] overflow-auto whitespace-pre-wrap rounded-md border border-hairline/50 bg-inset p-3 font-mono text-[11.5px] leading-relaxed text-ink outline-none focus-visible:ring-2 focus-visible:ring-signal/30"
              >
                {review.text}
              </pre>
              {!method.enabled && (
                <div className="mt-3 rounded-md border border-hairline/50 bg-panel p-3">
                  <label className="flex cursor-pointer items-start gap-2.5 text-[12px] leading-relaxed text-ink">
                    <input
                      type="checkbox"
                      checked={review.acknowledged}
                      onChange={(event) => onAcknowledge(event.target.checked)}
                      className="mt-0.5 size-4 accent-[var(--color-signal)]"
                    />
                    <span>I reviewed the complete method and understand its source, warnings, and instructions.</span>
                  </label>
                  <button
                    type="button"
                    disabled={busy || !canEnableImportedMethod(review)}
                    onClick={() => onSetEnabled(true)}
                    className="mt-3 flex min-h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-medium text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ShieldCheck size={13} aria-hidden="true" /> {busy ? "Enabling…" : "Enable method"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </article>
  );
}

interface RemoveMethodDialogProps {
  method: ImportedMethod;
  busy: boolean;
  error: string | null;
  onCancel(): void;
  onConfirm(): void;
}

export function RemoveMethodDialog({ method, busy, error, onCancel, onConfirm }: RemoveMethodDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => cancelRef.current?.focus(), []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (controls.length < 2) return;
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" onKeyDown={handleKeyDown}>
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="remove-imported-method-title"
        aria-describedby="remove-imported-method-copy"
        className="w-full max-w-[420px] rounded-md border border-hairline bg-panel p-5 shadow-xl"
      >
        <h3 id="remove-imported-method-title" className="text-[16px] font-semibold text-ink">Remove {method.name}?</h3>
        <p id="remove-imported-method-copy" className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
          This removes the imported Markdown and disables its native discovery links for this operator. Import it again from GitHub to restore it.
        </p>
        {error && <p className="mt-3 rounded-md bg-danger/10 px-3 py-2 text-[12px] text-danger" role="alert">{error}</p>}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel} className="min-h-9 rounded-md bg-control px-4 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">Cancel</button>
          <button type="button" disabled={busy} onClick={onConfirm} className="min-h-9 rounded-md bg-danger px-4 text-[13px] font-medium text-[var(--color-danger-ink)] disabled:opacity-50">
            {busy ? "Removing…" : "Remove method"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AgentSkillsPanel({ botId, client = agentSkillsClient }: { botId: string; client?: AgentSkillsClient }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const loadEpoch = useRef(0);
  const reviewEpochs = useRef<Map<string, number>>(new Map());
  const methodRevisions = useRef<Map<string, string>>(new Map());
  const botIdRef = useRef(botId);
  botIdRef.current = botId;
  const [methods, setMethods] = useState<ImportedMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<ImportNotice | null>(null);
  const [reviews, setReviews] = useState<Record<string, MethodReview>>({});
  const [workingMethods, setWorkingMethods] = useState<Set<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const beginWorking = (name: string) => {
    setWorkingMethods((current) => new Set(current).add(name));
  };

  const endWorking = (name: string) => {
    setWorkingMethods((current) => {
      const next = new Set(current);
      next.delete(name);
      return next;
    });
  };

  const load = useCallback(async () => {
    const epoch = ++loadEpoch.current;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await client.list(botId);
      if (loadEpoch.current === epoch) {
        reviewEpochs.current.clear();
        const previousRevisions = methodRevisions.current;
        const refreshedRevisions = new Map(next.map((method) => [method.name, method.reviewRevision]));
        methodRevisions.current = refreshedRevisions;
        setReviews((current) => reconcileMethodReviews(next, current, previousRevisions).reviews);
        setMethods(next);
      }
    } catch (error) {
      if (loadEpoch.current === epoch) setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (loadEpoch.current === epoch) setLoading(false);
    }
  }, [botId, client]);

  useEffect(() => {
    setMethods([]);
    setReviews({});
    reviewEpochs.current.clear();
    methodRevisions.current.clear();
    setSource("");
    setImportNotice(null);
    setImportError(null);
    setActionError(null);
    setWorkingMethods(new Set());
    setDeleteTarget(null);
    void load();
  }, [botId, load]);

  const updateReview = (name: string, update: (review: MethodReview) => MethodReview) => {
    setReviews((current) => ({ ...current, [name]: update(current[name] ?? EMPTY_REVIEW) }));
  };

  const loadReview = async (method: ImportedMethod) => {
    const requestedBotId = botId;
    const epoch = beginMethodReviewRequest(reviewEpochs.current, method.name);
    updateReview(method.name, (review) => ({
      ...review,
      open: true,
      status: "loading",
      error: null,
      acknowledged: false,
    }));
    try {
      const text = await client.read(botId, method.name);
      if (botIdRef.current !== requestedBotId || !isCurrentMethodReviewRequest(reviewEpochs.current, method.name, epoch)) return;
      updateReview(method.name, (review) => ({
        ...review,
        open: true,
        status: "ready",
        text,
        error: null,
        acknowledged: false,
      }));
    } catch (error) {
      if (botIdRef.current !== requestedBotId || !isCurrentMethodReviewRequest(reviewEpochs.current, method.name, epoch)) return;
      updateReview(method.name, (review) => ({
        ...review,
        open: true,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const toggleReview = (method: ImportedMethod) => {
    const review = reviews[method.name] ?? EMPTY_REVIEW;
    if (review.open) {
      updateReview(method.name, (current) => ({ ...current, open: false }));
    } else if (review.status === "ready" || review.status === "loading") {
      updateReview(method.name, (current) => ({ ...current, open: true }));
    } else {
      void loadReview(method);
    }
  };

  const importMethods = async () => {
    const trimmed = source.trim();
    if (!trimmed) return;
    const requestedBotId = botId;
    setImporting(true);
    setImportError(null);
    setImportNotice(null);
    try {
      const result = await client.importFromGitHub(botId, trimmed);
      if (botIdRef.current !== requestedBotId) return;
      setImportNotice(result);
      setSource("");
      await load();
    } catch (error) {
      if (botIdRef.current !== requestedBotId) return;
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      if (botIdRef.current === requestedBotId) setImporting(false);
    }
  };

  const setEnabled = async (method: ImportedMethod, enabled: boolean) => {
    const review = reviews[method.name] ?? EMPTY_REVIEW;
    if (enabled && !canEnableImportedMethod(review)) {
      setActionError(`Read and acknowledge the complete ${method.name} method before enabling it.`);
      return;
    }
    const requestedBotId = botId;
    beginWorking(method.name);
    setActionError(null);
    try {
      const enablement: ImportedMethodEnablement = enabled
        ? { enabled: true, review: { revision: method.reviewRevision, acknowledged: true } }
        : { enabled: false };
      const updated = await client.setEnabled(botId, method.name, enablement);
      if (botIdRef.current !== requestedBotId) return;
      setMethods((current) => current.map((entry) => entry.name === method.name ? updated : entry));
      methodRevisions.current.set(updated.name, updated.reviewRevision);
    } catch (error) {
      if (botIdRef.current !== requestedBotId) return;
      setActionError(error instanceof Error ? error.message : String(error));
      if (enabled) await load();
    } finally {
      if (botIdRef.current === requestedBotId) endWorking(method.name);
    }
  };

  const cancelDelete = () => {
    const trigger = deleteTarget?.trigger;
    setDeleteTarget(null);
    setDeleteError(null);
    requestAnimationFrame(() => trigger?.focus());
  };

  const removeMethod = async () => {
    if (!deleteTarget) return;
    const name = deleteTarget.method.name;
    const requestedBotId = botId;
    beginWorking(name);
    setDeleteError(null);
    try {
      await client.remove(botId, name);
      if (botIdRef.current !== requestedBotId) return;
      setMethods((current) => current.filter((entry) => entry.name !== name));
      setReviews((current) => {
        const next = { ...current };
        delete next[name];
        return next;
      });
      reviewEpochs.current.delete(name);
      methodRevisions.current.delete(name);
      setDeleteTarget(null);
      requestAnimationFrame(() => headingRef.current?.focus());
    } catch (error) {
      if (botIdRef.current !== requestedBotId) return;
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      if (botIdRef.current === requestedBotId) endWorking(name);
    }
  };

  return (
    <section className="border-b border-hairline/50 py-4" aria-labelledby="agent-skills-heading">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-control text-ink-secondary">
          <BookOpen size={16} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-[0.1em] text-ink-secondary">Agent Skills</div>
          <h3 ref={headingRef} tabIndex={-1} id="agent-skills-heading" className="mt-0.5 text-[15px] font-semibold text-ink outline-none">Imported methods</h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">
            Bring in Markdown methods from GitHub for this operator. Imports stay disabled until you read and approve them.
          </p>
        </div>
      </div>

      <form
        className="mt-3"
        onSubmit={(event) => {
          event.preventDefault();
          void importMethods();
        }}
      >
        <label htmlFor={`method-source-${botId}`} className="text-[11.5px] font-medium text-ink">GitHub source</label>
        <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
          <input
            id={`method-source-${botId}`}
            value={source}
            disabled={importing}
            onChange={(event) => setSource(event.target.value)}
            className={inputClass}
            placeholder="owner/repo, a skill folder, or a GitHub SKILL.md URL"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="submit"
            disabled={importing || !source.trim()}
            className="flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-md bg-accent px-3.5 text-[12px] font-medium text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {importing ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Github size={13} aria-hidden="true" />}
            {importing ? "Importing…" : "Import"}
          </button>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-secondary">
          Markdown is copied into this operator&rsquo;s private workspace. Scripts and other files are skipped and reported.
        </p>
      </form>

      {importError && <div className="mt-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger" role="alert">{importError}</div>}
      {importNotice && (
        <div className={cn(
          "mt-3 rounded-md border px-3 py-2.5 text-[12px] leading-relaxed",
          importNotice.errors.length ? "border-warning/30 bg-warning/5 text-ink" : "border-success/30 bg-success/5 text-ink",
        )} role={importNotice.errors.length ? "alert" : "status"}>
          <p className="font-medium">
            Imported {importNotice.installed.length} {importNotice.installed.length === 1 ? "method" : "methods"}, all disabled for review.
          </p>
          {importNotice.installed.length > 0 && <p className="mt-1 font-mono text-[11px] text-ink-secondary">{importNotice.installed.map((method) => method.name).join(", ")}</p>}
          {importNotice.errors.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-warning">
              {importNotice.errors.map((error) => <li key={error}>{error}</li>)}
            </ul>
          )}
        </div>
      )}
      {actionError && <div className="mt-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger" role="alert">{actionError}</div>}

      <div className="mt-4">
        {loading && (
          <div className="flex items-center gap-2 py-4 text-[12px] text-ink-secondary" role="status">
            <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> Loading imported methods…
          </div>
        )}
        {!loading && loadError && (
          <div className="rounded-md border border-danger/30 bg-danger/5 p-3" role="alert">
            <p className="text-[12px] text-danger">{loadError}</p>
            <button type="button" onClick={() => void load()} className="mt-2 flex min-h-8 items-center gap-1.5 rounded-md bg-control px-2.5 text-[11.5px] text-ink hover:bg-raised-hover">
              <RefreshCw size={12} aria-hidden="true" /> Retry list
            </button>
          </div>
        )}
        {!loading && !loadError && methods.length === 0 && (
          <div className="rounded-md border border-dashed border-hairline/60 bg-inset/50 px-4 py-5 text-center">
            <BookOpen size={18} className="mx-auto text-ink-secondary" aria-hidden="true" />
            <p className="mt-2 text-[12.5px] font-medium text-ink">No imported methods</p>
            <p className="mt-1 text-[11.5px] text-ink-secondary">Paste a GitHub source above. Nothing is enabled during import.</p>
          </div>
        )}
        {!loading && !loadError && methods.length > 0 && (
          <div className="space-y-3">
            {methods.map((method) => (
              <ImportedMethodCard
                key={method.name}
                method={method}
                review={reviews[method.name] ?? EMPTY_REVIEW}
                busy={workingMethods.has(method.name)}
                onToggleReview={() => toggleReview(method)}
                onRetryReview={() => void loadReview(method)}
                onAcknowledge={(acknowledged) => updateReview(method.name, (review) => ({ ...review, acknowledged }))}
                onSetEnabled={(enabled) => void setEnabled(method, enabled)}
                onDelete={(trigger) => {
                  setDeleteError(null);
                  setDeleteTarget({ method, trigger });
                }}
              />
            ))}
          </div>
        )}
      </div>

      {deleteTarget && (
        <RemoveMethodDialog
          method={deleteTarget.method}
          busy={workingMethods.has(deleteTarget.method.name)}
          error={deleteError}
          onCancel={cancelDelete}
          onConfirm={() => void removeMethod()}
        />
      )}
    </section>
  );
}
