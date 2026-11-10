import { BubbleMenu as BaseBubbleMenu } from "@tiptap/react/menus";
import {
  Editor,
  findParentNode,
  posToDOMRect,
  useEditorState,
} from "@tiptap/react";
import { useCallback } from "react";
import { NodeSelection } from "@tiptap/pm/state";
import { Node as PMNode } from "@tiptap/pm/model";
import { isEditorReady } from "@docmost/editor-ext";
import {
  EditorMenuProps,
  ShouldShowProps,
} from "@/features/editor/components/table/types/types.ts";
import { ImageToolbar } from "./image-toolbar.tsx";

function findSelectionImagePos(editor: Editor): number | null {
  const { selection } = editor.state;

  if (
    selection instanceof NodeSelection &&
    selection.node.type.name === "image"
  ) {
    return selection.from;
  }

  const parent = findParentNode((node) => node.type.name === "image")(
    selection,
  );
  return parent?.pos ?? null;
}

export function ImageMenu({ editor }: EditorMenuProps) {
  const editorState = useEditorState({
    editor,
    selector: (ctx) => {
      if (!ctx.editor) {
        return null;
      }

      return { pos: findSelectionImagePos(ctx.editor) };
    },
  });

  const shouldShow = useCallback(
    ({ state }: ShouldShowProps) => {
      if (!state) {
        return false;
      }

      return (
        editor.isActive("image") && Boolean(editor.getAttributes("image").src)
      );
    },
    [editor],
  );

  const getReferencedVirtualElement = useCallback(() => {
    if (!isEditorReady(editor)) return;
    const { selection } = editor.state;
    const predicate = (node: PMNode) => node.type.name === "image";
    const parent = findParentNode(predicate)(selection);

    if (parent) {
      const dom = editor.view.nodeDOM(parent?.pos) as HTMLElement;
      const domRect = dom.getBoundingClientRect();
      return {
        getBoundingClientRect: () => domRect,
        getClientRects: () => [domRect],
      };
    }

    const domRect = posToDOMRect(editor.view, selection.from, selection.to);
    return {
      getBoundingClientRect: () => domRect,
      getClientRects: () => [domRect],
    };
  }, [editor]);

  return (
    <BaseBubbleMenu
      editor={editor}
      pluginKey={`image-menu`}
      updateDelay={0}
      getReferencedVirtualElement={getReferencedVirtualElement}
      options={{
        placement: "top",
        offset: 8,
        flip: false,
      }}
      shouldShow={shouldShow}
    >
      {editorState?.pos != null && (
        <ImageToolbar
          key={editorState.pos}
          editor={editor}
          pos={editorState.pos}
        />
      )}
    </BaseBubbleMenu>
  );
}

export default ImageMenu;
