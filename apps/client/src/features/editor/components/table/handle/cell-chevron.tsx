import React, { useCallback, useEffect } from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { columnResizingPluginKey } from "@tiptap/pm/tables";
import { useFloating, offset, autoUpdate, hide } from "@floating-ui/react";
import { Menu, UnstyledButton } from "@mantine/core";
import { IconChevronDown } from "@tabler/icons-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { isCellSelection } from "@docmost/editor-ext";
import { CellChevronMenu } from "./menus/cell-chevron-menu";
import classes from "./handle.module.css";

interface CellChevronProps {
  editor: Editor;
  cellPos: number;
  tableNode: ProseMirrorNode;
  tablePos: number;
}

export const CellChevron = React.memo(function CellChevron({
  editor,
  cellPos,
  tableNode,
  tablePos,
}: CellChevronProps) {
  const { t } = useTranslation();
  const cellDom = editor.view.nodeDOM(cellPos) as HTMLElement | null;

  const { refs, floatingStyles, middlewareData } = useFloating({
    placement: "top-end",
    middleware: [offset({ mainAxis: -22, crossAxis: -10 }), hide()],
    whileElementsMounted: autoUpdate,
    strategy: "absolute",
  });
  const isReferenceHidden = !!middlewareData.hide?.referenceHidden;

  useEffect(() => {
    refs.setReference(cellDom);
  }, [cellDom, refs]);

  const isResizingColumn = useEditorState({
    editor,
    selector: (ctx) => {
      if (!ctx.editor) return false;
      const state = columnResizingPluginKey.getState(ctx.editor.state) as
        | { activeHandle: number }
        | undefined;
      return !!state && state.activeHandle > -1;
    },
  });

  const onOpen = useCallback(() => {
    const current = editor.state.selection;

    let preserveExisting = false;
    if (isCellSelection(current)) {
      current.forEachCell((_node, pos) => {
        if (pos === cellPos) preserveExisting = true;
      });
    }

    if (!preserveExisting) {
      try {
        const $inside = editor.state.doc.resolve(cellPos + 1);
        const sel = TextSelection.near($inside, 1);
        editor.view.dispatch(editor.state.tr.setSelection(sel));
      } catch {}
    }
    editor.commands.freezeHandles();
  }, [editor, cellPos]);

  const onClose = useCallback(() => {
    editor.commands.unfreezeHandles();
  }, [editor]);

  if (!cellDom) return null;
  if (isResizingColumn) return null;

  return (
    <Menu
      position="bottom-end"
      onOpen={onOpen}
      onClose={onClose}
      withinPortal
      shadow="md"
    >
      <Menu.Target>
        <UnstyledButton
          ref={refs.setFloating}
          style={{
            ...floatingStyles,
            ...(isReferenceHidden ? { visibility: "hidden" as const } : {}),
          }}
          className={clsx(classes.cellChevron)}
          aria-label={t("Cell actions")}
        >
          <IconChevronDown size={14} />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <CellChevronMenu
          editor={editor}
          cellPos={cellPos}
          tableNode={tableNode}
          tablePos={tablePos}
        />
      </Menu.Dropdown>
    </Menu>
  );
});
