import { buildKnowledgeQualityReport } from './knowledge-quality.service';

describe('buildKnowledgeQualityReport', () => {
  it('builds exact workspace and per-Space health from bounded aggregate rows', () => {
    const report = buildKnowledgeQualityReport(
      [
        {
          spaceId: 'space-1',
          spaceName: 'Product',
          pageCount: 2,
          compiledPageCount: 2,
          stalePageCount: 1,
          staleSourcePageCount: 1,
          staleAccessPolicyPageCount: 0,
          missingSourcePageCount: 0,
          missingChunkPageCount: 0,
          missingEmbeddingPageCount: 0,
          oldestStaleSourceAt: new Date('2026-06-16T00:00:00.000Z'),
          scoreSum: 170,
        },
        {
          spaceId: 'space-2',
          spaceName: 'Engineering',
          pageCount: 2,
          compiledPageCount: 1,
          stalePageCount: 0,
          staleSourcePageCount: 0,
          staleAccessPolicyPageCount: 0,
          missingSourcePageCount: 1,
          missingChunkPageCount: 1,
          missingEmbeddingPageCount: 1,
          oldestStaleSourceAt: null,
          scoreSum: 90,
        },
      ],
      new Date('2026-06-18T00:00:00.000Z'),
    );

    expect(report.summary).toEqual({
      pageCount: 4,
      compiledPageCount: 3,
      stalePageCount: 1,
      missingSourcePageCount: 1,
      missingChunkPageCount: 1,
      missingEmbeddingPageCount: 1,
      healthScore: 65,
    });
    expect(report.spaces).toEqual([
      expect.objectContaining({
        spaceId: 'space-1',
        healthScore: 85,
        oldestStaleSourceAgeHours: 48,
      }),
      expect.objectContaining({
        spaceId: 'space-2',
        healthScore: 45,
        oldestStaleSourceAgeHours: null,
      }),
    ]);
    expect(report.topIssues).toEqual([
      expect.objectContaining({ code: 'missing_chunks', affectedPageCount: 1 }),
      expect.objectContaining({
        code: 'missing_sources',
        affectedPageCount: 1,
      }),
      expect.objectContaining({
        code: 'missing_embeddings',
        affectedPageCount: 1,
      }),
      expect.objectContaining({ code: 'stale_sources', affectedPageCount: 1 }),
    ]);
  });

  it('returns a healthy empty report without dividing by zero', () => {
    expect(buildKnowledgeQualityReport([], new Date()).summary).toEqual({
      pageCount: 0,
      compiledPageCount: 0,
      stalePageCount: 0,
      missingSourcePageCount: 0,
      missingChunkPageCount: 0,
      missingEmbeddingPageCount: 0,
      healthScore: 100,
    });
  });
});
