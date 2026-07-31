import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('knowledge compilation clean cutover', () => {
  it.each([
    'services/knowledge-text-job.handler.ts',
    'services/knowledge-space-compilation.service.ts',
    'processors/knowledge-image.processor.ts',
  ])(
    'does not retain a legacy page-sized queue implementation in %s',
    (file) => {
      const source = readFileSync(join(__dirname, file), 'utf8');

      for (const forbidden of [
        /QueueJob\.KNOWLEDGE_COMPILE_SPACE(?!_TEXT)/,
        /QueueJob\.KNOWLEDGE_COMPILE_PAGES\b/,
        /QueueJob\.KNOWLEDGE_COMPILE_PAGE_IMAGES\b/,
        /QueueJob\.KNOWLEDGE_MERGE_PAGE_IMAGES\b/,
        /QueueJob\.KNOWLEDGE_AGGREGATE_SPACE\b/,
      ]) {
        expect(source).not.toMatch(forbidden);
      }
    },
  );

  it('requires lease-bound execution for every page compilation operation', () => {
    const source = readFileSync(
      join(__dirname, 'services/knowledge-page-compilation.service.ts'),
      'utf8',
    );

    expect(source).not.toContain('KnowledgeSpaceCompilationService');
    expect(source).not.toContain('execution?:');
    expect(source).not.toContain('queueStandalonePage');
  });

  it('keeps aggregation lease-bound and exposes no natural terminal writer', () => {
    const source = readFileSync(
      join(__dirname, 'services/knowledge-space-aggregator.service.ts'),
      'utf8',
    );

    expect(source).not.toMatch(/\basync aggregate\(/);
    expect(source).not.toContain('completeAggregation');
    expect(source).not.toContain('KnowledgeSpaceCompilationRepo');
  });

  it('keeps legacy natural Run writers out of the compilation repository', () => {
    const source = readFileSync(
      join(
        __dirname,
        '../../database/repos/llm-wiki/knowledge-space-compilation.repo.ts',
      ),
      'utf8',
    );

    for (const method of [
      'createRun',
      'completePage',
      'startAggregation',
      'completeAggregation',
      'failAggregation',
      'findPendingPageDispatches',
      'markPageQueued',
      'findAggregatePendingRuns',
      'markAggregationQueued',
      'beginPageImages',
      'recordPageImageAttempt',
      'completePageImages',
      'beginPageMerge',
      'completePageMergePublication',
      'failPageMerge',
    ]) {
      expect(source).not.toMatch(new RegExp(`\\basync ${method}\\(`));
    }
  });

  it('serves the compile console only through bounded diagnostics endpoints', () => {
    const controller = readFileSync(
      join(__dirname, 'llm-wiki.controller.ts'),
      'utf8',
    );
    const clientPage = readFileSync(
      join(
        __dirname,
        '../../../../client/src/ee/llm-wiki/pages/knowledge-admin.tsx',
      ),
      'utf8',
    );

    expect(controller).not.toContain("@Post('admin/diagnostics')");
    expect(clientPage).not.toContain('getKnowledgeDiagnostics');
  });

  it('removes legacy queue protocol names, ID builders, and composite diagnostics', () => {
    const files = [
      '../../integrations/queue/constants/queue.constants.ts',
      '../../integrations/queue/constants/queue.interface.ts',
      'services/knowledge-queue.utils.ts',
      'services/knowledge-diagnostics.service.ts',
    ].map((file) => readFileSync(join(__dirname, file), 'utf8'));
    const source = files.join('\n');

    for (const forbidden of [
      'KNOWLEDGE_COMPILE_SPACE =',
      'KNOWLEDGE_COMPILE_PAGES',
      'KNOWLEDGE_COMPILE_PAGE_IMAGES',
      'KNOWLEDGE_MERGE_PAGE_IMAGES',
      'KNOWLEDGE_AGGREGATE_SPACE',
      'IKnowledgeCompilePagesJob',
      'IKnowledgeMergePageImagesJob',
      'buildKnowledgeAggregateSpaceJobId',
      'getWorkspaceDiagnostics',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
