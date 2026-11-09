import { KnowledgeImportService } from './knowledge-import.service';
import { MAX_SHARED_ARTIFACT_CHUNKS } from './knowledge-operation-budget';
import {
  CompiledKnowledgeArtifact,
  CompileSpaceInput,
} from '../types/compiler-artifact.types';

const PROFILE_A = 'a'.repeat(64);
const PROFILE_B = 'b'.repeat(64);

describe('KnowledgeImportService shared budget and vector reuse', () => {
  it('checks merged shared artifacts one at a time instead of summing them', async () => {
    const source = artifact('source-summary', 3, 'source_summary');
    const shared = [
      artifact('concept-template', 129),
      artifact('concept-logic', 118),
      artifact('concept-facts', 58),
    ];
    const harness = createHarness({ incoming: [source], materialized: shared });

    await expect(harness.publish([source])).resolves.toMatchObject({
      importedArtifactCount: 1,
    });
    const written =
      harness.capsuleRepo.upsertCompiledArtifacts.mock.calls[0][0];
    expect(
      written.reduce(
        (sum: number, item: { chunks: unknown[] }) => sum + item.chunks.length,
        0,
      ),
    ).toBe(305);
  });

  it('attributes an oversized shared artifact to the artifact, not the source page', async () => {
    const source = artifact('source-summary', 3, 'source_summary');
    const oversized = artifact('concept-huge', MAX_SHARED_ARTIFACT_CHUNKS + 1);
    const harness = createHarness({
      incoming: [source],
      materialized: [oversized],
    });

    await expect(harness.publish([source])).rejects.toMatchObject({
      code: 'shared_artifact_complexity_limit',
      limitKind: 'chunks',
      artifactId: 'concept-huge',
      canonicalKey: 'concept-huge',
      actual: MAX_SHARED_ARTIFACT_CHUNKS + 1,
      limit: MAX_SHARED_ARTIFACT_CHUNKS,
    });
    expect(harness.capsuleRepo.upsertCompiledArtifacts).not.toHaveBeenCalled();
  });

  it('keeps chunk ids when chunks are only reordered', async () => {
    const first = artifact('concept-order', 3);
    const reordered = {
      ...first,
      chunks: [...first.chunks!].reverse(),
    };
    const ids = async (value: CompiledKnowledgeArtifact) => {
      const harness = createHarness({
        incoming: [value],
        materialized: [value],
      });
      await harness.publish([value]);
      return harness.writtenChunks().map((chunk) => chunk.id);
    };

    expect((await ids(reordered)).sort()).toEqual((await ids(first)).sort());
  });

  it('changes the chunk id when the exact embedding input changes', async () => {
    const original = artifact('concept-text', 1);
    const edited = {
      ...original,
      chunks: [{ ...original.chunks![0], embeddingText: 'Title\n\nchanged' }],
    };
    const idOf = async (value: CompiledKnowledgeArtifact) => {
      const harness = createHarness({
        incoming: [value],
        materialized: [value],
      });
      await harness.publish([value]);
      return harness.writtenChunks()[0].id;
    };

    expect(await idOf(edited)).not.toBe(await idOf(original));
  });

  it('reuses stored vectors whose profile matches the current response profile', async () => {
    const value = artifact('concept-reuse', 3);
    const probe = createHarness({ incoming: [value], materialized: [value] });
    await probe.publish([value]);
    const ids = probe.writtenChunks().map((chunk) => chunk.id);

    const harness = createHarness({
      incoming: [value],
      materialized: [value],
      stored: ids.slice(1).map((id) => storedVector(id, PROFILE_A)),
    });
    const result = await harness.publish([value]);

    expect(result.embedding).toEqual({
      reusedCount: 2,
      generatedCount: 1,
      profileMismatchCount: 0,
    });
    expect(harness.embeddedTexts()).toHaveLength(1);
    const written = harness.writtenChunks();
    expect(written[1].embedding).toBe('[9,9]');
    expect(written[1].embeddingProfile).toBe(PROFILE_A);
  });

  it('re-embeds one chunk to learn the profile when every chunk has a stored vector', async () => {
    const value = artifact('concept-all-stored', 3);
    const probe = createHarness({ incoming: [value], materialized: [value] });
    await probe.publish([value]);
    const ids = probe.writtenChunks().map((chunk) => chunk.id);

    const harness = createHarness({
      incoming: [value],
      materialized: [value],
      stored: ids.map((id) => storedVector(id, PROFILE_A)),
    });
    const result = await harness.publish([value]);

    expect(result.embedding).toEqual({
      reusedCount: 2,
      generatedCount: 1,
      profileMismatchCount: 0,
    });
    expect(harness.provider.embedManyRequired).toHaveBeenCalledTimes(1);
  });

  it('does not reuse vectors from an old profile even if their own dimensions are consistent', async () => {
    const value = artifact('concept-old-profile', 2);
    const probe = createHarness({ incoming: [value], materialized: [value] });
    await probe.publish([value]);
    const ids = probe.writtenChunks().map((chunk) => chunk.id);

    const harness = createHarness({
      incoming: [value],
      materialized: [value],
      stored: ids.map((id) => storedVector(id, PROFILE_B)),
    });
    const result = await harness.publish([value]);

    expect(result.embedding).toEqual({
      reusedCount: 0,
      generatedCount: 2,
      profileMismatchCount: 1,
    });
    expect(
      harness
        .writtenChunks()
        .every((chunk) => chunk.embeddingProfile === PROFILE_A),
    ).toBe(true);
  });

  it('fails retryably instead of publishing mixed profiles', async () => {
    const value = artifact('concept-mixed', 2);
    let call = 0;
    const harness = createHarness({
      incoming: [value],
      materialized: [value],
      embed: (texts) => {
        call += 1;
        return texts.map(() => ({
          vector: [0.1, 0.2],
          profile: call === 1 ? PROFILE_A : PROFILE_B,
          model: 'embedding-test',
          dimensions: 2,
        }));
      },
      stored: [],
    });
    const probe = createHarness({ incoming: [value], materialized: [value] });
    await probe.publish([value]);
    harness.capsuleRepo.findChunkEmbeddingsByIds.mockResolvedValue([
      storedVector(probe.writtenChunks()[1].id, PROFILE_B),
    ]);

    await expect(harness.publish([value])).rejects.toMatchObject({
      name: 'KnowledgeEmbeddingError',
      retryable: true,
    });
    expect(harness.capsuleRepo.upsertCompiledArtifacts).not.toHaveBeenCalled();
  });
});

function artifact(
  artifactId: string,
  chunkCount: number,
  artifactKind: CompiledKnowledgeArtifact['artifactKind'] = 'concept',
): CompiledKnowledgeArtifact {
  return {
    artifactId,
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    title: artifactId,
    contentMarkdown: `# ${artifactId}`,
    sourcePageIds: ['source-1'],
    artifactKind,
    canonicalKey: artifactId,
    generationMode: 'semantic',
    compilerVersion: 'compiler@1',
    promptVersion: 'prompt@1',
    compilerRunId: 'run-1',
    compileTaskId: 'task-1',
    inputSourceRefs: [sourceRef()],
    chunks: Array.from({ length: chunkCount }, (_, index) => ({
      text: `${artifactId} chunk ${index}`,
      stableKey: `${artifactId}-key-${index}`,
      embeddingText: `${artifactId}\n\n${artifactId} chunk ${index}`,
      inputSourceRefs: [sourceRef()],
    })),
  };
}

function sourceRef() {
  return {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    sourcePageId: 'source-1',
    sourceVersion: 'v1',
    contentHash: 'hash-1',
  };
}

function storedVector(id: string, profile: string) {
  return {
    id,
    embedding: [9, 9],
    embeddingProfile: profile,
    embeddingModel: 'embedding-test',
    embeddingDimensions: 2,
    embeddingTotalTokens: 7,
    embeddingDurationMs: 3,
  };
}

function compileInput(): CompileSpaceInput {
  return {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    compilerVersion: 'compiler@1',
    promptVersion: 'prompt@1',
    compileMode: 'pages',
    sources: [
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageId: 'source-1',
        sourceVersion: 'v1',
        contentHash: 'hash-1',
        title: 'Source',
        text: 'Source body',
        references: [],
      },
    ],
  };
}

function createHarness(input: {
  incoming: CompiledKnowledgeArtifact[];
  materialized: CompiledKnowledgeArtifact[];
  stored?: ReturnType<typeof storedVector>[];
  embed?: (texts: string[]) => unknown[];
}) {
  const capsuleRepo = {
    markSourceArtifactsStaleBySourcePageIds: jest.fn(),
    markArtifactsStaleByIds: jest.fn(),
    upsertCompiledArtifacts: jest.fn().mockResolvedValue([]),
    findChunkEmbeddingsByIds: jest.fn().mockResolvedValue(input.stored ?? []),
  };
  const provider = {
    embedManyRequired: jest.fn(async (texts: string[]) =>
      input.embed
        ? input.embed(texts)
        : texts.map(() => ({
            vector: [0.1, 0.2],
            profile: PROFILE_A,
            model: 'embedding-test',
            dimensions: 2,
          })),
    ),
  };
  const service = new KnowledgeImportService(
    {
      upsertPageSource: jest.fn().mockResolvedValue({ id: 'source-row-1' }),
      replaceSourceChunks: jest.fn(),
    } as never,
    capsuleRepo as never,
    {
      validateCompileResult: jest.fn().mockReturnValue({
        accepted: input.incoming,
        quarantined: [],
      }),
    } as never,
    provider as never,
    { recordQuarantinedArtifacts: jest.fn() } as never,
    {
      transaction: () => ({
        execute: async (callback: (trx: unknown) => Promise<unknown>) =>
          callback({ id: 'trx-1' }),
      }),
    } as never,
    { ensureProfileIndex: jest.fn().mockResolvedValue('created') } as never,
    {
      findBySourcePage: jest.fn().mockResolvedValue([]),
      findByArtifactIds: jest.fn().mockResolvedValue([]),
      replaceSourceContributions: jest.fn(),
    } as never,
    {
      materializeSourceUpdate: jest.fn().mockResolvedValue({
        artifacts: input.materialized,
        removedArtifactIds: [],
      }),
    } as never,
  );
  return {
    capsuleRepo,
    provider,
    publish: (artifacts: CompiledKnowledgeArtifact[]) =>
      service.importCompileResult({ input: compileInput(), artifacts }),
    writtenChunks: (): Array<{
      id: string;
      embedding: string;
      embeddingProfile: string;
    }> =>
      capsuleRepo.upsertCompiledArtifacts.mock.calls[0][0].flatMap(
        (item: { chunks: unknown[] }) => item.chunks,
      ),
    embeddedTexts: () => provider.embedManyRequired.mock.calls.flat(2),
  };
}
