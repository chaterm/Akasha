import {
  initProseMirrorDoc,
  relativePositionToAbsolutePosition,
} from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { Document } from '@hocuspocus/server';
import { getSchema } from '@tiptap/core';
import { tiptapExtensions } from './collaboration.util';

export type YjsSelection = {
  anchor: any;
  head: any;
};

export function setYjsMark(
  doc: Document,
  fragment: Y.XmlFragment,
  yjsSelection: YjsSelection,
  markName: string,
  markAttributes: Record<string, any>,
) {
  const schema = getSchema(tiptapExtensions);
  const { mapping } = initProseMirrorDoc(fragment, schema);

  const anchorRelPos = Y.createRelativePositionFromJSON(yjsSelection.anchor);
  const headRelPos = Y.createRelativePositionFromJSON(yjsSelection.head);

  const anchor = relativePositionToAbsolutePosition(
    doc,
    fragment,
    anchorRelPos,
    mapping,
  );
  const head = relativePositionToAbsolutePosition(
    doc,
    fragment,
    headRelPos,
    mapping,
  );

  if (anchor === null || head === null) {
    throw new Error(
      'Could not resolve Y.js relative positions to absolute positions',
    );
  }

  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);

  applyMarkToYFragment(fragment, from, to, markName, markAttributes);
}

function applyMarkToYFragment(
  fragment: Y.XmlFragment,
  from: number,
  to: number,
  markName: string,
  markAttributes: Record<string, any>,
) {
  let pos = 0;

  const processItem = (item: any, parentNodeName?: string): boolean => {
    if (pos >= to) return false;

    if (item instanceof Y.XmlText) {
      const textLength = item.length;
      const itemEnd = pos + textLength;

      if (itemEnd > from && pos < to && parentNodeName !== 'codeBlock') {
        const formatFrom = Math.max(0, from - pos);
        const formatTo = Math.min(textLength, to - pos);
        const formatLength = formatTo - formatFrom;

        if (formatLength > 0) {
          item.format(formatFrom, formatLength, { [markName]: markAttributes });
        }
      }
      pos = itemEnd;
    } else if (item instanceof Y.XmlElement) {
      pos++;
      for (let i = 0; i < item.length; i++) {
        if (!processItem(item.get(i), item.nodeName)) return false;
      }
      pos++;
    }
    return true;
  };

  for (let i = 0; i < fragment.length; i++) {
    if (!processItem(fragment.get(i))) break;
  }
}

export function removeYjsMarkByAttribute(
  fragment: Y.XmlFragment,
  markName: string,
  attributeName: string,
  attributeValue: string,
) {
  const processItem = (item: any) => {
    if (item instanceof Y.XmlText) {
      const deltas = item.toDelta();
      let offset = 0;

      for (const delta of deltas) {
        const length = delta.insert?.length ?? 0;
        const attributes = delta.attributes ?? {};
        const markAttr = attributes[markName];

        if (markAttr && markAttr[attributeName] === attributeValue) {
          item.format(offset, length, { [markName]: null });
        }
        offset += length;
      }
    } else if (item instanceof Y.XmlElement) {
      for (let i = 0; i < item.length; i++) {
        processItem(item.get(i));
      }
    }
  };

  for (let i = 0; i < fragment.length; i++) {
    processItem(fragment.get(i));
  }
}

export function updateYjsMarkAttribute(
  fragment: Y.XmlFragment,
  markName: string,
  findByAttribute: { name: string; value: string },
  newAttributes: Record<string, any>,
) {
  const processItem = (item: any) => {
    if (item instanceof Y.XmlText) {
      const deltas = item.toDelta();
      let offset = 0;

      for (const delta of deltas) {
        const length = delta.insert?.length ?? 0;
        const attributes = delta.attributes ?? {};
        const markAttr = attributes[markName];

        if (
          markAttr &&
          markAttr[findByAttribute.name] === findByAttribute.value
        ) {
          item.format(offset, length, {
            [markName]: { ...markAttr, ...newAttributes },
          });
        }
        offset += length;
      }
    } else if (item instanceof Y.XmlElement) {
      for (let i = 0; i < item.length; i++) {
        processItem(item.get(i));
      }
    }
  };

  for (let i = 0; i < fragment.length; i++) {
    processItem(fragment.get(i));
  }
}
