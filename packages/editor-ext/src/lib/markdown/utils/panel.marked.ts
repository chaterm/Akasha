import { Token, marked } from 'marked';

interface PanelToken {
  type: 'panel';
  attributes: Record<string, string>;
  text: string;
  raw: string;
}

const DATA_ATTRIBUTES: Record<string, string> = {
  title: 'data-panel-title',
  borderStyle: 'data-panel-border-style',
  borderColor: 'data-panel-border-color',
  borderWidth: 'data-panel-border-width',
  bgColor: 'data-panel-bg-color',
  titleBGColor: 'data-panel-title-bg-color',
  titleColor: 'data-panel-title-color',
};

export const panelExtension = {
  name: 'panel',
  level: 'block',
  start(src: string) {
    return src.match(/:::panel/)?.index ?? -1;
  },
  tokenizer(src: string): PanelToken | undefined {
    const match =
      /^:::panel(?:[ \t]+([^\r\n]*))?[ \t]*(?:\r?\n|$)([\s\S]+?):::/.exec(src);
    if (!match) return;

    return {
      type: 'panel',
      attributes: parseAttributes(match[1] || ''),
      raw: match[0],
      text: match[2].trim(),
    };
  },
  renderer(token: Token) {
    const panelToken = token as PanelToken;
    const attributes = Object.entries(panelToken.attributes)
      .map(([key, value]) => {
        const dataKey = DATA_ATTRIBUTES[key];
        return dataKey ? ` ${dataKey}="${escapeAttribute(value)}"` : '';
      })
      .join('');

    return `<div data-type="panel"${attributes}>${marked.parse(panelToken.text)}</div>`;
  },
};

function parseAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /(\w+)=(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+))/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value))) {
    const attributeValue = match[2] ?? match[3] ?? match[4] ?? '';
    attributes[match[1]] =
      match[2] !== undefined
        ? attributeValue.replace(/\\(["\\])/g, '$1')
        : match[3] !== undefined
          ? attributeValue.replace(/\\(['\\])/g, '$1')
          : attributeValue;
  }

  return attributes;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
