import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Routine } from "@/lib/routines";
import { StoreProvider, type Bot } from "@/state/store";
import {
  assignCalendarColumns,
  calendarDayMinWidth,
  CalendarGrid,
  layoutCalendarDayItems,
  RoutineEditor,
  RoutinesPage,
  type CalendarItem,
} from "./RoutinesPage";

const minute = 60_000;

function bot(id = "rivet"): Bot {
  return {
    id,
    threadId: `thread-${id}`,
    name: "Rivet",
    title: "Release operator",
    description: "Keeps delivery moving.",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "test", model: "test" },
    messages: [],
  };
}

function routine(id: string, at: number, durationMinutes = 30): Routine {
  return {
    id,
    name: `Cadence ${id}`,
    prompt: "Check the release.",
    botId: "rivet",
    runOn: "local",
    enabled: true,
    schedule: { type: "once", at },
    durationMinutes,
    nextRunAt: at,
    createdAt: at - minute,
    updatedAt: at - minute,
  };
}

function item(id: string, at: number, durationMinutes = 30): CalendarItem {
  return { id, at, routine: routine(id, at, durationMinutes), run: null };
}

describe("Cadences surface", () => {
  it("renders the empty ledger with Helmryth vocabulary", () => {
    const markup = renderToStaticMarkup(
      createElement(StoreProvider, null, createElement(RoutinesPage)),
    );

    expect(markup).toContain("Cadences");
    expect(markup).toContain("Give recurring work a clear rhythm");
    expect(markup).toContain("Create an operator first");
    expect(markup).not.toMatch(/\b(?:bot|routine|task|agent)\b/i);
  });

  it("announces local and hosted workbench selection without infrastructure labels", () => {
    const markup = renderToStaticMarkup(
      createElement(
        StoreProvider,
        null,
        createElement(RoutineEditor, { bots: [], onClose: vi.fn() }),
      ),
    );

    expect(markup).toContain("Local workbench");
    expect(markup).toContain("Hosted workbench");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).not.toMatch(/\b(?:VM|Box|computer)\b/i);
  });
});

describe("Cadence collision layout", () => {
  it("places exact and partial overlaps into deterministic columns", () => {
    expect(assignCalendarColumns([
      { id: "b", start: 0, end: 60 },
      { id: "a", start: 0, end: 60 },
      { id: "c", start: 30, end: 90 },
    ])).toEqual([
      { id: "a", column: 0, columnCount: 3 },
      { id: "b", column: 1, columnCount: 3 },
      { id: "c", column: 2, columnCount: 3 },
    ]);
  });

  it("treats a boundary touch as a new collision group", () => {
    expect(assignCalendarColumns([
      { id: "first", start: 0, end: 60 },
      { id: "second", start: 60, end: 120 },
    ])).toEqual([
      { id: "first", column: 0, columnCount: 1 },
      { id: "second", column: 0, columnCount: 1 },
    ]);
  });

  it("reuses the first free column across chained overlaps", () => {
    expect(assignCalendarColumns([
      { id: "long", start: 0, end: 180 },
      { id: "early", start: 10, end: 50 },
      { id: "middle", start: 50, end: 100 },
      { id: "late", start: 100, end: 150 },
    ])).toEqual([
      { id: "long", column: 0, columnCount: 2 },
      { id: "early", column: 1, columnCount: 2 },
      { id: "middle", column: 1, columnCount: 2 },
      { id: "late", column: 1, columnCount: 2 },
    ]);
  });

  it("keeps zero-duration blocks visible and supports an all-day interval", () => {
    const day = new Date(2026, 7, 31, 0, 0, 0, 0).getTime();
    const layouts = layoutCalendarDayItems([
      item("all-day", day, 24 * 60),
      item("zero", day + 12 * 60 * minute, 0),
    ]);

    expect(layouts.map(({ item: entry, top, height, column, columnCount }) => ({
      id: entry.id,
      top,
      height,
      column,
      columnCount,
    }))).toEqual([
      { id: "all-day", top: 0, height: 24 * 68, column: 0, columnCount: 2 },
      { id: "zero", top: 12 * 68, height: 48, column: 1, columnCount: 2 },
    ]);
  });

  it("expands narrow day tracks instead of squeezing collision columns", () => {
    expect(calendarDayMinWidth(110, 1)).toBe(110);
    expect(calendarDayMinWidth(110, 2)).toBe(320);
    expect(calendarDayMinWidth(180, 3)).toBe(480);
    expect(calendarDayMinWidth(300, 4)).toBe(640);
  });

  it("renders every overlapping cadence as an independently reachable button", () => {
    const day = new Date(2026, 7, 31, 0, 0, 0, 0).getTime();
    const markup = renderToStaticMarkup(createElement(CalendarGrid, {
      anchor: day,
      days: 1,
      items: [
        item("alpha", day + 9 * 60 * minute, 60),
        item("beta", day + 9 * 60 * minute, 60),
        item("gamma", day + 9 * 60 * minute, 60),
      ],
      bots: [bot()],
      onOpen: vi.fn(),
    }));

    expect(markup.match(/<button/g)).toHaveLength(3);
    expect(markup).toContain('data-calendar-column="0"');
    expect(markup).toContain('data-calendar-column="1"');
    expect(markup).toContain('data-calendar-column="2"');
    expect(markup).toContain('data-calendar-columns="3"');
    expect(markup).toContain('aria-label="Open Cadence alpha cadence details"');
    expect(markup).toContain('aria-label="Open Cadence beta cadence details"');
    expect(markup).toContain('aria-label="Open Cadence gamma cadence details"');
  });
});
