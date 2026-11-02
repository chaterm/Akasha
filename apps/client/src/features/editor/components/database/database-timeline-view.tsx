import { useMemo, useState, type CSSProperties } from "react";
import { ActionIcon, Avatar, UnstyledButton } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  diffDatabaseDays,
  getDatabaseDateRange,
  moveDatabaseRowToDate,
  type DatabaseRowData,
} from "@docmost/editor-ext";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import {
  createRow,
  useViewRows,
  visibleColumns,
  type DatabaseContext,
} from "./database-context";
import { NoDateColumn } from "./database-calendar-view";
import { formatDateValue } from "./database-cells";
import { Highlighted } from "./database-ui";
import { parseDateKey, summarizeRow, toDateKey } from "./database-utils";
import { elementAt, usePointerDrag } from "./use-pointer-drag";
import classes from "./database.module.css";

interface Entry {
  row: DatabaseRowData;
  start?: string;
  end?: string;
}

/**
 * A vertical time axis showing only the dates that have rows, grouped by
 * month; rows without a date follow at the end. Drag an entry onto another
 * date to move it there; click it to open the row.
 */
export default function DatabaseTimelineView({ db }: { db: DatabaseContext }) {
  const { t } = useTranslation();
  const rows = useViewRows(db);
  const { view } = db;
  const fields = visibleColumns(db).filter(
    (column) =>
      column.id !== view.dateColumnId && column.id !== view.endDateColumnId,
  );
  const todayKey = toDateKey(new Date());
  const [dropDate, setDropDate] = useState<string | null>(null);

  const { months, undated } = useMemo(() => {
    const byDate = new Map<string, Entry[]>();
    const undated: Entry[] = [];
    for (const row of rows) {
      const range = getDatabaseDateRange(row, view);
      if (!range) {
        undated.push({ row });
        continue;
      }
      const list = byDate.get(range.start) ?? [];
      list.push({ row, ...range });
      byDate.set(range.start, list);
    }
    const months: { key: string; dates: [string, Entry[]][] }[] = [];
    const sorted = [...byDate].sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [date, entries] of sorted) {
      const key = date.slice(0, 7);
      if (months.at(-1)?.key !== key) months.push({ key, dates: [] });
      months.at(-1)!.dates.push([date, entries]);
    }
    return { months, undated };
  }, [rows, view]);

  const dateAt = (x: number, y: number) =>
    elementAt(x, y, "[data-timeline-date]")?.dataset.timelineDate ?? null;
  const drag = usePointerDrag<string>({
    tilt: -2,
    cursor: "grabbing",
    onMove: (_, x, y) => setDropDate(dateAt(x, y)),
    onDrop: (rowId, x, y) => {
      setDropDate(null);
      const date = dateAt(x, y);
      if (date)
        db.apply((tr, pos) =>
          moveDatabaseRowToDate(tr, pos, view.id, rowId, date),
        );
    },
    onCancel: () => setDropDate(null),
  });

  if (!view.dateColumnId) return <NoDateColumn db={db} />;
  const dateColumnId = view.dateColumnId;

  const addOn = (date: string) => {
    const id = createRow(db, { values: { [dateColumnId]: date } });
    if (id) db.openRow(id);
  };

  /** "Today", "Tomorrow", "Yesterday", otherwise the weekday. */
  const relative = (date: string) => {
    const days = diffDatabaseDays(todayKey, date);
    if (days === 0) return t("Today");
    if (days === 1) return t("Tomorrow");
    if (days === -1) return t("Yesterday");
    return parseDateKey(date).toLocaleDateString(db.locale, {
      weekday: "short",
    });
  };

  const item = (entry: Entry) => {
    const { title, tag, people, color, extra } = summarizeRow(
      fields,
      entry.row,
      db.locale,
    );
    const span =
      entry.start && entry.end && entry.end !== entry.start
        ? diffDatabaseDays(entry.start, entry.end) + 1
        : 0;
    return (
      <UnstyledButton
        key={entry.row.id}
        className={classes.timelineItem}
        data-row-id={entry.row.id}
        data-dragging={drag.dragging === entry.row.id || undefined}
        style={
          { "--bar-color": `var(--mantine-color-${color}-6)` } as CSSProperties
        }
        onPointerDown={
          db.editable
            ? (event) => drag.onPointerDown(event, entry.row.id)
            : undefined
        }
        onClick={() => db.openRow(entry.row.id)}
      >
        <span className={classes.calendarBarDot} />
        <span className={classes.timelineItemTitle}>
          {title ? (
            <Highlighted text={title} search={db.search} />
          ) : (
            <span className={classes.placeholder}>{t("Untitled")}</span>
          )}
        </span>
        {tag && <span className={classes.timelineItemMeta}>{tag.name}</span>}
        {span > 0 && (
          <span className={classes.timelineItemMeta}>
            {t("until {{date}} · {{count}} days", {
              date: formatDateValue(entry.end!, db.locale),
              count: span,
            })}
          </span>
        )}
        {extra && <span className={classes.timelineItemMeta}>{extra}</span>}
        {people.length > 0 && (
          <Avatar.Group spacing={6} className={classes.tilePeople}>
            {people.slice(0, 3).map((person) => (
              <CustomAvatar
                key={person.id}
                avatarUrl={person.avatarUrl}
                name={person.name}
                size={18}
              />
            ))}
          </Avatar.Group>
        )}
      </UnstyledButton>
    );
  };

  return (
    <div className={classes.timeline}>
      {months.map((month) => (
        <section key={month.key}>
          <div className={classes.timelineMonthLabel}>
            {parseDateKey(`${month.key}-01`).toLocaleDateString(db.locale, {
              year: "numeric",
              month: "long",
            })}
          </div>
          {month.dates.map(([date, entries]) => (
            <div
              key={date}
              className={classes.timelineDate}
              data-timeline-date={date}
              data-today={date === todayKey || undefined}
              data-past={date < todayKey || undefined}
              data-drop-target={dropDate === date || undefined}
            >
              <div className={classes.timelineDateLabel}>
                <span className={classes.timelineDayNumber}>
                  {parseDateKey(date).getDate()}
                </span>
                <span className={classes.timelineWeekday}>
                  {relative(date)}
                </span>
              </div>
              <span className={classes.timelineNode} />
              <div className={classes.timelineItems}>
                {entries.map(item)}
                {db.editable && (
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    color="gray"
                    className={classes.hoverAction}
                    aria-label={t("New")}
                    title={t("New")}
                    onClick={() => addOn(date)}
                  >
                    <IconPlus size={12} />
                  </ActionIcon>
                )}
              </div>
            </div>
          ))}
        </section>
      ))}
      {undated.length > 0 && (
        <section>
          <div className={classes.timelineMonthLabel}>
            {t("No date ({{count}})", { count: undated.length })}
          </div>
          <div className={classes.timelineDate} data-undated>
            <div className={classes.timelineDateLabel} />
            <span className={classes.timelineNode} />
            <div className={classes.timelineItems}>{undated.map(item)}</div>
          </div>
        </section>
      )}
      {db.editable && (
        <UnstyledButton
          className={classes.timelineNew}
          aria-label={t("New row")}
          title={t("New row")}
          onClick={() => addOn(todayKey)}
        >
          <IconPlus size={14} />
        </UnstyledButton>
      )}
    </div>
  );
}
