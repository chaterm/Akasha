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
    );
    expect(compilationRepo.saveAnalysis).not.toHaveBeenCalled();
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

  it('resolves generated links and graph edges to canonical artifact UUIDs', async () => {
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
    expect(summary.graphEdges?.[0]).toMatchObject({
      toKnowledgePageId: concept.artifactId,
      relation: 'explains',
    });
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
