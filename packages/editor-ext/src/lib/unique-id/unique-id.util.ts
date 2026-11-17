import type { Extensions, JSONContent } from '@tiptap/core';
import { resolveUniqueIdTypes, type UniqueID } from './unique-id';

export function addUniqueIdsToDoc(
  doc: JSONContent,
  extensions: Extensions,
): JSONContent {
  const uniqueIDExtension = extensions.find(
    (ext) => ext.name === 'uniqueID',
  ) as typeof UniqueID | undefined;
  if (!uniqueIDExtension) {
    throw new Error('UniqueID extension not found in the extensions array');
  }
  const { attributeName } = uniqueIDExtension.options;
  const types = resolveUniqueIdTypes(
    uniqueIDExtension.options.types,
    extensions,
  );
  const generateID = uniqueIDExtension.options.generateID as () => string;

  const addIds = (node: JSONContent): JSONContent => {
    const result = { ...node };
    if (types.includes(node.type) && !node.attrs?.[attributeName]) {
      result.attrs = { ...node.attrs, [attributeName]: generateID() };
    }
    if (node.content) {
      result.content = node.content.map(addIds);
    }
    return result;
  };

  return addIds(doc);
}
