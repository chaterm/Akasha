import { useMemo, useRef, useState, type PointerEvent } from "react";
import { ActionIcon, Button, Group, Popover, Stack, Text } from "@mantine/core";
import {
  IconChevronLeft,
  IconChevronRight,
  IconPlus,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  addDatabaseColumn,
  addDatabaseDays,
  diffDatabaseDays,
  getDatabaseDateRange,
  moveDatabaseRowToDate,
  resizeDatabaseRowRange,
  updateDatabaseView,
  type DatabaseColumn,
  type DatabaseRowData,
} from "@docmost/editor-ext";
import {
  stopBubbling,
  createRow,
  useViewRows,
  visibleColumns,
  type DatabaseContext,
} from "./database-context";
import { CalendarBar } from "./database-calendar-bar";
import {
  buildMonthWeeks,
  getWeekStart,
  layoutCalendarWeek,
  parseDateKey,
  toDateKey,
} from "./database-utils";
import { elementAt, usePointerDrag } from "./use-pointer-drag";
import classes from "./database.module.css";

/** Entries stack top-down in a day; past this many rows the rest is cut off. */
const MAX_SLOTS = 4;
const BAR_HEIGHT = 20;
const BAR_GAP = 2;
const DAY_HEADER = 22;
const WEEK_HEIGHT = DAY_HEADER + MAX_SLOTS * (BAR_HEIGHT + BAR_GAP) + 4;

interface CalendarDrag {
  rowId: string;
  mode: "move" | "start" | "end";
  /** Days between the grabbed day and the row start (move only). */
  grabOffset: number;
}

function dayAt(x: number, y: number): string | null {
  return elementAt(x, y, "[data-day]")?.dataset.day ?? null;
}

export default function DatabaseCalendarView({ db }: { db: DatabaseContext }) {
  const { t } = useTranslation();
  const [month, setMonth] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });
  const [preview, setPreview] = useState<{ start: string; end: string } | null>(
    null,
  );
  const gridRef = useRef<HTMLDivElement>(null);
  const rows = useViewRows(db);
  const { view } = db;
  const dateColumn = db.columns.find(
    (column) => column.id === view.dateColumnId,
  );
  const resizable = !!view.endDateColumnId && db.editable;
  // The first one is the bar's heading.
  const fields = visibleColumns(db).filter(
    (column) =>
      column.id !== view.dateColumnId && column.id !== view.endDateColumnId,
  );

  const { ranged, undated } = useMemo(() => {
    const ranged: { item: DatabaseRowData; start: string; end: string }[] = [];
    const undated: DatabaseRowData[] = [];
    for (const row of rows) {
      const range = getDatabaseDateRange(row, view);
      if (range) ranged.push({ item: row, ...range });
      else undated.push(row);
    }
    return { ranged, undated };
  }, [rows, view]);

  const weekStart = useMemo(() => getWeekStart(db.locale), [db.locale]);
  const weeks = buildMonthWeeks(
    month.getFullYear(),
    month.getMonth(),
    weekStart,
  );
  const todayKey = toDateKey(new Date());
  const isCurrentMonth =
    month.getFullYear() === new Date().getFullYear() &&
    month.getMonth() === new Date().getMonth();

  const rangeFor = (drag: CalendarDrag, day: string) => {
    const row = db.rows.find((item) => item.id === drag.rowId);
    const range = row ? getDatabaseDateRange(row, view) : null;
    if (drag.mode === "move") {
      const start = addDatabaseDays(day, -drag.grabOffset);
      const length = range ? diffDatabaseDays(range.start, range.end) : 0;
      return { start, end: addDatabaseDays(start, length) };
    }
    if (!range) return null;
    return drag.mode === "start"
      ? { start: day > range.end ? range.end : day, end: range.end }
      : { start: range.start, end: day < range.start ? range.start : day };
  };

  const drag = usePointerDrag<CalendarDrag>({
    tilt: 0,
    onMove: (data, x, y) => {
      const day = dayAt(x, y);
      setPreview(day ? rangeFor(data, day) : null);
    },
    onDrop: (data, x, y) => {
      setPreview(null);
      const day = dayAt(x, y);
      if (!day) return;
      if (data.mode === "move") {
        const start = addDatabaseDays(day, -data.grabOffset);
        db.apply((tr, pos) =>
          moveDatabaseRowToDate(tr, pos, view.id, data.rowId, start),
        );
      } else {
        db.apply((tr, pos) =>
          resizeDatabaseRowRange(
            tr,
            pos,
            view.id,
            data.rowId,
            data.mode as "start" | "end",
            day,
          ),
        );
      }
    },
    onCancel: () => setPreview(null),
  });

  const startDrag = (
    event: PointerEvent<HTMLElement>,
    row: DatabaseRowData,
    mode: CalendarDrag["mode"],
    start?: string,
  ) => {
    if (!db.editable) return;
    const day = dayAt(event.clientX, event.clientY);
    const grabOffset =
      mode === "move" && day && start
        ? Math.max(diffDatabaseDays(start, day), 0)
        : 0;
    drag.onPointerDown(event, { rowId: row.id, mode, grabOffset });
  };

  if (!dateColumn) return <NoDateColumn db={db} />;

  const shiftMonth = (delta: number) =>
    setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1));
  const addOn = (day: string) => {
    const id = createRow(db, { values: { [dateColumn.id]: day } });
    if (id) db.openRow(id);
  };
  const draggingId = drag.dragging?.rowId;

  return (
    <div>
      <Group justify="space-between" mb={6} wrap="nowrap">
        <Text size="sm" fw={600}>
          {month.toLocaleDateString(db.locale, {
            year: "numeric",
            month: "long",
          })}
        </Text>
        <Group gap={4} wrap="nowrap">
          {undated.length > 0 && (
            <UndatedList
              db={db}
              rows={undated}
              fields={fields}
              onDragStart={(event, row) => startDrag(event, row, "move")}
            />
          )}
          {!isCurrentMonth && (
            <Button
              size="compact-xs"
              variant="default"
              onClick={() =>
                setMonth(
                  new Date(new Date().getFullYear(), new Date().getMonth(), 1),
                )
              }
            >
              {t("Today")}
            </Button>
          )}
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            aria-label={t("Previous month")}
            onClick={() => shiftMonth(-1)}
          >
            <IconChevronLeft size={14} />
          </ActionIcon>
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            aria-label={t("Next month")}
            onClick={() => shiftMonth(1)}
          >
            <IconChevronRight size={14} />
          </ActionIcon>
        </Group>
      </Group>
      <div ref={gridRef} className={classes.calendar}>
        <div className={classes.weekdays}>
          {weeks[0].map((day) => (
            <div key={day} className={classes.weekday}>
              {parseDateKey(day).toLocaleDateString(db.locale, {
                weekday: "short",
              })}
            </div>
          ))}
        </div>
        {weeks.map((week) => {
          const segments = layoutCalendarWeek(week, ranged);
          const visible = segments.filter(
            (segment) => segment.slot < MAX_SLOTS,
          );
          return (
            <div
              key={week[0]}
              className={classes.week}
              style={{ height: WEEK_HEIGHT }}
            >
              {week.map((day) => {
                const inMonth =
                  parseDateKey(day).getMonth() === month.getMonth();
                const inPreview =
                  !!preview && day >= preview.start && day <= preview.end;
                return (
                  <div
                    key={day}
                    data-day={day}
                    className={classes.day}
                    data-outside={!inMonth || undefined}
                    data-today={day === todayKey || undefined}
                    data-drop-target={inPreview || undefined}
                  >
                    <span className={classes.dayNumber}>
                      {parseDateKey(day).getDate()}
                    </span>
                    {db.editable && inMonth && (
                      <ActionIcon
                        size="xs"
                        variant="subtle"
                        color="gray"
                        className={classes.dayAdd}
                        aria-label={t("New")}
                        onClick={() => addOn(day)}
                      >
                        <IconPlus size={12} />
                      </ActionIcon>
                    )}
                  </div>
                );
              })}
              {visible.map((segment) => (
                <CalendarBar
                  key={`${segment.item.id}-${segment.column}`}
                  db={db}
                  row={segment.item}
                  fields={fields}
                  multiDay={
                    segment.span > 1 ||
                    segment.continuesLeft ||
                    segment.continuesRight
                  }
                  continuesLeft={segment.continuesLeft}
                  continuesRight={segment.continuesRight}
                  resizable={resizable}
                  dragging={draggingId === segment.item.id}
                  style={{
                    top: DAY_HEADER + segment.slot * (BAR_HEIGHT + BAR_GAP),
                    left: `calc(${(segment.column / 7) * 100}% + 3px)`,
                    width: `calc(${(segment.span / 7) * 100}% - 6px)`,
                    height: BAR_HEIGHT,
                  }}
                  onPointerDown={(event, mode) =>
                    startDrag(
                      event,
                      segment.item,
                      mode,
                      ranged.find((entry) => entry.item.id === segment.item.id)
                        ?.start,
                    )
                  }
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function UndatedList({
  db,
  rows,
  fields,
  onDragStart,
}: {
  db: DatabaseContext;
  rows: DatabaseRowData[];
  fields: DatabaseColumn[];
  onDragStart: (event: PointerEvent<HTMLElement>, row: DatabaseRowData) => void;
}) {
  const { t } = useTranslation();
  return (
    <Popover position="bottom-end" width={260} shadow="md" withinPortal>
      <Popover.Target>
        <Button size="compact-xs" variant="subtle" color="gray">
          {t("Unassigned ({{count}})", { count: rows.length })}
        </Button>
      </Popover.Target>
      <Popover.Dropdown {...stopBubbling} p={6}>
        {db.editable && (
          <Text size="xs" c="dimmed" mb={4}>
            {t("Drag onto a day to schedule.")}
          </Text>
        )}
        <Stack gap={BAR_GAP} mah={300} style={{ overflowY: "auto" }}>
          {rows.map((row) => (
            <CalendarBar
              key={row.id}
              db={db}
              row={row}
              fields={fields.slice(0, 1)}
              style={{ position: "static", height: BAR_HEIGHT }}
              onPointerDown={(event) => onDragStart(event, row)}
            />
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

/** Shown by date-based views (calendar, timeline) until the view has a date column. */
export function NoDateColumn({ db }: { db: DatabaseContext }) {
  const { t } = useTranslation();
  return (
    <Stack align="center" gap="xs" p="lg">
      <Text size="sm" c="dimmed">
        {db.view.type === "timeline"
          ? t("Timeline needs a date field.")
          : t("Calendar needs a date field.")}
      </Text>
      {db.editable && (
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() =>
            db.apply((tr, pos) => {
              const id = addDatabaseColumn(tr, pos, {
                name: t("Date"),
                type: "date",
              });
              updateDatabaseView(tr, pos, db.view.id, { dateColumnId: id });
            })
          }
        >
          {t("Create date field")}
        </Button>
      )}
    </Stack>
  );
}
