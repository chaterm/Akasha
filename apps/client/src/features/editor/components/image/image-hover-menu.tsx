import { Editor, useEditorState } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { ImageToolbar } from "./image-toolbar.tsx";
import classes from "./image-hover-menu.module.css";

const HIDE_DELAY_MS = 160;
const TOOLBAR_CLEARANCE = 56;

type HoverTarget = { pos: number; element: HTMLImageElement };

function findImagePos(editor: Editor, event: MouseEvent): number | null {
  const hit = editor.view.posAtCoords({
    left: event.clientX,
    top: event.clientY,
  });
  if (!hit) return null;

  const { doc } = editor.state;
  if (doc.nodeAt(hit.pos)?.type.name === "image") return hit.pos;

  const before = doc.resolve(hit.pos).nodeBefore;
  if (before?.type.name === "image") return hit.pos - before.nodeSize;

  return null;
}

export function ImageHoverMenu({ editor }: { editor: Editor }) {
  const [target, setTarget] = useState<HoverTarget | null>(null);
  const [anchor, setAnchor] = useState({ top: 0, left: 0, below: false });
  const [isAltEditing, setIsAltEditing] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const pointerOverMenuRef = useRef(false);
  const wasAltEditingRef = useRef(false);

  const selectedImagePos = useEditorState({
    editor,
    selector: (ctx) => {
      const { selection } = ctx.editor.state;
      return selection instanceof NodeSelection &&
        selection.node.type.name === "image"
        ? selection.from
        : null;
    },
  });

  const cancelHide = useCallback(() => {
    clearTimeout(hideTimerRef.current);
  }, []);

  const hideLater = useCallback(() => {
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setTarget(null), HIDE_DELAY_MS);
  }, []);

  useEffect(() => cancelHide, [cancelHide]);

  useEffect(() => {
    const dom = editor.view.dom;

    const handlePointerMove = (event: PointerEvent) => {
      const image = (event.target as Element | null)?.closest?.("img");
      if (!(image instanceof HTMLImageElement)) {
        hideLater();
        return;
      }

      const pos = findImagePos(editor, event);
      if (pos == null) {
        hideLater();
        return;
      }

      cancelHide();
      setTarget((current) =>
        current && current.pos === pos && current.element === image
          ? current
          : { pos, element: image },
      );
    };

    dom.addEventListener("pointermove", handlePointerMove);
    dom.addEventListener("pointerleave", hideLater);

    return () => {
      dom.removeEventListener("pointermove", handlePointerMove);
      dom.removeEventListener("pointerleave", hideLater);
    };
  }, [editor, cancelHide, hideLater]);

  useEffect(() => {
    if (!target) return;

    const updateAnchor = () => {
      const rect = target.element.getBoundingClientRect();
      const below = rect.top < TOOLBAR_CLEARANCE;

      setAnchor({
        top: below ? rect.bottom : rect.top,
        left: rect.left + rect.width / 2,
        below,
      });
    };

    updateAnchor();
    window.addEventListener("scroll", updateAnchor, true);
    window.addEventListener("resize", updateAnchor);

    return () => {
      window.removeEventListener("scroll", updateAnchor, true);
      window.removeEventListener("resize", updateAnchor);
    };
  }, [target]);

  useEffect(() => {
    if (
      wasAltEditingRef.current &&
      !isAltEditing &&
      !pointerOverMenuRef.current
    ) {
      hideLater();
    }

    wasAltEditingRef.current = isAltEditing;
  }, [isAltEditing, hideLater]);

  if (!target || !target.element.isConnected) return null;
  if (selectedImagePos === target.pos) return null;

  return createPortal(
    <div
      className={clsx(classes.toolbar, anchor.below && classes.below)}
      style={{ top: anchor.top, left: anchor.left }}
      onMouseEnter={() => {
        pointerOverMenuRef.current = true;
        cancelHide();
      }}
      onMouseLeave={() => {
        pointerOverMenuRef.current = false;
        hideLater();
      }}
    >
      <ImageToolbar
        editor={editor}
        pos={target.pos}
        onAltEditingChange={setIsAltEditing}
      />
    </div>,
    document.body,
  );
}
