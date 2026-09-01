// Workstream records use GFM for durable, document-like output: tables, task
// lists, references, and source plates with copy controls and lazy highlighting.
// Generated output never reaches the DOM as raw
// HTML: no rehype-raw, so HTML in the text renders as text; Shiki's output is
// generator-escaped. While a record is still streaming, a code block renders
// as plain <pre> until its content has held still for STREAM_SETTLE_MS (the
// fence is very likely complete), then highlights and caches — so the settled
// record, a fresh component instance, mounts straight from cache instead of
// popping from plain to highlighted.
import { Children, isValidElement, memo, useEffect, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";

// A small highlight cache prevents revisiting a workstream from re-tokenizing
// blocks; keys are content-hashed and capped. Streamed partials may land here
// under their own hash — harmless (never collides with the final content's
// key, and the cap evicts it), and the final content's entry is exactly what
// makes the settled bubble render highlighted on mount.
const highlightCache = new Map<string, string>();
const CACHE_MAX = 200;
// how long a streaming block's content must be unchanged before we spend a
// tokenize on it — long enough to skip per-token churn mid-fence, short
// enough that the highlight lands before the stream settles
const STREAM_SETTLE_MS = 250;
const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

// A markdown link whose target is a file on this machine: bots hand over
// bot-created documents as absolute paths or file:// URLs. Web links stay
// ordinary anchors handled by the shell's window-open policy.
// A leading slash covers macOS and Linux; "C:\…" and "C:/…" cover Windows,
// where a file:// URL's pathname also arrives as "/C:/…".
const WINDOWS_PATH = /^[a-zA-Z]:[\\/]/;
const absolutePath = (value: string): string | null => {
  if (value.startsWith("/") && WINDOWS_PATH.test(value.slice(1))) return value.slice(1);
  if (value.startsWith("/") || WINDOWS_PATH.test(value)) return value;
  return null;
};

const localFilePath = (href?: string): string | null => {
  if (!href) return null;
  // URL schemes are case-insensitive, so FILE:// is as valid as file://
  if (/^file:\/\//i.test(href)) {
    try {
      return absolutePath(decodeURIComponent(new URL(href).pathname));
    } catch {
      return null;
    }
  }
  return absolutePath(href);
};

/** Transcript Markdown may reference only app-owned stored images. Remote,
 * data, blob, file and traversal-shaped sources never reach an <img>, so a
 * workstream cannot silently make a tracking request while it renders. */
export function markdownImageSource(src?: string): string | null {
  if (!src?.startsWith("/api/attachments/")) return null;
  let parsed: URL;
  try {
    parsed = new URL(src, "https://helmryth.invalid");
  } catch {
    return null;
  }
  if (parsed.origin !== "https://helmryth.invalid" || parsed.search || parsed.hash) return null;
  const basename = parsed.pathname.slice("/api/attachments/".length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|gif|webp)$/i.test(basename)) return null;
  return parsed.pathname;
}

function CodeBlock({ code, lang, streaming }: { code: string; lang: string; streaming: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyReset = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyReset.current) clearTimeout(copyReset.current);
  }, []);

  useEffect(() => {
    const key = `${lang}:${hash(code)}`;
    const cached = highlightCache.get(key);
    if (cached) return setHtml(cached);
    setHtml(null);
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const highlight = () => {
      import("@/lib/code-highlighter")
        .then(({ highlightCode }) => highlightCode(code, lang))
        .then((out) => {
          if (!out || !alive) return;
          if (highlightCache.size >= CACHE_MAX) {
            const first = highlightCache.keys().next().value;
            if (first) highlightCache.delete(first);
          }
          highlightCache.set(key, out);
          setHtml(out);
        })
        .catch(() => {
          /* unknown language or shiki failed — the plain <pre> stays */
        });
    };
    if (streaming) {
      // any earlier highlight is of a shorter snapshot — drop it so the
      // growing plain <pre> shows the real content, then wait for the block
      // to hold still. The effect re-runs (and this cleanup clears the timer)
      // on every content change, which is the debounce.
      setHtml(null);
      timer = setTimeout(highlight, STREAM_SETTLE_MS);
    } else {
      highlight();
    }
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [code, lang, streaming]);

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable");
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    if (copyReset.current) clearTimeout(copyReset.current);
    copyReset.current = setTimeout(() => setCopyState("idle"), 1600);
  };

  return (
    <figure className="my-3 overflow-hidden rounded-md border border-hairline/70 bg-inset/60">
      <figcaption className="flex items-center justify-between border-b border-hairline/60 bg-panel/70 px-3 py-1.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">
          Source · {lang || "Plain text"}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copyState === "copied" ? "Source copied" : copyState === "failed" ? "Source could not be copied" : "Copy source"}
          className="flex size-7 items-center justify-center rounded-sm text-ink-secondary hover:bg-raised hover:text-ink"
          title={copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy source"}
        >
          {copyState === "copied" ? <Check size={13} className="text-success" /> : <Copy size={13} />}
        </button>
        <span className="sr-only" role="status" aria-live="polite">
          {copyState === "copied" ? "Source copied to clipboard." : copyState === "failed" ? "Source could not be copied. Check clipboard permissions." : ""}
        </span>
      </figcaption>
      {html ? (
        <div
          className="overflow-x-auto text-[13px] leading-relaxed [&_code]:font-mono [&_pre]:m-0 [&_pre]:!bg-transparent [&_pre]:p-3"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto p-3 font-mono text-[13px] leading-relaxed text-ink">{code}</pre>
      )}
    </figure>
  );
}

// An operator handing over a local artifact renders as a button, not an anchor.
// Two reasons the href is dropped rather than merely preventDefault()ed:
// an absolute path in an href resolves against the page origin, so the link
// pointed at http://127.0.0.1:8799<path> and opened the workstream UI in a browser;
// and an <a href="file://…"> would still reach setWindowOpenHandler on a
// middle or modifier click, which calls shell.openExternal without the main
// process' containment check.
function LocalFileLink({ filePath, children }: { filePath: string; children?: ReactNode }) {
  const [state, setState] = useState<"idle" | "saved" | "failed">("idle");
  const [reason, setReason] = useState("");
  const [savedTo, setSavedTo] = useState("");

  const save = async () => {
    const saveFile = window.helmryth?.saveFile;
    if (!saveFile) {
      // an older shell has no save bridge; saying so beats the silent click
      // this change exists to remove
      setReason("Saving files needs a newer version of the desktop app");
      setState("failed");
      return;
    }
    try {
      const saved = await saveFile(filePath);
      // null means the user closed the save dialog, which is a decision
      // rather than a failure — say nothing
      if (!saved) return;
      setSavedTo(saved);
      setState("saved");
      setTimeout(() => setState("idle"), 4000);
    } catch (error) {
      // the bug being fixed here was a click that failed silently, so a
      // failed save says why rather than doing nothing
      setReason(error instanceof Error ? error.message : "That file could not be saved");
      setState("failed");
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void save()}
        aria-label={`Save local artifact: ${filePath}`}
        title={`Save local artifact — ${filePath}`}
        className="break-words text-left text-accent underline decoration-accent/40 hover:decoration-accent"
      >
        {children}
      </button>
      {state !== "idle" && (
        <span
          role={state === "saved" ? "status" : "alert"}
          className={`ml-1.5 text-[12px] ${state === "saved" ? "text-success" : "text-danger"}`}
        >
          {state === "saved" ? `Saved to ${savedTo}` : reason}
        </span>
      )}
    </>
  );
}

// Hidden spans: GFM parses ~~text~~ to <del>; in generated records that content
// is usually a spoiler (answers, plot points, surprises), not a deletion —
// hide it behind a tap-to-reveal chip instead of striking it through.
// Display only: the stored markdown, exports, and the model's own context
// all keep the raw ~~text~~.
function Spoiler({ children }: { children?: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  const restoreFocus = useRef(false);
  const revealRef = useRef<HTMLButtonElement>(null);
  const hideRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    (revealed ? hideRef.current : revealRef.current)?.focus();
  }, [revealed]);
  if (!revealed) {
    return (
      <span className="relative mx-px inline-block rounded px-1 py-px">
        <span
          aria-hidden="true"
          className="pointer-events-none select-none bg-raised text-transparent [&_*]:!text-transparent [&_a]:!no-underline"
        >
          {children}
        </span>
        <button
          ref={revealRef}
          type="button"
          aria-label="Reveal hidden text"
          title="Reveal hidden text"
          onClick={() => {
            restoreFocus.current = true;
            setRevealed(true);
          }}
          className="absolute inset-0 rounded bg-raised/90"
        />
      </span>
    );
  }
  return (
    <span className="mx-px inline rounded px-1 py-px text-[13px] leading-relaxed text-ink underline decoration-dotted decoration-hairline underline-offset-2">
      {children}
      <button
        ref={hideRef}
        type="button"
        aria-label="Hide revealed text"
        title="Hide revealed text"
        onClick={() => {
          restoreFocus.current = true;
          setRevealed(false);
        }}
        className="ml-1 inline-flex min-h-6 min-w-6 items-center justify-center rounded px-1 text-[11px] text-ink-secondary hover:text-ink"
      >
        Hide
      </button>
    </span>
  );
}

function WorkstreamMarkdownComponent({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="chat-md min-w-0 break-words text-[14.5px] leading-relaxed [overflow-wrap:anywhere] [&>*+*]:mt-2.5">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }: { children?: ReactNode }) {
            // fenced code arrives as <pre><code class="language-x">…</code></pre>
            const child = Children.toArray(children)[0];
            if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) {
              return <pre className="overflow-x-auto p-3 font-mono text-[13px] leading-relaxed text-ink">{children}</pre>;
            }
            const className = child.props.className ?? "";
            const lang = /language-([\w-]+)/.exec(className)?.[1] ?? "";
            const code = Children.toArray(child.props.children).join("").replace(/\n$/, "");
            return <CodeBlock code={code} lang={lang} streaming={streaming} />;
          },
          img({ src, alt }: { src?: string; alt?: string }) {
            const safeSource = markdownImageSource(src);
            if (!safeSource) {
              return (
                <span
                  role="note"
                  aria-label={`Remote image blocked${alt ? `: ${alt}` : ""}`}
                  className="my-2 inline-flex max-w-full items-center border border-hairline bg-inset px-3 py-2 text-[12px] text-ink-secondary"
                >
                  Remote image blocked{alt ? ` · ${alt}` : ""}
                </span>
              );
            }
            return (
              <img
                src={safeSource}
                alt={alt ?? ""}
                loading="lazy"
                referrerPolicy="no-referrer"
                className="max-h-96 max-w-full rounded-md border border-hairline/60"
              />
            );
          },
          code({ children }: { children?: ReactNode }) {
            return (
              <code className="max-w-full break-words rounded-sm border border-hairline/40 bg-inset px-1 py-px font-mono text-[13px] [overflow-wrap:anywhere]">{children}</code>
            );
          },
          a({ href, children }: { href?: string; children?: ReactNode }) {
            const localPath = localFilePath(href);
            if (localPath) return <LocalFileLink filePath={localPath}>{children}</LocalFileLink>;
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="break-words text-accent underline decoration-accent/40 hover:decoration-accent"
              >
                {children}
              </a>
            );
          },
          table({ children }: { children?: ReactNode }) {
            return (
              <div className="overflow-x-auto border-y border-hairline/70">
                <table className="w-full border-collapse text-[13.5px]">{children}</table>
              </div>
            );
          },
          th({ children }: { children?: ReactNode }) {
            return (
              <th className="border-b border-hairline/70 bg-inset/60 px-2 py-1.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">{children}</th>
            );
          },
          td({ children }: { children?: ReactNode }) {
            return <td className="border-b border-hairline/40 px-2 py-1.5 align-top">{children}</td>;
          },
          ul({ children }: { children?: ReactNode }) {
            return <ul className="list-disc space-y-1 pl-5">{children}</ul>;
          },
          ol({ children }: { children?: ReactNode }) {
            return <ol className="list-decimal space-y-1 pl-5">{children}</ol>;
          },
          h1({ children }: { children?: ReactNode }) {
            return <h1 className="mt-3 border-b border-hairline/60 pb-1 text-[17px] font-semibold tracking-[-0.02em]">{children}</h1>;
          },
          h2({ children }: { children?: ReactNode }) {
            return <h2 className="mt-3 border-b border-hairline/50 pb-1 text-[16px] font-semibold tracking-[-0.015em]">{children}</h2>;
          },
          h3({ children }: { children?: ReactNode }) {
            return <h3 className="mt-2 text-[15px] font-semibold">{children}</h3>;
          },
          h4({ children }: { children?: ReactNode }) {
            return <h4 className="mt-2 text-[14.5px] font-semibold">{children}</h4>;
          },
          h5({ children }: { children?: ReactNode }) {
            return <h5 className="mt-2 text-[13px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">{children}</h5>;
          },
          h6({ children }: { children?: ReactNode }) {
            return <h6 className="mt-2 text-[12px] font-semibold uppercase tracking-[0.075em] text-ink-secondary">{children}</h6>;
          },
          blockquote({ children }: { children?: ReactNode }) {
            return (
              <blockquote className="border-l-2 border-accent bg-inset/45 py-1 pl-3 pr-2 text-ink-secondary">{children}</blockquote>
            );
          },
          del({ children }: { children?: ReactNode }) {
            return <Spoiler>{children}</Spoiler>;
          },
          hr() {
            return <hr className="my-3 border-hairline/70" />;
          },
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

// Keep the established export while callers migrate independently.
export const ChatMarkdown = memo(WorkstreamMarkdownComponent);
