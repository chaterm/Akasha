import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeSourceRepo } from '@akasha/db/repos/llm-wiki/knowledge-source.repo';
import { KnowledgeArtifactValidatorService } from './knowledge-artifact-validator.service';
import { KnowledgeImportService } from './knowledge-import.service';
import { CompileSpaceInput } from '../types/compiler-artifact.types';

describe('KnowledgeImportService', () => {
  it('embeds imported chunks when compiler artifacts do not include embeddings', async () => {
    const artifact = {
      artifactId: 'artifact-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      title: 'Compiled',
      contentMarkdown: '# Compiled',
      sourcePageIds: ['source-1'],
      artifactKind: 'source_summary' as const,
      compilerVersion: 'compiler@1',
      promptVersion: 'prompt@1',
      inputSourceRefs: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'source-1',
          sourceVersion: 'v1',
          contentHash: 'hash-1',
        },
      ],
      chunks: [{ text: 'Chaterm Flutter uses layered modules.' }],
    };
    const sourceRepo = {
      upsertPageSource: jest.fn().mockResolvedValue({ id: 'source-row-1' }),
    };
    const capsuleRepo = {
      markCompileScopeStale: jest.fn().mockResolvedValue(undefined),
      upsertCompiledArtifacts: jest
        .fn()
        .mockResolvedValue({ id: 'artifact-1' }),
    };
    const validator = {
      validateCompileResult: jest.fn().mockReturnValue({
        accepted: [artifact],
        quarantined: [],
      }),
    };
    const embeddingProvider = {
      embedQuery: jest.fn().mockResolvedValue({
        vector: [0.12, 0.34, 0.56],
        profile: 'a'.repeat(64),
        model: 'bge-m3',
        dimensions: 3,
      }),
    };
    const quarantineRepo = {
      recordQuarantinedArtifacts: jest.fn().mockResolvedValue(undefined),
    };
    const vectorIndex = {
      ensureProfileIndex: jest.fn().mockResolvedValue('created'),
    };
    const service = new KnowledgeImportService(
      sourceRepo as unknown as KnowledgeSourceRepo,
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
      validator as unknown as KnowledgeArtifactValidatorService,
      embeddingProvider as never,
      quarantineRepo as never,
      createTransactionDb() as never,
      vectorIndex as never,
    );

    await service.importCompileResult({
      input: compileInput(),
      artifacts: [artifact],
    });

    expect(embeddingProvider.embedQuery).toHaveBeenCalledWith(
      'Chaterm Flutter uses layered modules.',
    );
    expect(capsuleRepo.upsertCompiledArtifacts).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          chunks: [
            expect.objectContaining({
              text: 'Chaterm Flutter uses layered modules.',
              embedding: '[0.12,0.34,0.56]',
              embeddingLegacy: [0.12, 0.34, 0.56],
              embeddingProfile: 'a'.repeat(64),
              embeddingModel: 'bge-m3',
              embeddingDimensions: 3,
            }),
          ],
        }),
      ],
      expect.anything(),
    );
    expect(vectorIndex.ensureProfileIndex).toHaveBeenCalledWith({
      profile: 'a'.repeat(64),
      dimensions: 3,
    });
  });

  it('imports only validator-accepted artifacts and dependencies', async () => {
    const input = compileInput();
    const artifact = {
      artifactId: 'artifact-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      title: 'Compiled',
      contentMarkdown: '# Compiled',
      sourcePageIds: ['source-1'],
      artifactKind: 'source_summary' as const,
      compilerVersion: 'compiler@1',
      promptVersion: 'prompt@1',
      compilerRunId: 'run-1',
      compileTaskId: 'task-1',
      inputSourceRefs: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'source-1',
          sourceVersion: 'v1',
          contentHash: 'hash-1',
        },
      ],
      claims: [
        {
          text: 'Kafka is used for events.',
          confidence: 0.8,
        },
      ],
      chunks: [
        {
          text: 'Kafka is used for events.',
          claimIndex: 0,
        },
      ],
      links: [
        {
          linkType: 'cross_space_reference',
          targetSpaceId: 'space-2',
          linkText: 'External page',
          isOpaque: true,
        },
      ],
      graphEdges: [
        {
          toKnowledgePageId: '22222222-2222-4222-8222-222222222222',
          relation: 'depends_on',
        },
      ],
    };
    const sourceRepo = {
      upsertPageSource: jest.fn().mockResolvedValue({ id: 'source-row-1' }),
    };
    const capsuleRepo = {
      markCompileScopeStale: jest.fn().mockResolvedValue(undefined),
      upsertCompiledArtifacts: jest
        .fn()
        .mockResolvedValue({ id: 'artifact-1' }),
    };
    const validator = {
      validateCompileResult: jest.fn().mockReturnValue({
        accepted: [artifact],
        quarantined: [],
      }),
    };
    const embeddingProvider = {
      embedQuery: jest.fn().mockResolvedValue(null),
    };
    const quarantineRepo = {
      recordQuarantinedArtifacts: jest.fn().mockResolvedValue(undefined),
    };
    const service = new KnowledgeImportService(
      sourceRepo as unknown as KnowledgeSourceRepo,
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
      validator as unknown as KnowledgeArtifactValidatorService,
      embeddingProvider as never,
      quarantineRepo as never,
      createTransactionDb() as never,
    );

    await expect(
      service.importCompileResult({ input, artifacts: [artifact] }),
    ).resolves.toEqual({
      importedArtifactCount: 1,
      quarantinedArtifactCount: 0,
    });

    expect(sourceRepo.upsertPageSource).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'source-1',
      sourceSpaceId: 'space-1',
      sourceType: 'docmost_page',
      sourceVersion: 'v1',
      contentHash: 'hash-1',
      extractedText: 'Source body',
      mimeType: 'text/plain',
    });
    expect(capsuleRepo.markCompileScopeStale).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      },
      expect.anything(),
    );
    expect(
      capsuleRepo.markCompileScopeStale.mock.invocationCallOrder[0],
    ).toBeLessThan(
      capsuleRepo.upsertCompiledArtifacts.mock.invocationCallOrder[0],
    );
    expect(capsuleRepo.upsertCompiledArtifacts).toHaveBeenCalledWith(
      [
        {
          page: expect.objectContaining({
            id: 'artifact-1',
            workspaceId: 'workspace-1',
            spaceId: 'space-1',
            title: 'Compiled',
            pageType: 'source_summary',
            body: '# Compiled',
            compilerRunId: 'run-1',
            compileTaskId: 'task-1',
          }),
          pageSources: [
            {
              workspaceId: 'workspace-1',
              knowledgePageId: 'artifact-1',
              sourcePageId: 'source-1',
              sourceVersion: 'v1',
              sourceRange: null,
              quoteHash: null,
              contentHash: 'hash-1',
              provenanceKind: 'synthesis_lineage',
              attachmentId: null,
            },
          ],
          parentSections: [],
          parentSectionSources: [],
          claims: [
            expect.objectContaining({
              workspaceId: 'workspace-1',
              spaceId: 'space-1',
              knowledgePageId: 'artifact-1',
              text: 'Kafka is used for events.',
              confidence: 0.8,
              position: 0,
              compilerRunId: 'run-1',
              compileTaskId: 'task-1',
            }),
          ],
          claimSources: [
            expect.objectContaining({
              workspaceId: 'workspace-1',
              sourcePageId: 'source-1',
              sourceVersion: 'v1',
              sourceRange: null,
              quoteHash: null,
              contentHash: 'hash-1',
              provenanceKind: 'synthesis_lineage',
              attachmentId: null,
            }),
          ],
          chunks: [
            expect.objectContaining({
              workspaceId: 'workspace-1',
              spaceId: 'space-1',
              knowledgePageId: 'artifact-1',
              text: 'Kafka is used for events.',
              contentHash: expect.stringMatching(/^sha256:/),
              embedding: null,
              compilerRunId: 'run-1',
              compileTaskId: 'task-1',
            }),
          ],
          chunkSources: [
            expect.objectContaining({
              workspaceId: 'workspace-1',
              sourcePageId: 'source-1',
              sourceVersion: 'v1',
              sourceRange: null,
              quoteHash: null,
              contentHash: 'hash-1',
              provenanceKind: 'synthesis_lineage',
              attachmentId: null,
            }),
          ],
          links: [
            expect.objectContaining({
              workspaceId: 'workspace-1',
              spaceId: 'space-1',
              fromKnowledgePageId: 'artifact-1',
              toKnowledgePageId: null,
              targetPageId: null,
              targetSpaceId: 'space-2',
              linkText: 'External page',
              linkType: 'cross_space_reference',
              isDangling: true,
              compilerRunId: 'run-1',
              compileTaskId: 'task-1',
            }),
          ],
          linkSources: [
            expect.objectContaining({
              workspaceId: 'workspace-1',
              sourcePageId: 'source-1',
              sourceVersion: 'v1',
              sourceRange: null,
              quoteHash: null,
              contentHash: 'hash-1',
              provenanceKind: 'synthesis_lineage',
              attachmentId: null,
            }),
          ],
          graphEdges: [
            expect.objectContaining({
              workspaceId: 'workspace-1',
              spaceId: 'space-1',
              fromKnowledgePageId: 'artifact-1',
              toKnowledgePageId: '22222222-2222-4222-8222-222222222222',
              relation: 'depends_on',
              compilerRunId: 'run-1',
              compileTaskId: 'task-1',
            }),
          ],
          graphEdgeSources: [
            expect.objectContaining({
              workspaceId: 'workspace-1',
              sourcePageId: 'source-1',
              sourceVersion: 'v1',
              sourceRange: null,
              quoteHash: null,
              contentHash: 'hash-1',
              provenanceKind: 'synthesis_lineage',
              attachmentId: null,
            }),
          ],
        },
      ],
      expect.anything(),
    );
  });

  it('persists verified source ranges and quote hashes from lineage refs', async () => {
    const rangedSourceRef = {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'source-1',
      sourceVersion: 'v1',
      contentHash: 'hash-1',
      sourceRange: { startOffset: 0, endOffset: 6 },
      quoteHash: quoteHash('Source'),
    };
    const artifact = {
      artifactId: 'artifact-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      title: 'Compiled',
      contentMarkdown: '# Compiled',
      sourcePageIds: ['source-1'],
      compilerVersion: 'compiler@1',
      promptVersion: 'prompt@1',
      compilerRunId: 'run-1',
      compileTaskId: 'task-1',
      inputSourceRefs: [rangedSourceRef],
      claims: [
        {
          text: 'Source',
          confidence: 0.8,
          inputSourceRefs: [rangedSourceRef],
        },
      ],
      chunks: [
        {
          text: 'Source',
          claimIndex: 0,
          inputSourceRefs: [rangedSourceRef],
        },
      ],
      links: [
        {
          linkType: 'same_space_reference',
          linkText: 'Source',
          inputSourceRefs: [rangedSourceRef],
        },
      ],
      graphEdges: [
        {
          toKnowledgePageId: '22222222-2222-4222-8222-222222222222',
          relation: 'mentions',
          inputSourceRefs: [rangedSourceRef],
        },
      ],
    };
    const sourceRepo = {
      upsertPageSource: jest.fn().mockResolvedValue({ id: 'source-row-1' }),
    };
    const capsuleRepo = {
      markCompileScopeStale: jest.fn().mockResolvedValue(undefined),
      upsertCompiledArtifacts: jest
        .fn()
        .mockResolvedValue({ id: 'artifact-1' }),
    };
    const validator = {
      validateCompileResult: jest.fn().mockReturnValue({
        accepted: [artifact],
        quarantined: [],
      }),
    };
    const embeddingProvider = {
      embedQuery: jest.fn().mockResolvedValue(null),
    };
    const quarantineRepo = {
      recordQuarantinedArtifacts: jest.fn().mockResolvedValue(undefined),
    };
    const service = new KnowledgeImportService(
      sourceRepo as unknown as KnowledgeSourceRepo,
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
      validator as unknown as KnowledgeArtifactValidatorService,
      embeddingProvider as never,
      quarantineRepo as never,
      createTransactionDb() as never,
    );

    await service.importCompileResult({
      input: compileInput(),
      artifacts: [artifact],
    });

    const persisted = capsuleRepo.upsertCompiledArtifacts.mock.calls[0][0][0];
    for (const sourceRows of [
      persisted.pageSources,
      persisted.claimSources,
      persisted.chunkSources,
      persisted.linkSources,
      persisted.graphEdgeSources,
    ]) {
      expect(sourceRows[0]).toEqual(
        expect.objectContaining({
          sourceRange: { startOffset: 0, endOffset: 6 },
          quoteHash: quoteHash('Source'),
        }),
      );
    }
  });

  it('does not import quarantined artifacts', async () => {
    const sourceRepo = {
      upsertPageSource: jest.fn(),
    };
    const capsuleRepo = {
      markCompileScopeStale: jest.fn(),
      upsertCompiledArtifacts: jest.fn(),
    };
    const validator = {
      validateCompileResult: jest.fn().mockReturnValue({
        accepted: [],
        quarantined: [{ artifact: {}, reasons: ['bad'] }],
      }),
    };
    const embeddingProvider = {
      embedQuery: jest.fn(),
    };
    const quarantineRepo = {
      recordQuarantinedArtifacts: jest.fn().mockResolvedValue(undefined),
    };
    const service = new KnowledgeImportService(
      sourceRepo as unknown as KnowledgeSourceRepo,
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
      validator as unknown as KnowledgeArtifactValidatorService,
      embeddingProvider as never,
      quarantineRepo as never,
      createTransactionDb() as never,
    );

    await expect(
      service.importCompileResult({ input: compileInput(), artifacts: [] }),
    ).resolves.toEqual({
      importedArtifactCount: 0,
      quarantinedArtifactCount: 1,
    });

    expect(capsuleRepo.upsertCompiledArtifacts).not.toHaveBeenCalled();
    expect(capsuleRepo.markCompileScopeStale).not.toHaveBeenCalled();
  });

  it('records quarantined artifact reasons without persisting source content', async () => {
    const hiddenText = 'Private launch plan: revenue migration dates.';
    const quarantinedArtifact = {
      artifactId: 'artifact-quarantined-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      title: 'Private roadmap',
      contentMarkdown: hiddenText,
      sourcePageIds: ['source-secret-1'],
      artifactKind: 'source_summary' as const,
      compilerVersion: 'compiler@1',
      promptVersion: 'prompt@1',
      compilerRunId: 'run-1',
      compileTaskId: 'task-1',
      inputSourceRefs: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'source-secret-1',
          sourceVersion: 'v1',
          contentHash: 'hash-secret',
        },
      ],
    };
    const sourceRepo = {
      upsertPageSource: jest.fn().mockResolvedValue({ id: 'source-row-1' }),
    };
    const capsuleRepo = {
      markCompileScopeStale: jest.fn(),
      upsertCompiledArtifacts: jest.fn(),
    };
    const quarantineRepo = {
      recordQuarantinedArtifacts: jest.fn().mockResolvedValue(undefined),
    };
    const validator = {
      validateCompileResult: jest.fn().mockReturnValue({
        accepted: [],
        quarantined: [
          {
            artifact: quarantinedArtifact,
            reasons: [
              'artifact source range is invalid',
              'artifact quote hash does not match source range',
            ],
          },
        ],
      }),
    };
    const embeddingProvider = {
      embedQuery: jest.fn(),
    };
    const service = new KnowledgeImportService(
      sourceRepo as unknown as KnowledgeSourceRepo,
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
      validator as unknown as KnowledgeArtifactValidatorService,
      embeddingProvider as never,
      quarantineRepo as never,
      createTransactionDb() as never,
    );

    await expect(
      service.importCompileResult({
        input: compileInput(),
        artifacts: [quarantinedArtifact],
      }),
    ).resolves.toEqual({
      importedArtifactCount: 0,
      quarantinedArtifactCount: 1,
    });

    expect(quarantineRepo.recordQuarantinedArtifacts).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        artifacts: [
          {
            artifactId: 'artifact-quarantined-1',
            artifactKind: 'source_summary',
            compilerRunId: 'run-1',
            compileTaskId: 'task-1',
            reasonCodes: [
              'artifact_source_range_invalid',
              'artifact_quote_hash_mismatch',
            ],
          },
        ],
      },
      expect.anything(),
    );
    const persistedPayload = JSON.stringify(
      quarantineRepo.recordQuarantinedArtifacts.mock.calls,
    );
    expect(persistedPayload).not.toContain(hiddenText);
    expect(persistedPayload).not.toContain('Private roadmap');
    expect(persistedPayload).not.toContain('source-secret-1');
    expect(capsuleRepo.upsertCompiledArtifacts).not.toHaveBeenCalled();
  });

  it('writes stale markers, quarantine records, and compiled artifacts in one transaction', async () => {
    const trx = { id: 'trx-1' };
    const artifact = {
      artifactId: 'artifact-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      title: 'Compiled',
      contentMarkdown: '# Compiled',
      sourcePageIds: ['source-1'],
      artifactKind: 'source_summary' as const,
      compilerVersion: 'compiler@1',
      promptVersion: 'prompt@1',
      inputSourceRefs: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'source-1',
          sourceVersion: 'v1',
          contentHash: 'hash-1',
        },
      ],
      chunks: [{ text: 'Kafka is used for events.' }],
    };
    const quarantinedArtifact = {
      artifactId: 'artifact-quarantined-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      title: 'Quarantined',
      contentMarkdown: '# Quarantined',
      sourcePageIds: ['source-1'],
      artifactKind: 'overview' as const,
      compilerVersion: 'compiler@1',
      promptVersion: 'prompt@1',
      compilerRunId: 'run-1',
      compileTaskId: 'task-1',
    };
    const sourceRepo = {
      upsertPageSource: jest.fn().mockResolvedValue({ id: 'source-row-1' }),
    };
    const capsuleRepo = {
      markCompileScopeStale: jest.fn().mockResolvedValue(undefined),
      upsertCompiledArtifacts: jest
        .fn()
        .mockResolvedValue({ id: 'artifact-1' }),
    };
    const quarantineRepo = {
      recordQuarantinedArtifacts: jest.fn().mockResolvedValue(undefined),
    };
    const validator = {
      validateCompileResult: jest.fn().mockReturnValue({
        accepted: [artifact],
        quarantined: [
          {
            artifact: quarantinedArtifact,
            reasons: ['artifact source range is invalid'],
          },
        ],
      }),
    };
    const embeddingProvider = {
      embedQuery: jest.fn().mockResolvedValue(null),
    };
    const service = new KnowledgeImportService(
      sourceRepo as unknown as KnowledgeSourceRepo,
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
      validator as unknown as KnowledgeArtifactValidatorService,
      embeddingProvider as never,
      quarantineRepo as never,
      createTransactionDb(trx) as never,
    );

    await service.importCompileResult({
      input: compileInput(),
      artifacts: [artifact, quarantinedArtifact],
    });

    expect(capsuleRepo.markCompileScopeStale).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      },
      trx,
    );
    expect(quarantineRepo.recordQuarantinedArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
      trx,
    );
    expect(capsuleRepo.upsertCompiledArtifacts).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          page: expect.objectContaining({ id: 'artifact-1' }),
        }),
      ],
      trx,
    );
  });
});

function compileInput(): CompileSpaceInput {
  return {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    compilerVersion: 'compiler@1',
    promptVersion: 'prompt@1',
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

function quoteHash(text: string): string {
  const { createHash } = jest.requireActual(
    'crypto',
  ) as typeof import('crypto');
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function createTransactionDb(trx: unknown = { id: 'trx-1' }) {
  return {
    transaction: () => ({
      execute: async (callback: (trx: unknown) => Promise<unknown>) =>
        callback(trx),
    }),
  };
}
