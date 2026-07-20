import { createHash } from 'node:crypto';
import { chunkKnowledgeSource } from './knowledge-structural-chunker';

describe('chunkKnowledgeSource', () => {
  it('keeps children inside heading parents with exact source ranges', () => {
    const text = [
      '# Architecture',
      'Akasha uses a Wiki-first architecture.',
      '## Retrieval',
      '- Dense recall',
      '- Full-text recall',
      '| Channel | Source |',
      '| --- | --- |',
      '| Evidence | Wiki |',
      '```ts',
      'const safe = true;',
      '```',
      '> [!NOTE]',
      '> ACL runs before LIMIT.',
    ].join('\n');

    const parents = chunkKnowledgeSource({
      pageTitle: 'Akasha',
      text,
      maxChildCharacters: 120,
    });

    expect(parents.map((parent) => parent.headingPath)).toEqual([
      ['Architecture'],
      ['Architecture', 'Retrieval'],
    ]);
    expect(
      parents[1].children.some((child) =>
        child.text.includes('| Evidence | Wiki |'),
      ),
    ).toBe(true);
    expect(
      parents[1].children.some((child) =>
        child.text.includes('const safe = true'),
      ),
    ).toBe(true);
    expect(
      parents[1].children.some((child) =>
        child.text.includes('ACL runs before LIMIT'),
      ),
    ).toBe(true);

    for (const parent of parents) {
      expect(text.slice(parent.startOffset, parent.endOffset)).toBe(
        parent.text,
      );
      expect(parent.quoteHash).toBe(hash(parent.text));
      for (const child of parent.children) {
        expect(text.slice(child.startOffset, child.endOffset)).toBe(child.text);
        expect(child.quoteHash).toBe(hash(child.text));
        expect(child.embeddingText).toContain('Akasha');
        expect(child.embeddingText).toContain(parent.headingPath.join(' > '));
      }
    }
  });

  it('splits oversized Chinese blocks without crossing parent boundaries', () => {
    const longParagraph = '知识库检索必须先完成权限过滤。'.repeat(30);
    const text = `# 安全\n${longParagraph}\n# 生成\n回答必须携带引用。`;

    const parents = chunkKnowledgeSource({
      pageTitle: '研发规范',
      text,
      maxChildCharacters: 80,
    });

    expect(parents).toHaveLength(2);
    expect(parents[0].children.length).toBeGreaterThan(1);
    expect(parents[0].children.every((child) => child.text.length <= 80)).toBe(
      true,
    );
    expect(
      parents[0].children.every(
        (child) => child.endOffset <= text.indexOf('# 生成'),
      ),
    ).toBe(true);
  });

  it('gives repeated headings distinct stable keys while preserving unchanged child keys', () => {
    const before = '# Notes\nAlpha\n# Notes\nBeta';
    const after = '# Notes\nAlpha changed\n# Notes\nBeta';

    const first = chunkKnowledgeSource({ pageTitle: 'Page', text: before });
    const second = chunkKnowledgeSource({ pageTitle: 'Page', text: after });

    expect(first[0].stableKey).not.toBe(first[1].stableKey);
    expect(first[1].stableKey).toBe(second[1].stableKey);
    expect(first[1].children[0].stableKey).toBe(
      second[1].children[0].stableKey,
    );
  });

  it('uses ProseMirror heading levels when structured content is available', () => {
    const text = 'Overview\n\nIntro text\n\nDetails\n\nNested text';
    const content = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Overview' }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'Intro text' }] },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Details' }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'Nested text' }] },
      ],
    };

    const parents = chunkKnowledgeSource({
      pageTitle: 'Page',
      text,
      content,
    });

    expect(parents.map((parent) => parent.headingPath)).toEqual([
      ['Overview'],
      ['Overview', 'Details'],
    ]);
  });
});

function hash(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
