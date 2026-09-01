import { createHash } from "node:crypto";
import { z } from "zod";

import { parseJson, type JsonValue } from "./schema.ts";

/** Provider-neutral policy for deciding when a computer observation needs vision. */
export interface ObservationMetrics {
  screenshotsCaptured: number;
  screenshotsSentToModel: number;
  fullScreenObservations: number;
  croppedObservations: number;
  structuredBrowserObservations: number;
  computerActions: number;
  retries: number;
  verificationSuccesses: number;
  verificationFailures: number;
}

export interface CropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserTarget {
  id: string;
  title: string;
  /** Safe for a model or log: credentials, query, and fragment removed. */
  url: string;
  /** Internal-only comparison value. Never include this in tool output. */
  comparisonUrl: string;
}

export const emptyObservationMetrics = (): ObservationMetrics => ({
  screenshotsCaptured: 0,
  screenshotsSentToModel: 0,
  fullScreenObservations: 0,
  croppedObservations: 0,
  structuredBrowserObservations: 0,
  computerActions: 0,
  retries: 0,
  verificationSuccesses: 0,
  verificationFailures: 0,
});

const cropInputSchema = z.object({
  x: z.coerce.number(),
  y: z.coerce.number(),
  width: z.coerce.number(),
  height: z.coerce.number(),
}).passthrough();

const browserUrlInputSchema = z.string().min(1).max(8_192);
const browserTargetInputSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string().optional(),
  url: z.string(),
}).passthrough();

export function normalizeCrop(raw: JsonValue, maxWidth: number, maxHeight: number): CropRegion | null {
  const parsed = cropInputSchema.safeParse(raw);
  if (!parsed.success) return null;
  const x = Math.round(parsed.data.x);
  const y = Math.round(parsed.data.y);
  const width = Math.round(parsed.data.width);
  const height = Math.round(parsed.data.height);
  if (
    ![x, y, width, height, maxWidth, maxHeight].every(Number.isFinite) ||
    maxWidth <= 0 ||
    maxHeight <= 0 ||
    x < 0 ||
    y < 0 ||
    width < 32 ||
    height < 32
  ) {
    return null;
  }
  if (x + width > maxWidth || y + height > maxHeight) return null;
  return { x, y, width, height };
}

/** Canonical value for internal navigation checks. Credentials are never
 * needed for equality and are removed here; query and fragment remain so
 * two distinct application states cannot verify as the same destination. */
export function normalizeBrowserUrl(value: JsonValue): string | null {
  const parsed = browserUrlInputSchema.safeParse(value);
  if (!parsed.success) return null;
  try {
    const url = new URL(parsed.data);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Removes credentials, query, and fragment before browser state reaches a model or log. */
export function safeBrowserUrl(value: JsonValue): string | null {
  const normalized = normalizeBrowserUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  url.search = "";
  url.hash = "";
  const safe = url.toString();
  return safe.length <= 2_048 ? safe : null;
}

/** Parses Chrome's /json/list response into a small, safe structured observation. */
export function parseBrowserTargets(raw: string): BrowserTarget[] {
  if (raw.length > 1_000_000) return [];
  try {
    const parsed = parseJson(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 20).flatMap((item) => {
      const target = browserTargetInputSchema.safeParse(item);
      if (!target.success) return [];
      const comparisonUrl = normalizeBrowserUrl(target.data.url);
      const url = safeBrowserUrl(target.data.url);
      if (target.data.type !== "page" || !url || !comparisonUrl) return [];
      const title = (target.data.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      return [{ id: target.data.id.slice(0, 100), title, url, comparisonUrl }];
    });
  } catch {
    return [];
  }
}

/**
 * Keeps observations cheap without claiming the screen is immutable. Every
 * requested observation still captures fresh pixels (pages can change without
 * an input action), while byte-identical frames are not sent to the model twice.
 */
export class ObservationCoordinator {
  metrics = emptyObservationMetrics();
  private lastObservation: string | null = null;

  noteAction(count = 1) {
    this.metrics.computerActions += Math.max(0, Math.trunc(count));
  }

  noteRetry() {
    this.metrics.retries += 1;
  }

  /** canonicalFrame must describe the full screenshot, even when the image
   * returned to the model is cropped. A box-provided full-frame hash works. */
  observeFrame(canonicalFrame: string | null, crop: CropRegion | null) {
    this.metrics.screenshotsCaptured += 1;
    const hash = canonicalFrame
      ? createHash("sha256").update(canonicalFrame).digest("hex")
      : null;
    const view = crop ? `${crop.x},${crop.y},${crop.width},${crop.height}` : "full";
    const signature = hash ? `${hash}:${view}` : null;
    // If the box cannot provide a full-frame hash, fail open and send the
    // valid image. Suppressing a possibly-new crop would be worse.
    const changed = signature === null || signature !== this.lastObservation;
    if (signature) this.lastObservation = signature;
    if (changed) {
      this.metrics.screenshotsSentToModel += 1;
      if (crop) this.metrics.croppedObservations += 1;
      else this.metrics.fullScreenObservations += 1;
    }
    return { changed, hash };
  }

  noteStructuredObservation() {
    this.metrics.structuredBrowserObservations += 1;
  }

  noteVerification(ok: boolean) {
    if (ok) this.metrics.verificationSuccesses += 1;
    else this.metrics.verificationFailures += 1;
  }
}
