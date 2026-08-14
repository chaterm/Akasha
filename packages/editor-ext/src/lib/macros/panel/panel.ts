import { mergeAttributes, Node } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { ReactNodeViewRenderer } from '@tiptap/react';

export interface PanelOptions {
  HTMLAttributes: Record<string, any>;
  view: any;
}

export interface PanelAttributes {
  title?: string;
  borderStyle?: string;
  borderColor?: string;
  borderWidth?: number | null;
  bgColor?: string;
  titleBgColor?: string;
  titleColor?: string;
}

export interface PanelStorage {
  autoOpen: boolean;
}

export const DEFAULT_PANEL_ATTRIBUTES: Required<PanelAttributes> = {
  title: '',
  borderStyle: 'solid',
  borderColor: '',
  borderWidth: null,
  bgColor: '',
  titleBgColor: '',
  titleColor: '',
};

const BORDER_STYLES = new Set([
  'none',
  'hidden',
  'dotted',
  'dashed',
  'solid',
  'double',
  'groove',
  'ridge',
  'inset',
  'outset',
]);

const CSS_COLOR_PATTERN =
  /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([\d\s.,%+-]+\)|[a-z]+)$/i;

function normalizeColor(value: unknown): string {
  const color = String(value ?? '').trim();
  return color && CSS_COLOR_PATTERN.test(color) ? color : '';
}

export function normalizePanelBorderStyle(value: unknown): string {
  const style = String(value ?? '')
    .trim()
    .toLowerCase();
  return BORDER_STYLES.has(style)
    ? style
    : DEFAULT_PANEL_ATTRIBUTES.borderStyle;
}

export function normalizePanelBorderWidth(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null;
  const width = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(width) || width < 0) return null;
  return Math.min(width, 50);
}

export function normalizePanelAttributes(
  attributes?: Partial<PanelAttributes> | null,
): Required<PanelAttributes> {
  const input = attributes || {};
  return {
    title: String(input.title ?? DEFAULT_PANEL_ATTRIBUTES.title),
    borderStyle: normalizePanelBorderStyle(input.borderStyle),
    borderColor: normalizeColor(input.borderColor),
    borderWidth: normalizePanelBorderWidth(input.borderWidth),
    bgColor: normalizeColor(input.bgColor),
    titleBgColor: normalizeColor(input.titleBgColor),
    titleColor: normalizeColor(input.titleColor),
  };
}

export function getPanelInlineStyle(attributes?: PanelAttributes): string {
  const normalized = normalizePanelAttributes(attributes);
  const styles: string[] = [];

  if (normalized.borderStyle !== DEFAULT_PANEL_ATTRIBUTES.borderStyle) {
    styles.push(`border-style: ${normalized.borderStyle}`);
  }
  if (normalized.borderColor) {
    styles.push(`border-color: ${normalized.borderColor}`);
  }
  if (normalized.borderWidth !== null) {
    styles.push(`border-width: ${normalized.borderWidth}px`);
  }
  if (normalized.bgColor) {
    styles.push(`background-color: ${normalized.bgColor}`);
  }

  return styles.join('; ');
}

export function getPanelTitleInlineStyle(
  attributes?: PanelAttributes,
): Record<string, string> {
  const normalized = normalizePanelAttributes(attributes);
  const styles: Record<string, string> = {};

  if (normalized.titleBgColor) {
    styles.backgroundColor = normalized.titleBgColor;
  }
  if (normalized.titleColor) {
    styles.color = normalized.titleColor;
  }

  return styles;
}

export function getPanelHTMLAttributes(
  attributes?: PanelAttributes,
): Record<string, string | number> {
  const normalized = normalizePanelAttributes(attributes);
  const result: Record<string, string | number> = {};

  if (normalized.borderStyle !== DEFAULT_PANEL_ATTRIBUTES.borderStyle) {
    result['data-panel-border-style'] = normalized.borderStyle;
  }
  if (normalized.borderColor) {
    result['data-panel-border-color'] = normalized.borderColor;
  }
  if (normalized.borderWidth !== null) {
    result['data-panel-border-width'] = normalized.borderWidth;
  }
  if (normalized.bgColor) {
    result['data-panel-bg-color'] = normalized.bgColor;
  }
  if (normalized.titleBgColor) {
    result['data-panel-title-bg-color'] = normalized.titleBgColor;
  }
  if (normalized.titleColor) {
    result['data-panel-title-color'] = normalized.titleColor;
  }

  return result;
}

declare module '@tiptap/core' {
  interface Storage {
    panel: PanelStorage;
  }

  interface Commands<ReturnType> {
    panel: {
      setPanel: (attributes?: PanelAttributes) => ReturnType;
      insertPanel: (attributes?: PanelAttributes) => ReturnType;
      unsetPanel: () => ReturnType;
      togglePanel: (attributes?: PanelAttributes) => ReturnType;
    };
  }
}

export const Panel = Node.create<PanelOptions, PanelStorage>({
  name: 'panel',

  addOptions() {
    return {
      HTMLAttributes: {},
      view: null,
    };
  },

  addStorage() {
    return {
      autoOpen: false,
    };
  },

  content: 'block+',
  group: 'block',
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      title: {
        default: DEFAULT_PANEL_ATTRIBUTES.title,
        parseHTML: (element) => element.getAttribute('data-panel-title') || '',
        renderHTML: (attributes: PanelAttributes) =>
          attributes.title ? { 'data-panel-title': attributes.title } : {},
      },
      borderStyle: {
        default: DEFAULT_PANEL_ATTRIBUTES.borderStyle,
        parseHTML: (element) =>
          normalizePanelBorderStyle(
            element.getAttribute('data-panel-border-style') ||
              element.style.borderStyle,
          ),
        renderHTML: (attributes: PanelAttributes) => ({
          'data-panel-border-style': normalizePanelBorderStyle(
            attributes.borderStyle,
          ),
        }),
      },
      borderColor: {
        default: DEFAULT_PANEL_ATTRIBUTES.borderColor,
        parseHTML: (element) =>
          normalizeColor(
            element.getAttribute('data-panel-border-color') ||
              element.style.borderColor,
          ),
        renderHTML: (attributes: PanelAttributes) =>
          attributes.borderColor
            ? {
                'data-panel-border-color': normalizeColor(
                  attributes.borderColor,
                ),
              }
            : {},
      },
      borderWidth: {
        default: DEFAULT_PANEL_ATTRIBUTES.borderWidth,
        parseHTML: (element) =>
          normalizePanelBorderWidth(
            element.getAttribute('data-panel-border-width') ||
              element.style.borderWidth.replace(/px$/, ''),
          ),
        renderHTML: (attributes: PanelAttributes) => {
          const width = normalizePanelBorderWidth(attributes.borderWidth);
          return width === null ? {} : { 'data-panel-border-width': width };
        },
      },
      bgColor: {
        default: DEFAULT_PANEL_ATTRIBUTES.bgColor,
        parseHTML: (element) =>
          normalizeColor(
            element.getAttribute('data-panel-bg-color') ||
              element.style.backgroundColor,
          ),
        renderHTML: (attributes: PanelAttributes) =>
          attributes.bgColor
            ? { 'data-panel-bg-color': normalizeColor(attributes.bgColor) }
            : {},
      },
      titleBgColor: {
        default: DEFAULT_PANEL_ATTRIBUTES.titleBgColor,
        parseHTML: (element) =>
          normalizeColor(element.getAttribute('data-panel-title-bg-color')),
        renderHTML: (attributes: PanelAttributes) =>
          attributes.titleBgColor
            ? {
                'data-panel-title-bg-color': normalizeColor(
                  attributes.titleBgColor,
                ),
              }
            : {},
      },
      titleColor: {
        default: DEFAULT_PANEL_ATTRIBUTES.titleColor,
        parseHTML: (element) =>
          normalizeColor(element.getAttribute('data-panel-title-color')),
        renderHTML: (attributes: PanelAttributes) =>
          attributes.titleColor
            ? {
                'data-panel-title-color': normalizeColor(attributes.titleColor),
              }
            : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[data-type="${this.name}"]` }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const style = getPanelInlineStyle(node.attrs);
    return [
      'div',
      mergeAttributes(
        { 'data-type': this.name },
        this.options.HTMLAttributes,
        HTMLAttributes,
        getPanelHTMLAttributes(node.attrs),
        style ? { style } : {},
      ),
      0,
    ];
  },

  addCommands() {
    return {
      setPanel:
        (attributes) =>
        ({ commands }) =>
          commands.wrapIn(this.name, normalizePanelAttributes(attributes)),
      insertPanel:
        (attributes) =>
        ({ commands }) => {
          this.storage.autoOpen = true;
          return commands.wrapIn(
            this.name,
            normalizePanelAttributes(attributes),
          );
        },
      unsetPanel:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
      togglePanel:
        (attributes) =>
        ({ commands }) => {
          if (!this.editor.isActive(this.name)) {
            this.storage.autoOpen = true;
          }
          return commands.toggleWrap(
            this.name,
            normalizePanelAttributes(attributes),
          );
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const { state, view } = editor;
        const { selection } = state;
        if (!selection.empty || selection.$from.parentOffset !== 0)
          return false;

        const panelDepth = selection.$from.depth - 1;
        if (panelDepth < 0) return false;

        const panelNode = selection.$from.node(panelDepth);
        if (panelNode.type !== this.type) return false;

        if (
          panelNode.childCount === 1 &&
          panelNode.firstChild?.content.size === 0
        ) {
          const panelPos = selection.$from.before(panelDepth);
          const tr = state.tr.delete(panelPos, panelPos + panelNode.nodeSize);
          tr.setSelection(TextSelection.near(tr.doc.resolve(panelPos), -1));
          view.dispatch(tr);
          return true;
        }

        return false;
      },
      Enter: ({ editor }) => {
        const { state, view } = editor;
        const { selection } = state;
        if (!selection.empty) return false;

        const panelDepth = selection.$from.depth - 1;
        if (panelDepth < 0) return false;

        const panelNode = selection.$from.node(panelDepth);
        if (
          panelNode.type !== this.type ||
          selection.$from.parent.content.size !== 0 ||
          selection.$from.index(panelDepth) !== panelNode.childCount - 1
        ) {
          return false;
        }

        const containerDepth = panelDepth - 1;
        const container = selection.$from.node(containerDepth);
        const indexAfter = selection.$from.indexAfter(containerDepth);
        const paragraphType = state.schema.nodes.paragraph;
        if (!container.canReplaceWith(indexAfter, indexAfter, paragraphType)) {
          return false;
        }

        const panelEnd = selection.$from.after(panelDepth);
        const tr = state.tr.insert(panelEnd, paragraphType.create());
        tr.setSelection(TextSelection.create(tr.doc, panelEnd + 1));
        view.dispatch(tr);
        return true;
      },
    };
  },

  addNodeView() {
    this.editor.isInitialized = true;
    return ReactNodeViewRenderer(this.options.view);
  },
});
