// Chips for what is attached to the next message, plus the window-wide
// file drop that creates them. A long paste collapses into a card of its
// first lines instead of flooding the composer; a file dropped anywhere
// on the window attaches by path.
import { useEffect, useRef, useState } from "react";
import {
  ClipboardPaste,
  File as FileIcon,
  Image as ImageIcon,
  ImageOff,
  MessageSquareText,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import {
  attachmentImageUrl,
  intakeFiles,
  formatSize,
  imageAttachmentFromFile,
  pasteSummary,
  type Attachment,
  type PasteAttachment,
} from "@/lib/composer-attachments";
import { AttachmentPreviewDialog, previewImage, type PreviewImage } from "./AttachmentPreview";

/** Electron 32 removed File.path — only the preload can name a file. */
export function pathForFile(file: File): string {
  return window.helmryth?.getPathForFile?.(file) ?? "";
}

/** Renders pending attachments and their composer actions. */
export function ComposerAttachments({
  items,
  onAdd,
  onRemove,
  onDisplayInChatBox,
  allowImages = true,
  notice,
  onNotice,
}: {
  items: Attachment[];
  onAdd: (attachments: Attachment[]) => void;
  onRemove: (id: string) => void;
  onDisplayInChatBox: (attachment: PasteAttachment) => void;
  allowImages?: boolean;
  notice: string | null;
  onNotice: (notice: string | null) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<PreviewImage | null>(null);
  // dragenter/dragleave fire once per element crossed, so the overlay
  // tracks depth rather than the last event it happened to see
  const depth = useRef(0);

  useEffect(() => {
    let active = true;
    const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const onEnter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current += 1;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    // without preventDefault the window navigates to the dropped file and
    // the app is simply gone
    const onOver = (e: DragEvent) => {
      if (carriesFiles(e)) e.preventDefault();
    };
    const onDrop = async (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      // Same intake the attach button uses: a dropped file and a picked one
      // must not appear in a different order.
      const { attachments, notice: message } = await intakeFiles(files, {
        allowImages,
        getPath: pathForFile,
        uploadImage: imageAttachmentFromFile,
      });
      if (!active) return;
      if (attachments.length) onAdd(attachments);
      // Only a failure changes the notice. This keeps a concurrent successful
      // intake from clearing an error before the user can read it.
      if (message) onNotice(message);
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      active = false;
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [onAdd, allowImages, onNotice]);

  return (
    <>
      {dragging && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-app/90 p-10"
          role="status"
          aria-live="assertive"
        >
          <div className="max-w-md rounded-md border-2 border-dashed border-accent bg-panel px-8 py-6 text-left shadow-lg">
            <div className="text-[11px] font-semibold uppercase tracking-[0.075em] text-accent-text">Artifact intake</div>
            <div className="mt-2 text-[15px] font-medium text-ink">Drop files into this run</div>
            <p className="mt-1 text-[12px] leading-5 text-ink-secondary">
              Helmryth keeps local files in place and gives the selected operator their paths.
            </p>
          </div>
        </div>
      )}

      {notice && (
        <div
          className="mb-2 flex items-start gap-2 rounded-sm border-l-2 border-warning bg-raised px-3 py-2 text-[12px] text-ink"
          role="alert"
        >
          <span className="min-w-0 flex-1">{notice}</span>
          <button
            type="button"
            onClick={() => onNotice(null)}
            aria-label="Dismiss artifact notice"
            className="shrink-0 rounded-sm p-0.5 text-ink-secondary hover:bg-control hover:text-ink"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}

      {items.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2" role="list" aria-label="Artifacts prepared for this run">
          {items.map((a) =>
            a.kind === "paste" ? (
              <Chip
                key={a.id}
                label="EXCERPT"
                title="Pasted text excerpt"
                removeLabel="pasted excerpt"
                onRemove={() => onRemove(a.id)}
              >
                <div className="relative h-[76px] overflow-hidden">
                  <pre className="whitespace-pre-wrap break-words font-sans text-[10.5px] leading-[1.45] text-ink-secondary">
                    {a.text.slice(0, 400)}
                  </pre>
                </div>
                <div className="mt-1 text-[10.5px] text-ink-secondary/70">{pasteSummary(a)}</div>
                <button
                  type="button"
                  onClick={() => onDisplayInChatBox(a)}
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-sm border border-accent/40 bg-accent/5 px-2 py-1.5 text-[10.5px] font-medium text-accent-text transition-colors hover:border-accent hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
                  aria-label="Move pasted excerpt into the run editor"
                  title="Move into editor"
                >
                  <MessageSquareText size={12} aria-hidden="true" />
                  <span>Move into editor</span>
                </button>
              </Chip>
            ) : a.kind === "image" ? (
              <Chip
                key={a.id}
                label="IMAGE"
                title={a.name}
                removeLabel={a.name}
                onRemove={() => onRemove(a.id)}
              >
                <PendingImage attachment={a} onPreview={setPreview} />
                <div className="mt-1 truncate text-[10.5px] text-ink-secondary/70">{formatSize(a.size)}</div>
              </Chip>
            ) : (
              <Chip
                key={a.id}
                label="FILE"
                title={a.path}
                removeLabel={a.name}
                onRemove={() => onRemove(a.id)}
              >
                <div className="flex h-[76px] items-center gap-2">
                  <FileIcon size={16} className="shrink-0 text-ink-secondary" />
                  <div className="min-w-0">
                    <div className="truncate text-[12px] text-ink">{a.name}</div>
                    <div className="text-[10.5px] text-ink-secondary/70">{formatSize(a.size)}</div>
                  </div>
                </div>
              </Chip>
            ),
          )}
        </div>
      )}
      {preview && <AttachmentPreviewDialog image={preview} onClose={() => setPreview(null)} />}
    </>
  );
}

function PendingImage({
  attachment,
  onPreview,
}: {
  attachment: Extract<Attachment, { kind: "image" }>;
  onPreview: (image: PreviewImage | null) => void;
}) {
  const [failed, setFailed] = useState(false);
  const src = attachmentImageUrl(attachment.path);

  if (!src || failed) {
    return (
      <div
        className="flex h-[76px] w-full items-center gap-2 rounded-sm border-l-2 border-danger bg-inset px-2 text-left"
        role="status"
      >
        <ImageOff size={16} className="shrink-0 text-danger" aria-hidden="true" />
        <span className="min-w-0 text-[10.5px] leading-4 text-ink-secondary">
          Preview unavailable. Remove this artifact or attach it again.
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onPreview(previewImage(attachment.path))}
      className="flex h-[76px] w-full items-center justify-center overflow-hidden rounded-sm bg-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
      aria-label={`Inspect ${attachment.name}`}
    >
      <img
        src={src}
        alt={`Prepared artifact: ${attachment.name}`}
        loading="lazy"
        onError={() => setFailed(true)}
        className="max-h-[76px] max-w-full object-contain"
      />
    </button>
  );
}

function Chip({
  children,
  label,
  title,
  removeLabel,
  onRemove,
}: {
  children: React.ReactNode;
  label: "EXCERPT" | "FILE" | "IMAGE";
  title: string;
  removeLabel: string;
  onRemove: () => void;
}) {
  const Icon = label === "EXCERPT" ? ClipboardPaste : label === "IMAGE" ? ImageIcon : FileIcon;
  return (
    <div
      title={title}
      role="listitem"
      className={cn(
        "group relative w-[172px] rounded-md border border-hairline/60 bg-raised px-2.5 py-2",
        "transition-colors hover:border-hairline focus-within:border-accent/60",
      )}
    >
      {children}
      <div className="mt-1 flex items-center gap-1">
        <Icon size={11} className="text-ink-secondary/70" aria-hidden="true" />
        <span className="rounded-sm border border-hairline/60 px-1 py-px text-[9.5px] font-semibold tracking-[0.075em] text-ink-secondary">
          {label}
        </span>
      </div>
      {/* hover reveals it, but so must focus: `hidden` would take the only
          way to drop a chip out of reach of the keyboard */}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${removeLabel} from this run`}
        className="absolute -right-1.5 -top-1.5 flex size-6 items-center justify-center rounded-sm border border-hairline/70 bg-panel text-ink-secondary opacity-0 shadow-sm transition-opacity hover:bg-control hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
}
