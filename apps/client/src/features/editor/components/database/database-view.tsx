import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import type { Transaction } from "@tiptap/pm/state";
import { Group, Text } from "@mantine/core";
import { useAtomValue } from "jotai";
import { userAtom } from "@/features/user/atoms/current-user-atom";
import { useTranslation } from "react-i18next";
import {
  normalizeDatabaseColumns,
  normalizeDatabaseFilter,
  normalizeDatabaseViews,
  normalizeDatabaseAlign,
  readDatabaseRows,
  updateDatabaseColumn,
  setDatabaseTitle,
  setDatabaseTitleAlign,
  addDatabaseView,
  updateDatabaseView,
  type DatabaseAlign,
  type DatabaseFilterGroup,
} from "@docmost/editor-ext";
import {
  isTextTarget,
  ownsEvent,
  rowsOf,
  useViewRows,
  type DatabaseContext,
  type DatabaseFilterDraft,
} from "./database-context";
import { DatabaseViewTabs } from "./database-view-tabs";
import { DatabaseToolbar } from "./database-toolbar";
import { AlignPicker } from "./database-ui";
import { DatabaseRowDetail } from "./database-row-detail";
import DatabaseTableView from "./database-table-view";
import DatabaseKanbanView from "./database-kanban-view";
import DatabaseCalendarView from "./database-calendar-view";
import DatabaseTimelineView from "./database-timeline-view";
import DatabaseAgendaView from "./database-agenda-view";
import { pageIdsOf, usePageInfo, withPageInfo } from "./use-page-info";
import classes from "./database.module.css";

/** The active view is a per-user choice, so it lives in localStorage, not in the shared doc. */
function useActiveViewId(databaseId: string | null) {
  const key = databaseId ? `akasha.database.view.${databaseId}` : null;
  const [viewId, setViewId] = useState<string | null>(() =>
    key ? localStorage.getItem(key) : null,
  );
  const select = useCallback(
    (id: string) => {
      setViewId(id);
      if (key) localStorage.setItem(key, id);
    },
    [key],
  );
  return [viewId, select] as const;
}

function TitleInput({
  value,
  align,
  editable,
  onCommit,
  onAlign,
}: {
  value: string;
  align: DatabaseAlign;
  editable: boolean;
  onCommit: (title: string) => void;
  onAlign: (align: DatabaseAlign) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (!editable && !value) return null;
  return (
    <div className={classes.titleRow}>
      <input
        className={classes.title}
        style={{ textAlign: align }}
        value={draft}
        readOnly={!editable}
        placeholder={t("Untitled database")}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => draft !== value && onCommit(draft)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === "Escape")
            event.currentTarget.blur();
        }}
      />
      {editable && (
        <AlignPicker
          value={align}
          onChange={onAlign}
          className={classes.titleAlign}
        />
      )}
    </div>
  );
}

function useEditorEditable(editor: NodeViewProps["editor"]) {
  const [editable, setEditable] = useState(editor.isEditable);
  useEffect(() => {
    const sync = () => setEditable(editor.isEditable);
    sync();
    editor.on("update", sync);
    editor.on("transaction", sync);
    return () => {
      editor.off("update", sync);
      editor.off("transaction", sync);
    };
  }, [editor]);
  return editable;
}

export default function DatabaseView(props: NodeViewProps) {
  const { node, editor, getPos } = props;
  const { t, i18n } = useTranslation();
  const editable = useEditorEditable(editor);
  const stored = useMemo(
    () => normalizeDatabaseColumns(node.attrs.columns),
    [node.attrs.columns],
  );
  const views = useMemo(
    () => normalizeDatabaseViews(node.attrs.views, stored),
    [node.attrs.views, stored],
  );
  // Documents are stored as ids; titles come from a lookup with this viewer's permissions.
  const pageInfo = usePageInfo(pageIdsOf(stored));
  const columns = useMemo(
    () => withPageInfo(stored, pageInfo),
    [stored, pageInfo],
  );
  const user = useAtomValue(userAtom);
  const rows = useMemo(() => readDatabaseRows(node), [node]);
  const [activeViewId, setActiveViewId] = useActiveViewId(node.attrs.id);
  const view = views.find((item) => item.id === activeViewId) ?? views[0];
  const [searches, setSearches] = useState<Record<string, string>>({});
  const [openRowId, setOpenRowId] = useState<string | null>(null);

  const apply = useCallback(
    (build: (tr: Transaction, dbPos: number) => unknown) => {
      const pos = typeof getPos === "function" ? getPos() : undefined;
      if (typeof pos !== "number" || !editor.isEditable) return;
      const tr = editor.state.tr;
      build(tr, pos);
      if (tr.docChanged) editor.view.dispatch(tr);
    },
    [editor, getPos],
  );

  const [draft, setDraft] = useState<{
    viewId: string;
    filter: DatabaseFilterGroup;
  } | null>(null);
  // Local drafts must follow schema changes just like the stored view filters.
  const draftFilter = useMemo(
    () =>
      draft?.viewId === view.id
        ? normalizeDatabaseFilter(draft.filter, columns)
        : null,
    [draft, view.id, columns],
  );
  const filterDraft: DatabaseFilterDraft = {
    dirty: !!draftFilter,
    change: (filter) => setDraft({ viewId: view.id, filter }),
    reset: () => setDraft(null),
    save: () => {
      if (!draftFilter) return;
      apply((tr, pos) =>
        updateDatabaseView(tr, pos, view.id, { filter: draftFilter }),
      );
      setDraft(null);
    },
    saveAsView: () => {
      let id = "";
      apply((tr, pos) => {
        const { id: _id, ...settings } = view;
        id = addDatabaseView(tr, pos, {
          ...settings,
          name: t("{{name}} (filtered)", { name: view.name }),
          filter: draftFilter ?? view.filter,
        });
      });
      setDraft(null);
      if (id) setActiveViewId(id);
    },
  };

  const base: DatabaseContext = {
    columns,
    rows,
    views,
    view: draftFilter ? { ...view, filter: draftFilter } : view,
    filterDraft,
    editable,
    locale: i18n.language,
    search: searches[view.id] ?? "",
    apply,
    openRow: setOpenRowId,
    setActiveView: setActiveViewId,
  };
  const mineColumn = columns.find((column) => column.type === "person");
  // "Mine" is a table over the viewer's rows; new rows there are assigned to the viewer.
  const db: DatabaseContext =
    view.type === "mine" && user && mineColumn
      ? {
          ...base,
          rows: rowsOf(base, user.id),
          prepareRow: (tr, pos) => {
            const options = mineColumn.options ?? [];
            if (!options.some((option) => option.id === user.id))
              updateDatabaseColumn(tr, pos, mineColumn.id, {
                options: [
                  ...options,
                  {
                    id: user.id,
                    name: user.name,
                    color: "blue",
                    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
                  },
                ],
              });
            return { [mineColumn.id]: [user.id] };
          },
        }
      : base;
  const order = useViewRows(db).map((row) => row.id);
  const closeRow = useCallback(() => setOpenRowId(null), []);

  return (
    <NodeViewWrapper
      className={classes.wrapper}
      data-database-id={node.attrs.id || undefined}
      contentEditable={false}
      onMouseDown={(event: MouseEvent) => {
        // Keep focus out of the ProseMirror root: otherwise Backspace typed
        // "inside" the block would be handled by the editor.
        const target = event.target as HTMLElement;
        if (
          !ownsEvent(event) ||
          isTextTarget(target) ||
          target.closest("button,a,input,[role=button],[data-db-focus]")
        )
          return;
        event.preventDefault();
        (event.currentTarget as HTMLElement).focus({ preventScroll: true });
      }}
      tabIndex={-1}
      onKeyDown={(event: KeyboardEvent) => {
        if (
          !ownsEvent(event) ||
          isTextTarget(event.target) ||
          !(event.metaKey || event.ctrlKey)
        )
          return;
        const key = event.key.toLowerCase();
        const redo = (key === "z" && event.shiftKey) || key === "y";
        if (key !== "z" && !redo) return;
        // Events inside the view never reach ProseMirror, so forward undo/redo.
        event.preventDefault();
        const commands = editor.commands as any;
        if (redo) commands.redo?.();
        else commands.undo?.();
      }}
    >
      <TitleInput
        value={String(node.attrs.title || "")}
        align={normalizeDatabaseAlign(node.attrs.titleAlign) ?? "left"}
        editable={editable}
        onCommit={(title) =>
          apply((tr, pos) => setDatabaseTitle(tr, pos, title))
        }
        onAlign={(align) =>
          apply((tr, pos) => setDatabaseTitleAlign(tr, pos, align))
        }
      />
      <Group
        justify="space-between"
        wrap="nowrap"
        gap="xs"
        className={classes.viewBar}
      >
        <DatabaseViewTabs db={db} />
        <DatabaseToolbar
          db={db}
          onSearch={(value) =>
            setSearches((current) => ({ ...current, [view.id]: value }))
          }
        />
      </Group>
      {view.type === "kanban" ? (
        <DatabaseKanbanView db={db} />
      ) : view.type === "calendar" ? (
        <DatabaseCalendarView db={db} />
      ) : view.type === "timeline" ? (
        <DatabaseTimelineView db={db} />
      ) : view.type === "agenda" ? (
        <DatabaseAgendaView db={db} />
      ) : view.type === "mine" && !mineColumn ? (
        <Text size="sm" c="dimmed" ta="center" p="lg">
          {t("Add a member property to see the rows assigned to you.")}
        </Text>
      ) : (
        <DatabaseTableView key={view.id} db={db} />
      )}
      <DatabaseRowDetail
        db={db}
        databaseId={String(node.attrs.id || "")}
        rowId={openRowId}
        order={order}
        onNavigate={setOpenRowId}
        onClose={closeRow}
      />
    </NodeViewWrapper>
  );
}
