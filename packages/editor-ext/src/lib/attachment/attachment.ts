import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { sanitizeUrl } from '../utils';

export interface AttachmentOptions {
  HTMLAttributes: Record<string, any>;
  view: any;
}

export interface AttachmentAttributes {
  url?: string;
  name?: string;
  mime?: string;
  size?: number;
  attachmentId?: string;
  placeholder?: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    attachment: {
      setAttachment: (attributes: AttachmentAttributes) => ReturnType;
    };
  }
}

export const Attachment = Node.create<AttachmentOptions>({
  name: 'attachment',
  inline: false,
  group: 'block',
  isolating: true,
  atom: true,
  defining: true,
  draggable: true,

  addOptions() {
    return {
      HTMLAttributes: {},
      view: null,
    };
  },
  addAttributes() {
    return {
      url: {
        default: '',
        parseHTML: (element) => {
          const url = element.getAttribute('data-attachment-url');
          return sanitizeUrl(url);
        },
        renderHTML: (attributes) => ({
          'data-attachment-url': sanitizeUrl(attributes.url),
        }),
      },
      name: {
        default: undefined,
        parseHTML: (element) => element.getAttribute('data-attachment-name'),
        renderHTML: (attributes: AttachmentAttributes) => ({
          'data-attachment-name': attributes.name,
        }),
      },
      mime: {
        default: undefined,
        parseHTML: (element) => element.getAttribute('data-attachment-mime'),
        renderHTML: (attributes: AttachmentAttributes) => ({
          'data-attachment-mime': attributes.mime,
        }),
      },
      size: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-attachment-size'),
        renderHTML: (attributes: AttachmentAttributes) => ({
          'data-attachment-size': attributes.size,
        }),
      },
      attachmentId: {
        default: undefined,
        parseHTML: (element) => element.getAttribute('data-attachment-id'),
        renderHTML: (attributes: AttachmentAttributes) => ({
          'data-attachment-id': attributes.attachmentId,
        }),
      },
      placeholder: {
        default: null,
        rendered: false,
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
      'div',
      mergeAttributes(
        { 'data-type': this.name },
        this.options.HTMLAttributes,
        HTMLAttributes,
      ),
      [
        'a',
        {
          href: sanitizeUrl(HTMLAttributes['data-attachment-url']),
          class: 'attachment',
          target: 'blank',
        },
        `${HTMLAttributes['data-attachment-name']}`,
      ],
    ];
  },

  addCommands() {
    return {
      setAttachment:
        (attrs: AttachmentAttributes) =>
        ({ commands }) => {
          return commands.insertContent({
            type: 'attachment',
            attrs: attrs,
          });
        },
    };
  },

  addNodeView() {
    this.editor.isInitialized = true;

    return ReactNodeViewRenderer(this.options.view);
  },
});
