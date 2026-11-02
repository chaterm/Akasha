import { describe, expect, it } from "vitest";
import {
  buildMonthWeeks,
  getWeekStart,
  layoutCalendarWeek,
  moveItem,
} from "./database-utils";

describe("buildMonthWeeks", () => {
  it("covers the month with whole weeks starting on the given day", () => {
    // November 2026 starts on a Sunday and has 30 days.
    const monday = buildMonthWeeks(2026, 10, 1);
    expect(monday).toHaveLength(6);
    expect(monday[0][0]).toBe("2026-10-26");
    expect(monday[0][6]).toBe("2026-11-01");
    expect(monday[5][6]).toBe("2026-12-06");

    const sunday = buildMonthWeeks(2026, 10, 0);
    expect(sunday).toHaveLength(5);
    expect(sunday[0][0]).toBe("2026-11-01");
  });

  it("uses only 4 weeks when the month fits exactly", () => {
    // February 2027 starts on a Monday and has 28 days.
    expect(buildMonthWeeks(2027, 1, 1)).toHaveLength(4);
  });
});

describe("layoutCalendarWeek", () => {
  const week = buildMonthWeeks(2026, 10, 1)[1]; // 2026-11-02 .. 2026-11-08

  it("cuts ranges at week edges and stacks overlaps into slots", () => {
    const segments = layoutCalendarWeek(week, [
      { item: "long", start: "2026-10-30", end: "2026-11-04" },
      { item: "mid", start: "2026-11-03", end: "2026-11-05" },
      { item: "single", start: "2026-11-06", end: "2026-11-06" },
      { item: "outside", start: "2026-11-20", end: "2026-11-20" },
    ]);
    const byItem = Object.fromEntries(
      segments.map((segment) => [segment.item, segment]),
    );
    expect(Object.keys(byItem).sort()).toEqual(["long", "mid", "single"]);
    expect(byItem.long).toMatchObject({
      column: 0,
      span: 3,
      slot: 0,
      continuesLeft: true,
      continuesRight: false,
    });
    expect(byItem.mid).toMatchObject({ column: 1, span: 3, slot: 1 });
    // The first slot is free again after "long" ends.
    expect(byItem.single).toMatchObject({ column: 4, span: 1, slot: 0 });
  });
});

describe("moveItem", () => {
  it("moves an item to an insert-before index", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 3)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 0, 3)).toEqual(["b", "c", "a"]);
  });
});

describe("getWeekStart", () => {
  it("returns Sunday for en-US and Monday for zh-CN / de-DE", () => {
    expect(getWeekStart("en-US")).toBe(0);
    expect(getWeekStart("zh-CN")).toBe(1);
    expect(getWeekStart("de-DE")).toBe(1);
  });
});
