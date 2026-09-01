// Turning the inspector's two record shapes into one-line summaries. Pure
// so the panel stays a thin renderer and the labels can be tested.
import type { RuntimeEvent } from "../../server/contracts.ts";
import type { InspectorEntry, NativeRecord } from "../../server/thread-events.ts";
import { z } from "zod";
import { presentRuntimeError } from "../../shared/runtime-error";
export type { InspectorEntry, InspectorPage, NativeRecord } from "../../server/thread-events.ts";

interface FoldPreview {
  text: string;
  pendingSpace: boolean;
  overflow: boolean;
}

/** A row in the panel: adjacent content.delta events fold into one so a
 * streamed paragraph is one line, not three hundred. */
export interface InspectorRow {
  key: string;
  kind: "runtime" | "native";
  at: string;
  /** short badge — the event type, or in/out for native */
  tag: string;
  /** what happened, in one line */
  summary: string;
  /** visual weight: a turn boundary, a failure, or plain */
  tone: "boundary" | "error" | "plain";
  /** the record(s) behind the row, for the expanded view */
  data: NativeRecord | RuntimeEvent | RuntimeEvent[];
  /** > 1 when deltas were folded */
  count: number;
  /** bounded, incrementally normalized preview for a folded delta run */
  preview?: FoldPreview;
}

interface RuntimeSummary {
  summary: string;
  tone: InspectorRow["tone"];
}

const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const FOLD_PREVIEW_CHARS = 119;
const traceType = (value: string) => value === "assistant_text" ? "operator_text" : value;
const traceEventTag = (value: string) => value.startsWith("turn.") ? `run.${value.slice("turn.".length)}` : value;

function appendPreview(previous: FoldPreview | undefined, delta: string): FoldPreview {
  const next: FoldPreview = previous ? { ...previous } : { text: "", pendingSpace: false, overflow: false };
  if (next.overflow) return next;
  for (const char of delta) {
    if (/\s/.test(char)) {
      if (next.text) next.pendingSpace = true;
      continue;
    }
    if (next.pendingSpace) {
      if (next.text.length >= FOLD_PREVIEW_CHARS) {
        next.overflow = true;
        break;
      }
      next.text += " ";
      next.pendingSpace = false;
    }
    if (next.text.length >= FOLD_PREVIEW_CHARS) {
      next.overflow = true;
      break;
    }
    next.text += char;
  }
  return next;
}

const previewText = (preview: FoldPreview) => `${preview.text}${preview.overflow ? "…" : ""}`;

export function summarizeRuntime(e: RuntimeEvent): RuntimeSummary {
  switch (e.type) {
    case "session.started":
      // Session ids and configured model identifiers belong in the explicit
      // technical expansion, not in the always-visible Trace scan line.
      return { summary: "engine session started", tone: "plain" };
    case "session.exited":
      // Exit reasons can carry provider HTTP text, endpoints, or model ids.
      // Preserve the complete event in row.data while keeping the collapsed
      // surface non-reflective.
      return { summary: "engine session ended", tone: "plain" };
    case "turn.started":
      return { summary: `run started${e.turnId ? ` · ${e.turnId.slice(0, 8)}` : ""}`, tone: "boundary" };
    case "turn.retrying":
      return { summary: `run retry · ${e.reason} · attempt ${e.attempt} · ${Math.round(e.delayMs / 1000)}s`, tone: "plain" };
    case "turn.completed": {
      const parts = [e.ok ? "run completed" : "run failed"];
      if (e.stopReason) parts.push(e.stopReason);
      if (e.cost !== null && e.cost !== undefined) parts.push(`$${e.cost.toFixed(4)}`);
      if (e.denials?.length) parts.push(`${e.denials.length} denied`);
      return { summary: parts.join(" · "), tone: e.ok ? "boundary" : "error" };
    }
    case "item.started":
      return { summary: `${traceType(e.itemType)}${e.title ? `: ${clip(oneLine(e.title))}` : " started"}`, tone: "plain" };
    case "item.updated":
      return { summary: `${traceType(e.itemType)} updated${e.tokens !== null && e.tokens !== undefined ? ` · ${e.tokens} tok` : ""}`, tone: "plain" };
    case "item.completed":
      if (e.itemType === "assistant_text") return { summary: `operator: ${clip(oneLine(e.text))}`, tone: "plain" };
      return { summary: `tool ${e.ok ? "ok" : "failed"}`, tone: e.ok ? "plain" : "error" };
    case "content.delta":
      return { summary: `${traceType(e.streamKind)}: ${clip(oneLine(e.delta))}`, tone: "plain" };
    case "request.opened":
      return { summary: `${e.requestType}: ${e.tool} — ${clip(oneLine(e.summary))}`, tone: "plain" };
    case "request.resolved":
      return { summary: `resolved ${e.behavior} · ${e.source}`, tone: "plain" };
    case "thread.token-usage.updated":
      return { summary: `tokens in ${e.input} · out ${e.output}`, tone: "plain" };
    case "runtime.error":
      // Keep the diagnostic in row.data for an explicit technical expand,
      // while the scannable Trace surface follows the same safe UI contract
      // as workstreams and roster previews.
      return { summary: presentRuntimeError(e.message, e.setup).message, tone: "error" };
  }
}

const nativeMessageSchema = z.object({
  method: z.string().optional(),
  type: z.string().optional(),
  id: z.json().optional(),
  // Claude's `stream_event` frames carry an OBJECT here while antigravity's
  // carry a string. Typing this as a string made the whole record fail to
  // parse, so every Claude stream frame fell through to String(msg) and the
  // Trace's Provider lens rendered a wall of "[object Object]".
  event: z.json().optional(),
  result: z.json().optional(),
  error: z.json().optional(),
  message: z.json().optional(),
  subtype: z.string().optional(),
}).passthrough();

/** antigravity names its stream frames with a string here; Claude's
 * `stream_event` frames carry an object. Parsing for the string form is what
 * decides the branch — the shape is a contract, not a runtime guess. */
const eventNameSchema = z.string().min(1);
const nativeResultSchema = z.object({ status: z.string().optional() }).passthrough();
const nativeInnerMessageSchema = z.object({ role: z.string().optional() }).passthrough();

export function summarizeNative(r: NativeRecord): string {
  const parsed = nativeMessageSchema.safeParse(r.msg);
  if (!parsed.success) return String(r.msg);
  const msg = parsed.data;
  const method = msg.method;
  const type = msg.type;
  const id = msg.id !== undefined ? ` #${String(msg.id)}` : "";
  if (method) return `${method}${id}`;
  // antigravity's stream keys on `event` with a STRING name and the outcome
  // under result.status. Anything else belongs to the `type` branch below,
  // which knows how to label it.
  const eventName = eventNameSchema.safeParse(msg.event);
  if (eventName.success) {
    const result = nativeResultSchema.safeParse(msg.result);
    return result.success && result.data.status
      ? `${eventName.data} · ${result.data.status}`
      : eventName.data;
  }
  if (type) {
    // claude stream-json: surface the role/subtype so a user turn and an
    // assistant chunk don't both read as "message"
    const inner = nativeInnerMessageSchema.safeParse(msg.message);
    const role = inner.success && inner.data.role ? ` · ${inner.data.role}` : "";
    const subtype = msg.subtype ? ` · ${msg.subtype}` : "";
    return `${type}${subtype}${role}`;
  }
  if (msg.result !== undefined) return `result${id}`;
  if (msg.error !== undefined) return `error${id}`;
  return clip(oneLine(JSON.stringify(msg)));
}

/** Entries → rows, folding runs of content.delta on the same stream. */
export function toRows(entries: InspectorEntry[]): InspectorRow[] {
  const rows: InspectorRow[] = [];
  for (const [i, entry] of entries.entries()) {
    if (entry.kind === "native") {
      rows.push({
        key: `n${i}`,
        kind: "native",
        at: entry.at,
        tag: entry.data.dir === "out" ? "→ out" : "← in",
        summary: `${entry.data.source} · ${summarizeNative(entry.data)}`,
        tone: "plain",
        data: entry.data,
        count: 1,
      });
      continue;
    }
    const e = entry.data;
    const last = rows.at(-1);
    const previousEvents = last && Array.isArray(last.data) ? last.data : null;
    if (
      e.type === "content.delta" &&
      last?.kind === "runtime" &&
      last.tag === "content.delta" &&
      previousEvents?.[0]?.type === "content.delta" &&
      previousEvents[0].streamKind === e.streamKind
    ) {
      previousEvents.push(e);
      last.count = previousEvents.length;
      last.preview = appendPreview(last.preview, e.delta);
      last.summary = `${traceType(e.streamKind)}: ${previewText(last.preview)}`;
      continue;
    }
    const { summary, tone } = summarizeRuntime(e);
    const preview = e.type === "content.delta" ? appendPreview(undefined, e.delta) : undefined;
    const streamKind = e.type === "content.delta" ? e.streamKind : undefined;
    rows.push({
      key: e.eventId || `r${i}`,
      kind: "runtime",
      at: entry.at,
      tag: traceEventTag(e.type),
      summary: preview && streamKind ? `${traceType(streamKind)}: ${previewText(preview)}` : summary,
      tone,
      data: e.type === "content.delta" ? [e] : e,
      count: 1,
      preview,
    });
  }
  return rows;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}
