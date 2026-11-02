import { useEffect, useState, type ReactNode } from "react";
import { Popover, Text, UnstyledButton } from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  readDatabaseValue,
  setDatabaseCellValue,
  updateDatabaseColumn,
  type DatabaseColumn,
  type DatabaseRowData,
  type DatabaseSelectOption,
} from "@docmost/editor-ext";
import { stopBubbling, type DatabaseContext } from "./database-context";
import { OptionLabel } from "./database-ui";
import { rememberPage } from "./use-page-info";
import classes from "./database.module.css";

/** A member or document as cached in a reference column's options. */
type Reference = Omit<DatabaseSelectOption, "color">;

/** Members (person) or documents (page) matching `query`. */
function useReferences(kind: "person" | "page", query: string) {
  const [items, setItems] = useState<Reference[]>([]);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(async () => {
      // Loaded on demand so the database view does not pull in the API client up front.
      const { searchSuggestions } =
        await import("@/features/search/services/search-service");
      const result = await searchSuggestions({
        query,
        includeUsers: kind === "person",
        includePages: kind === "page",
        limit: 8,
      }).catch(() => null);
      if (!alive) return;
      setItems(
        kind === "person"
          ? ((result?.users ?? []) as Reference[])
          : (result?.pages ?? []).map((page) => ({
              id: page.id,
              name: page.title ?? "",
              icon: page.icon || undefined,
              slugId: page.slugId,
              spaceSlug: page.space?.slug,
            })),
      );
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [kind, query]);
  return items;
}

/** Only fields with a value are cached, so options stay small. */
function toOption(item: Reference): DatabaseSelectOption {
  const option: DatabaseSelectOption = {
    id: item.id,
    name: item.name,
    color: "blue",
  };
  for (const key of ["avatarUrl", "icon", "slugId", "spaceSlug"] as const) {
    if (item[key]) option[key] = item[key];
  }
  return option;
}

/**
 * Popover for a member or document column: the row's references first, then
 * search results. Picking toggles one; a new one is cached in the options.
 */
export function ReferenceEditor({
  db,
  row,
  column,
  anchor,
  onDone,
}: {
  db: DatabaseContext;
  row: DatabaseRowData;
  column: DatabaseColumn;
  anchor: ReactNode;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const kind = column.type === "page" ? "page" : "person";
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useReferences(kind, query);
  const known = column.options ?? [];
  const selected = readDatabaseValue(column, row) as string[];
  const chosen = known.filter((option) => selected.includes(option.id));
  const list: Reference[] = [
    ...chosen,
    ...results.filter((item) => !selected.includes(item.id)),
  ];

  const toggle = (item: Reference) => {
    // Picked from this viewer's search, so it is visible to them.
    if (kind === "page" && item.slugId)
      rememberPage(item.id, {
        title: item.name,
        icon: item.icon,
        slugId: item.slugId,
        spaceSlug: item.spaceSlug,
      });
    db.apply((tr, pos) => {
      if (!known.some((option) => option.id === item.id)) {
        updateDatabaseColumn(tr, pos, column.id, {
          options: [...known, toOption(item)],
        });
      }
      const next = selected.includes(item.id)
        ? selected.filter((id) => id !== item.id)
        : [...selected, item.id];
      setDatabaseCellValue(tr, pos, row.id, column.id, next);
    });
  };

  return (
    <Popover
      opened
      onChange={(opened) => !opened && onDone()}
      position="bottom-start"
      width={260}
      shadow="md"
      withinPortal
    >
      <Popover.Target>
        <div className={classes.editorAnchor}>{anchor}</div>
      </Popover.Target>
      <Popover.Dropdown {...stopBubbling} p={4} className={classes.menu}>
        <input
          autoFocus
          className={classes.tagInput}
          style={{ padding: "4px 6px" }}
          placeholder={
            kind === "page" ? t("Search pages") : t("Search members")
          }
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!list.length) return;
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((active + step + list.length) % list.length);
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (list[active]) toggle(list[active]);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onDone();
            }
          }}
        />
        {list.length === 0 && (
          <Text size="xs" c="dimmed" px={8} py={6}>
            {kind === "page" ? t("No pages found") : t("No members found")}
          </Text>
        )}
        {list.map((item, index) => (
          <UnstyledButton
            key={item.id}
            className={classes.menuRow}
            data-active={index === active || undefined}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => toggle(item)}
          >
            <OptionLabel type={column.type} option={toOption(item)} menu />
            {selected.includes(item.id) && (
              <IconCheck size={14} style={{ marginLeft: "auto" }} />
            )}
          </UnstyledButton>
        ))}
      </Popover.Dropdown>
    </Popover>
  );
}
