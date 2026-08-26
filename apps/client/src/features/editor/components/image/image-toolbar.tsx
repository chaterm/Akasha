import { Editor, useEditorState } from "@tiptap/react";
import { ActionIcon, Tooltip } from "@mantine/core";
import { useCallback, useEffect, useRef } from "react";
import clsx from "clsx";
import {
  IconLayoutAlignCenter,
  IconLayoutAlignLeft,
  IconLayoutAlignRight,
  IconDownload,
  IconRefresh,
  IconTrash,
  IconZoomIn,
} from "@tabler/icons-react";
import { useSetAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { getFileUrl } from "@/lib/config.ts";
import { uploadImageAction } from "./upload-image-action.tsx";
import { useAltTextControl } from "@/features/editor/components/common/use-alt-text-control.tsx";
import { lightboxRequestAtom } from "@/features/editor/atoms/editor-atoms";
import classes from "@/features/editor/components/common/toolbar-menu.module.css";

interface ImageToolbarProps {
  editor: Editor;
  pos: number;
  onAltEditingChange?: (editing: boolean) => void;
}

export function ImageToolbar({
  editor,
  pos,
  onAltEditingChange,
}: ImageToolbarProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const setLightboxRequest = useSetAtom(lightboxRequestAtom);

  const editorState = useEditorState({
    editor,
    selector: (ctx) => {
      const node = ctx.editor.state.doc.nodeAt(pos);
      const attrs = node?.type.name === "image" ? node.attrs : null;

      return {
        align: attrs?.align ?? "center",
        src: (attrs?.src as string) || null,
        alt: (attrs?.alt as string) || "",
      };
    },
  });

  const updateAttrs = useCallback(
    (attrs: Record<string, unknown>) => {
      const { state, view } = editor;
      const node = state.doc.nodeAt(pos);
      if (!node || node.type.name !== "image") return;

      view.dispatch(
        state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }),
      );
    },
    [editor, pos],
  );

  const setAlign = useCallback(
    (align: "left" | "center" | "right") => updateAttrs({ align }),
    [updateAttrs],
  );

  const handleDownload = useCallback(() => {
    if (!editorState?.src) return;
    const link = document.createElement("a");
    link.href = getFileUrl(editorState.src);
    link.download = "";
    link.click();
  }, [editorState?.src]);

  const handleReplace = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset so the same file can be selected again
      event.target.value = "";
      if (!file) return;

      // @ts-ignore
      const pageId = editor.storage?.pageId;
      if (!pageId) return;

      uploadImageAction(file, editor, pos, pageId);
    },
    [editor, pos],
  );

  const handleDelete = useCallback(() => {
    const { state, view } = editor;
    const node = state.doc.nodeAt(pos);
    if (!node) return;

    view.dispatch(state.tr.delete(pos, pos + node.nodeSize));
  }, [editor, pos]);

  const {
    button: altTextButton,
    panel: altTextPanel,
    isEditing: isEditingAlt,
  } = useAltTextControl({
    editor,
    nodeName: "image",
    currentAlt: editorState?.alt || "",
    pos,
  });

  useEffect(() => {
    onAltEditingChange?.(isEditingAlt);
  }, [isEditingAlt, onAltEditingChange]);

  if (isEditingAlt) return altTextPanel;

  return (
    <div className={classes.toolbar}>
      <Tooltip position="top" label={t("Align left")} withinPortal={false}>
        <ActionIcon
          onClick={() => setAlign("left")}
          size="lg"
          aria-label={t("Align left")}
          variant="subtle"
          className={clsx({ [classes.active]: editorState?.align === "left" })}
        >
          <IconLayoutAlignLeft size={18} />
        </ActionIcon>
      </Tooltip>

      <Tooltip position="top" label={t("Align center")} withinPortal={false}>
        <ActionIcon
          onClick={() => setAlign("center")}
          size="lg"
          aria-label={t("Align center")}
          variant="subtle"
          className={clsx({
            [classes.active]: editorState?.align === "center",
          })}
        >
          <IconLayoutAlignCenter size={18} />
        </ActionIcon>
      </Tooltip>

      <Tooltip position="top" label={t("Align right")} withinPortal={false}>
        <ActionIcon
          onClick={() => setAlign("right")}
          size="lg"
          aria-label={t("Align right")}
          variant="subtle"
          className={clsx({ [classes.active]: editorState?.align === "right" })}
        >
          <IconLayoutAlignRight size={18} />
        </ActionIcon>
      </Tooltip>

      <div className={classes.divider} />

      {altTextButton}

      <div className={classes.divider} />

      <Tooltip position="top" label={t("Expand")} withinPortal={false}>
        <ActionIcon
          onClick={() =>
            editorState?.src &&
            setLightboxRequest({
              src: getFileUrl(editorState.src),
              type: "image",
            })
          }
          size="lg"
          aria-label={t("Expand")}
          variant="subtle"
        >
          <IconZoomIn size={18} />
        </ActionIcon>
      </Tooltip>

      <Tooltip position="top" label={t("Download")} withinPortal={false}>
        <ActionIcon
          onClick={handleDownload}
          size="lg"
          aria-label={t("Download")}
          variant="subtle"
        >
          <IconDownload size={18} />
        </ActionIcon>
      </Tooltip>

      <Tooltip position="top" label={t("Replace image")} withinPortal={false}>
        <ActionIcon
          onClick={handleReplace}
          size="lg"
          aria-label={t("Replace image")}
          variant="subtle"
        >
          <IconRefresh size={18} />
        </ActionIcon>
      </Tooltip>

      <Tooltip position="top" label={t("Delete")} withinPortal={false}>
        <ActionIcon
          onClick={handleDelete}
          size="lg"
          aria-label={t("Delete")}
          variant="subtle"
        >
          <IconTrash size={18} />
        </ActionIcon>
      </Tooltip>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />
    </div>
  );
}
