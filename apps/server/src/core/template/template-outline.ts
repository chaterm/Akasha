export type OutlineItem =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'task'; text: string }
  | { kind: 'block'; label: string };

const MAX_ITEMS = 9;
const MAX_TEXT = 40;

function textOf(node: any): string {
  if (!node) return '';
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(textOf).join('');
}

function clip(text: string) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t;
}

/**
 * 从模板正文提取前几块的结构概要，供列表卡片画缩略图；
 * 避免列表接口返回完整正文。
 */
export function buildOutline(doc: any): OutlineItem[] {
  const items: OutlineItem[] = [];

  const visit = (node: any) => {
    if (!node || items.length >= MAX_ITEMS) return;
    switch (node.type) {
      case 'heading':
        items.push({ kind: 'heading', level: node.attrs?.level ?? 1, text: clip(textOf(node)) });
        return;
      case 'paragraph':
        items.push({ kind: 'text', text: clip(textOf(node)) });
        return;
      case 'bulletList':
      case 'orderedList':
        for (const li of node.content ?? []) {
          if (items.length >= MAX_ITEMS) return;
          items.push({ kind: 'bullet', text: clip(textOf(li)) });
        }
        return;
      case 'taskList':
        for (const li of node.content ?? []) {
          if (items.length >= MAX_ITEMS) return;
          items.push({ kind: 'task', text: clip(textOf(li)) });
        }
        return;
      case 'table':
        items.push({ kind: 'block', label: 'table' });
        return;
      case 'codeBlock':
        items.push({ kind: 'block', label: 'code' });
        return;
      // 画布类节点在缩略图里渲染不出内容，用一行普通占位补上，别让结构断开
      case 'excalidraw':
      case 'drawio':
        items.push({ kind: 'text', text: '' });
        return;
      case 'blockquote':
      case 'callout':
        items.push({ kind: 'text', text: clip(textOf(node)) });
        return;
      default:
        for (const child of node.content ?? []) visit(child);
    }
  };

  visit(doc);
  // 去掉末尾连续空段落
  while (items.length && items[items.length - 1].kind === 'text' && !(items[items.length - 1] as any).text) {
    items.pop();
  }
  return items;
}
