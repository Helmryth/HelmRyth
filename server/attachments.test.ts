// attachments.ts: save + read-back, the mime allowlist, size ceiling, and
// the name-lock that keeps the serving route inside the attachments dir.
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The module reads DATA_DIR at import time, so the env var must be set
// before the import is evaluated.
const DATA_ROOT = mkdtempSync(join(tmpdir(), "hry-attachments-"));
process.env.HELMRYTH_DATA_DIR = join(DATA_ROOT, "data");

const {
  ATTACHMENTS_DIR,
  IMAGE_MAX_BYTES,
  appOwnedAttachmentName,
  extensionForMime,
  readAttachment,
  removeAppOwnedAttachment,
  saveImage,
  transcriptAttachmentCandidates,
} = await import("./attachments.ts");

describe("extensionForMime", () => {
  it("maps the accepted image mimes to extensions", () => {
    expect(extensionForMime("image/png")).toBe(".png");
    expect(extensionForMime("image/jpeg")).toBe(".jpg");
    expect(extensionForMime("image/gif")).toBe(".gif");
    expect(extensionForMime("image/webp")).toBe(".webp");
  });

  it("tolerates parameters and casing", () => {
    expect(extensionForMime("Image/PNG; charset=binary")).toBe(".png");
    expect(extensionForMime("  image/webp  ")).toBe(".webp");
  });

  it("refuses everything else — including svg, which executes script", () => {
    expect(extensionForMime("image/svg+xml")).toBeNull();
    expect(extensionForMime("text/plain")).toBeNull();
    expect(extensionForMime(undefined)).toBeNull();
  });
});

describe("saveImage", () => {
  beforeEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });

  it("persists bytes under the attachments dir with a generated name", () => {
    const saved = saveImage(Buffer.from("png-bytes"), "image/png");
    expect(saved.path.startsWith(ATTACHMENTS_DIR)).toBe(true);
    expect(saved.path.endsWith(".png")).toBe(true);
    expect(saved.bytes).toBe(9);
    expect(saved.mime).toBe("image/png");
    if (process.platform !== "win32") {
      expect(statSync(ATTACHMENTS_DIR).mode & 0o777).toBe(0o700);
      expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    }
  });

  it("round-trips through readAttachment with the right mime", () => {
    const saved = saveImage(Buffer.from("gif!"), "image/gif");
    const name = saved.path.split(/[\\/]/).pop()!;
    const back = readAttachment(name);
    expect(back?.bytes.toString()).toBe("gif!");
    expect(back?.mime).toBe("image/gif");
  });

  it("rejects unsupported mimes, empty bodies, and oversize bodies", () => {
    expect(() => saveImage(Buffer.from("x"), "image/svg+xml")).toThrow(/unsupported image type/);
    expect(() => saveImage(Buffer.alloc(0), "image/png")).toThrow(/empty/);
    expect(() => saveImage(Buffer.alloc(IMAGE_MAX_BYTES + 1), "image/png")).toThrow(/exceeds/);
  });
});

describe("readAttachment name lock", () => {
  beforeEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });

  it("refuses traversal, dotfiles, and names the saver never writes", () => {
    expect(readAttachment("..%2F..%2Fconfig.json")).toBeNull();
    expect(readAttachment(".env")).toBeNull();
    expect(readAttachment("a/b.png")).toBeNull();
    expect(readAttachment("no-extension")).toBeNull();
    expect(readAttachment("uuid.jpeg")).toBeNull(); // saved as .jpg
  });
});

describe("transcript ownership and unlink boundary", () => {
  const uuid = "123e4567-e89b-42d3-a456-426614174000";
  const name = `${uuid}.png`;

  beforeEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });

  it("extracts only generated images owned by this app, never arbitrary external paths", () => {
    expect(appOwnedAttachmentName(name)).toBe(name);
    expect(appOwnedAttachmentName("avatar.png")).toBeNull();
    expect(appOwnedAttachmentName("../x.png")).toBeNull();
    expect(transcriptAttachmentCandidates([
      `<attached-image path="${ATTACHMENTS_DIR}/${name}" />`,
      `<attached-image path="/tmp/${name}" />`,
      `<attached-image path="${ATTACHMENTS_DIR}/../../config.json" />`,
      `![shown](/api/attachments/${name})`,
      `![bad](/api/attachments/../../config.json)`,
    ].join("\n"))).toEqual([name]);
  });

  it("unlinks only a generated basename within the app attachment directory", () => {
    const saved = saveImage(Buffer.from("owned"), "image/png");
    const savedName = saved.path.split(/[\\/]/).pop()!;
    expect(removeAppOwnedAttachment("../config.json")).toBe(false);
    expect(existsSync(saved.path)).toBe(true);
    expect(removeAppOwnedAttachment(savedName)).toBe(true);
    expect(existsSync(saved.path)).toBe(false);
    expect(removeAppOwnedAttachment(savedName)).toBe(false);
  });

  it("surfaces non-ENOENT unlink failures so the erasure journal can retry", () => {
    const generatedDirectory = join(ATTACHMENTS_DIR, name);
    mkdirSync(generatedDirectory, { recursive: true });
    expect(() => removeAppOwnedAttachment(name)).toThrow();
  });
});
