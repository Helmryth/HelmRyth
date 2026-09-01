import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgentSkillsClient, ImportedMethod } from "@/lib/agent-skills-api";
import {
  AgentSkillsPanel,
  beginMethodReviewRequest,
  canEnableImportedMethod,
  ImportedMethodCard,
  importedMethodDate,
  isCurrentMethodReviewRequest,
  methodSourceHref,
  RemoveMethodDialog,
  reconcileMethodReviews,
  type ImportedMethodCardProps,
} from "./AgentSkillsPanel";

const method: ImportedMethod = {
  name: "release-check",
  description: "Review the release boundary before shipping.",
  enabled: false,
  source: "github.com/acme/methods/release-check",
  sha256: "abc123".repeat(10) + "abcd",
  importedAt: "2026-08-30T08:00:00.000Z",
  license: "Apache-2.0",
  compatibility: "Helmryth desktop",
  warnings: ["contains a command that needs review"],
  skippedFiles: ["run.sh"],
  reviewRevision: "def456".repeat(10) + "def4",
};

const readyReview = {
  open: true,
  status: "ready",
  text: "---\nname: release-check\n---\n# Complete method",
  error: null,
  acknowledged: false,
} satisfies ImportedMethodCardProps["review"];

const callbacks = {
  onToggleReview: vi.fn(),
  onRetryReview: vi.fn(),
  onAcknowledge: vi.fn(),
  onSetEnabled: vi.fn(),
  onDelete: vi.fn(),
};

const renderCard = (review: ImportedMethodCardProps["review"]): string =>
  renderToStaticMarkup(createElement(ImportedMethodCard, {
    method,
    review,
    busy: false,
    ...callbacks,
  }));

describe("Imported methods UI", () => {
  it("shows provenance, warnings, skipped files, and the complete Markdown before enablement", () => {
    const markup = renderCard(readyReview);

    expect(markup).toContain("release-check");
    expect(markup).toContain("Apache-2.0");
    expect(markup).toContain("Helmryth desktop");
    expect(markup).toContain(method.sha256);
    expect(markup).toContain("contains a command that needs review");
    expect(markup).toContain("run.sh");
    expect(markup).toContain("# Complete method");
    expect(markup).toContain("I reviewed the complete method");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>.*Enable method/s);
  });

  it("unlocks enablement only after the full-method acknowledgement", () => {
    expect(canEnableImportedMethod(readyReview)).toBe(false);
    const acknowledged = { ...readyReview, acknowledged: true };
    expect(canEnableImportedMethod(acknowledged)).toBe(true);

    const markup = renderCard(acknowledged);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>.*Enable method/s);
    expect(markup).toContain("Enable method");
  });

  it("allows an enabled method to be disabled without another review gate", () => {
    const markup = renderToStaticMarkup(createElement(ImportedMethodCard, {
      method: {
        ...method,
        enabled: true,
        reviewedRevision: method.reviewRevision,
        reviewedAt: "2026-08-30T09:00:00.000Z",
      },
      review: { ...readyReview, open: false, acknowledged: false },
      busy: false,
      ...callbacks,
    }));
    expect(markup).toContain("Disable");
    expect(markup).not.toContain("Enable method");
    expect(markup).toContain("Acknowledged");
  });

  it("lets only the newest same-method review request commit", () => {
    const epochs = new Map<string, number>();
    const first = beginMethodReviewRequest(epochs, method.name);
    const retry = beginMethodReviewRequest(epochs, method.name);
    expect(isCurrentMethodReviewRequest(epochs, method.name, first)).toBe(false);
    expect(isCurrentMethodReviewRequest(epochs, method.name, retry)).toBe(true);
  });

  it("resets acknowledgement on refresh and discards text when the review revision changes", () => {
    const current = { [method.name]: { ...readyReview, acknowledged: true } };
    const same = reconcileMethodReviews([method], current, new Map([[method.name, method.reviewRevision]]));
    expect(same.reviews[method.name]).toMatchObject({ status: "ready", acknowledged: false });
    expect(same.reviews[method.name]?.text).toContain("# Complete method");

    const changedMethod = { ...method, reviewRevision: "0".repeat(64) };
    const changed = reconcileMethodReviews([changedMethod], current, new Map([[method.name, method.reviewRevision]]));
    expect(changed.reviews[method.name]).toEqual({
      open: false,
      status: "idle",
      text: "",
      error: null,
      acknowledged: false,
    });
  });

  it("renders an accessible destructive confirmation and a focusable full-document review", () => {
    const card = renderCard(readyReview);
    expect(card).toContain('tabindex="0"');
    expect(card).toContain('aria-label="Full Markdown for release-check"');

    const dialog = renderToStaticMarkup(createElement(RemoveMethodDialog, {
      method,
      busy: false,
      error: null,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }));
    expect(dialog).toContain('role="alertdialog"');
    expect(dialog).toContain('aria-modal="true"');
    expect(dialog).toContain("Remove release-check?");
    expect(dialog).toContain("Cancel");
  });

  it("keeps source links on trusted GitHub HTTPS hosts", () => {
    expect(methodSourceHref("github.com/acme/methods")).toBe("https://github.com/acme/methods");
    expect(methodSourceHref("https://raw.githubusercontent.com/acme/methods/main/SKILL.md")).toContain("raw.githubusercontent.com");
    expect(methodSourceHref("http://github.com/acme/methods")).toBeNull();
    expect(methodSourceHref("https://evil.example/method")).toBeNull();
    expect(importedMethodDate("not-a-date")).toBe("Unknown date");
  });

  it("renders the lifecycle entry point with an explicit disabled-by-default promise", () => {
    const client: AgentSkillsClient = {
      list: vi.fn(async () => []),
      importFromGitHub: vi.fn(async () => ({ installed: [], errors: [] })),
      read: vi.fn(async () => ""),
      setEnabled: vi.fn(async () => method),
      remove: vi.fn(async () => undefined),
    };
    const markup = renderToStaticMarkup(createElement(AgentSkillsPanel, { botId: "op-1", client }));
    expect(markup).toContain("Imported methods");
    expect(markup).toContain("Imports stay disabled until you read and approve them");
    expect(markup).toContain("GitHub source");
    expect(markup).toContain("Loading imported methods");
  });
});
