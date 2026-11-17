import type { Node, Schema } from '@tiptap/pm/model';
import { DOMSerializer } from '@tiptap/pm/model';
import { Window } from 'happy-dom';

export function getHTMLFromFragment(
  doc: Node,
  schema: Schema,
  options?: { document?: Document },
): string {
  if (options?.document) {
    const wrap = options.document.createElement('div');

    DOMSerializer.fromSchema(schema).serializeFragment(
      doc.content,
      { document: options.document },
      wrap,
    );
    return wrap.innerHTML;
  }

  const localWindow = new Window();
  let result: string;

  try {
    const fragment = DOMSerializer.fromSchema(schema).serializeFragment(
      doc.content,
      {
        document: localWindow.document as unknown as Document,
      },
    );

    const serializer = new localWindow.XMLSerializer();
    result = serializer.serializeToString(fragment as any);
  } finally {
    localWindow.happyDOM.abort();
    localWindow.happyDOM.close();
  }

  return result;
}
