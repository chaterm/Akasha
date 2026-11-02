import { useRef, useState, type PointerEvent } from "react";
import { ActionIcon, Menu, UnstyledButton } from "@mantine/core";
import {
  IconCalendar,
  IconLayoutKanban,
  IconTimeline,
  IconUserCheck,
  IconPlus,
  IconTable,
  type Icon,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  addDatabaseView,
  moveDatabaseView,
  updateDatabaseView,
  DATABASE_VIEW_TYPES,
  type DatabaseView,
  type DatabaseViewType,
} from "@docmost/editor-ext";
import type { DatabaseContext } from "./database-context";
import { stopBubbling } from "./database-context";
import { hitTestList, usePointerDrag } from "./use-pointer-drag";
import classes from "./database.module.css";

export const VIEW_ICONS: Record<DatabaseViewType, Icon> = {
  table: IconTable,
  kanban: IconLayoutKanban,
  calendar: IconCalendar,
  timeline: IconTimeline,
  mine: IconUserCheck,
};

/** i18n keys. */
export const VIEW_LABELS: Record<DatabaseViewType, string> = {
  table: "Table",
  kanban: "Kanban",
  calendar: "Calendar",
  timeline: "Timeline",
  mine: "Mine",
};

/** Props a tab needs to be dragged and to show where a dragged tab would land. */
interface TabDrag {
  dragging: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
}

function tabProps(drag: TabDrag) {
  return {
    "data-view-tab": "",
    "data-dragging": drag.dragging || undefined,
    "data-drop-before": drag.dropBefore || undefined,
    "data-drop-after": drag.dropAfter || undefined,
    onPointerDown: drag.onPointerDown,
  };
}

/** The active tab; double-click renames it in place (Enter / blur saves, Escape cancels). */
function ActiveTab({
  db,
  view,
  drag,
}: {
  db: DatabaseContext;
  view: DatabaseView;
  drag: TabDrag;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(view.name);
  const ViewIcon = VIEW_ICONS[view.type];
  const label = view.name || t(VIEW_LABELS[view.type]);

  const finish = (save: boolean) => {
    setEditing(false);
    const next = name.trim();
    if (save && next && next !== view.name)
      db.apply((tr, pos) =>
        updateDatabaseView(tr, pos, view.id, { name: next }),
      );
  };

  if (editing) {
    return (
      <div className={classes.viewTab} data-active data-view-tab="">
        <ViewIcon size={14} />
        <input
          {...stopBubbling}
          autoFocus
          className={classes.viewTabInput}
          value={name}
          size={Math.max(name.length, 2)}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setName(event.currentTarget.value)}
          onBlur={() => finish(true)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") finish(true);
            if (event.key === "Escape") finish(false);
          }}
        />
      </div>
    );
  }

  return (
    <UnstyledButton
      className={classes.viewTab}
      data-active
      {...tabProps(drag)}
      title={
        db.editable ? t("Drag to reorder, double-click to edit") : undefined
      }
      onDoubleClick={() => {
        if (!db.editable) return;
        setName(label);
        setEditing(true);
      }}
    >
      <ViewIcon size={14} />
      <span>{label}</span>
    </UnstyledButton>
  );
}

export function DatabaseViewTabs({ db }: { db: DatabaseContext }) {
  const { t } = useTranslation();
  const addView = (type: DatabaseViewType) => {
    let id = "";
    db.apply((tr, pos) => {
      id = addDatabaseView(tr, pos, { name: t(VIEW_LABELS[type]), type });
    });
    if (id) db.setActiveView(id);
  };

  const tabsRef = useRef<HTMLDivElement>(null);
  // Index of the tab the dragged one would be inserted before.
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const hit = (x: number, y: number) =>
    hitTestList(tabsRef.current, "[data-view-tab]", "x", x, y);
  const tabDrag = usePointerDrag<string>({
    onMove: (_, x, y) => setDropIndex(hit(x, y)),
    onDrop: (viewId, x, y) => {
      setDropIndex(null);
      const before = db.views[hit(x, y)]?.id ?? null;
      db.apply((tr, pos) => moveDatabaseView(tr, pos, viewId, before));
    },
    onCancel: () => setDropIndex(null),
    scrollContainer: () => tabsRef.current,
    cursor: "grabbing",
  });
  const dragOf = (id: string, index: number): TabDrag => ({
    dragging: tabDrag.dragging === id,
    dropBefore: dropIndex === index,
    dropAfter: dropIndex === db.views.length && index === db.views.length - 1,
    onPointerDown: db.editable
      ? (event) => tabDrag.onPointerDown(event, id)
      : undefined,
  });

  return (
    <div ref={tabsRef} className={classes.viewTabs}>
      {db.views.map((item, index) => {
        if (item.id === db.view.id)
          return (
            <ActiveTab
              key={item.id}
              db={db}
              view={item}
              drag={dragOf(item.id, index)}
            />
          );
        const ViewIcon = VIEW_ICONS[item.type];
        return (
          <UnstyledButton
            key={item.id}
            className={classes.viewTab}
            {...tabProps(dragOf(item.id, index))}
            onClick={() => db.setActiveView(item.id)}
          >
            <ViewIcon size={14} />
            <span>{item.name || t(VIEW_LABELS[item.type])}</span>
          </UnstyledButton>
        );
      })}
      {db.editable && (
        <Menu shadow="md" position="bottom-start" withinPortal>
          <Menu.Target>
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              aria-label={t("Add view")}
            >
              <IconPlus size={14} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown {...stopBubbling}>
            {/* "Mine" only means something once a member column exists. */}
            {DATABASE_VIEW_TYPES.filter(
              (type) =>
                type !== "mine" ||
                db.columns.some((column) => column.type === "person"),
            ).map((type) => {
              const ViewIcon = VIEW_ICONS[type];
              return (
                <Menu.Item
                  key={type}
                  leftSection={<ViewIcon size={14} />}
                  onClick={() => addView(type)}
                >
                  {t(VIEW_LABELS[type])}
                </Menu.Item>
              );
            })}
          </Menu.Dropdown>
        </Menu>
      )}
    </div>
  );
}
