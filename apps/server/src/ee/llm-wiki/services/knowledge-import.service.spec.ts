import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { OPTIONAL_DEPS_METADATA } from '@nestjs/common/constants';
import { KnowledgeSourceRepo } from '@akasha/db/repos/llm-wiki/knowledge-source.repo';
import { KnowledgeArtifactValidatorService } from './knowledge-artifact-validator.service';
import {
  KnowledgeCompilationValidationError,
  KnowledgeImportService,
  PreparedKnowledgeImport,
} from './knowledge-import.service';
import { KnowledgeEmbeddingError } from './knowledge-embedding-provider.service';
import { CompileSpaceInput } from '../types/compiler-artifact.types';

describe('KnowledgeImportService', () => {
  it('requires contribution merge dependencies at application startup', () => {
    expect(
      Reflect.getMetadata(OPTIONAL_DEPS_METADATA, KnowledgeImportService) ?? [],
    ).toEqual([]);
  });

  it('rejects more than 200 chunks before materialization or publication', async () => {
    const artifact = {
      artifactId: 'artifact-too-large',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      title: 'Too large',
      contentMarkdown: '# Too large',
      sourcePageIds: ['source-1'],
      artifactKind: 'source_summary' as const,
      compilerVersion: 'compiler@1',
      promptVersion: 'prompt@1',
      chunks: Array.from({ length: 201 }, (_, index) => ({
        text: `chunk-${index}`,
      })),
    };
    const capsuleRepo = { upsertCompiledArtifacts: jest.fn() };
    const materializer = createMaterializer();
    const embeddingProvider = { embedQuery: jest.fn() };
    const service = new KnowledgeImportService(
      {} as KnowledgeSourceRepo,
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
      {
        validateCompileResult: jest.fn().mockReturnValue({
          accepted: [artifact],
          quarantined: [],
        }),
      } as unknown as KnowledgeArtifactValidatorService,
      embeddingProvider as never,
      {} as never,
      createTransactionDb() as never,
      {} as never,
      createContributionRepo() as never,
      materializer as never,
    );

    await expect(
      service.importCompileResult({
        input: { ...compileInput(), compileMode: 'pages' },
        artifacts: [artifact],
      }),
    ).rejects.toMatchObject({
      code: 'page_complexity_limit',
      limitKind: 'chunks',
    });
    expect(materializer.materializeSourceUpdate).not.toHaveBeenCalled();
    expect(embeddingProvider.embedQuery).not.toHaveBeenCalled();
    expect(capsuleRepo.upsertCompiledArtifacts).not.toHaveBeenCalled();
  });

  it('embeds imported chunks when compiler artifacts do not include embeddings', async () => {
    const artifact = {
      artifactId: 'artifact-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      title: 'Compiled',
      contentMarkdown: '# Compiled',
      sourcePageIds: ['source-1'],
      artifactKind: 'source_summary' as const,
      generationMode: 'semantic' as const,
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
      replaceSourceChunks: jest.fn().mockResolvedValue(undefined),
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
      createContributionRepo() as never,
      createMaterializer() as never,
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
    expect(sourceRepo.replaceSourceChunks).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace-1',
        sourceId: 'source-row-1',
        sourcePageId: 'source-1',
        chunks: [
          expect.objectContaining({
            id: expect.any(String),
            text: 'Source body',
            contentHash: expect.stringMatching(/^sha256:/),
            sourceRange: { startOffset: 0, endOffset: 11 },
            quoteHash: expect.stringMatching(/^sha256:/),
          }),
        ],
      },
      expect.anything(),
    );
    expect(
      vectorIndex.ensureProfileIndex.mock.invocationCallOrder[0],
    ).toBeLessThan(
      capsuleRepo.upsertCompiledArtifacts.mock.invocationCallOrder[0],
    );
  });

  it('keeps compiled page output unpublished and rematerializes current contributions before retrying embedding', async () => {
    const artifact = {
      artifactId: '11111111-1111-4111-8111-111111111111',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      title: 'Prepared page',
      contentMarkdown: '# Prepared page',
      sourcePageIds: ['source-1'],
      artifactKind: 'source_summary' as const,
      canonicalKey: 'page:source-1',
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
      chunks: [{ text: 'Prepared knowledge chunk.' }],
    };
    const refreshedArtifact = {
      ...artifact,
      title: 'Prepared page with latest shared knowledge',
      contentMarkdown: '# Prepared page\n\nLatest shared knowledge.',
      sourcePageIds: ['source-1', 'source-2'],
      chunks: [{ text: 'Latest shared knowledge chunk.' }],
    };
    const validator = {
      validateCompileResult: jest.fn().mockReturnValue({
        accepted: [artifact],
        quarantined: [],
      }),
    };
    const materializer = {
      materializeSourceUpdate: jest
        .fn()
        .mockResolvedValueOnce({
          artifacts: [artifact],
          removedArtifactIds: [],
        })
        .mockResolvedValueOnce({
          artifacts: [refreshedArtifact],
          removedArtifactIds: [],
        }),
    };
    const embeddingProvider = {
      embedRequired: jest
        .fn()
        .mockRejectedValueOnce(
          new KnowledgeEmbeddingError(
            'embedding_provider_error',
            'Knowledge embedding provider request failed.',
            true,
          ),
        ),
      embedQuery: jest.fn(),
    };
    const capsuleRepo = {
      markSourceArtifactsStaleBySourcePageIds: jest.fn(),
      markArtifactsStaleByIds: jest.fn(),
      upsertCompiledArtifacts: jest.fn(),
    };
    const latestContribution = {
      artifactId: artifact.artifactId,
      sourcePageId: 'source-2',
    };
    const contributionRepo = createContributionRepo();
    contributionRepo.findByArtifactIds
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([latestContribution]);
    const service = new KnowledgeImportService(
      {
        upsertPageSource: jest.fn().mockResolvedValue({ id: 'source-row-1' }),
        replaceSourceChunks: jest.fn(),
      } as never,
      capsuleRepo as never,
      validator as never,
      embeddingProvider as never,
      { recordQuarantinedArtifacts: jest.fn() } as never,
      createTransactionDb() as never,
      { ensureProfileIndex: jest.fn().mockResolvedValue('created') } as never,
      contributionRepo as never,
      materializer as never,
    );
    let prepared: PreparedKnowledgeImport | undefined;

    await expect(
      service.importCompileResult({
        input: { ...compileInput(), compileMode: 'pages' },
        artifacts: [artifact],
        onPrepared: (value) => {
          prepared = value;
        },
      }),
    ).rejects.toMatchObject({ code: 'embedding_provider_error' });

    expect(prepared).toEqual({
      acceptedArtifacts: [artifact],
      quarantineInputs: [],
      quarantinedArtifactCount: 0,
    });
    expect(capsuleRepo.upsertCompiledArtifacts).not.toHaveBeenCalled();
    expect(contributionRepo.replaceSourceContributions).not.toHaveBeenCalled();

    embeddingProvider.embedRequired.mockResolvedValue(testEmbedding());
    await expect(
      service.importCompileResult({
        input: { ...compileInput(), compileMode: 'pages' },
        artifacts: [artifact],
        preparedImport: prepared!,
      }),
    ).resolves.toMatchObject({ importedArtifactCount: 1 });

    expect(validator.validateCompileResult).toHaveBeenCalledTimes(1);
    expect(materializer.materializeSourceUpdate).toHaveBeenCalledTimes(2);
    expect(materializer.materializeSourceUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        incomingArtifacts: [artifact],
        affectedContributions: [latestContribution],
      }),
    );
    expect(embeddingProvider.embedRequired).toHaveBeenCalledTimes(2);
    expect(capsuleRepo.upsertCompiledArtifacts).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          page: expect.objectContaining({
            title: refreshedArtifact.title,
            body: refreshedArtifact.contentMarkdown,
          }),
          chunks: [
            expect.objectContaining({
              text: 'Latest shared knowledge chunk.',
            }),
          ],
        }),
      ],
      expect.anything(),
    );
  });

  it('publishes textual knowledge with an exact-search warning when HNSW cannot be created', async () => {
    const artifact = {
      artifactId: 'artifact-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      title: 'Compiled',
      contentMarkdown: '# Compiled',
      sourcePageIds: ['source-1'],
      artifactKind: 'source_summary' as const,
      generationMode: 'semantic' as const,
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
      chunks: [{ text: 'Enterprise retrieval' }],
    };
    const capsuleRepo = {
      markCompileScopeStale: jest.fn(),
      upsertCompiledArtifacts: jest.fn(),
    };
    const vectorIndex = {
      ensureProfileIndex: jest.fn().mockResolvedValue('exact-only'),
    };
    const service = new KnowledgeImportService(
      {
        upsertPageSource: jest.fn().mockResolvedValue({ id: 'source-row-1' }),
        replaceSourceChunks: jest.fn().mockResolvedValue(undefined),
      } as never,
      capsuleRepo as never,
      {
        validateCompileResult: jest.fn().mockReturnValue({
          accepted: [artifact],
          quarantined: [],
        }),
      } as never,
      {
        embedQuery: jest.fn().mockResolvedValue({
          vector: [0.1, 0.2, 0.3],
          profile: 'a'.repeat(64),
          model: 'bge-m3',
          dimensions: 3,
        }),
      } as never,
      { recordQuarantinedArtifacts: jest.fn() } as never,
      createTransactionDb() as never,
      vectorIndex as never,
      createContributionRepo() as never,
      createMaterializer() as never,
    );

    await expect(
      service.importCompileResult({
        input: compileInput(),
        artifacts: [artifact],
      }),
    ).resolves.toMatchObject({
      importedArtifactCount: 1,
      degradedRetrievalProfiles: ['a'.repeat(64)],
    });
    expect(capsuleRepo.upsertCompiledArtifacts).toHaveBeenCalled();
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
      canonicalKey: 'page:source-1',
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
          targetArtifactKind: 'concept' as const,
          targetCanonicalKey: 'external-page',
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
      replaceSourceChunks: jest.fn().mockResolvedValue(undefined),
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
      embedQuery: jest.fn().mockResolvedValue(testEmbedding()),
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
      { ensureProfileIndex: jest.fn() } as never,
      createContributionRepo() as never,
      createMaterializer() as never,
    );

    await expect(
      service.importCompileResult({ input, artifacts: [artifact] }),
    ).resolves.toEqual({
      importedArtifactCount: 1,
      quarantinedArtifactCount: 0,
    });

    expect(sourceRepo.upsertPageSource).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace-1',
        sourcePageId: 'source-1',
        sourceSpaceId: 'space-1',
        sourceType: 'docmost_page',
        sourceVersion: 'v1',
        contentHash: 'hash-1',
        extractedText: 'Source body',
        mimeType: 'text/plain',
      },
      expect.anything(),
    );
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
              embedding: '[0.1,0.2]',
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
              targetArtifactKind: 'concept',
              targetCanonicalKey: 'external-page',
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
      replaceSourceChunks: jest.fn().mockResolvedValue(undefined),
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
      embedQuery: jest.fn().mockResolvedValue(testEmbedding()),
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
      { ensureProfileIndex: jest.fn() } as never,
      createContributionRepo() as never,
      createMaterializer() as never,
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
      upsertPageSource: jest.fn().mockResolvedValue({ id: 'source-row-1' }),
      replaceSourceChunks: jest.fn().mockResolvedValue(undefined),
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
      { ensureProfileIndex: jest.fn() } as never,
      createContributionRepo() as never,
      createMaterializer() as never,
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

  it('replaces only affected source artifacts for page compilation', async () => {
    const artifact = {
      artifactId: 'artifact-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      title: 'Changed page',
      contentMarkdown: '# Changed page',
      sourcePageIds: ['source-1'],
      artifactKind: 'source_summary' as const,
      canonicalKey: 'page:source-1',
      compilerVersion: 'compiler@1',
      promptVersion: 'prompt@1',
      inputSourceRefs: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'source-1',
          sourceVersion: 'v2',
          contentHash: 'hash-2',
        },
      ],
      chunks: [],
    };
    const sourceRepo = {
      upsertPageSource: jest.fn().mockResolvedValue({ id: 'source-row-1' }),
      replaceSourceChunks: jest.fn().mockResolvedValue(undefined),
    };
    const capsuleRepo = {
      markCompileScopeStale: jest.fn(),
      markSourceArtifactsStaleBySourcePageIds: jest
        .fn()
        .mockResolvedValue(undefined),
      markArtifactsStaleByIds: jest.fn().mockResolvedValue(undefined),
      upsertCompiledArtifacts: jest.fn().mockResolvedValue([]),
    };
    const validator = {
      validateCompileResult: jest.fn().mockReturnValue({
        accepted: [artifact],
        quarantined: [],
      }),
    };
    const service = new KnowledgeImportService(
      sourceRepo as unknown as KnowledgeSourceRepo,
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
      validator as unknown as KnowledgeArtifactValidatorService,
      { embedQuery: jest.fn() } as never,
      { recordQuarantinedArtifacts: jest.fn() } as never,
      createTransactionDb() as never,
      { ensureProfileIndex: jest.fn() } as never,
      createContributionRepo() as never,
      createMaterializer() as never,
    );

    await service.importCompileResult({
      input: { ...compileInput(), compileMode: 'pages' },
      artifacts: [artifact],
    });

    expect(capsuleRepo.markCompileScopeStale).not.toHaveBeenCalled();
    expect(
      capsuleRepo.markSourceArtifactsStaleBySourcePageIds,
    ).toHaveBeenCalledWith(
      { workspaceId: 'workspace-1', sourcePageIds: ['source-1'] },
      expect.anything(),
    );
    expect(capsuleRepo.upsertCompiledArtifacts).toHaveBeenCalled();
  });

  it('replaces source contributions and materialized artifacts in one transaction', async () => {
    const trx = { id: 'trx-contributions' };
    const artifact = {
      artifactId: '11111111-1111-4111-8111-111111111111',
      canonicalKey: 'event-sourcing',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      title: 'Event sourcing',
      contentMarkdown: '# Event sourcing',
      sourcePageIds: ['source-1'],
      artifactKind: 'concept' as const,
      compilerVersion: 'compiler@1',
      promptVersion: 'prompt@1',
      compilerRunId: 'run-2',
      compileTaskId: 'task-1',
      inputSourceRefs: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'source-1',
          sourceVersion: 'v2',
          contentHash: 'hash-2',
        },
      ],
      chunks: [],
    };
    const previous = {
      sourcePageId: 'source-1',
      artifactId: 'artifact-removed',
    };
    const other = {
      sourcePageId: 'source-2',
      artifactId: artifact.artifactId,
    };
    const contributionRepo = {
      findBySourcePage: jest.fn().mockResolvedValue([previous]),
      findByArtifactIds: jest.fn().mockResolvedValue([other]),
      replaceSourceContributions: jest.fn().mockResolvedValue(undefined),
    };
    const materializer = {
      materializeSourceUpdate: jest.fn().mockResolvedValue({
        artifacts: [artifact],
        removedArtifactIds: ['artifact-removed'],
      }),
    };
    const capsuleRepo = {
      markCompileScopeStale: jest.fn(),
      markSourceArtifactsStaleBySourcePageIds: jest.fn(),
      markArtifactsStaleByIds: jest.fn().mockResolvedValue(undefined),
      upsertCompiledArtifacts: jest.fn().mockResolvedValue([]),
    };
    const sourceRepo = {
      upsertPageSource: jest.fn().mockResolvedValue({ id: 'source-row-1' }),
      replaceSourceChunks: jest.fn().mockResolvedValue(undefined),
    };
    const stages: string[] = [];
    const onStage = jest.fn(async (stage: string) => {
      stages.push(stage);
    });
    const validator = {
      validateCompileResult: jest.fn().mockReturnValue({
        accepted: [artifact],
        quarantined: [],
      }),
    };
    const service = new KnowledgeImportService(
      sourceRepo as never,
      capsuleRepo as never,
      validator as never,
      { embedQuery: jest.fn() } as never,
      { recordQuarantinedArtifacts: jest.fn() } as never,
      createTransactionDb(trx) as never,
      { ensureProfileIndex: jest.fn() } as never,
      contributionRepo as never,
      materializer as never,
    );

    await service.importCompileResult({
      input: {
        ...compileInput(),
        compileMode: 'pages',
        sources: [
          {
            ...compileInput().sources[0],
            sourceVersion: 'v2',
            contentHash: 'hash-2',
          },
        ],
      },
      artifacts: [artifact],
      onStage,
    });

    expect(stages).toEqual(['validation', 'merge', 'embedding', 'import']);
    expect(onStage.mock.invocationCallOrder[0]).toBeLessThan(
      validator.validateCompileResult.mock.invocationCallOrder[0],
    );
    expect(onStage.mock.invocationCallOrder[1]).toBeLessThan(
      materializer.materializeSourceUpdate.mock.invocationCallOrder[0],
    );
    expect(onStage.mock.invocationCallOrder[3]).toBeLessThan(
      sourceRepo.upsertPageSource.mock.invocationCallOrder[0],
    );

    expect(materializer.materializeSourceUpdate).toHaveBeenCalledWith({
      sourcePageId: 'source-1',
      previousSourceContributions: [previous],
      affectedContributions: [other],
      incomingArtifacts: [artifact],
      operationBudget: expect.anything(),
    });
    expect(
      capsuleRepo.markSourceArtifactsStaleBySourcePageIds,
    ).toHaveBeenCalledWith(
      { workspaceId: 'workspace-1', sourcePageIds: ['source-1'] },
      trx,
    );
    expect(contributionRepo.replaceSourceContributions).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        sourcePageId: 'source-1',
        contributions: [
          expect.objectContaining({
            artifactId: artifact.artifactId,
            canonicalKey: 'event-sourcing',
          }),
        ],
      }),
      trx,
    );
    expect(capsuleRepo.markArtifactsStaleByIds).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace-1',
        artifactIds: ['artifact-removed'],
      },
      trx,
    );
    expect(capsuleRepo.upsertCompiledArtifacts).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          page: expect.objectContaining({
            id: artifact.artifactId,
            canonicalKey: 'event-sourcing',
            compileScope: 'page',
            generationMode: 'semantic',
          }),
        }),
      ],
      trx,
    );
  });

  it('withdraws an empty source contribution and rematerializes survivors atomically', async () => {
    const trx = { id: 'trx-withdraw-source' };
    const previous = {
      sourcePageId: 'source-1',
      artifactId: '11111111-1111-4111-8111-111111111111',
    };
    const other = {
      sourcePageId: 'source-2',
      artifactId: previous.artifactId,
    };
    const survivor = {
      artifactId: previous.artifactId,
      canonicalKey: 'event-sourcing',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      title: 'Event sourcing',
      contentMarkdown: '# Event sourcing from source 2',
      sourcePageIds: ['source-2'],
      artifactKind: 'concept' as const,
      compilerVersion: 'compiler@1',
      promptVersion: 'prompt@1',
      compilerRunId: 'run-2',
      compileTaskId: 'task-withdraw',
      inputSourceRefs: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'source-2',
          sourceVersion: 'v1',
          contentHash: 'hash-source-2',
        },
      ],
      chunks: [],
    };
    const sourceRepo = {
      markSourcesStale: jest.fn().mockResolvedValue(undefined),
      upsertPageSource: jest.fn(),
      replaceSourceChunks: jest.fn(),
    };
    const capsuleRepo = {
      markSourceArtifactsStaleBySourcePageIds: jest
        .fn()
        .mockResolvedValue(undefined),
      markArtifactsStaleByIds: jest.fn().mockResolvedValue(undefined),
      upsertCompiledArtifacts: jest.fn().mockResolvedValue([]),
    };
    const contributionRepo = {
      findBySourcePage: jest.fn().mockResolvedValue([previous]),
      findByArtifactIds: jest.fn().mockResolvedValue([previous, other]),
      replaceSourceContributions: jest.fn().mockResolvedValue(undefined),
    };
    const materializer = {
      materializeSourceUpdate: jest.fn().mockResolvedValue({
        artifacts: [survivor],
        removedArtifactIds: [],
      }),
    };
    const publicationGuard = jest.fn().mockResolvedValue(true);
    const service = new KnowledgeImportService(
      sourceRepo as never,
      capsuleRepo as never,
      {
        validateCompileResult: jest.fn().mockReturnValue({
          accepted: [],
          quarantined: [],
        }),
      } as never,
      { embedQuery: jest.fn() } as never,
      { recordQuarantinedArtifacts: jest.fn() } as never,
      createTransactionDb(trx) as never,
      { ensureProfileIndex: jest.fn() } as never,
      contributionRepo as never,
      materializer as never,
    );

    await expect(
      service.importCompileResult({
        input: {
          ...compileInput(),
          compileMode: 'pages',
          sources: [
            {
              ...compileInput().sources[0],
              text: '',
            },
          ],
        },
        artifacts: [],
        upsertSources: false,
        retireSources: true,
        publicationGuard,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        importedArtifactCount: 0,
        quarantinedArtifactCount: 0,
      }),
    );

    expect(materializer.materializeSourceUpdate).toHaveBeenCalledWith({
      sourcePageId: 'source-1',
      previousSourceContributions: [previous],
      affectedContributions: [previous, other],
      incomingArtifacts: [],
      operationBudget: expect.anything(),
    });
    expect(publicationGuard).toHaveBeenCalledWith(trx);
    expect(sourceRepo.markSourcesStale).toHaveBeenCalledWith(
      { workspaceId: 'workspace-1', sourcePageIds: ['source-1'] },
      trx,
    );
    expect(
      capsuleRepo.markSourceArtifactsStaleBySourcePageIds,
    ).toHaveBeenCalledWith(
      { workspaceId: 'workspace-1', sourcePageIds: ['source-1'] },
      trx,
    );
    expect(contributionRepo.replaceSourceContributions).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace-1',
        sourcePageId: 'source-1',
        contributions: [],
      },
      trx,
    );
    expect(capsuleRepo.upsertCompiledArtifacts).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          page: expect.objectContaining({ id: survivor.artifactId }),
        }),
      ],
      trx,
    );
    expect(sourceRepo.upsertPageSource).not.toHaveBeenCalled();
  });

  it('fences empty Space retirement before marking aggregate artifacts stale', async () => {
    const trx = { id: 'trx-retire-space' };
    const capsuleRepo = {
      markCompileScopeStale: jest.fn(),
    };
    const publicationGuard = jest.fn().mockResolvedValue(false);
    const service = new KnowledgeImportService(
      { markSourcesStale: jest.fn() } as never,
      capsuleRepo as never,
      {
        validateCompileResult: jest.fn().mockReturnValue({
          accepted: [],
          quarantined: [],
        }),
      } as never,
      { embedQuery: jest.fn() } as never,
      { recordQuarantinedArtifacts: jest.fn() } as never,
      createTransactionDb(trx) as never,
      { ensureProfileIndex: jest.fn() } as never,
      createContributionRepo() as never,
      createMaterializer() as never,
    );

    await expect(
      service.importCompileResult({
        input: {
          ...compileInput(),
          compileMode: 'space',
          sources: [],
        },
        artifacts: [],
        upsertSources: false,
        retireCompileScope: true,
        publicationGuard,
      }),
    ).resolves.toEqual(
      expect.objectContaining({ skippedReason: 'run_superseded' }),
    );

    expect(publicationGuard).toHaveBeenCalledWith(trx);
    expect(capsuleRepo.markCompileScopeStale).not.toHaveBeenCalled();
  });

  it('rejects a semantic page publication atomically when any artifact is quarantined', async () => {
    const artifact = {
      artifactId: 'artifact-invalid',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      title: 'Invalid summary',
      contentMarkdown: '# Invalid summary',
      sourcePageIds: ['source-1'],
      artifactKind: 'source_summary' as const,
      compilerVersion: 'compiler@1',
      promptVersion: 'prompt@1',
      compilerRunId: 'run-2',
      compileTaskId: 'task-1',
    };
    const contributionRepo = {
      findBySourcePage: jest.fn(),
      findByArtifactIds: jest.fn(),
      replaceSourceContributions: jest.fn(),
    };
    const materializer = { materializeSourceUpdate: jest.fn() };
    const capsuleRepo = {
      markArtifactsStaleByIds: jest.fn(),
      upsertCompiledArtifacts: jest.fn(),
    };
    const quarantineRepo = {
      recordQuarantinedArtifacts: jest.fn().mockResolvedValue(undefined),
    };
    const service = new KnowledgeImportService(
      {
        upsertPageSource: jest.fn().mockResolvedValue({ id: 'source-row-1' }),
        replaceSourceChunks: jest.fn().mockResolvedValue(undefined),
      } as never,
      capsuleRepo as never,
      {
        validateCompileResult: jest.fn().mockReturnValue({
          accepted: [],
          quarantined: [
            { artifact, reasons: ['artifact source range is invalid'] },
          ],
        }),
      } as never,
      { embedQuery: jest.fn() } as never,
      quarantineRepo as never,
      createTransactionDb() as never,
      { ensureProfileIndex: jest.fn() } as never,
      contributionRepo as never,
      materializer as never,
    );

    await expect(
      service.importCompileResult({
        input: { ...compileInput(), compileMode: 'pages' },
        artifacts: [artifact],
      }),
    ).rejects.toBeInstanceOf(KnowledgeCompilationValidationError);

    expect(quarantineRepo.recordQuarantinedArtifacts).toHaveBeenCalled();
    expect(contributionRepo.replaceSourceContributions).not.toHaveBeenCalled();
    expect(materializer.materializeSourceUpdate).not.toHaveBeenCalled();
    expect(capsuleRepo.markArtifactsStaleByIds).not.toHaveBeenCalled();
    expect(capsuleRepo.upsertCompiledArtifacts).not.toHaveBeenCalled();
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
      replaceSourceChunks: jest.fn().mockResolvedValue(undefined),
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
      { ensureProfileIndex: jest.fn() } as never,
      createContributionRepo() as never,
      createMaterializer() as never,
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
      generationMode: 'semantic' as const,
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
      replaceSourceChunks: jest.fn().mockResolvedValue(undefined),
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
      embedQuery: jest.fn().mockResolvedValue(testEmbedding()),
    };
    const service = new KnowledgeImportService(
      sourceRepo as unknown as KnowledgeSourceRepo,
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
      validator as unknown as KnowledgeArtifactValidatorService,
      embeddingProvider as never,
      quarantineRepo as never,
      createTransactionDb(trx) as never,
      { ensureProfileIndex: jest.fn() } as never,
      createContributionRepo() as never,
      createMaterializer() as never,
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
          page: expect.objectContaining({
            id: 'artifact-1',
            generationMode: 'semantic',
          }),
        }),
      ],
      trx,
    );
  });

  it('rejects every durable publication write when the run fence is closed', async () => {
    const trx = { id: 'trx-fenced' };
    const artifact = {
      artifactId: 'artifact-fenced',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      title: 'Fenced artifact',
      contentMarkdown: '# Fenced artifact',
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
      chunks: [{ text: 'This result belongs to an obsolete run.' }],
    };
    const sourceRepo = {
      upsertPageSource: jest.fn().mockResolvedValue({ id: 'source-row-1' }),
      replaceSourceChunks: jest.fn().mockResolvedValue(undefined),
    };
    const capsuleRepo = {
      markCompileScopeStale: jest.fn().mockResolvedValue(undefined),
      upsertCompiledArtifacts: jest.fn().mockResolvedValue(undefined),
    };
    const validator = {
      validateCompileResult: jest.fn().mockReturnValue({
        accepted: [artifact],
        quarantined: [],
      }),
    };
    const publicationGuard = jest.fn().mockResolvedValue(false);
    const service = new KnowledgeImportService(
      sourceRepo as unknown as KnowledgeSourceRepo,
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
      validator as unknown as KnowledgeArtifactValidatorService,
      { embedQuery: jest.fn().mockResolvedValue(testEmbedding()) } as never,
      { recordQuarantinedArtifacts: jest.fn() } as never,
      createTransactionDb(trx) as never,
      { ensureProfileIndex: jest.fn() } as never,
      createContributionRepo() as never,
      createMaterializer() as never,
    );

    await expect(
      service.importCompileResult({
        input: compileInput(),
        artifacts: [artifact],
        publicationGuard,
      }),
    ).resolves.toEqual({
      importedArtifactCount: 0,
      quarantinedArtifactCount: 0,
      skippedReason: 'run_superseded',
    });

    expect(publicationGuard).toHaveBeenCalledWith(trx);
    expect(sourceRepo.upsertPageSource).not.toHaveBeenCalled();
    expect(sourceRepo.replaceSourceChunks).not.toHaveBeenCalled();
    expect(capsuleRepo.markCompileScopeStale).not.toHaveBeenCalled();
    expect(capsuleRepo.upsertCompiledArtifacts).not.toHaveBeenCalled();
  });

  it('acknowledges page publication inside the same transaction after artifact writes', async () => {
    const trx = { id: 'trx-publication-complete' };
    const artifact = {
      artifactId: 'artifact-merge',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      title: 'Merged page',
      contentMarkdown: '# Merged page\n\nImage facts',
      sourcePageIds: ['source-1'],
      artifactKind: 'source_summary' as const,
      canonicalKey: 'page:source-1',
      generationMode: 'semantic' as const,
      compilerVersion: 'compiler@1',
      promptVersion: 'prompt@1',
      compilerRunId: 'run-1',
      compileTaskId: 'merge-1',
      inputSourceRefs: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'source-1',
          sourceVersion: 'v1',
          contentHash: 'hash-1',
        },
      ],
      chunks: [{ text: 'Image facts' }],
    };
    const capsuleRepo = {
      markSourceArtifactsStaleBySourcePageIds: jest.fn(),
      markArtifactsStaleByIds: jest.fn(),
      upsertCompiledArtifacts: jest.fn().mockResolvedValue(undefined),
    };
    const publicationComplete = jest.fn().mockResolvedValue(undefined);
    const service = new KnowledgeImportService(
      {
        upsertPageSource: jest.fn().mockResolvedValue({ id: 'source-row-1' }),
        replaceSourceChunks: jest.fn(),
      } as never,
      capsuleRepo as never,
      {
        validateCompileResult: jest.fn().mockReturnValue({
          accepted: [artifact],
          quarantined: [],
        }),
      } as never,
      { embedQuery: jest.fn().mockResolvedValue(testEmbedding()) } as never,
      { recordQuarantinedArtifacts: jest.fn() } as never,
      createTransactionDb(trx) as never,
      { ensureProfileIndex: jest.fn() } as never,
      createContributionRepo() as never,
      createMaterializer() as never,
    );

    await service.importCompileResult({
      input: { ...compileInput(), compileMode: 'pages' },
      artifacts: [artifact],
      publicationGuard: jest.fn().mockResolvedValue(true),
      publicationComplete,
    });

    expect(capsuleRepo.upsertCompiledArtifacts).toHaveBeenCalledWith(
      expect.any(Array),
      trx,
    );
    expect(publicationComplete).toHaveBeenCalledWith(trx);
    expect(
      capsuleRepo.upsertCompiledArtifacts.mock.invocationCallOrder[0],
    ).toBeLessThan(publicationComplete.mock.invocationCallOrder[0]);
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

function testEmbedding() {
  return {
    vector: [0.1, 0.2],
    profile: 'a'.repeat(64),
    model: 'embedding-test',
    dimensions: 2,
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

function createContributionRepo() {
  return {
    findBySourcePage: jest.fn().mockResolvedValue([]),
    findByArtifactIds: jest.fn().mockResolvedValue([]),
    replaceSourceContributions: jest.fn().mockResolvedValue(undefined),
  };
}

function createMaterializer() {
  return {
    materializeSourceUpdate: jest.fn().mockImplementation(async (input) => ({
      artifacts: input.incomingArtifacts,
      removedArtifactIds: [],
    })),
  };
}
