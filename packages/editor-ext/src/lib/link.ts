import TiptapLink from '@tiptap/extension-link';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { EditorView } from '@tiptap/pm/view';

export const LinkExtension = TiptapLink.extend({
  inclusive: false,

  addAttributes() {
    return {
      ...this.parent?.(),
      internal: {
        default: false,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute('data-internal') === 'true',
        renderHTML: (attributes) =>
          attributes.internal ? { 'data-internal': 'true' } : {},
      },
    };
  },

  addProseMirrorPlugins() {
    const { editor } = this;

    return [
      ...(this.parent?.() || []),
      new Plugin({
        props: {
          handleKeyDown: (view: EditorView, event: KeyboardEvent) => {
            const { selection } = editor.state;

            if (event.key === 'Escape' && selection.empty !== true) {
              editor.commands.focus(selection.to, { scrollIntoView: false });
            }

            return false;
          },
        },
      }),
      new Plugin({
        key: new PluginKey('linkBoundaryInput'),
        props: {
          handleKeyDown: (view: EditorView, event: KeyboardEvent) => {
            if (event.key.length !== 1) return false;
            if (
              event.ctrlKey ||
              event.metaKey ||
              event.altKey ||
              event.isComposing
            )
              return false;

            const { state } = view;
            const linkType = state.schema.marks.link;
            if (!linkType) return false;

            if (state.storedMarks !== null) return false;

            const { from, to } = state.selection;
            const $from = state.doc.resolve(from);
            const nodeBefore = $from.nodeBefore;
            const nodeAfter = $from.nodeAfter;

            const linkBefore = nodeBefore && linkType.isInSet(nodeBefore.marks);
            const linkAfter = nodeAfter && linkType.isInSet(nodeAfter.marks);

            if (linkBefore && linkAfter) return false;

            if (!linkBefore && !linkAfter) return false;

            event.preventDefault();
            const tr = state.tr.insertText(event.key, from, to);
            tr.removeMark(from, from + event.key.length, linkType);
            view.dispatch(tr.scrollIntoView());
            return true;
          },
        },
      }),
    ];
  },
});
