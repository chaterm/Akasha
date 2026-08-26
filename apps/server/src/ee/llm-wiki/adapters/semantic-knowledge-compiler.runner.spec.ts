import { KnowledgeCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-compilation.repo';
import {
  KnowledgeCompilerLlmError,
  KnowledgeCompilerLlmProvider,
} from '../compiler/knowledge-compiler-llm.provider';
import { SemanticAnalysis } from '../compiler/semantic-compiler.schema';
import { CompileSpaceInput } from '../types/compiler-artifact.types';
import { SemanticKnowledgeCompilerRunner } from './semantic-knowledge-compiler.runner';

const analysis: SemanticAnalysis = {
  version: '1',
  synopsis: 'Event sourcing records changes as an append-only log.',
  language: 'en',
  entities: [],
  concepts: [
    {
      canonicalKey: 'event-sourcing',
      name: 'Event sourcing',
      description: 'An append-only state reconstruction pattern.',
      evidenceQuotes: ['records changes as an append-only log'],
    },
  ],
  claims: [],
  relations: [],
  comparisons: [],
  contradictions: [],
};

const generation = {
  version: '1' as const,
  artifacts: [
    {
      kind: 'source_summary' as const,
      canonicalKey: 'model-supplied-summary-key',
      title: 'Architecture notes',
      markdown: 'The source explains event sourcing.',
      claims: [
        {
          text: 'Event sourcing records changes.',
          confidence: 0.95,
          evidenceQuote: 'records changes as an append-only log',
        },
      ],
      links: [
        {
          targetKind: 'concept' as const,
          targetCanonicalKey: 'event-sourcing',
          relation: 'explains',
          evidenceQuote: 'Event sourcing',
        },
      ],
      tags: ['architecture'],
    },
    {
      kind: 'concept' as const,
      canonicalKey: 'event-sourcing',
      title: 'Event sourcing',
      markdown: 'Event sourcing stores state changes in an append-only log.',
      claims: [
        {
          text: 'State changes are append-only.',
          evidenceQuote: 'append-only log',
        },
      ],
      links: [],
      tags: ['architecture'],
    },
  ],
};

describe('SemanticKnowledgeCompilerRunner', () => {
  it('uses the queue task identity when updating fenced compilation stages', async () => {
    const provider = createProvider();
    const compilationRepo = createCompilationRepo();
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      compilationRepo,
    );

    await runner.compileSpace({
      ...compileInput(),
      compileTaskId: 'knowledge-page-job-1',
    });

    expect(compilationRepo.updateStage).toHaveBeenNthCalledWith(1, {
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: 'knowledge-page-job-1',
      stage: 'analysis',
    });
    expect(compilationRepo.updateStage).toHaveBeenNthCalledWith(2, {
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: 'knowledge-page-job-1',
      stage: 'generation',
    });
  });

  it('runs analysis then generation and emits stable typed artifacts', async () => {
    const provider = createProvider();
    const compilationRepo = createCompilationRepo();
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      compilationRepo,
    );

    const first = await runner.compileSpace(compileInput());
    const second = await runner.compileSpace(compileInput());

    expect(provider.analyze).toHaveBeenCalledTimes(2);
    expect(provider.generate).toHaveBeenCalledTimes(2);
    expect(provider.analyze.mock.invocationCallOrder[0]).toBeLessThan(
      provider.generate.mock.invocationCallOrder[0],
    );
    expect(first.artifacts.map((artifact) => artifact.artifactId)).toEqual(
      second.artifacts.map((artifact) => artifact.artifactId),
    );
    expect(first.artifacts).toEqual([
      expect.objectContaining({
        artifactKind: 'source_summary',
        canonicalKey: 'page-1',
        compileTaskId: 'akasha-page:page-1',
      }),
      expect.objectContaining({
        artifactKind: 'concept',
        canonicalKey: 'event-sourcing',
      }),
    ]);
    expect(compilationRepo.saveAnalysis).toHaveBeenCalledTimes(2);
  });

  it('adds deterministic table-row evidence to the source summary', async () => {
    const provider = createProvider();
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      createCompilationRepo(),
    );
    const input = compileInput();
    input.sources[0].content = tableContent();
    input.sources[0].text =
      '表头：Service；Version；Primary IP；Contact\nService=service-alpha；Version=5.7-test；Primary IP=192.0.2.8；Contact=owner-a';

    const result = await runner.compileSpace(input);
    const summary = result.artifacts.find(
      (artifact) => artifact.artifactKind === 'source_summary',
    );
    const rowChunk = summary?.chunks?.find((chunk) =>
      chunk.text.includes('Primary IP=192.0.2.8'),
    );

    expect(rowChunk).toEqual(
      expect.objectContaining({
        chunkRole: 'standalone',
        retrievalChannel: 'evidence',
        embeddingText: expect.stringContaining('Primary IP=192.0.2.8'),
      }),
    );
    expect(rowChunk?.inputSourceRefs?.[0]?.sourceRange).toEqual({
      startOffset: input.sources[0].text.indexOf('Service=service-alpha'),
      endOffset: input.sources[0].text.length,
    });
  });

  it('reuses an exact cached analysis and skips the Stage 1 call', async () => {
    const provider = createProvider();
    const compilationRepo = createCompilationRepo(analysis);
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      compilationRepo,
    );

    await runner.compileSpace(compileInput());

    expect(provider.analyze).not.toHaveBeenCalled();
    expect(provider.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('<stage_1_analysis>'),
      }),
      {
        canonicalKey: 'page-1',
        title: 'Architecture notes',
        markdown: 'Event sourcing records changes as an append-only log.',
      },
    );
    expect(compilationRepo.saveAnalysis).not.toHaveBeenCalled();
  });

  it('does not reuse analysis when the effective knowledge hash changes', async () => {
    const provider = createProvider();
    const compilationRepo = createCompilationRepo();
    let firstCacheKey: string | undefined;
    compilationRepo.findAnalysis.mockImplementation(async (key) => {
      if (!firstCacheKey) {
        firstCacheKey = key.effectiveKnowledgeHash;
        return analysis;
      }
      return key.effectiveKnowledgeHash === firstCacheKey
        ? analysis
        : undefined;
    });
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      compilationRepo,
    );
    const textOnly = compileInput();
    textOnly.sources[0].effectiveKnowledgeHash = 'sha256:effective-text-only';
    const imageReady = compileInput();
    imageReady.sources[0].effectiveKnowledgeHash =
      'sha256:effective-with-image';

    await runner.compileSpace(textOnly);
    await runner.compileSpace(imageReady);

    expect(provider.analyze).toHaveBeenCalledTimes(1);
    expect(compilationRepo.findAnalysis).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        effectiveKnowledgeHash: expect.stringMatching(/^sha256:/),
      }),
    );
    expect(compilationRepo.findAnalysis).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        effectiveKnowledgeHash: expect.stringMatching(/^sha256:/),
      }),
    );
    expect(
      compilationRepo.findAnalysis.mock.calls[0][0].effectiveKnowledgeHash,
    ).not.toBe(
      compilationRepo.findAnalysis.mock.calls[1][0].effectiveKnowledgeHash,
    );
  });

  it('includes the compiler model profile in the analysis cache identity', async () => {
    const provider = createProvider();
    const compilationRepo = createCompilationRepo();
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      compilationRepo,
    );
    provider.getCacheIdentity.mockReturnValue(
      'openai-compatible:qwen-max:thinking=false',
    );

    await runner.compileSpace(compileInput());
    provider.getCacheIdentity.mockReturnValue(
      'openai-compatible:qwen3.8-max:thinking=false',
    );
    await runner.compileSpace(compileInput());

    const cacheKeys = compilationRepo.findAnalysis.mock.calls.map(
      ([key]) => key.effectiveKnowledgeHash,
    );
    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
  });

  it('explicitly bypasses the analysis cache for a force rebuild', async () => {
    const provider = createProvider();
    const compilationRepo = createCompilationRepo(analysis);
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      compilationRepo,
    );

    await runner.compileSpace({ ...compileInput(), bypassCache: true });

    expect(compilationRepo.findAnalysis).not.toHaveBeenCalled();
    expect(provider.analyze).toHaveBeenCalledTimes(1);
    expect(compilationRepo.checkGenerationAttemptBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceContentHash: 'hash-1',
        reset: true,
      }),
    );
    expect(compilationRepo.reserveGenerationAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceContentHash: 'hash-1',
        reset: true,
      }),
    );
  });

  it('stops before generation when the source-content retry budget is exhausted', async () => {
    const provider = createProvider();
    const compilationRepo = createCompilationRepo();
    compilationRepo.checkGenerationAttemptBudget.mockResolvedValue({
      allowed: false,
      attemptCount: 3,
    });
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      compilationRepo,
    );

    await expect(runner.compileSpace(compileInput())).rejects.toMatchObject({
      code: 'invalid_output',
      retryable: false,
    });
    expect(provider.generate).not.toHaveBeenCalled();
    expect(compilationRepo.reserveGenerationAttempt).not.toHaveBeenCalled();
  });

  it('does not spend generation retry budget on retryable provider failures', async () => {
    const provider = createProvider();
    provider.generate.mockRejectedValueOnce(
      new KnowledgeCompilerLlmError(
        'timeout',
        'Knowledge compiler provider timed out.',
        true,
      ),
    );
    const compilationRepo = createCompilationRepo();
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      compilationRepo,
    );

    await expect(runner.compileSpace(compileInput())).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    });
    expect(compilationRepo.checkGenerationAttemptBudget).toHaveBeenCalledTimes(
      1,
    );
    expect(compilationRepo.reserveGenerationAttempt).not.toHaveBeenCalled();
  });

  it('spends generation retry budget on invalid model output failures', async () => {
    const provider = createProvider();
    provider.generate.mockRejectedValueOnce(
      new KnowledgeCompilerLlmError(
        'invalid_output',
        'Knowledge compiler returned invalid generation output.',
        true,
      ),
    );
    const compilationRepo = createCompilationRepo();
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      compilationRepo,
    );

    await expect(runner.compileSpace(compileInput())).rejects.toMatchObject({
      code: 'invalid_output',
      retryable: true,
    });
    expect(compilationRepo.reserveGenerationAttempt).toHaveBeenCalledTimes(1);
  });

  it('includes final enriched source text in the compatibility cache key', async () => {
    const provider = createProvider();
    const compilationRepo = createCompilationRepo();
    let firstCacheKey: string | undefined;
    compilationRepo.findAnalysis.mockImplementation(async (key) => {
      if (!firstCacheKey) {
        firstCacheKey = key.effectiveKnowledgeHash;
        return analysis;
      }
      return key.effectiveKnowledgeHash === firstCacheKey
        ? analysis
        : undefined;
    });
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      compilationRepo,
    );
    const first = compileInput();
    first.sources[0].text += '\n\n图片内文字: Error rate 8%';
    const changedOcr = compileInput();
    changedOcr.sources[0].text += '\n\n图片内文字: Error rate 12%';

    await runner.compileSpace(first);
    await runner.compileSpace(changedOcr);

    expect(provider.analyze).toHaveBeenCalledTimes(1);
    const cacheKeys = compilationRepo.findAnalysis.mock.calls.map(
      ([key]) => key.effectiveKnowledgeHash,
    );
    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
    expect(cacheKeys.join(' ')).not.toContain('Error rate');
  });

  it('marks deterministic source-summary recovery as raw fallback', async () => {
    const provider = createProvider();
    provider.generate.mockResolvedValueOnce({
      version: '1',
      artifacts: [
        {
          kind: 'source_summary',
          canonicalKey: 'page-1',
          title: 'Architecture notes',
          markdown: 'Event sourcing records changes as an append-only log.',
          claims: [],
          links: [],
          tags: [],
        },
      ],
      compilerRecovery: 'source_summary_fallback',
    });
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      createCompilationRepo(),
    );

    const result = await runner.compileSpace(compileInput());

    expect(result.artifacts).toEqual([
      expect.objectContaining({
        artifactKind: 'source_summary',
        generationMode: 'raw_fallback',
      }),
    ]);
    expect(result.diagnostics.warnings).toContainEqual(
      expect.objectContaining({
        code: 'compiler_source_summary_fallback',
        sourcePageId: 'page-1',
      }),
    );
  });

  it('builds the degraded fallback only from bounded validated analysis', async () => {
    const provider = createProvider();
    provider.analyze.mockResolvedValueOnce({
      ...analysis,
      synopsis: 'Validated synopsis. '.repeat(1_000),
      claims: [
        {
          text: 'Validated claim.',
          evidenceQuote: 'Validated evidence.',
        },
      ],
    });
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      createCompilationRepo(),
    );
    const input = compileInput();
    input.sources[0].text = `PRIVATE_FULL_SOURCE_BODY\n${'z'.repeat(20_000)}`;

    await runner.compileSpace(input);

    const fallback = provider.generate.mock.calls[0][1];
    expect(fallback?.markdown).toContain('Validated synopsis.');
    expect(fallback?.markdown).toContain('Validated claim.');
    expect(fallback?.markdown).toContain('Validated evidence.');
    expect(fallback?.markdown).not.toContain('PRIVATE_FULL_SOURCE_BODY');
    expect(fallback?.markdown.length).toBeLessThanOrEqual(8_000);
  });

  it('does not offer a degraded fallback when a last-success exists', async () => {
    const provider = createProvider();
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      createCompilationRepo(),
    );

    await runner.compileSpace({ ...compileInput(), hasLastSuccess: true });

    expect(provider.generate).toHaveBeenCalledWith(
      expect.any(Object),
      undefined,
    );
  });

  it('maps generated evidence quotes back to exact source ranges', async () => {
    const runner = new TestSemanticKnowledgeCompilerRunner(
      createProvider(),
      createCompilationRepo(),
    );

    const result = await runner.compileSpace(compileInput());
    const source = result.artifacts[0].claims?.[0].inputSourceRefs?.[0];

    expect(source?.sourceRange).toEqual({ startOffset: 15, endOffset: 52 });
    expect(source?.quoteHash).toMatch(/^sha256:/);
    expect(
      compileInput().sources[0].text.slice(
        source!.sourceRange!.startOffset,
        source!.sourceRange!.endOffset,
      ),
    ).toBe('records changes as an append-only log');
  });

  it('carries Stage 1 claims into the source summary when generation omits them', async () => {
    const provider = createProvider();
    provider.analyze.mockResolvedValueOnce({
      ...analysis,
      claims: [
        {
          text: 'Event sourcing records changes as an append-only log.',
          confidence: 0.92,
          evidenceQuote: 'records changes as an append-only log',
        },
      ],
    });
    provider.generate.mockResolvedValueOnce({
      ...generation,
      artifacts: generation.artifacts.map((artifact) => ({
        ...artifact,
        claims: [],
      })),
    });
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      createCompilationRepo(),
    );

    const result = await runner.compileSpace(compileInput());
    const summary = result.artifacts.find(
      (artifact) => artifact.artifactKind === 'source_summary',
    );

    expect(summary?.claims).toEqual([
      expect.objectContaining({
        text: 'Event sourcing records changes as an append-only log.',
        confidence: 0.92,
        inputSourceRefs: [
          expect.objectContaining({
            sourceRange: { startOffset: 15, endOffset: 52 },
            quoteHash: expect.stringMatching(/^sha256:/),
          }),
        ],
      }),
    ]);
  });

  it('keeps generated direct links separate from semantic graph edges', async () => {
    const runner = new TestSemanticKnowledgeCompilerRunner(
      createProvider(),
      createCompilationRepo(),
    );

    const result = await runner.compileSpace(compileInput());
    const summary = result.artifacts[0];
    const concept = result.artifacts[1];

    expect(summary.links?.[0]).toMatchObject({
      toKnowledgePageId: concept.artifactId,
      linkType: 'explains',
    });
    expect(summary.graphEdges).toEqual([]);
  });

  it('adds deterministic summary links when the model returns no links', async () => {
    const provider = createProvider();
    provider.generate.mockResolvedValueOnce({
      ...generation,
      artifacts: generation.artifacts.map((artifact) => ({
        ...artifact,
        links: [],
      })),
    });
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      createCompilationRepo(),
    );

    const result = await runner.compileSpace(compileInput());
    const summary = result.artifacts[0];
    const concept = result.artifacts[1];

    expect(summary.links).toEqual([
      expect.objectContaining({
        linkType: 'mentions',
        linkText: 'Event sourcing',
        targetArtifactKind: 'concept',
        targetCanonicalKey: 'event-sourcing',
        toKnowledgePageId: concept.artifactId,
        isDangling: false,
      }),
    ]);
  });

  it('adds exact catalog-title mentions without relying on model links', async () => {
    const provider = createProvider();
    provider.generate.mockResolvedValueOnce({
      ...generation,
      artifacts: generation.artifacts.map((artifact, index) => ({
        ...artifact,
        markdown:
          index === 0
            ? 'The architecture also uses an Existing concept.'
            : artifact.markdown,
        links: [],
      })),
    });
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      createCompilationRepo(),
    );
    const input = compileInput();
    input.catalog = [
      {
        artifactId: '22222222-2222-4222-8222-222222222222',
        artifactKind: 'concept',
        canonicalKey: 'existing-concept',
        title: 'Existing concept',
      },
    ];

    const result = await runner.compileSpace(input);

    expect(result.artifacts[0].links).toContainEqual(
      expect.objectContaining({
        linkType: 'catalog_mention',
        linkText: 'Existing concept',
        targetArtifactKind: 'concept',
        targetCanonicalKey: 'existing-concept',
        toKnowledgePageId: '22222222-2222-4222-8222-222222222222',
      }),
    );
  });

  it('materializes resolvable Stage 1 relations as semantic graph edges', async () => {
    const provider = createProvider();
    provider.analyze.mockResolvedValueOnce({
      ...analysis,
      relations: [
        {
          fromCanonicalKey: 'event-sourcing',
          toCanonicalKey: 'existing-concept',
          relation: 'depends on',
          evidenceQuote: 'append-only log',
        },
      ],
    });
    provider.generate.mockResolvedValueOnce({
      ...generation,
      artifacts: generation.artifacts.map((artifact) => ({
        ...artifact,
        links: [],
      })),
    });
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      createCompilationRepo(),
    );
    const input = compileInput();
    input.catalog = [
      {
        artifactId: '22222222-2222-4222-8222-222222222222',
        artifactKind: 'concept',
        canonicalKey: 'existing-concept',
        title: 'Existing concept',
      },
    ];

    const result = await runner.compileSpace(input);
    const concept = result.artifacts.find(
      (artifact) => artifact.canonicalKey === 'event-sourcing',
    );

    expect(concept?.graphEdges).toEqual([
      expect.objectContaining({
        toKnowledgePageId: '22222222-2222-4222-8222-222222222222',
        relation: 'depends on',
      }),
    ]);
  });

  it('materializes generated Markdown headings as parented structural chunks', async () => {
    const provider = createProvider();
    provider.generate.mockResolvedValueOnce({
      ...generation,
      artifacts: generation.artifacts.map((artifact, index) => ({
        ...artifact,
        markdown:
          index === 0
            ? '# Architecture\nEvent sourcing records changes.\n## Replay\nEvents rebuild state.'
            : artifact.markdown,
      })),
    });
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      createCompilationRepo(),
    );

    const result = await runner.compileSpace(compileInput());
    const summary = result.artifacts[0];

    expect(
      summary.parentSections?.map((section) => section.headingPath),
    ).toEqual([['Architecture'], ['Architecture', 'Replay']]);
    expect(summary.chunks?.length).toBeGreaterThan(0);
    expect(
      summary.chunks?.every(
        (chunk) => chunk.chunkRole === 'child' && chunk.parentStableKey,
      ),
    ).toBe(true);
  });

  it('keeps unresolved canonical links dangling without inventing a foreign key', async () => {
    const provider = createProvider();
    provider.generate.mockResolvedValueOnce({
      ...generation,
      artifacts: [
        {
          ...generation.artifacts[0],
          links: [
            {
              ...generation.artifacts[0].links[0],
              targetCanonicalKey: 'missing-concept',
            },
          ],
        },
        generation.artifacts[1],
      ],
    });
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      createCompilationRepo(),
    );

    const result = await runner.compileSpace(compileInput());
    const summary = result.artifacts[0];

    expect(summary.links?.[0]).toMatchObject({
      toKnowledgePageId: undefined,
      linkText: 'missing-concept',
      targetArtifactKind: 'concept',
      targetCanonicalKey: 'missing-concept',
      isDangling: true,
    });
    expect(summary.graphEdges).toEqual([]);
  });

  it('resolves cross-page links against the existing active catalog', async () => {
    const provider = createProvider();
    provider.generate.mockResolvedValueOnce({
      ...generation,
      artifacts: [
        {
          ...generation.artifacts[0],
          links: [
            {
              ...generation.artifacts[0].links[0],
              targetCanonicalKey: 'existing-concept',
            },
          ],
        },
        generation.artifacts[1],
      ],
    });
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      createCompilationRepo(),
    );
    const input = compileInput();
    input.catalog = [
      {
        artifactId: '22222222-2222-4222-8222-222222222222',
        artifactKind: 'concept',
        canonicalKey: 'existing-concept',
        title: 'Existing concept',
      },
    ];

    const result = await runner.compileSpace(input);

    expect(result.artifacts[0].links?.[0]).toMatchObject({
      toKnowledgePageId: '22222222-2222-4222-8222-222222222222',
      isDangling: false,
    });
    expect(result.artifacts[0].graphEdges).toEqual([]);
  });

  it('rejects batches, empty sources, and generation without a source summary', async () => {
    const provider = createProvider();
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      createCompilationRepo(),
    );

    await expect(
      runner.compileSpace({
        ...compileInput(),
        sources: [compileInput().sources[0], compileInput().sources[0]],
      }),
    ).rejects.toThrow('exactly one source page');
    await expect(
      runner.compileSpace({
        ...compileInput(),
        sources: [{ ...compileInput().sources[0], text: '   ' }],
      }),
    ).rejects.toThrow('empty source page');

    provider.generate.mockResolvedValueOnce({
      version: '1',
      artifacts: [generation.artifacts[1]],
    });
    await expect(runner.compileSpace(compileInput())).rejects.toThrow(
      'exactly one source_summary',
    );
  });

  it('rejects more than 20 generated artifacts before materialization', async () => {
    const provider = createProvider();
    provider.generate.mockResolvedValueOnce({
      version: '1',
      artifacts: [
        generation.artifacts[0],
        ...Array.from({ length: 20 }, (_, index) => ({
          ...generation.artifacts[1],
          canonicalKey: `concept-${index}`,
        })),
      ],
    });
    const runner = new TestSemanticKnowledgeCompilerRunner(
      provider,
      createCompilationRepo(),
    );

    await expect(runner.compileSpace(compileInput())).rejects.toMatchObject({
      code: 'page_complexity_limit',
      retryable: false,
    });
  });
});

class TestSemanticKnowledgeCompilerRunner extends SemanticKnowledgeCompilerRunner {
  protected now(): Date {
    return new Date('2026-07-21T01:02:03.000Z');
  }
}

function createProvider() {
  return {
    getCacheIdentity: jest
      .fn()
      .mockReturnValue('openai-compatible:qwen3.8-max:thinking=false'),
    getCompilerModel: jest.fn().mockReturnValue('qwen3.8-max'),
    analyze: jest.fn().mockResolvedValue(analysis),
    generate: jest.fn().mockResolvedValue(generation),
  } as unknown as jest.Mocked<KnowledgeCompilerLlmProvider>;
}

function createCompilationRepo(cachedAnalysis?: SemanticAnalysis) {
  return {
    findAnalysis: jest.fn().mockResolvedValue(cachedAnalysis),
    saveAnalysis: jest.fn().mockResolvedValue(undefined),
    updateStage: jest.fn().mockResolvedValue(undefined),
    recordCompilerCandidates: jest.fn().mockResolvedValue(undefined),
    checkGenerationAttemptBudget: jest.fn().mockResolvedValue({
      allowed: true,
      attemptCount: 0,
    }),
    reserveGenerationAttempt: jest.fn().mockResolvedValue({
      allowed: true,
      attemptCount: 1,
    }),
  } as unknown as jest.Mocked<KnowledgeCompilationRepo>;
}

function compileInput(): CompileSpaceInput {
  return {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    compilerVersion: 'semantic-v1',
    promptVersion: 'semantic-prompt-v1',
    compileMode: 'pages' as const,
    purpose: 'Build an architecture wiki.',
    schema: 'Use typed knowledge pages.',
    catalog: [],
    sources: [
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageId: 'page-1',
        sourceVersion: 'v1',
        contentHash: 'hash-1',
        title: 'Architecture notes',
        text: 'Event sourcing records changes as an append-only log.',
        references: [],
      },
    ],
  };
}

function tableContent() {
  const cell = (type: string, text: string) => ({
    type,
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text }],
      },
    ],
  });
  return {
    type: 'doc',
    content: [
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              cell('tableHeader', 'Service'),
              cell('tableHeader', 'Version'),
              cell('tableHeader', 'Primary IP'),
              cell('tableHeader', 'Contact'),
            ],
          },
          {
            type: 'tableRow',
            content: [
              cell('tableCell', 'service-alpha'),
              cell('tableCell', '5.7-test'),
              cell('tableCell', '192.0.2.8'),
              cell('tableCell', 'owner-a'),
            ],
          },
        ],
      },
    ],
  };
}
