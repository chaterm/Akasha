import { mergeAttributes, Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';

export interface SubpagesOptions {
  HTMLAttributes: Record<string, any>;
  view: any;
}

export type SubpagesSortBy = 'default' | 'title-asc' | 'recent';

export interface SubpagesAttributes {
  sortBy?: SubpagesSortBy;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    subpages: {
      insertSubpages: (attributes?: SubpagesAttributes) => ReturnType;
    };
  }
}

export const Subpages = Node.create<SubpagesOptions>({
  name: 'subpages',

  addOptions() {
    return {
      HTMLAttributes: {},
      view: null,
    };
  },

  addAttributes() {
    return {
      sortBy: {
        default: 'default',
        parseHTML: (element: HTMLElement) =>
          element.getAttribute('data-sort-by') || 'default',
        renderHTML: (attributes: SubpagesAttributes) => ({
          'data-sort-by': attributes.sortBy || 'default',
        }),
      },
    };
  },

  group: 'block',
  atom: true,
  draggable: true,
  isolating: true,

  parseHTML() {
    return [
      {
        tag: `div[data-type="${this.name}"]`,
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(
        { 'data-type': this.name },
        this.options.HTMLAttributes,
        HTMLAttributes,
      ),
    ];
  },

  addCommands() {
    return {
      insertSubpages:
        (attributes) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: attributes,
          });
        },
    };
  },

  addNodeView() {
    this.editor.isInitialized = true;

    return ReactNodeViewRenderer(this.options.view);
  },
});
