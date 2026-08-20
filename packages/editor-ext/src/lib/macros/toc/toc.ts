import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";

export interface TocOptions {
  HTMLAttributes: Record<string, any>;
  view: any;
}

export interface TocAttributes {
  minLevel?: number;
  maxLevel?: number;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    toc: {
      insertToc: (attributes?: TocAttributes) => ReturnType;
      setTocLevels: (attributes: TocAttributes) => ReturnType;
    };
  }
}

const clampLevel = (value: unknown, fallback: number): number => {
  const parsed = typeof value === "number" ? value : parseInt(String(value), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 6);
};

export const Toc = Node.create<TocOptions>({
  name: "toc",

  addOptions() {
    return {
      HTMLAttributes: {},
      view: null,
    };
  },

  group: "block",
  atom: true,
  draggable: true,
  isolating: true,

  addAttributes() {
    return {
      minLevel: {
        default: 1,
        parseHTML: (element) =>
          clampLevel(element.getAttribute("data-min-level"), 1),
        renderHTML: (attributes: TocAttributes) => ({
          "data-min-level": attributes.minLevel,
        }),
      },
      maxLevel: {
        default: 3,
        parseHTML: (element) =>
          clampLevel(element.getAttribute("data-max-level"), 3),
        renderHTML: (attributes: TocAttributes) => ({
          "data-max-level": attributes.maxLevel,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: `div[data-type="${this.name}"]`,
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(
        { "data-type": this.name },
        this.options.HTMLAttributes,
        HTMLAttributes,
      ),
    ];
  },

  addCommands() {
    return {
      insertToc:
        (attributes) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: {
              minLevel: clampLevel(attributes?.minLevel, 1),
              maxLevel: clampLevel(attributes?.maxLevel, 3),
            },
          });
        },

      setTocLevels:
        (attributes) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, {
            minLevel: clampLevel(attributes?.minLevel, 1),
            maxLevel: clampLevel(attributes?.maxLevel, 3),
          }),
    };
  },

  addNodeView() {
    // Force the react node view to render immediately using flush sync
    this.editor.isInitialized = true;

    return ReactNodeViewRenderer(this.options.view);
  },
});
