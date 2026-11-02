import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Button,
  Group,
  Popover,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { IconChevronsRight, IconEye, IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  addDatabaseColumn,
  generateNodeId,
  getDatabaseGroupMoveValue,
  groupDatabaseRows,
  isDatabaseReference,
  moveDatabaseCard,
  nextDatabaseOptionColor,
  updateDatabaseColumn,
  updateDatabaseView,
  DATABASE_EMPTY_GROUP,
  type DatabaseColumn,
  type DatabaseGroup,
} from "@docmost/editor-ext";
import {
  stopBubbling,
  createRow,
  patchView,
  useViewRows,
  type DatabaseContext,
} from "./database-context";
import { KanbanCard } from "./database-kanban-card";
import {
  GroupName,
  KanbanGroupHeader,
  groupLabel,
} from "./database-kanban-group";
import { MenuRow, OptionLabel } from "./database-ui";
import { elementAt, hitTestList, usePointerDrag } from "./use-pointer-drag";
import { focusWithoutScroll, moveItem } from "./database-utils";
import classes from "./database.module.css";

interface CardDrag {
  rowId: string;
  fromKey: string;
}

interface CardDrop {
  key: string;
  /** Insert index among the lane's cards without the dragged one. */
  index: number;
}

export default function DatabaseKanbanView({ db }: { db: DatabaseContext }) {
  const { t } = useTranslation();
  const boardRef = useRef<HTMLDivElement>(null);
  const rows = useViewRows(db);
  const column = db.columns.find((item) => item.id === db.view.groupBy);
  // The ungrouped lane only shows while it has cards.
  const groups = useMemo(
    () =>
      column
        ? groupDatabaseRows(rows, column, db.view).filter(
            (group) =>
              group.key !== DATABASE_EMPTY_GROUP || group.rows.length > 0,
          )
        : [],
    [rows, column, db.view],
  );
  const hidden = new Set(db.view.hiddenGroups);
  const shown = groups.filter(
    (group) =>
      !hidden.has(group.key) &&
      !(db.view.hideEmptyGroups && !group.rows.length),
  );
  const hiddenGroups = groups.filter((group) => hidden.has(group.key));
  // Viewers may reveal cards without writing to the shared view configuration.
  const [localExpanded, setLocalExpanded] = useState<Record<string, string[]>>(
    {},
  );
  const expanded = new Set(localExpanded[db.view.id] ?? []);
  const collapsedKeys = new Set(
    db.view.collapsedGroups.filter((key) => db.editable || !expanded.has(key)),
  );
  const toggleCollapsed = (key: string) => {
    if (!db.editable) {
      setLocalExpanded((current) => ({
        ...current,
        [db.view.id]: [...(current[db.view.id] ?? []), key],
      }));
      return;
    }
    patchView(db, {
      collapsedGroups: collapsedKeys.has(key)
        ? db.view.collapsedGroups.filter((item) => item !== key)
        : [...db.view.collapsedGroups, key],
    });
  };
  const [drop, setDrop] = useState<CardDrop | null>(null);
  const [groupDrop, setGroupDrop] = useState<number | null>(null);
  // Horizontal: each group is a row of cards; groups stack top to bottom.
  const horizontal = db.view.orientation === "horizontal";
  const laneAxis = horizontal ? "y" : "x";
  useSidewaysWheel(boardRef, horizontal);

  const hitCard = (drag: CardDrag, x: number, y: number): CardDrop | null => {
    const lane = elementAt(x, y, "[data-lane-key]");
    if (!lane || !boardRef.current?.contains(lane)) return null;
    const selector = `[data-card-id]:not([data-card-id="${CSS.escape(drag.rowId)}"])`;
    return {
      key: lane.dataset.laneKey!,
      index: hitTestList(lane, selector, horizontal ? "x" : "y", x, y),
    };
  };

  const cardDrag = usePointerDrag<CardDrag>({
    scrollContainer: () => boardRef.current,
    tilt: -3,
    onMove: (drag, x, y) => setDrop(hitCard(drag, x, y)),
    onDrop: (drag, x, y) => {
      setDrop(null);
      const target = hitCard(drag, x, y);
      const lane = target && groups.find((group) => group.key === target.key);
      if (!target || !lane) return;
      // A sorted view has no manual order: only moves between lanes count.
      if (db.view.sorts.length && target.key === drag.fromKey) return;
      const cards = lane.rows.filter((row) => row.id !== drag.rowId);
      const beforeRowId = cards[target.index]?.id ?? null;
      db.apply((tr, pos) =>
        moveDatabaseCard(tr, pos, db.view.id, {
          ...drag,
          toKey: target.key,
          beforeRowId,
        }),
      );
    },
    onCancel: () => setDrop(null),
  });

  const groupDrag = usePointerDrag<string>({
    scrollContainer: () => boardRef.current,
    onMove: (_, x, y) =>
      setGroupDrop(
        hitTestList(boardRef.current, "[data-lane-key]", laneAxis, x, y),
      ),
    onDrop: (key, x, y) => {
      setGroupDrop(null);
      const to = hitTestList(
        boardRef.current,
        "[data-lane-key]",
        laneAxis,
        x,
        y,
      );
      const keys = shown.map((group) => group.key);
      const from = keys.indexOf(key);
      if (from < 0 || to === from || to === from + 1) return;
      const reordered = moveItem(keys, from, to);
      patchView(db, {
        groupOrder: [
          ...reordered,
          ...groups
            .map((group) => group.key)
            .filter((k) => !reordered.includes(k)),
        ],
      });
    },
    onCancel: () => setGroupDrop(null),
  });

  if (!column) return <NoGroupColumn db={db} />;

  /** New card in `group`, placed relative to `anchorId` in the lane's manual order, then opened. */
  const insertCard = (
    group: DatabaseGroup,
    anchorId: string | null,
    side: "above" | "below" | "top" | "bottom",
  ) => {
    const value = getDatabaseGroupMoveValue(
      column,
      null,
      DATABASE_EMPTY_GROUP,
      group.key,
    );
    const id = createRow(
      db,
      { values: { [column.id]: value } },
      (tr, pos, rowId) => {
        if (db.view.sorts.length) return;
        const ids = group.rows.map((row) => row.id);
        const at =
          side === "top"
            ? 0
            : side === "bottom" || !anchorId
              ? ids.length
              : ids.indexOf(anchorId) + (side === "below" ? 1 : 0);
        ids.splice(at, 0, rowId);
        updateDatabaseView(tr, pos, db.view.id, {
          cardOrder: { ...db.view.cardOrder, [group.key]: ids },
        });
      },
    );
    if (id) db.openRow(id);
  };

  const moveTo = (group: DatabaseGroup, rowId: string, close: () => void) => {
    const others = groups.filter((item) => item.key !== group.key);
    if (!others.length) return null;
    return (
      <>
        <Text size="xs" c="dimmed" px={8} pt={4} pb={2}>
          {t("Move to")}
        </Text>
        {others.map((target) => (
          <MenuRow
            key={target.key}
            label={
              target.option ? (
                <OptionLabel type={column.type} option={target.option} menu />
              ) : (
                groupLabel(column, target, t)
              )
            }
            onClick={() => {
              close();
              db.apply((tr, pos) =>
                moveDatabaseCard(tr, pos, db.view.id, {
                  rowId,
                  fromKey: group.key,
                  toKey: target.key,
                  beforeRowId: null,
                }),
              );
            }}
          />
        ))}
      </>
    );
  };

  const showIndicator = !db.view.sorts.length;

  return (
    <div>
      {hiddenGroups.length > 0 && (
        <HiddenGroups db={db} column={column} groups={hiddenGroups} />
      )}
      <div
        ref={boardRef}
        className={classes.kanban}
        data-align={horizontal ? undefined : db.view.align}
        data-orientation={db.view.orientation}
        data-card-size={db.view.cardSize}
      >
        {shown.map((group, laneIndex) => {
          let index = 0;
          const isTarget = drop?.key === group.key;
          const collapsed = collapsedKeys.has(group.key);
          if (collapsed)
            return (
              <CollapsedLane
                key={group.key}
                column={column}
                group={group}
                dropTarget={isTarget}
                onExpand={() => toggleCollapsed(group.key)}
              />
            );
          return (
            <div
              key={group.key}
              className={classes.lane}
              data-lane-key={group.key}
              data-drop-target={isTarget || undefined}
              data-drop-before={groupDrop === laneIndex || undefined}
              data-drop-after={
                (groupDrop === shown.length &&
                  laneIndex === shown.length - 1) ||
                undefined
              }
              data-dragging={groupDrag.dragging === group.key || undefined}
            >
              <KanbanGroupHeader
                db={db}
                column={column}
                group={group}
                onAddCard={() => insertCard(group, null, "top")}
                onCollapse={() => toggleCollapsed(group.key)}
                onPointerDown={
                  db.editable
                    ? (event) =>
                        groupDrag.onPointerDown(
                          event,
                          group.key,
                          event.currentTarget.closest<HTMLElement>(
                            "[data-lane-key]",
                          ),
                        )
                    : undefined
                }
              />
              <div className={classes.laneCards}>
                {group.rows.map((row) => {
                  // A multi-select card can sit in several lanes; hit testing skips every copy.
                  const isDragged = cardDrag.dragging?.rowId === row.id;
                  const dragged =
                    isDragged && cardDrag.dragging!.fromKey === group.key;
                  const position = isDragged ? -1 : index++;
                  return (
                    <div key={row.id}>
                      {showIndicator &&
                        isTarget &&
                        drop!.index === position && (
                          <div className={classes.dropIndicator} />
                        )}
                      <KanbanCard
                        db={db}
                        row={row}
                        groupColumnId={column.id}
                        dragging={dragged}
                        onPointerDown={
                          db.editable
                            ? (event) =>
                                cardDrag.onPointerDown(event, {
                                  rowId: row.id,
                                  fromKey: group.key,
                                })
                            : undefined
                        }
                        onInsert={(side) => insertCard(group, row.id, side)}
                        menuExtra={(close) => moveTo(group, row.id, close)}
                      />
                    </div>
                  );
                })}
                {showIndicator && isTarget && drop!.index >= index && (
                  <div className={classes.dropIndicator} />
                )}
              </div>
              {db.editable && !horizontal && (
                <Button
                  size="xs"
                  variant="subtle"
                  color="gray"
                  fullWidth
                  justify="flex-start"
                  leftSection={<IconPlus size={14} />}
                  onClick={() => insertCard(group, null, "bottom")}
                >
                  {t("New")}
                </Button>
              )}
            </div>
          );
        })}
        {db.editable &&
          column.type !== "checkbox" &&
          !isDatabaseReference(column.type) && (
            <AddGroupButton db={db} column={column} />
          )}
      </div>
    </div>
  );
}

/**
 * On a horizontal board, a vertical wheel over a row of cards scrolls it
 * sideways while it can still move; at either end the page scrolls as usual.
 * Native and non-passive, since React's wheel listener cannot preventDefault.
 */
function useSidewaysWheel(
  board: RefObject<HTMLDivElement | null>,
  enabled: boolean,
) {
  useEffect(() => {
    const element = board.current;
    if (!element || !enabled) return;
    const onWheel = (event: globalThis.WheelEvent) => {
      const lane = (event.target as HTMLElement).closest<HTMLElement>(
        `.${classes.laneCards}`,
      );
      if (!lane || event.deltaX || lane.scrollWidth <= lane.clientWidth) return;
      const max = lane.scrollWidth - lane.clientWidth;
      const next = Math.min(Math.max(lane.scrollLeft + event.deltaY, 0), max);
      if (next === lane.scrollLeft) return;
      lane.scrollLeft = next;
      event.preventDefault();
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [board, enabled]);
}

/** A folded lane: a narrow strip with the group name and count; cards can still be dropped on it. */
function CollapsedLane({
  column,
  group,
  dropTarget,
  onExpand,
}: {
  column: DatabaseColumn;
  group: DatabaseGroup;
  dropTarget: boolean;
  onExpand: () => void;
}) {
  const { t } = useTranslation();
  return (
    <UnstyledButton
      className={classes.laneCollapsed}
      data-lane-key={group.key}
      data-drop-target={dropTarget || undefined}
      title={t("Expand group")}
      onClick={onExpand}
    >
      <IconChevronsRight size={14} className={classes.menuIcon} />
      <span className={classes.laneCollapsedLabel}>
        <GroupName column={column} group={group} />
      </span>
      <Text size="xs" c="dimmed">
        {group.rows.length}
      </Text>
    </UnstyledButton>
  );
}

function HiddenGroups({
  db,
  column,
  groups,
}: {
  db: DatabaseContext;
  column: DatabaseColumn;
  groups: DatabaseGroup[];
}) {
  const { t } = useTranslation();
  return (
    <Popover position="bottom-start" width={220} shadow="md" withinPortal>
      <Popover.Target>
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          mb={4}
          leftSection={<IconEye size={12} />}
        >
          {t("{{count}} hidden groups", { count: groups.length })}
        </Button>
      </Popover.Target>
      <Popover.Dropdown {...stopBubbling} p={4} className={classes.menu}>
        {groups.map((group) => (
          <MenuRow
            key={group.key}
            label={
              <Group gap={6} wrap="nowrap">
                {group.option ? (
                  <OptionLabel type={column.type} option={group.option} menu />
                ) : (
                  groupLabel(column, group, t)
                )}
                <Text size="xs" c="dimmed">
                  {group.rows.length}
                </Text>
              </Group>
            }
            hint={db.editable ? t("Show") : undefined}
            onClick={() =>
              db.editable &&
              patchView(db, {
                hiddenGroups: db.view.hiddenGroups.filter(
                  (key) => key !== group.key,
                ),
              })
            }
          />
        ))}
      </Popover.Dropdown>
    </Popover>
  );
}

function NoGroupColumn({ db }: { db: DatabaseContext }) {
  const { t } = useTranslation();
  return (
    <Stack align="center" gap="xs" p="lg">
      <Text size="sm" c="dimmed">
        {t(
          "Kanban needs a select, multi-select or checkbox field to group by.",
        )}
      </Text>
      {db.editable && (
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() =>
            db.apply((tr, pos) => {
              const options = [t("To do"), t("In progress"), t("Done")].reduce<
                DatabaseColumn["options"]
              >(
                (list, name) => [
                  ...list!,
                  {
                    id: generateNodeId(),
                    name,
                    color: nextDatabaseOptionColor(list!),
                  },
                ],
                [],
              );
              const id = addDatabaseColumn(tr, pos, {
                name: t("Status"),
                type: "select",
                options,
              });
              updateDatabaseView(tr, pos, db.view.id, { groupBy: id });
            })
          }
        >
          {t("Create status field")}
        </Button>
      )}
    </Stack>
  );
}

function AddGroupButton({
  db,
  column,
}: {
  db: DatabaseContext;
  column: DatabaseColumn;
}) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const [name, setName] = useState("");
  const add = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const options = column.options ?? [];
    db.apply((tr, pos) =>
      updateDatabaseColumn(tr, pos, column.id, {
        options: [
          ...options,
          {
            id: generateNodeId(),
            name: trimmed,
            color: nextDatabaseOptionColor(options),
          },
        ],
      }),
    );
    setName("");
    setOpened(false);
  };
  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-start"
      width={220}
      shadow="md"
      withinPortal
    >
      <Popover.Target>
        <Button
          size="xs"
          variant="subtle"
          color="gray"
          leftSection={<IconPlus size={14} />}
          className={classes.addLane}
          onClick={() => setOpened((value) => !value)}
        >
          {t("New group")}
        </Button>
      </Popover.Target>
      <Popover.Dropdown {...stopBubbling} p="xs">
        <TextInput
          size="xs"
          ref={focusWithoutScroll}
          placeholder={t("Group name")}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") add();
          }}
        />
      </Popover.Dropdown>
    </Popover>
  );
}
