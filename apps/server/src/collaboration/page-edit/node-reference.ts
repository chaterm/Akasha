import { getSchema } from '@tiptap/core';
import { ADDRESSABLE_NODE_TYPES } from '@docmost/editor-ext';
import { tiptapExtensions } from '../collaboration.util';

export type NodeReferenceEntry = {
  name: string;
  group: string;
  inline: boolean;
  atom: boolean;
  addressable: boolean;
  content: string;
  marks: string;
  attrs: { name: string; default: string }[];
};

export type MarkReferenceEntry = {
  name: string;
  attrs: { name: string; default: string }[];
};

function describeDefault(value: unknown): string {
  if (value === undefined) return 'required';
  return JSON.stringify(value) ?? 'null';
}

function attrsOf(spec: Record<string, any> | undefined) {
  return Object.entries(spec ?? {})
    .map(([name, definition]) => ({
      name,
      default: describeDefault(definition?.default),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildNodeReference(): {
  nodes: NodeReferenceEntry[];
  marks: MarkReferenceEntry[];
} {
  const schema = getSchema(tiptapExtensions);
  const addressable = new Set<string>(ADDRESSABLE_NODE_TYPES);
  const nodes = Object.values(schema.nodes)
    .map((type) => ({
      name: type.name,
      group: type.spec.group ?? '',
      inline: type.isInline,
      atom: type.isAtom,
      addressable: addressable.has(type.name),
      content: type.spec.content ?? '',
      marks: type.spec.marks ?? '',
      attrs: attrsOf(type.spec.attrs),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const marks = Object.values(schema.marks)
    .map((type) => ({ name: type.name, attrs: attrsOf(type.spec.attrs) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { nodes, marks };
}

function attrCell(attrs: { name: string; default: string }[]): string {
  if (!attrs.length) return '—';
  return attrs
    .map((attr) => `\`${attr.name}\`=${attr.default}`)
    .join('<br>');
}

export function renderNodeReference(): string {
  const { nodes, marks } = buildNodeReference();
  const lines: string[] = [];
  lines.push('# 编辑器节点参考');
  lines.push('');
  lines.push(
    '本文件由 `apps/server/src/collaboration/page-edit/node-reference.ts` 从服务端 schema 生成，',
  );
  lines.push(
    '请勿手工编辑；运行 `pnpm --filter ./apps/server run skill:node-reference` 重新生成。',
  );
  lines.push('');
  lines.push(
    `共 ${nodes.length} 个节点、${marks.length} 个 mark。「可定位」表示该节点带稳定 \`id\`，`,
  );
  lines.push(
    '可作为 `edit_page` 的 `nodeId`；表格单元格按行列坐标定位，database 行列用自己的 id。',
  );
  lines.push('');
  lines.push('## 节点');
  lines.push('');
  lines.push('| 节点 | 分组 | 可定位 | content | 属性与缺省值 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const node of nodes) {
    const group = [node.group, node.inline ? 'inline' : '', node.atom ? 'atom' : '']
      .filter(Boolean)
      .join(' / ');
    lines.push(
      `| \`${node.name}\` | ${group || '—'} | ${node.addressable ? '是' : '否'} | ${
        node.content ? `\`${node.content}\`` : '—'
      } | ${attrCell(node.attrs)} |`,
    );
  }
  lines.push('');
  lines.push('## Marks');
  lines.push('');
  lines.push('| mark | 属性与缺省值 |');
  lines.push('| --- | --- |');
  for (const mark of marks) {
    lines.push(`| \`${mark.name}\` | ${attrCell(mark.attrs)} |`);
  }
  lines.push('');
  return lines.join('\n');
}
