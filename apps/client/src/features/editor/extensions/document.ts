import { Document } from "@tiptap/extension-document";
import { GapCursor } from "@tiptap/pm/gapcursor";
import { Plugin, PluginKey, Selection } from "@tiptap/pm/state";

const leadingGapCursorKey = new PluginKey("leadingGapCursor");

export const TiptapDocument = Document.extend({
  content: "block+",
  allowGapCursor: true,

  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const { state } = editor;
        const { selection } = state;

        if (!selection.empty) return false;

        const { $from } = selection;
        if ($from.depth !== 1 || $from.parentOffset !== 0) return false;
        if ($from.index(0) !== 0) return false;

        const first = $from.parent;
        if (first.type.name !== "paragraph" || first.content.size !== 0) {
          return false;
        }
        if (state.doc.childCount < 2) return false;

        const { tr } = state;
        tr.delete(0, first.nodeSize);
        tr.setSelection(Selection.near(tr.doc.resolve(0), 1));
        editor.view.dispatch(tr.scrollIntoView());
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: leadingGapCursorKey,
        props: {
          handleDOMEvents: {
            mousedown: (view, event) => {
              if (!view.editable || event.button !== 0) return false;

              const first = view.dom.firstElementChild;
              if (!first) return false;

              const editorTop = view.dom.getBoundingClientRect().top;
              const firstTop = first.getBoundingClientRect().top;
              if (event.clientY >= firstTop || event.clientY < editorTop) {
                return false;
              }

              if (view.state.doc.child(0).isTextblock) return false;

              event.preventDefault();
              view.dispatch(
                view.state.tr.setSelection(
                  new GapCursor(view.state.doc.resolve(0)),
                ),
              );
              view.focus();
              return true;
            },
          },
        },
      }),
    ];
  },
});
