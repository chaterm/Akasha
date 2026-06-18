import { KNOWLEDGE_COMPLETENESS_NOTICE } from './knowledge-retrieval.service';
import { KnowledgeContextPackService } from './knowledge-context-pack.service';

describe('KnowledgeContextPackService', () => {
  it('builds context from authorized capsules and readable citations only', () => {
    const service = new KnowledgeContextPackService();

    const pack = service.buildContextPack({
      capsules: [
        {
          capsule: capsule(
            'kp-1',
            'Kafka Guide',
            'Use Kafka for async events.',
          ),
          citations: [
            {
              sourcePageId: 'page-1',
              title: 'Readable Page',
              url: '/s/space/page-1',
            },
          ],
        },
        {
          capsule: capsule('kp-2', 'Hidden Source Derived', 'Authorized body.'),
          citations: [],
        },
      ],
    });

    expect(pack.context).toBe(
      [
        '# Kafka Guide',
        'Use Kafka for async events.',
        '',
        '# Hidden Source Derived',
        'Authorized body.',
      ].join('\n'),
    );
    expect(pack.citations).toEqual([
      {
        sourcePageId: 'page-1',
        title: 'Readable Page',
        url: '/s/space/page-1',
      },
    ]);
    expect(pack.primary).toEqual([
      {
        id: 'kp-1',
        kind: 'capsule',
        title: 'Kafka Guide',
        text: 'Use Kafka for async events.',
        citationSourcePageIds: ['page-1'],
        retrievalReasons: [],
        sourceWindows: [],
      },
      {
        id: 'kp-2',
        kind: 'capsule',
        title: 'Hidden Source Derived',
        text: 'Authorized body.',
        citationSourcePageIds: [],
        retrievalReasons: [],
        sourceWindows: [],
      },
    ]);
    expect(pack.warnings).toEqual([]);
    expect(pack.retrievalReasons).toEqual([]);
    expect(pack.budget).toMatchObject({
      maxContextLength: 12000,
      includedItemCount: 2,
      omittedItemCount: 0,
    });
    expect(pack.budget.usedContextLength).toBe(pack.context.length);
    expect(pack.completenessNotice).toBe(KNOWLEDGE_COMPLETENESS_NOTICE);
  });

  it('builds structured chunk context with retrieval reasons, source windows, warnings, and budget', () => {
    const service = new KnowledgeContextPackService();

    const pack = service.buildContextPack({
      chunks: [
        {
          chunk: chunk('chunk-1', 'kp-1', '登记批准日期：2026年06月05日'),
          pageTitle: '合合信息Chaterm',
          citations: [
            {
              sourcePageId: 'page-1',
              title: 'Chaterm source',
              url: '/p/chaterm',
            },
          ],
          retrievalReasons: ['exact-title', 'lexical', 'sidecar-prefiltered'],
          sourceWindows: [
            {
              sourcePageId: 'page-1',
              title: 'Chaterm source',
              url: '/p/chaterm',
              text: '登记批准日期：2026年06月05日',
              sourceRange: { startOffset: 4, endOffset: 22 },
              quoteHash: 'sha256:quote',
            },
          ],
          warnings: ['Some retrieved knowledge may be stale.'],
        },
      ],
    });

    expect(pack.context).toContain('# 合合信息Chaterm');
    expect(pack.context).toContain('登记批准日期：2026年06月05日');
    expect(pack.primary).toEqual([
      {
        id: 'chunk-1',
        kind: 'chunk',
        title: '合合信息Chaterm',
        text: '登记批准日期：2026年06月05日',
        citationSourcePageIds: ['page-1'],
        retrievalReasons: ['exact-title', 'lexical', 'sidecar-prefiltered'],
        sourceWindows: [
          {
            sourcePageId: 'page-1',
            title: 'Chaterm source',
            url: '/p/chaterm',
            text: '登记批准日期：2026年06月05日',
            sourceRange: { startOffset: 4, endOffset: 22 },
            quoteHash: 'sha256:quote',
          },
        ],
      },
    ]);
    expect(pack.citations).toEqual([
      {
        sourcePageId: 'page-1',
        title: 'Chaterm source',
        url: '/p/chaterm',
      },
    ]);
    expect(pack.warnings).toEqual(['Some retrieved knowledge may be stale.']);
    expect(pack.retrievalReasons).toEqual([
      'exact-title',
      'lexical',
      'sidecar-prefiltered',
    ]);
    expect(pack.budget).toMatchObject({
      maxContextLength: 12000,
      includedItemCount: 1,
      omittedItemCount: 0,
      responseReserve: expect.any(Number),
      perItemMaxLength: expect.any(Number),
    });
    expect(pack.budget.usedContextLength).toBe(pack.context.length);
  });

  it('does not reveal filtered counts or denied reasons', () => {
    const service = new KnowledgeContextPackService();

    const pack = service.buildContextPack({
      capsules: [],
    });

    expect(pack.context).toBe('');
    expect(pack.citations).toEqual([]);
    expect(pack.primary).toEqual([]);
    expect(pack.warnings).toEqual([]);
    expect(pack.completenessNotice).toBe(KNOWLEDGE_COMPLETENESS_NOTICE);
    expect(JSON.stringify(pack)).not.toContain('denied');
    expect(JSON.stringify(pack)).not.toContain('filtered');
    expect(JSON.stringify(pack)).not.toContain('hidden');
  });

  it('limits context size while preserving capsule order', () => {
    const service = new KnowledgeContextPackService();

    const pack = service.buildContextPack({
      capsules: [
        { capsule: capsule('kp-1', 'First', 'A'.repeat(9000)) },
        { capsule: capsule('kp-2', 'Second', 'B'.repeat(9000)) },
      ],
    });

    expect(pack.context.length).toBeLessThanOrEqual(12000);
    expect(pack.context).toContain('# First');
    expect(pack.context).toContain('# Second');
    expect(pack.context.indexOf('# First')).toBeLessThan(
      pack.context.indexOf('# Second'),
    );
    expect(pack.budget.usedContextLength).toBeLessThanOrEqual(
      pack.budget.maxContextLength,
    );
  });

  it('only returns citations for chunks that are included in the bounded context', () => {
    const service = new KnowledgeContextPackService();

    const pack = service.buildContextPack({
      chunks: [
        {
          chunk: chunk('chunk-1', 'kp-1', 'A'.repeat(11_980)),
          pageTitle: 'Long KMS',
          citations: [
            { sourcePageId: 'page-1', title: 'Long KMS', url: '/p/page-1' },
          ],
        },
        {
          chunk: chunk('chunk-2', 'kp-2', '登记批准日期：2026年06月05日'),
          pageTitle: '合合信息Chaterm',
          citations: [
            {
              sourcePageId: 'page-2',
              title: '合合信息Chaterm',
              url: '/p/page-2',
            },
          ],
        },
      ],
    });

    expect(pack.context).toContain('Long KMS');
    expect(pack.context).not.toContain('登记批准日期');
    expect(pack.citations).toEqual([
      { sourcePageId: 'page-1', title: 'Long KMS', url: '/p/page-1' },
    ]);
    expect(pack.primary.map((entry) => entry.id)).toEqual(['chunk-1']);
    expect(pack.budget.omittedItemCount).toBe(1);
  });

  it('applies configured context and per-item budgets', () => {
    const service = new KnowledgeContextPackService();

    const pack = service.buildContextPack({
      budget: {
        totalContextLength: 200,
        responseReserve: 50,
        perItemMaxLength: 80,
      },
      chunks: [
        {
          chunk: chunk('chunk-1', 'kp-1', 'A'.repeat(400)),
          pageTitle: 'Very long source',
        },
      ],
    });

    expect(pack.context.length).toBeLessThanOrEqual(150);
    expect(pack.primary[0].text.length).toBeLessThanOrEqual(80);
    expect(pack.budget).toMatchObject({
      maxContextLength: 150,
      responseReserve: 50,
      perItemMaxLength: 80,
      includedItemCount: 1,
      omittedItemCount: 0,
    });
  });
});

function capsule(id: string, title: string, body: string) {
  return {
    id,
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    compileScope: 'space',
    title,
    slug: id,
    pageType: null,
    body,
    summary: null,
    compiledAt: new Date('2026-06-16T00:00:00.000Z'),
    compilerVersion: 'compiler@1',
    compilerRunId: 'run-1',
    compileTaskId: 'task-1',
    staleAt: null,
    createdAt: new Date('2026-06-16T00:00:00.000Z'),
    updatedAt: new Date('2026-06-16T00:00:00.000Z'),
  };
}

function chunk(id: string, knowledgePageId: string, text: string) {
  return {
    id,
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    knowledgePageId,
    claimId: null,
    text,
    contentHash: `${id}-hash`,
    embedding: [1, 0],
    compilerRunId: 'run-1',
    compileTaskId: 'task-1',
    staleAt: null,
    createdAt: new Date('2026-06-16T00:00:00.000Z'),
  };
}
