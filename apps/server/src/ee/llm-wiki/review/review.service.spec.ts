import { normalizeReviewResultReferences } from './review.service';
import type { ReviewResult } from './review.schema';
import type { StructuredWiki } from './structured-wiki';

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
