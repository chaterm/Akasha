import { generateText } from 'ai';
import {
  normalizeReviewResultReferences,
  ReviewService,
} from './review.service';
import {
  draftContentSchema,
  resolvedReviewSchema,
  type ReviewResult,
} from './review.schema';
import type { StructuredWiki } from './structured-wiki';

jest.mock('ai', () => ({ generateText: jest.fn() }));
jest.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: jest.fn(() =>
    Object.assign(jest.fn(() => 'review-model'), {
      chatModel: jest.fn(() => 'review-model'),
    }),
  ),
}));

describe('ReviewService external call bounds', () => {
  it('applies a hard timeout to review and negotiation model calls', async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce({
        text: JSON.stringify({ version: '2', items: [] }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          title: 'New page',
          body: 'Body',
          applyOperation: ['create-page'],
          targetDocId: null,
          notes: '',
        }),
      });
    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    const service = new ReviewService(
      {
        getKnowledgeCompilerTimeoutMs: jest.fn(() => 120_000),
      } as never,
      {
        getResolvedConfig: jest.fn().mockResolvedValue({
          driver: 'openai-compatible',
          model: 'chat-model',
          apiKey: 'key',
          baseUrl: 'https://example.test/v1',
          parameters: {},
          fromDatabase: true,
        }),
      } as never,
    );
    const wiki: StructuredWiki = {
      version: '1',
      folders: [],
      documents: [],
    };
    const source = {
      load: jest.fn().mockResolvedValue(wiki),
      getDocument: jest.fn().mockResolvedValue(null),
      listFolders: jest.fn().mockResolvedValue([]),
    };

    await service.reviewWiki(source);
    await service.negotiateDraft(
      source,
      {
        id: 'review-1',
        type: 'missing-page',
        title: 'New page',
        detail: 'Missing.',
        recommendation: 'Create it.',
        relatedDocIds: [],
        searchQueries: [],
        outline: [],
      },
      '采纳',
    );

    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      120_000,
    );
    expect(generateText).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    expect(generateText).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    timeoutSpy.mockRestore();
  });
});

describe('normalizeReviewResultReferences', () => {
  it('rewrites bare document UUIDs into canonical [id=...] tokens', () => {
    const wiki: StructuredWiki = {
      version: '1',
      folders: [],
      documents: [
        {
          id: '70147931-2df1-48ef-aef2-f16f2fdb132e',
          title: 'SLI/SLO 指南',
          folderId: null,
          body: 'body',
          claims: [],
          links: [],
          tags: [],
          status: 'reviewed',
          confidence: 0.5,
        },
      ],
    };
    const result: ReviewResult = {
      version: '2',
      items: [
        {
          id: 'rev-1',
          type: 'suggestion',
          title: '补全 SLO 落地细节',
          detail:
            '文档 70147931-2df1-48ef-aef2-f16f2fdb132e 仅有概述性条目，缺少样例。',
          recommendation:
            '建议在 70147931-2df1-48ef-aef2-f16f2fdb132e 中加入 Prometheus 与告警规则示例。',
          relatedDocIds: ['70147931-2df1-48ef-aef2-f16f2fdb132e'],
          searchQueries: ['slo prometheus alerting'],
          targetDocId: '70147931-2df1-48ef-aef2-f16f2fdb132e',
        },
      ],
    };

    expect(normalizeReviewResultReferences(result, wiki)).toEqual({
      version: '2',
      items: [
        expect.objectContaining({
          detail:
            '文档 [id=70147931-2df1-48ef-aef2-f16f2fdb132e] 仅有概述性条目，缺少样例。',
          recommendation:
            '建议在 [id=70147931-2df1-48ef-aef2-f16f2fdb132e] 中加入 Prometheus 与告警规则示例。',
        }),
      ],
    });
  });
});

describe('draftContentSchema', () => {
  it('maps legacy approach-only drafts to applyOperation arrays', () => {
    expect(
      draftContentSchema.parse({
        title: 'Rollback criteria',
        body: '## Rollback criteria\n\nRollback when needed.',
        approach: 'section',
        targetDocId: 'kp-1',
        notes: '',
      }),
    ).toMatchObject({
      applyOperation: ['append-section'],
    });
  });
});

describe('resolvedReviewSchema', () => {
  it('hydrates legacy resolved reviews into a single negotiation turn', () => {
    const parsed = resolvedReviewSchema.parse({
      item: {
        id: 'rev-1',
        type: 'suggestion',
        title: 'Add rollback section',
        detail: 'Missing rollback details.',
        recommendation: 'Add rollback details.',
        relatedDocIds: ['kp-1'],
        searchQueries: [],
        targetDocId: 'kp-1',
      },
      feedback: '采纳',
      skipped: false,
      deepSearched: false,
      searchResults: [],
      draft: {
        title: 'Rollback criteria',
        body: '## Rollback criteria\n\nRollback when needed.',
        applyOperation: ['append-section'],
        targetDocId: 'kp-1',
        notes: '',
      },
      applied: null,
    });

    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]).toMatchObject({
      feedback: '采纳',
      draft: { title: 'Rollback criteria' },
    });
  });

  it('keeps full negotiation history while exposing the latest draft', () => {
    const baseDraft = {
      title: 'Rollback criteria',
      body: '## Rollback criteria\n\nRollback when needed.',
      applyOperation: ['append-section'],
      targetDocId: 'kp-1',
      notes: '',
    };
    const parsed = resolvedReviewSchema.parse({
      item: {
        id: 'rev-1',
        type: 'suggestion',
        title: 'Add rollback section',
        detail: 'Missing rollback details.',
        recommendation: 'Add rollback details.',
        relatedDocIds: ['kp-1'],
        searchQueries: [],
        targetDocId: 'kp-1',
      },
      feedback: 'old feedback',
      skipped: false,
      deepSearched: false,
      searchResults: [],
      draft: baseDraft,
      applied: null,
      turns: [
        {
          feedback: 'old feedback',
          draft: baseDraft,
          deepSearched: false,
          searchResults: [],
        },
        {
          feedback: 'latest feedback',
          draft: { ...baseDraft, title: 'Latest rollback criteria' },
          deepSearched: false,
          searchResults: [],
        },
      ],
    });

    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0]).toMatchObject({
      feedback: 'old feedback',
      draft: { title: 'Rollback criteria' },
    });
    expect(parsed.turns[1]).toMatchObject({
      feedback: 'latest feedback',
      draft: { title: 'Latest rollback criteria' },
    });
    expect(parsed.draft).toMatchObject({ title: 'Latest rollback criteria' });
  });
});
