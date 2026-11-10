import type { CSSProperties, PointerEvent } from "react";
import { Avatar } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { DatabaseColumn, DatabaseRowData } from "@docmost/editor-ext";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import type { DatabaseContext } from "./database-context";
import { Highlighted } from "./database-ui";
import { summarizeRow } from "./database-utils";
import classes from "./database.module.css";

interface CalendarBarProps {
  db: DatabaseContext;
  row: DatabaseRowData;
  /** Visible non-date fields; the first is the heading, the rest follow it. */
  fields: DatabaseColumn[];
  style?: CSSProperties;
  continuesLeft?: boolean;
  continuesRight?: boolean;
  multiDay?: boolean;
  dragging?: boolean;
  /** Resize handles only make sense when the view has an end date column. */
  resizable?: boolean;
  onPointerDown?: (
    event: PointerEvent<HTMLElement>,
    mode: "move" | "start" | "end",
  ) => void;
}

export function CalendarBar({
  db,
  row,
  fields,
  style,
  continuesLeft,
  continuesRight,
  multiDay,
  dragging,
  resizable,
  onPointerDown,
}: CalendarBarProps) {
  const { t } = useTranslation();
  const summary = summarizeRow(fields, row, db.locale);
  const { tag, people, extra, color } = summary;
  const title = summary.title || t("Untitled");
  const tooltip = [title, tag?.name, extra, ...people.map((p) => p.name)]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      role="button"
      tabIndex={0}
      className={classes.calendarBar}
      style={
        {
          ...style,
          "--bar-color": `var(--mantine-color-${color}-6)`,
          "--bar-tint": `var(--mantine-color-${color}-light)`,
        } as CSSProperties
      }
      data-multi-day={multiDay || undefined}
      data-continues-left={continuesLeft || undefined}
      data-continues-right={continuesRight || undefined}
      data-dragging={dragging || undefined}
      title={tooltip}
      onPointerDown={(event) => onPointerDown?.(event, "move")}
      onClick={() => db.openRow(row.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          db.openRow(row.id);
        }
      }}
    >
      {resizable && !continuesLeft && (
        <span
          className={classes.resizeStart}
          onPointerDown={(event) => {
            event.stopPropagation();
            onPointerDown?.(event, "start");
          }}
        />
      )}
      <span className={classes.calendarBarDot} />
      <span className={classes.calendarBarTitle}>
        <Highlighted text={title} search={db.search} />
      </span>
      {extra && (
        <span className={classes.calendarBarExtra}>
          <Highlighted text={extra} search={db.search} />
        </span>
      )}
      {people.length > 0 && (
        <Avatar.Group spacing={6} className={classes.calendarBarPeople}>
          {people.slice(0, 2).map((person) => (
            <CustomAvatar
              key={person.id}
              avatarUrl={person.avatarUrl}
              name={person.name}
              size={16}
            />
          ))}
        </Avatar.Group>
      )}
      {resizable && !continuesRight && (
        <span
          className={classes.resizeEnd}
          onPointerDown={(event) => {
            event.stopPropagation();
            onPointerDown?.(event, "end");
          }}
        />
      )}
    </div>
  );
}
