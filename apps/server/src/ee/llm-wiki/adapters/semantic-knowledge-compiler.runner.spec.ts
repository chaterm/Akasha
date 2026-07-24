import { KnowledgeCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-compilation.repo';
import { KnowledgeCompilerLlmProvider } from '../compiler/knowledge-compiler-llm.provider';
import { SemanticAnalysis } from '../compiler/semantic-compiler.schema';
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
});

class TestSemanticKnowledgeCompilerRunner extends SemanticKnowledgeCompilerRunner {
  protected now(): Date {
    return new Date('2026-07-21T01:02:03.000Z');
  }
}

function createProvider() {
  return {
    analyze: jest.fn().mockResolvedValue(analysis),
    generate: jest.fn().mockResolvedValue(generation),
  } as unknown as jest.Mocked<KnowledgeCompilerLlmProvider>;
}

function createCompilationRepo(cachedAnalysis?: SemanticAnalysis) {
  return {
    findAnalysis: jest.fn().mockResolvedValue(cachedAnalysis),
    saveAnalysis: jest.fn().mockResolvedValue(undefined),
    updateStage: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<KnowledgeCompilationRepo>;
}

function compileInput() {
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
