import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserDesktopCapabilities } from "@/lib/desktop";

const analytics = {
  setEmailGateDone: vi.fn(),
  track: vi.fn(),
};

const desktopState = {
  capabilities: browserDesktopCapabilities(),
  ready: true,
};

afterEach(() => {
  analytics.setEmailGateDone.mockReset();
  analytics.track.mockReset();
});

describe("Onboarding", () => {
  it("renders as a labelled modal dialog", async () => {
    const { Onboarding, onboardingDialogTitle } = await import("./Onboarding");
    const markup = renderToStaticMarkup(createElement(Onboarding, { onDone: () => {}, analytics, desktopState }));

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("First-run setup. Finish or skip each step inside this dialog before the main workspace becomes available.");
    expect(markup).toContain(onboardingDialogTitle(0));
  });

  it("announces the step change through a region that outlives the message", async () => {
    // Advancing a step swaps the dialog's accessible name while focus moves
    // into the new step, so nothing re-reads the name: without a live region
    // the whole flow advances in silence.
    const { Onboarding } = await import("./Onboarding");
    const markup = renderToStaticMarkup(createElement(Onboarding, { onDone: () => {}, analytics, desktopState }));
    const progress = markup.match(/<p[^>]*class="sr-only"[^>]*>Setup step 1 of 4[^<]*<\/p>/);

    expect(progress).not.toBeNull();
    expect(progress?.[0]).toContain('role="status"');
    expect(progress?.[0]).toContain('aria-live="polite"');
  });

  it("names each setup step consistently for assistive tech", async () => {
    const { onboardingDialogTitle } = await import("./Onboarding");
    expect(onboardingDialogTitle(0)).toBe("Setup step 1 of 4: Identity");
    expect(onboardingDialogTitle(1)).toBe("Setup step 2 of 4: Engines");
    expect(onboardingDialogTitle(2)).toBe("Setup step 3 of 4: Input boundary");
    expect(onboardingDialogTitle(3)).toBe("Setup step 4 of 4: Helmryth Mobile");
  });

  it("wraps keyboard focus at the dialog edges", async () => {
    const { onboardingFocusWrapTarget } = await import("./Onboarding");
    const first = { focus: () => {} };
    const middle = { focus: () => {} };
    const last = { focus: () => {} };
    const focusables = [first, middle, last];

    expect(onboardingFocusWrapTarget(focusables, first, true)).toBe(last);
    expect(onboardingFocusWrapTarget(focusables, last, false)).toBe(first);
    expect(onboardingFocusWrapTarget(focusables, middle, false)).toBeNull();
    expect(onboardingFocusWrapTarget(focusables, null, false)).toBe(first);
    expect(onboardingFocusWrapTarget(focusables, null, true)).toBe(last);
  });

  it("finishes the engine loading state with the live inventory", async () => {
    const { loadOnboardingInstances } = await import("./Onboarding");
    const instances = [{
      instanceId: "openai-compatible",
      driverKind: "openaiCompatible",
      displayName: "OpenAI-compatible",
      snapshot: { state: "available" },
      models: { default: "test-model", options: [] },
      access: "custom",
    }];
    const fetchInstances = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ instances }),
    });

    await expect(loadOnboardingInstances(fetchInstances)).resolves.toStrictEqual(instances);
    expect(fetchInstances).toHaveBeenCalledOnce();
    expect(fetchInstances).toHaveBeenCalledWith("/api/instances");
  });

  it.each([
    ["HTTP failure", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })],
    ["network failure", vi.fn().mockRejectedValue(new Error("offline"))],
    ["invalid payload", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ instances: null }) })],
  ])("finishes the engine loading state after %s", async (_name, fetchInstances) => {
    const { loadOnboardingInstances } = await import("./Onboarding");
    await expect(loadOnboardingInstances(fetchInstances)).resolves.toEqual([]);
  });

  it("coalesces focus refreshes while an engine inventory request is pending", async () => {
    const { createOnboardingInstancesRefresh } = await import("./Onboarding");
    let resolveResponse!: (value: never[]) => void;
    const loadInstances = vi.fn(
      () =>
        new Promise<never[]>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const commit = vi.fn();
    const loader = createOnboardingInstancesRefresh(loadInstances, commit);

    const enteredStep = loader.refresh();
    const focusRefresh = loader.refresh();

    expect(focusRefresh).toBe(enteredStep);
    expect(loadInstances).toHaveBeenCalledOnce();

    resolveResponse([]);
    await enteredStep;
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith([]);

    const settledRefresh = loader.refresh();
    expect(loadInstances).toHaveBeenCalledTimes(2);
    resolveResponse([]);
    await settledRefresh;
  });

  it("does not commit a late inventory result after the dialog stops", async () => {
    const { createOnboardingInstancesRefresh } = await import("./Onboarding");
    let resolveResponse!: (value: never[]) => void;
    const loadInstances = vi.fn(
      () =>
        new Promise<never[]>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const commit = vi.fn();
    const loader = createOnboardingInstancesRefresh(loadInstances, commit);

    const pending = loader.refresh();
    loader.stop();
    resolveResponse([]);
    await pending;

    expect(commit).not.toHaveBeenCalled();
  });
});
