import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeSpaceCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-space-compilation.repo';
import { KnowledgeCompilerLlmProvider } from '../compiler/knowledge-compiler-llm.provider';
import { KnowledgeCompilerLlmError } from '../compiler/knowledge-compiler-llm.provider';
import { KnowledgeImportService } from './knowledge-import.service';
import { KnowledgeSpaceAggregatorService } from './knowledge-space-aggregator.service';
import { buildAggregatePrompt } from './knowledge-space-aggregator.service';
import { KnowledgeLinkResolverService } from './knowledge-link-resolver.service';

describe('KnowledgeSpaceAggregatorService', () => {
  it('bounds a representative large-Space narrative prompt', () => {
    const pages = Array.from({ length: 1_000 }, (_, index) =>
      page(
        `artifact-${index}`,
        'concept',
        `concept-${String(index).padStart(4, '0')}`,
        `Concept ${index}`,
        'x'.repeat(2_000),
      ),
    );

    const prompt = buildAggregatePrompt(pages);

    expect(prompt.length).toBeLessThanOrEqual(120_000);
    expect(prompt).toContain('total="1000"');
    expect(prompt).toContain('sampled="100"');
    expect(prompt).toContain('concept-0000');
    expect(prompt).toContain('concept-0990');
  });

  it('publishes an LLM overview plus a deterministic complete catalog', async () => {
    const runRepo = {
      startAggregation: jest.fn().mockResolvedValue({
        id: 'run-1',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
      }),
      completeAggregation: jest.fn().mockResolvedValue(undefined),
    };
    const capsuleRepo = {
      findGraphCandidatesForSpace: jest.fn().mockResolvedValue({
        pages: [
          page('artifact-z', 'entity', 'zeta', 'Zeta', 'Zeta body'),
          page('artifact-a', 'concept', 'alpha', 'Alpha', 'Alpha body'),
          page('old-overview', 'overview', 'overview', 'Old', 'Old body'),
        ],
        pageSources: [
          pageSource('artifact-a', 'page-1', 'v1', 'hash-1'),
          pageSource('artifact-z', 'page-2', 'v2', 'hash-2'),
        ],
        parentSections: [],
        parentSectionSources: [],
        links: [],
        linkSources: [],
        graphEdges: [],
        graphEdgeSources: [],
      }),
    };
    const provider = {
      completeMerge: jest.fn().mockResolvedValue(
        JSON.stringify({
          title: 'Space overview',
          markdown: '# Space overview\n\nA concise synthesis.',
        }),
      ),
    };
    const importer = {
      importCompileResult: jest.fn().mockResolvedValue({
        importedArtifactCount: 1,
        quarantinedArtifactCount: 0,
      }),
    };
    const linkResolver = {
      resolveSpace: jest.fn().mockResolvedValue({ resolvedLinkCount: 1 }),
    };
    const service = new KnowledgeSpaceAggregatorService(
      runRepo as unknown as KnowledgeSpaceCompilationRepo,
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
      provider as unknown as KnowledgeCompilerLlmProvider,
      importer as unknown as KnowledgeImportService,
      linkResolver as unknown as KnowledgeLinkResolverService,
    );

    await expect(
      service.aggregate({
        runId: 'run-1',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        importedArtifactCount: 1,
        quarantinedArtifactCount: 0,
      }),
    );

    expect(provider.completeMerge).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('untrusted'),
        prompt: expect.stringContaining('Alpha body'),
      }),
    );
    const importCall = importer.importCompileResult.mock.calls[0][0];
    expect(importCall.upsertSources).toBe(false);
    expect(importCall.input).toEqual(
      expect.objectContaining({ compileMode: 'space' }),
    );
    expect(importCall.artifacts).toHaveLength(1);
    expect(importCall.artifacts[0]).toEqual(
      expect.objectContaining({
        artifactKind: 'overview',
        canonicalKey: 'overview',
        generationMode: 'semantic',
        contentMarkdown: expect.stringContaining('## Knowledge catalog'),
      }),
    );
    expect(importCall.artifacts[0].chunks[0].stableKey).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(
      importCall.artifacts[0].contentMarkdown.indexOf('Alpha'),
    ).toBeLessThan(importCall.artifacts[0].contentMarkdown.indexOf('Zeta'));
    expect(importCall.artifacts[0].links).toEqual([
      expect.objectContaining({ toKnowledgePageId: 'artifact-a' }),
      expect.objectContaining({ toKnowledgePageId: 'artifact-z' }),
    ]);
    expect(runRepo.completeAggregation).toHaveBeenCalledWith({
      runId: 'run-1',
      importedArtifactCount: 1,
      quarantinedArtifactCount: 0,
    });
    expect(linkResolver.resolveSpace).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
  });

  it('classifies an invalid aggregate contract as non-retryable output', async () => {
    const runRepo = {
      startAggregation: jest.fn().mockResolvedValue({
        id: 'run-1',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
      }),
    };
    const capsuleRepo = {
      findGraphCandidatesForSpace: jest.fn().mockResolvedValue({
        pages: [page('artifact-a', 'concept', 'alpha', 'Alpha', 'Body')],
        pageSources: [pageSource('artifact-a', 'page-1', 'v1', 'hash-1')],
        parentSections: [],
        parentSectionSources: [],
        links: [],
        linkSources: [],
        graphEdges: [],
        graphEdgeSources: [],
      }),
    };
    const service = new KnowledgeSpaceAggregatorService(
      runRepo as unknown as KnowledgeSpaceCompilationRepo,
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
      {
        completeMerge: jest
          .fn()
          .mockResolvedValue('{"title":"","markdown":""}'),
      } as unknown as KnowledgeCompilerLlmProvider,
      { importCompileResult: jest.fn() } as unknown as KnowledgeImportService,
      {
        resolveSpace: jest.fn(),
      } as unknown as KnowledgeLinkResolverService,
    );

    const error = await service
      .aggregate({
        runId: 'run-1',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      })
      .catch((value) => value);

    expect(error).toBeInstanceOf(KnowledgeCompilerLlmError);
    expect(error).toMatchObject({ code: 'invalid_output', retryable: false });
  });

  it('retires the previous Space package when no active page artifacts remain', async () => {
    const runRepo = {
      startAggregation: jest.fn().mockResolvedValue({
        id: 'run-empty',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
      }),
      completeAggregation: jest.fn().mockResolvedValue(undefined),
    };
    const capsuleRepo = {
      findGraphCandidatesForSpace: jest.fn().mockResolvedValue({
        pages: [],
        pageSources: [],
        parentSections: [],
        parentSectionSources: [],
        links: [],
        linkSources: [],
        graphEdges: [],
        graphEdgeSources: [],
      }),
      markCompileScopeStale: jest.fn().mockResolvedValue(undefined),
    };
    const provider = { completeMerge: jest.fn() };
    const importer = { importCompileResult: jest.fn() };
    const service = new KnowledgeSpaceAggregatorService(
      runRepo as unknown as KnowledgeSpaceCompilationRepo,
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
      provider as unknown as KnowledgeCompilerLlmProvider,
      importer as unknown as KnowledgeImportService,
      { resolveSpace: jest.fn() } as unknown as KnowledgeLinkResolverService,
    );

    await expect(
      service.aggregate({
        runId: 'run-empty',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual({
      importedArtifactCount: 0,
      quarantinedArtifactCount: 0,
    });

    expect(capsuleRepo.markCompileScopeStale).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(provider.completeMerge).not.toHaveBeenCalled();
    expect(importer.importCompileResult).not.toHaveBeenCalled();
  });
});

function page(
  id: string,
  pageType: string,
  canonicalKey: string,
  title: string,
  body: string,
) {
  return {
    id,
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    compileScope: pageType === 'overview' ? 'space' : 'page',
    title,
    slug: id,
    pageType,
    body,
    summary: null,
    compiledAt: new Date(),
    compilerVersion: 'compiler-v1',
    compilerRunId: 'page-run',
    compileTaskId: 'page-task',
    staleAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    generationMode: pageType === 'overview' ? 'legacy' : 'semantic',
    canonicalKey,
  };
}

function pageSource(
  knowledgePageId: string,
  sourcePageId: string,
  sourceVersion: string,
  contentHash: string,
) {
  return {
    workspaceId: 'workspace-1',
    knowledgePageId,
    sourcePageId,
    attachmentId: null,
    sourceVersion,
    sourceRange: null,
    quoteHash: null,
    contentHash,
    provenanceKind: 'synthesis_lineage',
  };
}
