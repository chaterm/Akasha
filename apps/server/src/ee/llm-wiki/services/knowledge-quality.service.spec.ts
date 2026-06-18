import { KnowledgeQualityService } from './knowledge-quality.service';
import { KnowledgeDiagnosticsPage } from './knowledge-diagnostics.service';

describe('KnowledgeQualityService', () => {
  it('computes deterministic health, per-space status, and actionable issues', () => {
    const service = new KnowledgeQualityService();

    const report = service.evaluate({
      pages: [
        diagnosticsPage({
          pageId: 'page-good',
          spaceId: 'space-1',
          spaceName: 'Product',
          knowledgeSourceCount: 1,
          knowledgePageSourceCount: 1,
          knowledgeChunkCount: 3,
          missingEmbeddingChunkCount: 0,
        }),
        diagnosticsPage({
          pageId: 'page-stale',
          spaceId: 'space-1',
          spaceName: 'Product',
          knowledgeSourceCount: 1,
          staleSourceCount: 1,
          knowledgePageSourceCount: 1,
          knowledgeChunkCount: 2,
          oldestStaleSourceAt: new Date('2026-06-16T00:00:00.000Z'),
        }),
        diagnosticsPage({
          pageId: 'page-missing',
          spaceId: 'space-2',
          spaceName: 'Engineering',
          knowledgeSourceCount: 0,
          knowledgePageSourceCount: 0,
          knowledgeChunkCount: 0,
          missingEmbeddingChunkCount: 0,
        }),
        diagnosticsPage({
          pageId: 'page-embedding',
          spaceId: 'space-2',
          spaceName: 'Engineering',
          knowledgeSourceCount: 1,
          knowledgePageSourceCount: 1,
          knowledgeChunkCount: 2,
          missingEmbeddingChunkCount: 2,
        }),
      ],
      now: new Date('2026-06-18T00:00:00.000Z'),
    });

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
      {
        spaceId: 'space-1',
        spaceName: 'Product',
        pageCount: 2,
        compiledPageCount: 2,
        stalePageCount: 1,
        missingChunkPageCount: 0,
        missingEmbeddingPageCount: 0,
        oldestStaleSourceAgeHours: 48,
        healthScore: 85,
      },
      {
        spaceId: 'space-2',
        spaceName: 'Engineering',
        pageCount: 2,
        compiledPageCount: 1,
        stalePageCount: 0,
        missingChunkPageCount: 1,
        missingEmbeddingPageCount: 1,
        oldestStaleSourceAgeHours: null,
        healthScore: 45,
      },
    ]);
    expect(report.topIssues).toEqual([
      {
        code: 'missing_chunks',
        severity: 'high',
        message: 'Some pages have no compiled chunks.',
        affectedPageCount: 1,
      },
      {
        code: 'missing_sources',
        severity: 'high',
        message: 'Some pages have not been exported into knowledge sources.',
        affectedPageCount: 1,
      },
      {
        code: 'missing_embeddings',
        severity: 'medium',
        message: 'Some compiled chunks are missing embeddings.',
        affectedPageCount: 1,
      },
      {
        code: 'stale_sources',
        severity: 'medium',
        message: 'Some sources changed after compilation.',
        affectedPageCount: 1,
      },
    ]);
  });
});

function diagnosticsPage(
  overrides: Partial<KnowledgeDiagnosticsPage>,
): KnowledgeDiagnosticsPage {
  return {
    pageId: 'page-1',
    slugId: 'page-1',
    title: 'Page',
    spaceId: 'space-1',
    spaceName: 'Space',
    spaceSlug: 'space',
    updatedAt: new Date('2026-06-18T00:00:00.000Z'),
    deletedAt: null,
    textLength: 100,
    knowledgeSourceCount: 0,
    staleSourceCount: 0,
    oldestStaleSourceAt: null,
    knowledgePageSourceCount: 0,
    knowledgeChunkCount: 0,
    missingEmbeddingChunkCount: 0,
    lastCompiledAt: null,
    lastAccessPolicyIndexedAt: null,
    staleAccessPolicyCount: 0,
    ...overrides,
  };
}
