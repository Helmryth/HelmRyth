// Image attachments: pasted/dropped images become files under
// ~/.helmryth/attachments so every CLI engine can open them by path —
// the app never ships image bytes through the prompt itself.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { DATA_DIR } from "./config.ts";

export const ATTACHMENTS_DIR = join(DATA_DIR, "attachments");

/** `saveImage` is the only producer.  Keep deletion narrower than the read
 * route: a transcript can contain arbitrary file paths, but only generated
 * UUID image names are ever app-owned attachment candidates. */
const GENERATED_ATTACHMENT_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|gif|webp)$/i;

/** The spec's ceiling: a screenshot bigger than this is rejected before it
 * is ever buffered, matching the composer's existing size discipline. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Mimes the endpoint accepts, mapped to the extension stored on disk.
 * Sniffing is not attempted — a lie here only changes the filename. */
const IMAGE_MIMES = new Map<string, string>([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
]);

export function extensionForMime(mime: string | undefined): string | null {
  if (!mime) return null;
  return IMAGE_MIMES.get(mime.split(";")[0]!.trim().toLowerCase()) ?? null;
}

export function ensureAttachmentsDir(): void {
  mkdirSync(ATTACHMENTS_DIR, { recursive: true, mode: 0o700 });
}

export interface SavedAttachment {
  path: string;
  mime: string;
  bytes: number;
}

/** Persist one image and return its path. The UUID filename means the name
 * is never attacker-controlled and never collides; the extension preserves
 * the format the sender claimed. */
export function saveImage(bytes: Buffer, mime: string): SavedAttachment {
  const ext = extensionForMime(mime);
  if (!ext) throw Object.assign(new Error("unsupported image type"), { status: 400 });
  if (bytes.byteLength === 0) throw Object.assign(new Error("empty image"), { status: 400 });
  if (bytes.byteLength > IMAGE_MAX_BYTES) {
    throw Object.assign(new Error(`image exceeds ${IMAGE_MAX_BYTES} bytes`), { status: 413 });
  }
  ensureAttachmentsDir();
  const name = `${randomUUID()}${ext}`;
  const path = join(ATTACHMENTS_DIR, name);
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  return { path, mime: mime.split(";")[0]!.trim().toLowerCase(), bytes: bytes.byteLength };
}

/** Existence check with the same name discipline as readAttachment, without
 * reading up to 10MB of pixels just to learn the file is there. */
export function attachmentExists(name: string): boolean {
  if (!/^[A-Za-z0-9-]+\.(png|jpg|gif|webp)$/.test(name)) return false;
  try {
    return statSync(join(ATTACHMENTS_DIR, name)).isFile();
  } catch {
    return false;
  }
}

/** Return a generated app-owned filename, or null.  This is intentionally
 * stricter than `attachmentExists`: callers use it before unlinking, so an
 * external path or a hand-written file in the attachments directory can
 * never be reclaimed by transcript cleanup. */
export function appOwnedAttachmentName(value: string): string | null {
  return GENERATED_ATTACHMENT_NAME.test(value) ? value : null;
}

/** Extract only app-owned image candidates from the transcript's image tags
 * and rendered same-origin image links.  A basename alone is never enough:
 * arbitrary attached files may share an image extension, and must remain. */
export function transcriptAttachmentCandidates(text: string | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  const addPath = (raw: string) => {
    let decoded = raw
      .replaceAll("&quot;", '"')
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // A malformed percent sequence is transcript text, not a filesystem
      // address.  Leave it alone.
    }
    const name = decoded.split(/[\\/]/).at(-1) ?? "";
    const safe = appOwnedAttachmentName(name);
    // A coincidentally UUID-shaped external file path is never ours. Resolve
    // only for lexical containment; deletion later uses a generated basename
    // and does not follow a target path from the transcript.
    if (safe && resolve(decoded) === join(resolve(ATTACHMENTS_DIR), safe)) found.add(safe);
  };
  const addUrlName = (raw: string) => {
    let decoded = raw;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {}
    const safe = appOwnedAttachmentName(decoded);
    if (safe) found.add(safe);
  };
  for (const match of text.matchAll(/<attached-image\s+path="([^"]*)"\s*\/?>(?:\s*\n)?/gi)) addPath(match[1]!);
  for (const match of text.matchAll(/\/api\/attachments\/([A-Za-z0-9_.%-]+)/g)) addUrlName(match[1]!);
  return [...found];
}

/** Remove one generated attachment by basename.  `unlink` operates on the
 * terminal directory entry (including a malicious symlink) and never follows
 * it; the strict name check prevents directory traversal. */
export function removeAppOwnedAttachment(name: string): boolean {
  const safe = appOwnedAttachmentName(name);
  if (!safe) return false;
  try {
    unlinkSync(join(ATTACHMENTS_DIR, safe));
    return true;
  } catch (error) {
    // A prior pass may already have removed it. Anything else is a genuine
    // cleanup fault and must keep the erasure journal pending.
    // SAFETY: Node filesystem errors expose the documented optional errno code.
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Read an attachment back for serving. Only names that are exactly a bare
 * filename (no separators, no dotfiles) inside ATTACHMENTS_DIR resolve —
 * the route must never become a general file server for the data dir. */
export function readAttachment(name: string): { bytes: Buffer; mime: string } | null {
  if (!/^[A-Za-z0-9-]+\.(png|jpg|jpeg|gif|webp)$/.test(name)) return null;
  const path = join(ATTACHMENTS_DIR, name);
  if (extname(path) === ".jpeg") return null; // saved as .jpg; .jpeg is not a name we write
  try {
    return { bytes: readFileSync(path), mime: mimeForExt(extname(path)) };
  } catch {
    return null;
  }
}

function mimeForExt(ext: string): string {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}
