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
  it('keeps attachment markers whole, in one child, cleaned from output', () => {
    const marker =
      '[[AKASHA_ATTACHMENT:v1:550e8400-e29b-41d4-a716-446655440000]]';
    const filler = 'A'.repeat(200);
    const text = `${filler}\nconfig.xlsx ${marker}\n${filler}`;
    const markerStart = text.indexOf('config.xlsx');
    const markerEnd = text.indexOf(marker) + marker.length;

    const parents = chunkKnowledgeSource({
      pageTitle: 'Page',
      text,
      maxChildCharacters: 120,
      attachmentOccurrences: [
        { startOffset: markerStart, endOffset: markerEnd },
      ],
    });

    const children = parents.flatMap((parent) => parent.children);
    // No child text or embedding text may contain the internal marker.
    for (const child of children) {
      expect(child.text).not.toContain('AKASHA_ATTACHMENT');
      expect(child.embeddingText).not.toContain('AKASHA_ATTACHMENT');
      expect(child.quoteHash).toBe(hash(child.text));
    }
    // The file name survives for retrieval.
    expect(children.some((child) => child.text.includes('config.xlsx'))).toBe(
      true,
    );
    // Exactly one child carries the file name (marker not copied to neighbors).
    expect(
      children.filter((child) => child.text.includes('config.xlsx')),
    ).toHaveLength(1);
  });

  it('does not cut inside a marker when it straddles a length boundary', () => {
    const marker =
      '[[AKASHA_ATTACHMENT:v1:550e8400-e29b-41d4-a716-446655440000]]';
    // Force the raw split near the middle of the marker.
    const head = 'x'.repeat(60);
    const text = `${head} report.pdf ${marker} tail`;
    const markerStart = text.indexOf('report.pdf');
    const markerEnd = text.indexOf(marker) + marker.length;

    const parents = chunkKnowledgeSource({
      pageTitle: 'Page',
      text,
      maxChildCharacters: 80,
      attachmentOccurrences: [
        { startOffset: markerStart, endOffset: markerEnd },
      ],
    });

    const children = parents.flatMap((parent) => parent.children);
    // The raw source between offsets must never bisect the marker: any child
    // whose raw range overlaps the marker must contain it entirely.
    for (const child of children) {
      const overlaps =
        child.startOffset < markerEnd && child.endOffset > markerStart;
      if (overlaps) {
        expect(child.startOffset).toBeLessThanOrEqual(markerStart);
        expect(child.endOffset).toBeGreaterThanOrEqual(markerEnd);
      }
      expect(child.text).not.toContain('AKASHA_ATTACHMENT');
    }
  });

  it('preserves marker-shaped user text outside trusted occurrences', () => {
    const marker = '[[AKASHA_ATTACHMENT:v1:user-written]]';
    const trustedMarker = '[[AKASHA_ATTACHMENT:v1:att-1]]';
    const text = `Literal ${marker}\nfile.pdf ${trustedMarker}`;
    const occurrenceStart = text.indexOf('file.pdf');

    const parents = chunkKnowledgeSource({
      pageTitle: 'Page',
      text,
      attachmentOccurrences: [
        { startOffset: occurrenceStart, endOffset: text.length },
      ],
    });
    const output = parents
      .flatMap((parent) => parent.children)
      .map((child) => child.text)
      .join('\n');

    expect(output).toContain(marker);
    expect(output).not.toContain(trustedMarker);
    expect(output).toContain('file.pdf');
  });

  it('namespaces stable keys while keeping 64-char parent/child alignment', () => {
    const text = '# Notes\nAlpha content here';
    const plain = chunkKnowledgeSource({ pageTitle: 'Page', text });
    const namespaced = chunkKnowledgeSource({
      pageTitle: 'Page',
      text,
      stableKeyNamespace: 'source',
    });
    const again = chunkKnowledgeSource({
      pageTitle: 'Page',
      text,
      stableKeyNamespace: 'source',
    });

    expect(namespaced[0].stableKey).toHaveLength(64);
    expect(namespaced[0].children[0].stableKey).toHaveLength(64);
    // Namespacing changes keys deterministically.
    expect(namespaced[0].stableKey).not.toBe(plain[0].stableKey);
    expect(namespaced[0].stableKey).toBe(again[0].stableKey);
    expect(namespaced[0].children[0].stableKey).toBe(
      again[0].children[0].stableKey,
    );
  });

  it('keeps offsets correct across Chinese, emoji and newlines', () => {
    const text = '第一段落 🚀\n第二段落包含表情 😀 结束';
    const parents = chunkKnowledgeSource({ pageTitle: '页面', text });
    for (const parent of parents) {
      expect(text.slice(parent.startOffset, parent.endOffset)).toBe(
        parent.text,
      );
      for (const child of parent.children) {
        expect(text.slice(child.startOffset, child.endOffset)).toBe(child.text);
        expect(child.quoteHash).toBe(hash(child.text));
      }
    }
  });
});

function hash(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
