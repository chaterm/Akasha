import { Kbd } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { findSlashMenuItem } from "@/features/editor/components/slash-menu/menu-items";
import { isGenerativeAiEnabled } from "@/features/editor/utils/is-generative-ai-enabled";
import classes from "./empty-page-hint.module.css";

const EXAMPLE_GROUPS = [
  {
    label: "Writing",
    shortcuts: ["ai", "h1", "h2", "h3", "todo", "ul", "ol"],
  },
  {
    label: "Content blocks",
    shortcuts: ["quote", "code", "callout", "toggle", "hr", "toc"],
  },
  {
    label: "Media and data",
    shortcuts: ["table", "database", "image", "file", "mermaid", "date"],
  },
];

export function EmptyPageHint() {
  const { t } = useTranslation();
  const aiEnabled = isGenerativeAiEnabled();
  const groups = EXAMPLE_GROUPS.map((group) => ({
    label: group.label,
    items: group.shortcuts
      .filter((shortcut) => shortcut !== "ai" || aiEnabled)
      .map(findSlashMenuItem)
      .filter(Boolean),
  }));

  return (
    <div className={classes.hint} aria-hidden="true">
      <p className={classes.lead}>
        {t('This page is empty. Switch to "Edit" to start writing.')}
      </p>
      <p>
        {t(
          'In edit mode, type "/" to insert headings, tables, images and more:',
        )}
      </p>
      <dl className={classes.groups}>
        {groups.map((group) => (
          <div key={group.label} className={classes.group}>
            <dt className={classes.groupLabel}>{t(group.label)}</dt>
            <dd className={classes.list}>
              {group.items.map((item) => (
                <span key={item.shortcut} className={classes.item}>
                  <Kbd size="xs">/{item.shortcut}</Kbd>
                  <span>{t(item.title)}</span>
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
