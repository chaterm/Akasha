import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { Button, Group, SegmentedControl, UnstyledButton } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  addDatabaseDays,
  diffDatabaseDays,
  getDatabaseDateRange,
  moveDatabaseRowToDate,
  resizeDatabaseRowRange,
  setDatabaseCellValue,
  type DatabaseRowData,
  type DatabaseTimelineScale,
} from "@docmost/editor-ext";
import {
  createRow,
  patchView,
  useViewRows,
  visibleColumns,
  type DatabaseContext,
} from "./database-context";
import { NoDateColumn } from "./database-calendar-view";
import { formatDateValue } from "./database-cells";
import { Highlighted } from "./database-ui";
import {
  TIMELINE_DAY_WIDTH,
  getTimelineWindow,
  getWeekStart,
  parseDateKey,
  splitTimeline,
  summarizeRow,
  toDateKey,
} from "./database-utils";
import classes from "./database.module.css";

const LABEL_WIDTH = 220;
const ROW_HEIGHT = 36;
/** Bars shorter than this put their title beside them instead of inside. */
const MIN_LABEL_WIDTH = 72;

interface BarDrag {
  rowId: string;
  mode: "move" | "start" | "end";
  startX: number;
  /** Whole days the pointer has moved. */
  days: number;
  moved: boolean;
}

/**
 * Gantt chart: one row per record, a bar from its start to its end date.
 * Drag a bar to move it, its edges to change the dates (with an end date
 * column), and click an empty row to schedule it on that day.
 */
export default function DatabaseTimelineView({ db }: { db: DatabaseContext }) {
  const { t } = useTranslation();
  const rows = useViewRows(db);
  const { view } = db;
  const scrollRef = useRef<HTMLDivElement>(null);
  // Read-only viewers can still zoom; only editors save the choice.
  const [localScale, setLocalScale] = useState<DatabaseTimelineScale | null>(
    null,
  );
  const scale = localScale ?? view.timelineScale;
  const dayWidth = TIMELINE_DAY_WIDTH[scale];
  const weekStart = useMemo(() => getWeekStart(db.locale), [db.locale]);
  const todayKey = toDateKey(new Date());
  const [drag, setDrag] = useState<BarDrag | null>(null);
  const [hover, setHover] = useState<{ rowId: string; date: string } | null>(
    null,
  );
  const [title, ...rest] = visibleColumns(db);
  const fields = rest.filter(
    (column) =>
      column.id !== view.dateColumnId && column.id !== view.endDateColumnId,
  );
  const resizable = db.editable && !!view.endDateColumnId;

  const ranges = useMemo(
    () => new Map(rows.map((row) => [row.id, getDatabaseDateRange(row, view)])),
    [rows, view],
  );
  const axis = useMemo(
    () =>
      getTimelineWindow(
        [...ranges.values()].flatMap((range) =>
          range ? [range.start, range.end] : [],
        ),
        todayKey,
        scale,
        weekStart,
      ),
    [ranges, todayKey, scale, weekStart],
  );
  const width = axis.days * dayWidth;
  const offsetOf = (date: string) => diffDatabaseDays(axis.start, date);
  const dateAt = (x: number) =>
    addDatabaseDays(axis.start, Math.floor(x / dayWidth));

  const [major, minor] = useMemo(() => {
    const units = {
      day: ["month", "day"],
      week: ["month", "week"],
      month: ["year", "month"],
    } as const;
    const [top, bottom] = units[scale];
    return [
      splitTimeline(axis.start, axis.days, top, weekStart),
      splitTimeline(axis.start, axis.days, bottom, weekStart),
    ];
  }, [axis, scale, weekStart]);

  const scrollToToday = (behavior: ScrollBehavior = "smooth") => {
    const element = scrollRef.current;
    if (!element) return;
    const left = offsetOf(todayKey) * dayWidth;
    element.scrollTo?.({
      left: Math.max(left - (element.clientWidth - LABEL_WIDTH) / 3, 0),
      behavior,
    });
  };
  // Open on today, and keep it in view after zooming.
  useLayoutEffect(() => scrollToToday("auto"), [scale]);

  // Drag runs on window listeners so the bar can be released anywhere.
  const dragRef = useRef<BarDrag | null>(null);
  useEffect(() => {
    if (!drag) return;
    const onMove = (event: globalThis.PointerEvent) => {
      const current = dragRef.current!;
      const delta = event.clientX - current.startX;
      const next = {
        ...current,
        days: Math.round(delta / dayWidth),
        moved: current.moved || Math.abs(delta) > 3,
      };
      dragRef.current = next;
      setDrag(next);
    };
    const onUp = () => {
      const current = dragRef.current!;
      dragRef.current = null;
      setDrag(null);
      const range = ranges.get(current.rowId);
      if (!current.moved) {
        if (current.mode === "move") db.openRow(current.rowId);
        return;
      }
      if (!range || !current.days) return;
      db.apply((tr, pos) =>
        current.mode === "move"
          ? moveDatabaseRowToDate(
              tr,
              pos,
              view.id,
              current.rowId,
              addDatabaseDays(range.start, current.days),
            )
          : resizeDatabaseRowRange(
              tr,
              pos,
              view.id,
              current.rowId,
              current.mode,
              addDatabaseDays(
                current.mode === "start" ? range.start : range.end,
                current.days,
              ),
            ),
      );
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // Listeners are bound once per drag; the drag state is read from the ref.
  }, [!!drag]);

  if (!view.dateColumnId) return <NoDateColumn db={db} />;
  const dateColumnId = view.dateColumnId;

  const startDrag = (
    event: PointerEvent<HTMLElement>,
    rowId: string,
    mode: BarDrag["mode"],
  ) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (!db.editable) {
      if (mode === "move") db.openRow(rowId);
      return;
    }
    event.preventDefault();
    const next = { rowId, mode, startX: event.clientX, days: 0, moved: false };
    dragRef.current = next;
    setDrag(next);
  };

  /** The range a row shows, including the drag in progress. */
  const shownRange = (row: DatabaseRowData) => {
    const range = ranges.get(row.id);
    if (!range || drag?.rowId !== row.id || !drag.moved) return range;
    const { mode, days } = drag;
    if (mode === "move")
      return {
        start: addDatabaseDays(range.start, days),
        end: addDatabaseDays(range.end, days),
      };
    if (mode === "start") {
      const start = addDatabaseDays(range.start, days);
      return { start: start > range.end ? range.end : start, end: range.end };
    }
    const end = addDatabaseDays(range.end, days);
    return { start: range.start, end: end < range.start ? range.start : end };
  };

  const trackX = (event: { clientX: number; currentTarget: HTMLElement }) =>
    event.clientX - event.currentTarget.getBoundingClientRect().left;

  const changeScale = (next: DatabaseTimelineScale) => {
    if (db.editable) patchView(db, { timelineScale: next });
    else setLocalScale(next);
  };

  const label = (span: (typeof minor)[number], unit: "major" | "minor") => {
    const date = parseDateKey(span.date);
    if (unit === "major")
      return scale === "month"
        ? String(date.getFullYear())
        : date.toLocaleDateString(db.locale, {
            year: "numeric",
            month: "long",
          });
    if (scale === "month")
      return date.toLocaleDateString(db.locale, { month: "short" });
    if (scale === "week")
      return date.toLocaleDateString(db.locale, {
        month: "numeric",
        day: "numeric",
      });
    return String(date.getDate());
  };

  const addRow = () => {
    const id = createRow(db, { values: { [dateColumnId]: todayKey } });
    if (id) db.openRow(id);
  };

  return (
    <div className={classes.gantt}>
      <Group justify="flex-end" gap={6} mb={6} wrap="nowrap">
        <Button
          size="compact-xs"
          variant="default"
          onClick={() => scrollToToday()}
        >
          {t("Today")}
        </Button>
        <SegmentedControl
          size="xs"
          value={scale}
          onChange={(next) => changeScale(next as DatabaseTimelineScale)}
          data={[
            { value: "day", label: t("Day") },
            { value: "week", label: t("Week") },
            { value: "month", label: t("Month") },
          ]}
        />
      </Group>
      <div
        ref={scrollRef}
        className={classes.ganttScroll}
        style={
          {
            "--gantt-label": `${LABEL_WIDTH}px`,
            "--gantt-row": `${ROW_HEIGHT}px`,
          } as CSSProperties
        }
      >
        <div
          className={classes.ganttCanvas}
          style={{ width: LABEL_WIDTH + width }}
        >
          <div className={classes.ganttHeader}>
            <div className={classes.ganttCorner}>
              {title?.name || t("Title")}
            </div>
            <div className={classes.ganttScale} style={{ width }}>
              <div className={classes.ganttScaleRow}>
                {major.map((span) => (
                  <div
                    key={span.date}
                    className={classes.ganttMajor}
                    style={{
                      left: span.offset * dayWidth,
                      width: span.days * dayWidth,
                    }}
                  >
                    <span>{label(span, "major")}</span>
                  </div>
                ))}
              </div>
              <div className={classes.ganttScaleRow}>
                {minor.map((span) => (
                  <div
                    key={span.date}
                    className={classes.ganttMinor}
                    data-today={
                      (span.date <= todayKey &&
                        todayKey < addDatabaseDays(span.date, span.days)) ||
                      undefined
                    }
                    style={{
                      left: span.offset * dayWidth,
                      width: span.days * dayWidth,
                    }}
                  >
                    {label(span, "minor")}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className={classes.ganttBody}>
            <div
              className={classes.ganttGrid}
              style={{ left: LABEL_WIDTH, width }}
              aria-hidden
            >
              {minor.map((span) => {
                const day = parseDateKey(span.date).getDay();
                return (
                  <div
                    key={span.date}
                    className={classes.ganttGridLine}
                    data-weekend={
                      (scale === "day" && (day === 0 || day === 6)) || undefined
                    }
                    style={{
                      left: span.offset * dayWidth,
                      width: span.days * dayWidth,
                    }}
                  />
                );
              })}
              <div
                className={classes.ganttToday}
                style={{ left: (offsetOf(todayKey) + 0.5) * dayWidth }}
              />
            </div>
            {rows.map((row) => {
              const range = shownRange(row);
              const summary = summarizeRow(
                [title, ...fields].filter(Boolean),
                row,
                db.locale,
              );
              const name = summary.title || t("Untitled");
              const left = range ? offsetOf(range.start) * dayWidth : 0;
              const barWidth = range
                ? (diffDatabaseDays(range.start, range.end) + 1) * dayWidth
                : 0;
              const inside = barWidth >= MIN_LABEL_WIDTH;
              const ghost =
                !range && hover?.rowId === row.id ? hover.date : null;
              return (
                <div key={row.id} className={classes.ganttRow}>
                  <UnstyledButton
                    className={classes.ganttLabel}
                    onClick={() => db.openRow(row.id)}
                  >
                    {summary.title ? (
                      <Highlighted text={summary.title} search={db.search} />
                    ) : (
                      <span className={classes.placeholder}>
                        {t("Untitled")}
                      </span>
                    )}
                  </UnstyledButton>
                  <div
                    className={classes.ganttTrack}
                    style={{ width }}
                    data-schedulable={(!range && db.editable) || undefined}
                    title={
                      !range && db.editable ? t("Click to schedule") : undefined
                    }
                    onPointerMove={
                      !range && db.editable
                        ? (event) =>
                            setHover({
                              rowId: row.id,
                              date: dateAt(trackX(event)),
                            })
                        : undefined
                    }
                    onPointerLeave={() => setHover(null)}
                    onClick={
                      !range && db.editable
                        ? (event) => {
                            const date = dateAt(trackX(event));
                            db.apply((tr, pos) =>
                              setDatabaseCellValue(
                                tr,
                                pos,
                                row.id,
                                dateColumnId,
                                date,
                              ),
                            );
                          }
                        : undefined
                    }
                  >
                    {ghost && (
                      <div
                        className={classes.ganttGhost}
                        style={{
                          left: offsetOf(ghost) * dayWidth,
                          width: dayWidth,
                        }}
                      />
                    )}
                    {range && (
                      <>
                        <div
                          role="button"
                          tabIndex={0}
                          className={classes.ganttBar}
                          data-dragging={
                            (drag?.rowId === row.id && drag.moved) || undefined
                          }
                          data-editable={db.editable || undefined}
                          style={
                            {
                              left,
                              width: barWidth,
                              "--bar-color": `var(--mantine-color-${summary.color}-6)`,
                              "--bar-tint": `var(--mantine-color-${summary.color}-light)`,
                            } as CSSProperties
                          }
                          title={`${name} · ${formatDateValue(range.start, db.locale)}${
                            range.end !== range.start
                              ? ` – ${formatDateValue(range.end, db.locale)}`
                              : ""
                          }`}
                          onPointerDown={(event) =>
                            startDrag(event, row.id, "move")
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              db.openRow(row.id);
                            }
                          }}
                        >
                          {resizable && (
                            <span
                              className={classes.ganttHandle}
                              data-edge="start"
                              onPointerDown={(event) =>
                                startDrag(event, row.id, "start")
                              }
                            />
                          )}
                          {inside && (
                            <span className={classes.ganttBarTitle}>
                              {name}
                            </span>
                          )}
                          {resizable && (
                            <span
                              className={classes.ganttHandle}
                              data-edge="end"
                              onPointerDown={(event) =>
                                startDrag(event, row.id, "end")
                              }
                            />
                          )}
                        </div>
                        {!inside && (
                          <span
                            className={classes.ganttOutsideTitle}
                            style={{ left: left + barWidth + 6 }}
                          >
                            {name}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            {db.editable && (
              <div className={classes.ganttRow}>
                <UnstyledButton
                  className={classes.ganttNew}
                  aria-label={t("New row")}
                  onClick={addRow}
                >
                  <IconPlus size={14} />
                  <span>{t("New")}</span>
                </UnstyledButton>
                <div className={classes.ganttTrack} style={{ width }} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
