import { Table } from '@tiptap/extension-table';
import { Editor } from '@tiptap/core';
import { DOMOutputSpec } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { cellAround } from '@tiptap/pm/tables';
import { closestListItem } from '../list-item';

function handleListIndent(editor: Editor): boolean {
  const listItem = closestListItem(editor.state);
  return Boolean(listItem) && editor.commands.sinkListItem(listItem);
}

function handleListOutdent(editor: Editor): boolean {
  const listItem = closestListItem(editor.state);
  return Boolean(listItem) && editor.commands.liftListItem(listItem);
}

export const CustomTable = Table.extend({
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      'Mod-a': () => {
        const { state, view } = this.editor;
        const { selection, doc } = state;

        const $cellPos = cellAround(selection.$anchor);
        if (!$cellPos) return false;

        const cellNode = doc.nodeAt($cellPos.pos);
        if (!cellNode || !cellNode.textContent) return false;

        const from = $cellPos.pos + 1;
        const to = $cellPos.pos + cellNode.nodeSize - 1;
        if (from >= to) return true;

        const nextSel = TextSelection.between(
          doc.resolve(from),
          doc.resolve(to),
          1,
        );
        if (!nextSel || selection.eq(nextSel)) return true;

        view.dispatch(state.tr.setSelection(nextSel));
        return true;
      },
      Tab: () => {
        if (this.editor.isActive('table')) {
          if (handleListIndent(this.editor)) {
            return true;
          }
        }

        if (this.editor.commands.goToNextCell()) {
          return true;
        }

        if (!this.editor.can().addRowAfter()) {
          return false;
        }

        return this.editor.chain().addRowAfter().goToNextCell().run();
      },
      'Shift-Tab': () => {
        if (this.editor.isActive('table')) {
          if (handleListOutdent(this.editor)) {
            return true;
          }
        }

        return this.editor.commands.goToPreviousCell();
      },
    };
  },

  renderHTML({ node, HTMLAttributes }) {
    const originalRender = this.parent?.({ node, HTMLAttributes });
    const wrapper: DOMOutputSpec = [
      'div',
      { class: 'tableWrapper' },
      originalRender,
    ];
    return wrapper;
  },
});
