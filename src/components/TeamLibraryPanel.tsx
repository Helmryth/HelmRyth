import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { teamImportPreview, type PendingTeamImport, type TeamImportSource } from "@/lib/team-import";
import type { Routine } from "@/lib/routines";
import { api, useStore, type Bot, type Group } from "@/state/store";
import {
  ArrowLeft,
  BookOpen,
  CalendarClock,
  Check,
  Compass,
  Crown,
  FolderOpen,
  Github,
  Loader2,
  MessageSquare,
  Plug,
  Search,
  UploadCloud,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { z } from "zod";

const MAX_TEAM_FILE_BYTES = 1_000_000;

interface TeamCatalogEntry {
  slug: string;
  name: string;
  summary: string;
  category: string;
  outcome?: string;
  setupMinutes?: number;
  featured?: boolean;
  package?: string;
  manifest: string;
  readme: string;
  members: number;
  skills: string[];
  requires: { apps: string[] };
}

interface TeamCatalog {
  repositoryUrl: string;
  teams: TeamCatalogEntry[];
}

export interface ArchivedTeamBot {
  id: string;
  chiefOfStaff: boolean;
}

export interface TeamImportResult {
  name: string;
  members: number;
  importedBotIds: string[];
  importedGroupIds: string[];
  importedRoutineIds: string[];
  archived: ArchivedTeamBot[];
  transaction: {
    transactionId: string;
    idempotencyKey: string;
    fingerprint: string;
    committedAt: string;
  };
}

type ImportSource = "library" | "file" | "github";
type TeamTab = "explore" | "import" | "scout";
type ImportMode = "replace" | "add";

/** the scout endpoint's answer, as far as this panel renders it — the
 * manifest itself stays opaque and goes back to the server verbatim */
const scoutRoleSchema = z.enum(["frontend", "backend", "mobile", "data", "testing", "infra", "docs"]);
const crewColorSchema = z.enum(["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"]);
const scoutOperatorSchema = z.object({
  key: z.string(),
  name: z.string(),
  title: z.string(),
  description: z.string(),
  appearance: z.object({
    color: crewColorSchema,
    sigilExpression: z.string().optional(),
  }),
});
const scoutResultSchema = z.object({
  profile: z.object({
    name: z.string(),
    summary: z.string(),
    stacks: z.array(z.string()),
    signals: z.array(z.object({ role: scoutRoleSchema, evidence: z.array(z.string()) })),
  }),
  suggestion: z.object({
    roomName: z.string(),
    manifest: z.object({
      format: z.literal("helmryth.crew"),
      version: z.literal(1),
      crew: z.object({
        name: z.string(),
        description: z.string().optional(),
        operators: z.array(scoutOperatorSchema),
      }),
    }),
    reasons: z.record(z.string(), z.string()),
  }),
});

export type ScoutResult = z.output<typeof scoutResultSchema>;
type ScoutOperator = z.output<typeof scoutOperatorSchema>;
type ProjectCrewManifest = ScoutResult["suggestion"]["manifest"];

export function parseScoutResult(value: z.input<typeof scoutResultSchema>): ScoutResult {
  return scoutResultSchema.parse(value);
}

export interface DirectoryCandidate {
  slug: string;
  name: string;
  category: string;
  integrations: string[];
  prompt: string;
  detailUrl: string;
  matched: string[];
}

/** Appearance colors for directory operators folded into a scouted crew. */
const DIRECTORY_COLORS = ["green", "red", "yellow", "teal", "orange"] as const satisfies readonly ScoutOperator["appearance"]["color"][];

const CREW_GLYPHS = [
  "bg-accent/10 text-accent",
  "bg-success/10 text-success",
  "bg-warning/15 text-warning",
  "bg-inset text-ink-secondary",
] as const;

function CrewGlyph({ index }: { index: number }) {
  return (
    <div className={cn("flex size-11 shrink-0 items-center justify-center rounded-sm border border-hairline", CREW_GLYPHS[index % CREW_GLYPHS.length])}>
      <Users size={20} />
    </div>
  );
}

function OperatorGlyph({ index }: { index: number }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-hairline",
        CREW_GLYPHS[index % CREW_GLYPHS.length],
      )}
    >
      <span className="h-7 w-px -rotate-[34deg] bg-current opacity-70" />
      <span className="absolute h-px w-7 rotate-[34deg] bg-current opacity-45" />
      <span className="absolute size-1.5 rounded-sm border border-current bg-panel" />
    </div>
  );
}

export function projectScoutOperators(result: ScoutResult): ScoutOperator[] {
  return result.suggestion.manifest.crew.operators;
}

export function composeProjectCrewManifest(
  result: ScoutResult,
  directory: DirectoryCandidate[],
  selected: ReadonlySet<string>,
): ProjectCrewManifest {
  const extras = directory
    .filter((candidate) => selected.has(candidate.slug))
    .map((candidate, index): ScoutOperator => ({
      key: `dir-${candidate.slug}`,
      name: candidate.name,
      title: candidate.category || "Directory operator",
      description: candidate.prompt,
      appearance: { color: DIRECTORY_COLORS[index % DIRECTORY_COLORS.length] },
    }));
  return {
    ...result.suggestion.manifest,
    crew: {
      ...result.suggestion.manifest.crew,
      operators: [...result.suggestion.manifest.crew.operators, ...extras],
    },
  };
}

export function LibraryCrewLoadError({
  crewName,
  retrying,
  onRetry,
}: {
  crewName: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className="mb-4 rounded-xl border border-danger/30 bg-danger/10 p-4 text-[13px] text-danger">
      <p>Helmryth couldn’t load {crewName}. Check your connection, then try again.</p>
      <button
        onClick={onRetry}
        disabled={retrying}
        className="mt-3 flex min-h-9 items-center gap-1.5 rounded-md border border-hairline bg-raised px-3.5 py-2 text-ink hover:bg-raised-hover disabled:opacity-50"
      >
        {retrying && <Loader2 size={13} className="animate-spin" />}
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}

export function TeamLibraryPanel({
  onClose,
  onImported,
  returnFocusRef,
  initialUrl,
}: {
  onClose: () => void;
  onImported: (result: TeamImportResult) => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
  initialUrl?: string;
}) {
  const { state, dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<TeamTab>("explore");
  const [catalog, setCatalog] = useState<TeamCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [failedLibraryCrew, setFailedLibraryCrew] = useState<TeamCatalogEntry | null>(null);
  const [pending, setPending] = useState<PendingTeamImport | null>(null);
  const [source, setSource] = useState<ImportSource>("file");
  const [githubUrl, setGithubUrl] = useState("");
  const [githubLoading, setGithubLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>("replace");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const importRequestRef = useRef<string | null>(null);
  const projectRequestRef = useRef<string | null>(null);
  const [scoutFolder, setScoutFolder] = useState("");
  const [scouting, setScouting] = useState(false);
  const [scouted, setScouted] = useState<ScoutResult | null>(null);
  // the folder the current `scouted` result was actually read from — the
  // import must pin the room to THIS, not to whatever the input says now
  const [scoutedFolder, setScoutedFolder] = useState("");
  // null = not asked yet or still loading; [] = asked, nothing (or offline)
  const [directory, setDirectory] = useState<DirectoryCandidate[] | null>(null);
  const [pickedDirectory, setPickedDirectory] = useState<Set<string>>(new Set());
  const [roomName, setRoomName] = useState("");
  const [creating, setCreating] = useState(false);
  // monotonically increasing scout token: a late response from an older
  // scout (including its lazy directory call) must never overwrite state
  // that belongs to a newer one
  const scoutRequest = useRef(0);

  const currentBotCount = state.bots.filter((bot) => !bot.hidden).length;

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError("");
    try {
      // SAFETY: this endpoint is owned by the app and returns TeamCatalog.
      setCatalog((await api("/api/team-library/catalog")) as TeamCatalog);
    } catch (cause) {
      setCatalogError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    dialogRef.current?.focus();
    return () => {
      const target = returnFocusRef.current;
      if (!target) return;
      // Restore on the next frame. A synchronous focus() in the cleanup lands
      // while the dialog is still being torn down and the browser discards it,
      // so focus falls to <body> instead of the control that opened the panel.
      requestAnimationFrame(() => target.focus());
    };
  }, [returnFocusRef]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !importing) {
        event.preventDefault();
        event.stopPropagation();
        if (pending) setPending(null);
        else onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      const items = Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (!dialog || items.length === 0) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [importing, onClose, pending]);

  const previewManifest = (preview: PendingTeamImport, nextSource: ImportSource) => {
    setPending(preview);
    setSource(nextSource);
    setImportMode(currentBotCount > 0 ? "replace" : "add");
    setError("");
    importRequestRef.current = crypto.randomUUID();
  };

  const chooseImportMode = (mode: ImportMode) => {
    setImportMode(mode);
    importRequestRef.current = crypto.randomUUID();
  };

  const readFile = async (file: File) => {
    if (file.size > MAX_TEAM_FILE_BYTES) throw new Error("That crew package is too large.");
    const raw = await file.text();
    let manifest: TeamImportSource = raw;
    if (!file.name.toLowerCase().endsWith(".md")) {
      try {
        manifest = JSON.parse(raw);
      } catch (cause) {
        // Not "legacy": this branch takes every non-Markdown file, including the
        // app's own current-format .json export.
        if (cause instanceof SyntaxError) throw new Error("That crew package is not valid JSON.");
        throw cause;
      }
    }
    previewManifest(teamImportPreview(manifest), "file");
  };

  const loadLibraryTeam = async (entry: TeamCatalogEntry) => {
    const retryingFailedCrew = failedLibraryCrew?.slug === entry.slug;
    setBusySlug(entry.slug);
    if (!retryingFailedCrew) setFailedLibraryCrew(null);
    setError("");
    try {
      previewManifest(teamImportPreview(await api(`/api/team-library/teams/${entry.slug}`)), "library");
      setFailedLibraryCrew(null);
    } catch {
      setFailedLibraryCrew(entry);
    } finally {
      setBusySlug(null);
    }
  };

  const loadGithubUrl = useCallback(async (requestedUrl: string) => {
    if (!requestedUrl.trim()) return;
    setGithubLoading(true);
    setError("");
    try {
      const manifest = await api("/api/team-library/github", {
        method: "POST",
        body: JSON.stringify({ url: requestedUrl.trim() }),
      });
      previewManifest(teamImportPreview(manifest), "github");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGithubLoading(false);
    }
  }, []);

  const loadGithubTeam = async () => {
    await loadGithubUrl(githubUrl);
  };

  useEffect(() => {
    if (!initialUrl) return;
    setTab("import");
    setGithubUrl(initialUrl);
    void loadGithubUrl(initialUrl);
  }, [initialUrl, loadGithubUrl]);

  const importTeam = async () => {
    if (!pending) return;
    setImporting(true);
    setError("");
    try {
      // SAFETY: this endpoint is owned by the app and returns imported bots.
      const response = (await api(`/api/teams/import?mode=${importMode}`, {
        method: "POST",
        headers: { "idempotency-key": importRequestRef.current ??= crypto.randomUUID() },
        body: JSON.stringify(pending.manifest),
      })) as {
        bots: Bot[];
        groups?: Group[];
        routines?: Routine[];
        archivedBots?: Bot[];
        archived?: ArchivedTeamBot[];
        transaction: TeamImportResult["transaction"];
      };
      for (const bot of response.archivedBots ?? []) dispatch({ type: "botPatched", bot });
      for (const bot of response.bots) dispatch({ type: "botAdded", bot });
      for (const group of response.groups ?? []) dispatch({ type: "groupPatched", group });
      for (const routine of response.routines ?? []) dispatch({ type: "routinePatched", routine });
      const first = response.bots[0];
      if (first) dispatch({ type: "select", id: first.id });
      importRequestRef.current = crypto.randomUUID();
      track("team_imported", { members: response.bots.length, source, mode: importMode });
      onImported({
        name: pending.name,
        members: response.bots.length,
        importedBotIds: response.bots.map((bot) => bot.id),
        importedGroupIds: (response.groups ?? []).map((group) => group.id),
        importedRoutineIds: (response.routines ?? []).map((routine) => routine.id),
        archived: response.archived ?? [],
        transaction: response.transaction,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
    }
  };

  const scoutTarget = scoutFolder.trim();

  const runScout = async (folder: string) => {
    const request = ++scoutRequest.current;
    projectRequestRef.current = crypto.randomUUID();
    setScouting(true);
    setError("");
    setScouted(null);
    setDirectory(null);
    setPickedDirectory(new Set());
    try {
      // SAFETY: this endpoint is owned by the app and returns ScoutResult.
      const result = parseScoutResult(await api(`/api/teams/scout?cwd=${encodeURIComponent(folder)}`));
      if (request !== scoutRequest.current) return;
      setScouted(result);
      setScoutedFolder(folder);
      setRoomName(result.suggestion.roomName);
      track("team_scouted", { signals: projectScoutOperators(result).length - 1 });
      // community candidates arrive lazily; an unreachable directory just
      // leaves this section empty
      void api(`/api/teams/scout/directory?cwd=${encodeURIComponent(folder)}`)
        .then((extra) => {
          // SAFETY: this endpoint is owned by the app and returns candidates.
          const response = extra as { directory: DirectoryCandidate[] };
          if (request === scoutRequest.current) setDirectory(response.directory);
        })
        .catch(() => {
          if (request === scoutRequest.current) setDirectory([]);
        });
    } catch (cause) {
      if (request !== scoutRequest.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === scoutRequest.current) setScouting(false);
    }
  };

  const pickScoutFolder = async () => {
    const chosen = await window.helmryth?.pickFolder?.(scoutTarget || undefined);
    if (!chosen) return;
    setScoutFolder(chosen);
    await runScout(chosen);
  };

  const createProject = async () => {
    if (!scouted || creating) return;
    setCreating(true);
    setError("");
    try {
      // The confirmed suggestion, plus any directory operators the user ticked —
      // folded in as ordinary manifest operators so the import boundary
      // (persona only, no grants) applies to them like to everything else
      const manifest = composeProjectCrewManifest(scouted, directory ?? [], pickedDirectory);
      const room = roomName.trim() || scouted.suggestion.roomName;
      // SAFETY: this endpoint is owned by the app and returns imported bots.
      const response = (await api(
        `/api/teams/import?mode=project&cwd=${encodeURIComponent(scoutedFolder)}&room=${encodeURIComponent(room)}`,
        {
          method: "POST",
          headers: { "idempotency-key": projectRequestRef.current ??= crypto.randomUUID() },
          body: JSON.stringify(manifest),
        },
      )) as { bots: Bot[]; group?: Group; transaction: TeamImportResult["transaction"] };
      for (const bot of response.bots) dispatch({ type: "botAdded", bot });
      if (response.group) {
        // upsert now instead of waiting for the SSE frame, then land in the room
        dispatch({ type: "groupPatched", group: { ...response.group, messages: [] } });
        dispatch({ type: "select", id: response.group.id });
      }
      projectRequestRef.current = crypto.randomUUID();
      track("team_imported", { members: response.bots.length, source: "scout", mode: "project" });
      onImported({
        name: room,
        members: response.bots.length,
        importedBotIds: response.bots.map((bot) => bot.id),
        importedGroupIds: response.group ? [response.group.id] : [],
        importedRoutineIds: [],
        archived: [],
        transaction: response.transaction,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  const normalizedSearch = search.trim().toLowerCase();
  const visibleTeams = (catalog?.teams ?? []).filter((entry) => {
    if (!normalizedSearch) return true;
    return `${entry.name} ${entry.summary} ${entry.category} ${entry.skills.join(" ")} ${entry.requires.apps.join(" ")}`
      .toLowerCase()
      .includes(normalizedSearch);
  });

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-4 sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && !importing && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="crew-library-title"
        tabIndex={-1}
        className="animate-pop-in flex h-[min(780px,calc(100dvh-2rem))] w-full max-w-[1040px] flex-col overflow-hidden rounded-md border border-hairline/60 bg-panel shadow-xl outline-none"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-3 pt-6 sm:px-8 sm:pt-7">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {pending && (
                <button
                  onClick={() => {
                    setPending(null);
                    setError("");
                  }}
                  disabled={importing}
                  className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                  aria-label="Back to crew library"
                >
                  <ArrowLeft size={18} />
                </button>
              )}
              <h2 id="crew-library-title" className="truncate text-[22px] font-semibold tracking-[-0.01em] text-ink">
                {pending ? pending.name : "Crew library"}
              </h2>
            </div>
            <p className={cn("mt-1 text-[13px] text-ink-secondary", pending && "ml-9")}>
                {pending
                  ? pending.kind === "package"
                    ? `${pending.members.length} operators · portable crew package`
                    : `${pending.members.length} ready-to-load operators`
                  : "Start with a complete crew or bring a package you control."}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={onClose}
              disabled={importing}
              className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
              aria-label="Close crew library"
            >
              <X size={21} />
            </button>
          </div>
        </header>

        {pending ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-6 sm:px-8">
              {pending.description && (
                <p className="max-w-2xl text-[13.5px] leading-relaxed text-ink-secondary">{pending.description}</p>
              )}
              {pending.kind === "package" && (
                <div className="mt-5 flex flex-wrap gap-2 text-[11.5px] text-ink-secondary">
                  {pending.chiefOfStaff && <span className="flex items-center gap-1.5 rounded-full bg-raised px-3 py-1.5"><Crown size={13} />Lead operator · {pending.chiefOfStaff}</span>}
                  <span className="flex items-center gap-1.5 rounded-full bg-raised px-3 py-1.5"><MessageSquare size={13} />{pending.rooms} {pending.rooms === 1 ? "crew" : "crews"}</span>
                  <span className="flex items-center gap-1.5 rounded-full bg-raised px-3 py-1.5"><BookOpen size={13} />{pending.playbooks} methods</span>
                  <span className="flex items-center gap-1.5 rounded-full bg-raised px-3 py-1.5"><CalendarClock size={13} />{pending.routines} paused cadences</span>
                  <span className="flex items-center gap-1.5 rounded-full bg-raised px-3 py-1.5"><Plug size={13} />{pending.apps.length} capabilities</span>
                </div>
              )}
              <div className="mt-6 text-[12px] font-medium text-ink-secondary">Operators</div>
              <div className="mt-2 max-w-[760px] border-t border-hairline/35">
                {pending.members.map((member, index) => (
                  <div key={`${member.name}-${index}`} className="flex min-h-[72px] items-center gap-3 border-b border-hairline/35 px-1 py-3">
                    <OperatorGlyph index={index} />
                    <div className="min-w-0">
                      <div className="truncate text-[14px] font-medium text-ink">{member.name}</div>
                      <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary">{member.title || "General operator"}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-6 flex items-start gap-2.5 rounded-xl bg-raised/45 px-4 py-3 text-[12.5px] leading-relaxed text-ink-secondary">
                <Check size={15} className="mt-0.5 shrink-0 text-success" />
                <p>
                  {pending.kind === "package"
                    ? "Operators, lead operator assignments, crews, and reviewed methods are loaded. Suggested cadences arrive paused, and capabilities stay off until you approve them. Workstreams, credentials, gates, and workbench access stay private."
                    : "Only operator roles and appearance are loaded. Your workstreams, account connections, gates, and workbench access stay private."}
                </p>
              </div>
              {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
            </div>

            <footer className="flex flex-col gap-3 border-t border-hairline/35 px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8">
              <div className="text-[12.5px] text-ink-secondary">
                {currentBotCount > 0 ? (
                  importMode === "replace" ? (
                    <>
                      Replaces your {currentBotCount} current {currentBotCount === 1 ? "operator" : "operators"}. They&apos;ll be archived with workstreams intact.{" "}
                      <button onClick={() => chooseImportMode("add")} className="font-medium text-ink hover:underline">Add alongside instead</button>
                    </>
                  ) : (
                    <>
                      This crew will be added alongside your current operators.{" "}
                      <button onClick={() => chooseImportMode("replace")} className="font-medium text-ink hover:underline">Replace current crew instead</button>
                    </>
                  )
                ) : (
                  pending.kind === "package" ? "Review the complete setup, then activate the crew package." : "No crew is created; assemble one later when the operators are ready."
                )}
              </div>
              <button
                onClick={() => void importTeam()}
                disabled={importing}
                className="flex shrink-0 items-center justify-center gap-2 rounded-md bg-accent px-5 py-2.5 text-[13.5px] font-medium text-white hover:bg-accent/90 disabled:opacity-60"
              >
                {importing && <Loader2 size={15} className="animate-spin" />}
                {importing
                  ? "Loading…"
                  : pending.kind === "package" && currentBotCount === 0
                    ? "Activate crew"
                    : currentBotCount === 0
                    ? "Load crew"
                    : importMode === "replace"
                      ? "Replace crew"
                      : "Add crew"}
              </button>
            </footer>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-3 px-6 pb-4 pt-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
              <div
                className="flex w-fit rounded-md border border-hairline bg-raised/70 p-1"
                role="tablist"
                aria-label="Crew source"
                onKeyDown={(event) => {
                  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                  event.preventDefault();
                  const order = ["explore", "import", "scout"] as const;
                  const step = event.key === "ArrowRight" ? 1 : -1;
                  const next = order[(order.indexOf(tab) + step + order.length) % order.length];
                  setTab(next);
                  setError("");
                  // roving tabindex moves focus with the selection
                  document.getElementById(`crew-source-tab-${next}`)?.focus();
                }}
              >
                <button
                  role="tab"
                  id="crew-source-tab-explore"
                  aria-controls="crew-source-panel"
                  aria-selected={tab === "explore"}
                  tabIndex={tab === "explore" ? 0 : -1}
                  onClick={() => {
                    setTab("explore");
                    setError("");
                  }}
                  className={cn(
                    "rounded-lg px-4 py-2 text-[13.5px] transition-colors",
                    tab === "explore" ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  Library
                </button>
                <button
                  role="tab"
                  id="crew-source-tab-import"
                  aria-controls="crew-source-panel"
                  aria-selected={tab === "import"}
                  tabIndex={tab === "import" ? 0 : -1}
                  onClick={() => {
                    setTab("import");
                    setError("");
                  }}
                  className={cn(
                    "rounded-lg px-4 py-2 text-[13.5px] transition-colors",
                    tab === "import" ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  Bring a package
                </button>
                <button
                  role="tab"
                  id="crew-source-tab-scout"
                  aria-controls="crew-source-panel"
                  aria-selected={tab === "scout"}
                  tabIndex={tab === "scout" ? 0 : -1}
                  onClick={() => {
                    setTab("scout");
                    setError("");
                  }}
                  className={cn(
                    "rounded-lg px-4 py-2 text-[13.5px] transition-colors",
                    tab === "scout" ? "bg-card text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  Compose from project
                </button>
              </div>
              {tab === "explore" && (
                <label className="flex h-11 w-full items-center gap-2.5 rounded-xl bg-raised/70 px-3.5 sm:w-[320px]">
                  <Search size={17} className="shrink-0 text-ink-secondary" />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search crews"
                    aria-label="Search crews"
                    className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
                  />
                </label>
              )}
            </div>

            <div
              id="crew-source-panel"
              role="tabpanel"
              aria-labelledby={`crew-source-tab-${tab}`}
              className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-5 sm:px-8"
            >
              {tab === "explore" && (
                <div>
                  <div className="mb-3 text-[12px] font-medium text-ink-secondary">
                    {search ? "Search results" : "Crew library"}
                  </div>
                  {failedLibraryCrew && (
                    <LibraryCrewLoadError
                      crewName={failedLibraryCrew.name}
                      retrying={busySlug === failedLibraryCrew.slug}
                      onRetry={() => void loadLibraryTeam(failedLibraryCrew)}
                    />
                  )}
                  {catalogLoading && (
                    <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-ink-secondary">
                      <Loader2 size={16} className="animate-spin" /> Loading crews…
                    </div>
                  )}
                  {!catalogLoading && catalogError && (
                    <div role="alert" className="rounded-xl bg-danger/10 p-4 text-[13px] text-danger">
                      <p>{catalogError}</p>
                      <button onClick={() => void loadCatalog()} className="mt-3 rounded-md border border-hairline bg-raised px-3.5 py-2 text-ink hover:bg-raised-hover">Try again</button>
                    </div>
                  )}
                  {!catalogLoading && catalog && (
                    <div className="max-w-[800px] border-t border-hairline/35">
                      {visibleTeams.map((entry, index) => (
                        <article key={entry.slug} className="flex min-h-[104px] items-center gap-3 border-b border-hairline/35 px-1 py-4">
                          <CrewGlyph index={index} />
                          <div className="min-w-0 flex-1">
                            <h3 className="truncate text-[14px] font-medium text-ink">{entry.name}</h3>
                            <p className="mt-0.5 truncate text-[12.5px] text-ink-secondary">{entry.outcome ?? entry.summary}</p>
                            <p className="mt-1 truncate text-[11.5px] text-ink-secondary/80">
                              {entry.members} operators · {entry.skills.length} methods
                              {entry.requires.apps.length > 0 && ` · ${entry.requires.apps.join(", ")}`}
                              {entry.setupMinutes && ` · ~${entry.setupMinutes} min`}
                            </p>
                          </div>
                          <button
                            onClick={() => void loadLibraryTeam(entry)}
                            disabled={busySlug !== null}
                            aria-label={`Load ${entry.name}`}
                            className="flex min-w-[72px] items-center justify-center gap-1.5 rounded-md border border-hairline bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40"
                          >
                            {busySlug === entry.slug && <Loader2 size={13} className="animate-spin" />}
                            {busySlug === entry.slug ? "Loading" : "Load"}
                          </button>
                        </article>
                      ))}
                    </div>
                  )}
                  {!catalogLoading && catalog && visibleTeams.length === 0 && (
                    <div className="flex min-h-56 flex-col items-center justify-center text-center">
                      <div className="text-[14px] font-medium text-ink">No crews match this search</div>
                      <div className="mt-1 text-[12.5px] text-ink-secondary">Try an outcome, capability, or operator role.</div>
                    </div>
                  )}
                </div>
              )}

              {tab === "import" && (
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".md,.json,text/markdown,application/json"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (!file) return;
                      void readFile(file).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
                    }}
                  />
                  <div className="mb-3 text-[12px] font-medium text-ink-secondary">Bring your own crew package</div>
                  <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      onDragEnter={(event) => {
                        event.preventDefault();
                        setDragging(true);
                      }}
                      onDragOver={(event) => event.preventDefault()}
                      onDragLeave={() => setDragging(false)}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDragging(false);
                        const file = event.dataTransfer.files[0];
                        if (file) void readFile(file).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
                      }}
                      className={cn(
                        "flex min-h-56 flex-col items-center justify-center rounded-md border border-dashed px-6 text-center transition-colors",
                        dragging ? "border-accent bg-accent/5" : "border-hairline/60 bg-raised/20 hover:bg-raised/35",
                      )}
                    >
                      <UploadCloud size={27} className="text-accent" />
                      <span className="mt-3 text-[14px] font-medium text-ink">Choose a crew package</span>
                      <span className="mt-1 text-[12.5px] text-ink-secondary">Drop a portable Markdown package or a supported legacy JSON file.</span>
                    </button>

                    <div className="flex min-h-56 flex-col justify-center rounded-md border border-hairline bg-raised/25 px-6">
                      <Github size={25} className="text-ink-secondary" />
                      <h3 className="mt-3 text-[14px] font-medium text-ink">Load from GitHub</h3>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">Paste a public repository or a direct crew-package link.</p>
                      <div className="mt-4 flex gap-2">
                        <input
                          value={githubUrl}
                          onChange={(event) => setGithubUrl(event.target.value)}
                          onKeyDown={(event) => event.key === "Enter" && void loadGithubTeam()}
                          placeholder="github.com/owner/repo"
                          aria-label="GitHub crew package URL"
                          className="min-w-0 flex-1 rounded-xl bg-raised/80 px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
                        />
                        <button
                          onClick={() => void loadGithubTeam()}
                          disabled={!githubUrl.trim() || githubLoading}
                          className="flex items-center gap-1.5 rounded-md bg-accent px-4 py-2.5 text-[13px] font-medium text-white hover:bg-accent/90 disabled:opacity-40"
                        >
                          {githubLoading && <Loader2 size={13} className="animate-spin" />}
                          Load
                        </button>
                      </div>
                    </div>
                  </div>
                  {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
                </div>
              )}

              {tab === "scout" && (
                <div>
                  <div className="mb-3 text-[12px] font-medium text-ink-secondary">Compose a crew from a project</div>
                  <p className="max-w-2xl text-[12.5px] leading-relaxed text-ink-secondary">
                    Choose a folder for a read-only survey of its README, dependencies, and layout. Helmryth proposes
                    a crew, but creates nothing until you confirm it.
                  </p>
                  <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                    <input
                      value={scoutFolder}
                      onChange={(event) => setScoutFolder(event.target.value)}
                      onKeyDown={(event) => event.key === "Enter" && scoutTarget && void runScout(scoutTarget)}
                      placeholder="/path/to/your/project"
                      aria-label="Project folder to scout"
                      className="min-w-0 flex-1 rounded-xl bg-raised/80 px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
                    />
                    {Boolean(window.helmryth?.pickFolder) && (
                      <button
                        onClick={() => void pickScoutFolder()}
                        disabled={scouting}
                        className="flex items-center justify-center gap-1.5 rounded-md border border-hairline bg-raised px-4 py-2.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-40"
                      >
                        <FolderOpen size={14} />
                        Browse
                      </button>
                    )}
                    <button
                      onClick={() => void runScout(scoutTarget)}
                      disabled={!scoutTarget || scouting}
                      className="flex items-center justify-center gap-1.5 rounded-md bg-accent px-4 py-2.5 text-[13px] font-medium text-white hover:bg-accent/90 disabled:opacity-40"
                    >
                      {scouting ? <Loader2 size={14} className="animate-spin" /> : <Compass size={14} />}
                      {scouting ? "Reading project…" : "Read project"}
                    </button>
                  </div>

                  {scouted && (
                    <div className="mt-6">
                      <div className="border-y border-hairline bg-raised/25 px-5 py-4">
                        <div className="text-[15px] font-semibold text-ink">{scouted.profile.name}</div>
                        {scouted.profile.summary && (
                          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{scouted.profile.summary}</p>
                        )}
                        {scouted.profile.stacks.length > 0 && (
                          <div className="mt-2.5 flex flex-wrap gap-1.5">
                            {scouted.profile.stacks.map((stack) => (
                              <span key={stack} className="rounded-full bg-raised px-2.5 py-1 text-[11.5px] text-ink-secondary">
                                {stack}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="mt-5 text-[12px] font-medium text-ink-secondary">Suggested crew</div>
                      <div className="mt-1 max-w-[800px] border-t border-hairline/35">
                        {projectScoutOperators(scouted).map((member, index) => (
                          <div key={member.key} className="flex min-h-[64px] items-center gap-3 border-b border-hairline/35 px-1 py-3">
                            <OperatorGlyph index={index} />
                            <div className="min-w-0">
                              <div className="truncate text-[14px] font-medium text-ink">
                                {member.name} <span className="font-normal text-ink-secondary">· {member.title}</span>
                              </div>
                              <div className="mt-0.5 truncate text-[12px] text-ink-secondary">
                                {scouted.suggestion.reasons[member.key] ?? ""}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>

                      {directory && directory.length > 0 && (
                        <>
                          <div className="mt-5 text-[12px] font-medium text-ink-secondary">Optional operators from the directory</div>
                          <div className="mt-1 flex flex-col">
                            {directory.map((candidate) => (
                              <div key={candidate.slug} className="flex items-center gap-3 border-b border-hairline/35 px-1 py-3">
                                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                                  <input
                                    type="checkbox"
                                    checked={pickedDirectory.has(candidate.slug)}
                                    onChange={() =>
                                      setPickedDirectory((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(candidate.slug)) next.delete(candidate.slug);
                                        else next.add(candidate.slug);
                                        return next;
                                      })
                                    }
                                    className="size-4 accent-accent"
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-[13.5px] font-medium text-ink">
                                      {candidate.name}
                                      {candidate.category && <span className="font-normal text-ink-secondary"> · {candidate.category}</span>}
                                    </div>
                                    <div className="mt-0.5 truncate text-[12px] text-ink-secondary">
                                      Matches {candidate.matched.join(", ")}
                                    </div>
                                  </div>
                                </label>
                              </div>
                            ))}
                          </div>
                        </>
                      )}

                      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
                        <input
                          value={roomName}
                          onChange={(event) => setRoomName(event.target.value)}
                          aria-label="Project crew name"
                          className="min-w-0 flex-1 rounded-xl bg-raised/80 px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
                        />
                        <button
                          onClick={() => void createProject()}
                          disabled={creating}
                          className="flex shrink-0 items-center justify-center gap-2 rounded-md bg-accent px-5 py-2.5 text-[13.5px] font-medium text-white hover:bg-accent/90 disabled:opacity-60"
                        >
                          {creating && <Loader2 size={15} className="animate-spin" />}
                          {creating ? "Assembling…" : "Assemble project crew"}
                        </button>
                      </div>
                      <p className="mt-2 text-[12px] text-ink-secondary">
                        Creates new operators, assembles their crew, and gives the crew this folder as its working context.
                      </p>
                    </div>
                  )}
                  {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
