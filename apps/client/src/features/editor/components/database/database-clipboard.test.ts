import { describe, expect, it } from "vitest";
import {
  normalizeDatabaseColumns,
  normalizeDatabaseViews,
  type DatabaseColumn,
} from "@docmost/editor-ext";
import {
  cellToClipboard,
  parseClipboardCell,
  parseTSV,
  toTSV,
} from "./database-clipboard";
import { getTimelineWindow, splitTimeline } from "./database-utils";

describe("title column", () => {
  it("moves the first text column to the front and keeps it shown first in views", () => {
    const columns = normalizeDatabaseColumns([
      { id: "due", name: "Due", type: "date" },
      { id: "name", name: "Name", type: "text" },
    ]);
    expect(columns.map((column) => column.id)).toEqual(["name", "due"]);
    const [view] = normalizeDatabaseViews(
      [
        {
          id: "t",
          type: "table",
          columns: [
            { id: "due" },
            { id: "name", hidden: true },
          ],
        },
      ],
      columns,
    );
    expect(view.columns.map((entry) => [entry.id, entry.hidden])).toEqual([
      ["name", false],
      ["due", false],
    ]);
  });

  it("adds a title column with a fixed id when there is no text column", () => {
    const raw = [{ id: "title", name: "Done", type: "checkbox" }];
    const a = normalizeDatabaseColumns(raw);
    const b = normalizeDatabaseColumns(raw);
    expect(a[0]).toEqual({ id: "title_", name: "Title", type: "text" });
    expect(b[0].id).toBe(a[0].id);
  });
});

describe("clipboard", () => {
  it.each(["en-US", "zh-CN", "de-DE", "fr-FR", "pt-BR"])(
    "preserves numeric values when copying and pasting in %s",
    (locale) => {
      const column: DatabaseColumn = {
        id: "n",
        name: "Number",
        type: "number",
        format: "USD",
        decimals: 2,
      };
      for (const value of [0, -12.5, 1234.5, 1.2345678901234567, 1e-20, 1e21]) {
        const copied = cellToClipboard(
          column,
          { id: "r", values: { n: value } },
          locale,
        );
        expect(parseClipboardCell(column, copied, locale, [])).toBe(value);
      }
      const progress: DatabaseColumn = { ...column, type: "progress" };
      const copied = cellToClipboard(
        progress,
        { id: "r", values: { n: 75 } },
        locale,
      );
      expect(parseClipboardCell(progress, copied, locale, [])).toBe(75);
    },
  );

  it("round-trips tabs, newlines and quotes like Excel", () => {
    const matrix = [
      ["a", 'say "hi"'],
      ["two\nlines", "tab\there"],
    ];
    expect(parseTSV(toTSV(matrix))).toEqual(matrix);
    expect(parseTSV("1\t2\r\n3\t4\r\n")).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("parses values per column type and creates missing select options once", () => {
    const select: DatabaseColumn = {
      id: "s",
      name: "Status",
      type: "select",
      options: [{ id: "o1", name: "Done", color: "green" }],
    };
    const options = [...select.options!];
    expect(parseClipboardCell(select, "done", "en-US", options)).toBe("o1");
    const created = parseClipboardCell(select, "Blocked", "en-US", options);
    expect(options).toHaveLength(2);
    expect(parseClipboardCell(select, "blocked", "en-US", options)).toBe(created);

    const date: DatabaseColumn = { id: "d", name: "Due", type: "date" };
    expect(parseClipboardCell(date, "2026/1/5", "en-US", [])).toBe("2026-01-05");
    expect(parseClipboardCell(date, "2026年11月3日", "zh-CN", [])).toBe("2026-11-03");
    expect(parseClipboardCell(date, "soon", "en-US", [])).toBeUndefined();

    const number: DatabaseColumn = { id: "n", name: "N", type: "number" };
    expect(parseClipboardCell(number, "1,234.5", "en-US", [])).toBe(1234.5);
    const check: DatabaseColumn = { id: "c", name: "C", type: "checkbox" };
    expect(parseClipboardCell(check, "TRUE", "en-US", [])).toBe(true);
    expect(parseClipboardCell(check, "no", "en-US", [])).toBe(false);

    const person: DatabaseColumn = {
      id: "p",
      name: "Owner",
      type: "person",
      options: [{ id: "u1", name: "Ann", color: "blue" }],
    };
    // Members are only matched, never created.
    expect(parseClipboardCell(person, "Ann, Bob", "en-US", person.options!)).toEqual(["u1"]);
    expect(parseClipboardCell(person, "Bob", "en-US", person.options!)).toBeUndefined();
  });
});

describe("timeline axis", () => {
  it("pads the rows' dates and aligns weeks and months", () => {
    const week = getTimelineWindow(["2026-11-04", "2026-11-20"], "2026-11-10", "week", 1);
    expect(new Date(`${week.start}T00:00`).getDay()).toBe(1);
    expect(week.days % 7).toBe(0);
    expect(week.start <= "2026-10-21").toBe(true);

    const month = getTimelineWindow([], "2026-11-10", "month", 1);
    expect(month.start).toBe("2026-09-01");
    expect(month.days).toBeGreaterThanOrEqual(365);
  });

  it("splits the axis into months and weeks", () => {
    const months = splitTimeline("2026-01-30", 5, "month", 1);
    expect(months).toEqual([
      { date: "2026-01-30", offset: 0, days: 2 },
      { date: "2026-02-01", offset: 2, days: 3 },
    ]);
    const weeks = splitTimeline("2026-11-02", 14, "week", 1);
    expect(weeks.map((span) => span.days)).toEqual([7, 7]);
  });
});
