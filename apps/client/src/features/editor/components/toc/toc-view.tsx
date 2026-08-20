import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { Box, Text } from "@mantine/core";
import { TextSelection } from "@tiptap/pm/state";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import classes from "./toc.module.css";

type TocEntry = {
  label: string;
  level: number;
  position: number;
};

export default function TocView(props: NodeViewProps) {
  const { editor, node, selected } = props;
  const { t } = useTranslation();
  const minLevel = (node.attrs.minLevel as number) ?? 1;
  const maxLevel = (node.attrs.maxLevel as number) ?? 3;

  const [entries, setEntries] = useState<TocEntry[]>([]);

  const collect = useCallback(() => {
    if (!editor) return;

    const found: TocEntry[] = [];
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name !== "heading") return;
      const label = n.textContent.trim();
      if (!label) return;
      found.push({ label, level: Number(n.attrs.level), position: pos });
    });
    setEntries(found);
  }, [editor]);

  useEffect(() => {
    collect();
    if (!editor) return;

    editor.on("update", collect);
    return () => {
      editor.off("update", collect);
    };
  }, [editor, collect]);

  const visible = useMemo(
    () => entries.filter((e) => e.level >= minLevel && e.level <= maxLevel),
    [entries, minLevel, maxLevel],
  );

  const baseLevel = useMemo(
    () => (visible.length ? Math.min(...visible.map((e) => e.level)) : 1),
    [visible],
  );

  const scrollTo = (position: number) => {
    const { view } = editor;
    const node = view.nodeDOM(position) as HTMLElement | null;

    node?.scrollIntoView({ behavior: "smooth", block: "start" });

    if (editor.isEditable) {
      const tr = view.state.tr;
      tr.setSelection(TextSelection.near(tr.doc.resolve(position)));
      view.dispatch(tr);
      view.focus();
    }
  };

  return (
    <NodeViewWrapper data-drag-handle>
      <div
        className={clsx(classes.container, { [classes.selected]: selected })}
      >
        {visible.length === 0 ? (
          <Text c="dimmed" size="sm" py="xs">
            {t("Add headings to generate a table of contents.")}
          </Text>
        ) : (
          visible.map((entry, idx) => (
            <Box<"button">
              component="button"
              key={`${entry.position}-${idx}`}
              onClick={() => scrollTo(entry.position)}
              className={classes.link}
              style={{
                paddingLeft: `calc(${entry.level - baseLevel} * var(--mantine-spacing-md))`,
              }}
            >
              {entry.label}
            </Box>
          ))
        )}
      </div>
    </NodeViewWrapper>
  );
}
