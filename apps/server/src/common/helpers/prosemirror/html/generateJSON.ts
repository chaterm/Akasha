import type { Extensions } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import { type ParseOptions, DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { Window } from 'happy-dom';

export function generateJSON(
  html: string,
  extensions: Extensions,
  options?: ParseOptions,
): Record<string, any> {
  if (typeof window !== 'undefined') {
    throw new Error(
      'generateJSON can only be used in a Node environment\nIf you want to use this in a browser environment, use the `@tiptap/html` import instead.',
    );
  }

  const localWindow = new Window();
  const localDOMParser = new localWindow.DOMParser();
  let result: Record<string, any>;

  try {
    const schema = getSchema(extensions);
    let doc: ReturnType<typeof localDOMParser.parseFromString> | null = null;

    const htmlString = `<!DOCTYPE html><html><body>${html}</body></html>`;
    doc = localDOMParser.parseFromString(htmlString, 'text/html');

    if (!doc) {
      throw new Error('Failed to parse HTML string');
    }

    result = PMDOMParser.fromSchema(schema)
      .parse(doc.body as unknown as Node, options)
      .toJSON();
  } finally {
    localWindow.happyDOM.abort();
    localWindow.happyDOM.close();
  }

  return result;
}
