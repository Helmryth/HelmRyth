import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", {
    value: {
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    configurable: true,
    writable: true,
  });
});

import {
  BubbleEditor,
  MOBILE_PRIMARY_ACTION_CLASS,
  runtimeLabel,
  workstreamContextLabel,
  workstreamScrollBehavior,
  WORKSTREAM_TITLE_CLASS,
  writeWorkstreamClipboard,
} from "./ChatView";
import { ChatFindBar, restoreWorkstreamFocus } from "./ChatFindBar";
import { markdownImageSource, ChatMarkdown } from "./ChatMarkdown";
import { COMPOSER_BACKDROP_CLASS, directMentionPool, recoverHeldGroupDirection } from "./Composer";
import {
  crewQuestionDecision,
  CrewQuestionCard,
} from "./GroupView";
import { reactionGridDestination } from "./Reactions";
import { ReplyQuote } from "./ReplyQuote";
import { PendingApprovalPanel } from "./PendingApproval";
import { SecretRequestCard } from "./SecretRequestCard";
import { StoreProvider, type Message } from "@/state/store";

const question = {
  id: "question-1",
  role: "bot",
  kind: "options",
  at: 1,
  from: { botId: "operator-1", name: "Rivet", color: "green" },
  card: {
    title: "Which release lane should move?",
    subtitle: "Choose one lane or describe a different answer.",
    options: ["Staging", "Production"],
    requestId: "request-1",
  },
} satisfies Message;

describe("Workstream clipboard acceptance", () => {
  it("does not report success until the clipboard promise settles", async () => {
    let resolveWrite = () => {};
    const pendingWrite = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const copy = writeWorkstreamClipboard("exact entry", { writeText: vi.fn(() => pendingWrite) });
    let settled = false;
    void copy.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    resolveWrite();
    await expect(copy).resolves.toBe("copied");
  });

  it("reports a denied or missing clipboard without false success", async () => {
    await expect(writeWorkstreamClipboard("entry", null)).resolves.toBe("failed");
    await expect(writeWorkstreamClipboard("entry", {
      writeText: vi.fn(() => Promise.reject(new Error("denied"))),
    })).resolves.toBe("failed");
  });
});

describe("provider failure presentation", () => {
  it("does not render provider diagnostics or model identifiers from legacy activity records", () => {
    const label = runtimeLabel("error: upstream HTTP 404: model private-preview-2026 does not exist");

    expect(label).toBe("error: This engine rejected the current run configuration. Review its engine settings, then try again.");
    expect(label).not.toMatch(/HTTP|private-preview|404/i);
  });
});

describe("crew questions", () => {
  it("builds an exact thread-scoped answer decision", () => {
    expect(crewQuestionDecision("crew-thread", question, "Production")).toEqual({
      type: "decideRequest",
      threadId: "crew-thread",
      requestId: "request-1",
      behavior: "answer",
      message: "Production",
    });
  });

  it("renders requester, prompt, choices and a labelled free-text answer", () => {
    const markup = renderToStaticMarkup(
      createElement(StoreProvider, null, createElement(CrewQuestionCard, {
        threadId: "crew-thread",
        message: question,
      })),
    );

    expect(markup).toContain("Rivet asks");
    expect(markup).toContain("Which release lane should move?");
    expect(markup).toContain("Staging");
    expect(markup).toContain("Answer in your own words");
    expect(markup).toContain('aria-live="polite"');
  });
});

describe("held direction recovery", () => {
  it("restores the complete held snapshot before clearing its send slot", () => {
    const order: string[] = [];
    recoverHeldGroupDirection({
      restore: () => order.push("restore"),
      clear: () => order.push("clear"),
    });
    expect(order).toEqual(["restore", "clear"]);
  });
});

describe("Markdown image privacy", () => {
  it("allows only same-origin stored attachments", () => {
    expect(markdownImageSource("/api/attachments/123e4567-e89b-12d3-a456-426614174000.png"))
      .toBe("/api/attachments/123e4567-e89b-12d3-a456-426614174000.png");
    expect(markdownImageSource("https://tracker.example/pixel.png")).toBeNull();
    expect(markdownImageSource("//tracker.example/pixel.png")).toBeNull();
    expect(markdownImageSource("data:image/png;base64,AAAA")).toBeNull();
    expect(markdownImageSource("/api/attachments/../../config.json")).toBeNull();
  });

  it("renders blocked remote images without an image source or tracking request", () => {
    const markup = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "![Release evidence](https://tracker.example/pixel.png)",
    }));

    expect(markup).toContain("Remote image blocked");
    expect(markup).not.toContain("tracker.example");
    expect(markup).not.toContain("<img");
  });
});

describe("keyboard, focus and compact controls", () => {
  it("restores focus through the scheduled post-unmount boundary", () => {
    const target = { focus: vi.fn() };
    const callbacks: Array<() => void> = [];
    restoreWorkstreamFocus(target, (callback) => callbacks.push(callback));

    expect(target.focus).not.toHaveBeenCalled();
    callbacks[0]?.();
    expect(target.focus).toHaveBeenCalledOnce();
  });

  it("moves through the six-column record-mark grid with arrow keys", () => {
    expect(reactionGridDestination(0, "ArrowRight", 22)).toBe(1);
    expect(reactionGridDestination(0, "ArrowLeft", 22)).toBe(21);
    expect(reactionGridDestination(2, "ArrowDown", 22)).toBe(8);
    expect(reactionGridDestination(2, "ArrowUp", 22)).toBe(18);
    expect(reactionGridDestination(2, "Escape", 22)).toBeNull();
  });

  it("renders visible editor focus and >=24px find/reply actions", () => {
    const editor = renderToStaticMarkup(createElement(BubbleEditor, {
      initial: "Original",
      onCancel: vi.fn(),
      onSubmit: vi.fn(),
    }));
    const find = renderToStaticMarkup(
      createElement(StoreProvider, null, createElement(ChatFindBar, {
        threadId: "thread-1",
        onClose: vi.fn(),
      })),
    );
    const reply = renderToStaticMarkup(createElement(ReplyQuote, {
      message: { id: "m1", role: "user", kind: "text", text: "Quoted", at: 1 },
      onClear: vi.fn(),
    }));

    expect(editor).toContain("focus:ring-2");
    expect(find.match(/size-7/g)?.length).toBe(3);
    expect(reply).toContain("size-7");
  });

  it("uses instant scrolling when reduced motion is requested", () => {
    expect(workstreamScrollBehavior({ matches: true })).toBe("auto");
    expect(workstreamScrollBehavior({ matches: false })).toBe("smooth");
  });

  it("keeps complete current-workstream identity behind a clipped mobile label", () => {
    const longTitle = "Release qualification with a deliberately long customer-visible title";

    expect(workstreamContextLabel(longTitle)).toEqual({
      visible: `Workstream · ${longTitle}`,
      accessible: `Current workstream: ${longTitle}`,
    });
    expect(workstreamContextLabel()).toEqual({
      visible: "Workstream · Untitled workstream",
      accessible: "Current workstream: Untitled workstream",
    });
  });

  it("keeps primary mobile rail actions at 44px while preserving desktop geometry", () => {
    const classes = MOBILE_PRIMARY_ACTION_CLASS.split(" ");

    expect(classes).toEqual(expect.arrayContaining(["size-11", "md:size-auto", "md:p-2"]));
  });

  it("covers the mobile composer gutter without increasing viewport width", () => {
    const classes = COMPOSER_BACKDROP_CLASS.split(" ");

    expect(classes).toEqual(expect.arrayContaining(["-left-3", "-right-3", "sm:-left-5", "sm:-right-5"]));
    expect(classes.filter((name) => name === "-left-5" || name === "-right-5")).toHaveLength(0);
  });
});

describe("Gate accessibility associations", () => {
  it("announces a newly waiting gate without moving focus", () => {
    const gateMessage = {
      id: "gate-1",
      role: "bot",
      kind: "options",
      at: 1,
      card: {
        title: "Permission needed",
        subtitle: "git status",
        options: ["Allow", "Deny"],
        requestId: "request-gate",
        tool: "Bash",
      },
    } satisfies Message;
    const markup = renderToStaticMarkup(createElement(PendingApprovalPanel, {
      pending: {
        message: gateMessage,
        requestId: "request-gate",
        tool: "Bash",
        detail: "git status",
      },
      count: 1,
      index: 0,
    }));
    expect(markup).toContain("Gate waiting. Active operator needs a decision.");
    expect(markup).toContain('aria-live="polite"');
  });

  it("associates the local-only credential assurance with the secret input", () => {
    const secretMessage = {
      id: "secret-1",
      role: "bot",
      kind: "secret",
      at: 1,
      secret: {
        target: "boxToken",
        label: "Project key",
        description: "Connect the workspace",
        placeholder: "ak_…",
        helpUrl: "https://example.test/help",
        requestKey: "request-secret",
      },
    } satisfies Message;
    const markup = renderToStaticMarkup(
      createElement(StoreProvider, null, createElement(SecretRequestCard, {
        botId: "operator-1",
        threadId: "thread-1",
        message: secretMessage,
      })),
    );
    expect(markup).toMatch(/aria-describedby="credential-gate-secret-1-description credential-gate-secret-1-assurance"/);
    expect(markup).toContain('id="credential-gate-secret-1-assurance"');
  });
});

describe("Workstream header target size", () => {
  it("keeps the operator-name control above the WCAG 2.5.8 floor", () => {
    // The name button opened the operator profile at 39x23 CSS px — one pixel
    // under the 24px minimum, because it inherited its height from the line box.
    const classes = WORKSTREAM_TITLE_CLASS.split(" ");
    expect(classes).toContain("min-h-6");
    // min-height does nothing on a purely inline box.
    expect(classes).toContain("inline-block");
  });
});

describe("1:1 @mention pool", () => {
  const rivet = { id: "op-1", name: "Rivet", section: "Release" };
  const scout = { id: "op-2", name: "Scout", section: "Release" };
  const outsider = { id: "op-3", name: "Outsider", section: "Research" };
  const archived = { id: "op-4", name: "Archived", section: "Release", hidden: true };
  const roster = [rivet, scout, outsider, archived];

  it("offers only the operators the harness will actually route to", () => {
    // The harness resolves a 1:1 tag against same-section, non-archived peers
    // (server/index.ts `sectionPeers`). Anyone else was offered, tagged, and
    // then dropped without a word.
    expect(directMentionPool(rivet, roster, true)).toEqual([scout]);
  });

  it("offers nobody when the operator's engine cannot delegate", () => {
    expect(directMentionPool(rivet, roster, false)).toEqual([]);
  });

  it("offers nobody when there is no operator to delegate from", () => {
    expect(directMentionPool(undefined, roster, true)).toEqual([]);
  });

  it("treats a blank section and no section as the same section", () => {
    const unfiled = { id: "op-5", name: "Unfiled" };
    const blank = { id: "op-6", name: "Blank", section: "  " };
    expect(directMentionPool(unfiled, [unfiled, blank, rivet], true)).toEqual([blank]);
  });
});
