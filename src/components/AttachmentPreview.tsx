// Same-origin image thumbnails and an in-app lightbox. Transcript text can
// contain arbitrary strings, so callers pass saved paths and this component
// resolves them through attachmentImageUrl rather than loading them as URLs.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, ImageOff, Maximize2, X } from "lucide-react";

import { attachmentBasename, attachmentImageUrl } from "@/lib/composer-attachments";
import { cn } from "@/lib/cn";

export interface PreviewImage {
  src: string;
  name: string;
}

export function previewImage(path: string): PreviewImage | null {
  const src = attachmentImageUrl(path);
  if (!src) return null;
  return { src, name: attachmentBasename(path) };
}

export function AttachmentPreviewDialog({ image, onClose }: { image: PreviewImage; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const [failed, setFailed] = useState(false);
  const descriptionId = useId();

  useLayoutEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => setFailed(false), [image.src]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === dialog || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Next frame, not now: a synchronous focus() here lands while the dialog is
      // still being torn down and the browser discards it, dropping focus to <body>.
      const target = previousFocus;
      if (target) requestAnimationFrame(() => target.focus());
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-app/95 p-3 sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${descriptionId}-title`}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="animate-pop-in flex h-full max-h-[900px] w-full max-w-[1200px] flex-col overflow-hidden rounded-md border border-hairline/70 bg-panel shadow-lg outline-none"
      >
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-hairline/50 bg-raised px-4 py-3">
          <div className="min-w-0">
            <div
              id={`${descriptionId}-title`}
              className="truncate font-display text-[14px] font-semibold text-ink"
            >
              {image.name}
            </div>
            <div id={descriptionId} className="text-[11px] text-ink-secondary">
              Local artifact · inspect before using it in a run
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <a
              href={image.src}
              download={image.name}
              className="flex size-9 items-center justify-center rounded-sm text-ink-secondary hover:bg-control hover:text-ink"
              aria-label={`Save a copy of ${image.name}`}
              title="Save a copy"
            >
              <Download size={17} />
            </a>
            <button
              type="button"
              onClick={onClose}
              className="flex size-9 items-center justify-center rounded-sm text-ink-secondary hover:bg-control hover:text-ink"
              aria-label="Close artifact preview"
              title="Close (Esc)"
            >
              <X size={19} />
            </button>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-inset p-4 sm:p-8">
          {failed ? (
            <div
              className="max-w-sm border-l-2 border-danger px-4 py-2 text-ink"
              role="status"
              aria-live="polite"
            >
              <ImageOff size={34} />
              <div className="mt-3 text-[14px] font-medium">Preview unavailable</div>
              <p className="mt-1 text-[12px] leading-5 text-ink-secondary">
                Helmryth cannot read this local artifact. It may have been moved, renamed, or removed.
              </p>
            </div>
          ) : (
            <img
              src={image.src}
              alt={`Artifact preview: ${image.name}`}
              onError={() => setFailed(true)}
              className="block max-h-full max-w-full rounded-sm border border-hairline/40 bg-raised object-contain shadow-sm"
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Thumbnail({ image, onPreview }: { image: PreviewImage; onPreview: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div
        className="flex min-h-20 w-[220px] items-center gap-3 border-l-2 border-danger bg-raised px-3 py-2 text-left"
        role="status"
        aria-label={`${image.name} preview unavailable`}
      >
        <ImageOff size={18} className="shrink-0 text-danger" aria-hidden="true" />
        <span className="min-w-0">
          <span className="block truncate text-[12px] font-medium text-ink">{image.name}</span>
          <span className="block text-[11px] text-ink-secondary">Local artifact unavailable</span>
        </span>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onPreview}
      className="group/image relative block max-w-[260px] overflow-hidden rounded-sm border border-hairline/60 bg-inset text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
      aria-label={`Open artifact preview for ${image.name}`}
      title={`Inspect ${image.name}`}
    >
      <img
        src={image.src}
        alt={`Attached artifact: ${image.name}`}
        loading="lazy"
        onError={() => setFailed(true)}
        className="block max-h-[220px] w-full object-cover transition-transform duration-200 group-hover/image:scale-[1.01] motion-reduce:transform-none"
      />
      <span className="absolute right-1.5 top-1.5 flex size-7 items-center justify-center rounded-sm border border-hairline/60 bg-raised text-ink opacity-0 shadow-sm transition-opacity group-hover/image:opacity-100 group-focus-visible/image:opacity-100">
        <Maximize2 size={13} aria-hidden="true" />
      </span>
    </button>
  );
}

export function AttachedImageGallery({ paths, className }: { paths: string[]; className?: string }) {
  const images = useMemo(() => paths.flatMap((path) => {
    const image = previewImage(path);
    return image ? [image] : [];
  }), [paths]);
  const [selected, setSelected] = useState<PreviewImage | null>(null);
  if (images.length === 0) return null;
  return (
    <>
      <ul className={cn("mb-2 flex list-none flex-wrap justify-end gap-2", className)} aria-label="Attached artifacts">
        {images.map((image, index) => (
          <li key={`${image.src}:${index}`}>
            <Thumbnail image={image} onPreview={() => setSelected(image)} />
          </li>
        ))}
      </ul>
      {selected && <AttachmentPreviewDialog image={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
