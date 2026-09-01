import { Quote, X } from "lucide-react";

import { replyAuthor, replySnippet } from "@/lib/replies";
import type { Message } from "@/state/store";

export function ReplyQuote({
  message,
  fallbackName,
  onJump,
  onClear,
  compact = false,
}: {
  message: Message;
  fallbackName?: string;
  onJump?: () => void;
  onClear?: () => void;
  compact?: boolean;
}) {
  const author = replyAuthor(message, fallbackName);
  const body = (
    <>
      <Quote size={compact ? 12 : 14} aria-hidden="true" className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1">
        <span className="block text-[10.5px] font-semibold uppercase tracking-[0.075em] text-accent">
          Quoted record · {author}
        </span>
        <span className="block truncate text-[11.5px] leading-relaxed text-ink-secondary">
          {replySnippet(message.text ?? "")}
        </span>
      </span>
    </>
  );
  return (
    <div className="flex min-w-0 items-center gap-2 border-l-2 border-accent bg-inset/55 px-2.5 py-1.5">
      {onJump ? (
        <button
          type="button"
          onClick={onJump}
          aria-label={`Open quoted record from ${author}`}
          className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-ink focus-visible:outline-none"
          title="Open quoted record"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{body}</div>
      )}
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear quoted record"
          title="Clear quoted record"
          className="flex size-7 shrink-0 items-center justify-center rounded-sm text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
