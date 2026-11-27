import { Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    fileList: {
      insertFileList: () => ReturnType;
    };
  }
}

export const FileList = Node.create<{ view: any }>({
  name: 'fileList',
  group: 'block',
  content: 'attachment*',
  isolating: true,
  defining: true,

  addOptions() {
    return { view: null };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="fileList"]' }];
  },

  renderHTML() {
    return ['div', { 'data-type': 'fileList' }, 0];
  },

  renderText({ node }) {
    return node.content.content.map((file) => file.attrs.name).join('\n');
  },

  addCommands() {
    return {
      insertFileList:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    };
  },

  addNodeView() {
    return this.options.view ? ReactNodeViewRenderer(this.options.view) : null;
  },
});
