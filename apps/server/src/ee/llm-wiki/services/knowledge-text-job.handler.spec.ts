import { Job } from 'bullmq';
import { Queue } from 'bullmq';
import { OPTIONAL_DEPS_METADATA } from '@nestjs/common/constants';
import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-compilation.repo';
import { KnowledgeReviewApplicationRepo } from '@akasha/db/repos/llm-wiki/knowledge-review-application.repo';
import { KnowledgeSourceRepo } from '@akasha/db/repos/llm-wiki/knowledge-source.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { QueueJob } from '../../../integrations/queue/constants';
import { KnowledgeCompilerAdapter } from '../adapters/knowledge-compiler.adapter';
import { KnowledgeAccessIndexerService } from './knowledge-access-indexer.service';
import { KnowledgeArtifactCatalogService } from './knowledge-artifact-catalog.service';
import { KnowledgeSpaceCompilationService } from './knowledge-space-compilation.service';
import { KnowledgeSpaceAggregatorService } from './knowledge-space-aggregator.service';
import { KnowledgeImportService } from './knowledge-import.service';
import { KnowledgeSourceExporterService } from './knowledge-source-exporter.service';
import { IAuditService } from '../../../integrations/audit/audit.service';
import { ReviewService } from '../review/review.service';
import { ReviewSnapshotService } from '../review/review-snapshot.service';
import { KnowledgeTextJobHandler } from './knowledge-text-job.handler';
import { KnowledgeImageEnrichmentService } from './knowledge-image-enrichment.service';
import { KnowledgeVectorIndexService } from './knowledge-vector-index.service';
import { KnowledgeCompilerLlmError } from '../compiler/knowledge-compiler-llm.provider';
import { buildEffectiveKnowledgeHash } from './knowledge-effective-hash';
import {
  DEFAULT_KNOWLEDGE_COMPILER_VERSION,
  DEFAULT_KNOWLEDGE_PROMPT_VERSION,
} from '../llm-wiki.constants';

describe('KnowledgeTextJobHandler', () => {
  it('declares all knowledge compilation collaborators as mandatory startup dependencies', () => {
    expect(
      Reflect.getMetadata(OPTIONAL_DEPS_METADATA, KnowledgeTextJobHandler) ??
        [],
    ).toEqual([]);
  });

  it('creates a durable Space run instead of reporting fan-out as complete', async () => {
    const exporter = {
      exportSpaceSources: jest.fn().mockResolvedValue([
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'page-1',
          sourceVersion: 'v1',
          contentHash: 'sha256:page-1',
          title: 'Page',
          text: 'Body',
          references: [],
        },
      ]),
    };
    const compiler = createCompiler();
    const importer = {
      importCompileResult: jest.fn().mockResolvedValue({
        importedArtifactCount: 2,
        quarantinedArtifactCount: 1,
      }),
    };
    const accessIndexer = createAccessIndexer();
    const textQueue = createTextQueue();
    const compilationRepo = createCompilationRepo();
    const spaceCompilation = {
      startSpaceRun: jest.fn().mockResolvedValue({ id: 'space-run-1' }),
    };
    const processor = new KnowledgeTextJobHandler(
      exporter as unknown as KnowledgeSourceExporterService,
      compiler as unknown as KnowledgeCompilerAdapter,
      importer as unknown as KnowledgeImportService,
      accessIndexer,
      createSourceRepo(),
      createCapsuleRepo(),
      createPageRepo(),
      textQueue,
      createReviewService(),
      createReviewSnapshotService(),
      createAuditService(),
      createReviewApplicationRepo(),
      compilationRepo as never,
      createArtifactCatalog(),
      spaceCompilation as unknown as KnowledgeSpaceCompilationService,
      createSpaceAggregator(),
      createImageEnrichment(),
    );

    const requestedAt = Date.parse('2026-07-27T03:00:00.000Z');
    const result = await processor.handle({
      id: 'compile-space-job-1',
      name: QueueJob.KNOWLEDGE_COMPILE_SPACE,
      data: { workspaceId: 'workspace-1', spaceId: 'space-1' },
      timestamp: requestedAt,
    } as Job);

    expect(exporter.exportSpaceSources).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(spaceCompilation.startSpaceRun).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      trigger: 'manual_compile',
      requestedAt: new Date(requestedAt),
      sources: [
        expect.objectContaining({
          sourcePageId: 'page-1',
        }),
      ],
    });
    expect(textQueue.add).not.toHaveBeenCalled();
    expect(compilationRepo.queueAttempt).not.toHaveBeenCalled();
    expect(compiler.compileSpace).not.toHaveBeenCalled();
    expect(importer.importCompileResult).not.toHaveBeenCalled();
    expect(accessIndexer.reindexSourcePages).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        type: 'compile-space',
        status: 'queued',
        compilerRunId: 'space-run-1',
        sourceCount: 1,
      }),
    );
  });

  it('completes an older cross-queue full-space command as a no-op', async () => {
    const exporter = {
      exportSpaceSources: jest.fn().mockResolvedValue([]),
    };
    const spaceCompilation = {
      startSpaceRun: jest.fn().mockResolvedValue(null),
    };
    const processor = new KnowledgeTextJobHandler(
      exporter as unknown as KnowledgeSourceExporterService,
      createCompiler() as unknown as KnowledgeCompilerAdapter,
      createImporter() as unknown as KnowledgeImportService,
      createAccessIndexer(),
      createSourceRepo(),
      createCapsuleRepo(),
      createPageRepo(),
      createTextQueue(),
      createReviewService(),
      createReviewSnapshotService(),
      createAuditService(),
      createReviewApplicationRepo(),
      createCompilationRepo() as never,
      createArtifactCatalog(),
      spaceCompilation as unknown as KnowledgeSpaceCompilationService,
      createSpaceAggregator(),
      createImageEnrichment(),
    );
    const requestedAt = Date.parse('2026-07-27T03:00:00.000Z');

    await expect(
      processor.handle({
        id: 'legacy-compile-space-job',
        name: QueueJob.KNOWLEDGE_COMPILE_SPACE,
        data: { workspaceId: 'workspace-1', spaceId: 'space-1' },
        timestamp: requestedAt,
      } as Job),
    ).resolves.toEqual(
      expect.objectContaining({
        type: 'compile-space',
        status: 'succeeded',
        compilerRunId: 'legacy-compile-space-job',
        sourceCount: 0,
      }),
    );

    expect(spaceCompilation.startSpaceRun).toHaveBeenCalledWith(
      expect.objectContaining({ requestedAt: new Date(requestedAt) }),
    );
  });

  it('exports and replaces only requested sources for page compile jobs', async () => {
    const sources = [
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageId: 'page-1',
        sourceVersion: 'v2',
        contentHash: 'sha256:page-1-v2',
        title: 'Changed page',
        text: 'Changed body',
        references: [],
      },
    ];
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest.fn().mockResolvedValue(sources),
    };
    const compiler = createCompiler();
    const importer = createImporter();
    const accessIndexer = createAccessIndexer();
    const processor = new KnowledgeTextJobHandler(
      exporter as unknown as KnowledgeSourceExporterService,
      compiler,
      importer,
      accessIndexer,
      createSourceRepo(),
      createCapsuleRepo(),
      createPageRepo(),
      createTextQueue(),
      createReviewService(),
      createReviewSnapshotService(),
      createAuditService(),
      createReviewApplicationRepo(),
      ...createRequiredProcessorDependencies(),
    );

    const result = await processor.handle({
      name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
      data: {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
      },
    } as Job);

    expect(exporter.exportPageSources).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageIds: ['page-1'],
    });
    expect(compiler.compileSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        compileMode: 'pages',
        compileTaskId: expect.any(String),
        sources,
      }),
    );
    expect(importer.importCompileResult).toHaveBeenCalledWith({
      input: jest.mocked(compiler.compileSpace).mock.calls[0][0],
      artifacts: [],
      onStage: expect.any(Function),
    });
    expect(accessIndexer.reindexSourcePages).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1'],
    });
    expect(result).toEqual(
      expect.objectContaining({
        type: 'compile-pages',
        sourceCount: 1,
      }),
    );
  });

  it('publishes text before images and never invokes vision enrichment in the text handler', async () => {
    const page = {
      ...sourceSnapshot({ text: '正文可先检索' }),
      images: [
        {
          attachmentId: 'image-1',
          fileName: 'diagram.png',
          mimeType: 'image/png' as const,
          fileSize: 1024,
          attachmentVersion: 'image-v1',
        },
      ],
    };
    const exporter = {
      exportPageSources: jest.fn().mockResolvedValue([page]),
    };
    const imageEnrichment = {
      readReadySource: jest.fn().mockResolvedValue({
        source: page,
        readyImages: [],
      }),
      enrichSource: jest.fn(),
    };
    const spaceCompilation = {
      ...createSpaceCompilation(),
      queueStandalonePageImages: jest.fn().mockResolvedValue('image-job-1'),
    };
    const compiler = createCompiler();
    const processor = createProcessor({
      exporter,
      compiler,
      imageEnrichment,
      spaceCompilation,
    });

    await processor.handle({
      id: 'text-job-1',
      name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
      data: {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
        trigger: 'page_update',
      },
    } as Job);

    expect(imageEnrichment.readReadySource).toHaveBeenCalledWith(page);
    expect(imageEnrichment.enrichSource).not.toHaveBeenCalled();
    expect(compiler.compileSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [expect.objectContaining({ text: '正文可先检索' })],
      }),
    );
    expect(spaceCompilation.queueStandalonePageImages).toHaveBeenCalledWith(
      page,
    );
  });

  it('does not enqueue a redundant image merge when every page image was already compiled from cache', async () => {
    const page = {
      ...sourceSnapshot({ text: '正文' }),
      images: [
        {
          attachmentId: 'image-ready',
          fileName: 'diagram.png',
          mimeType: 'image/png' as const,
          fileSize: 1024,
          attachmentVersion: 'image-v1',
        },
      ],
    };
    const enriched = {
      ...page,
      text: '正文\n\n## 页面图片识别内容\n\n图片内文字: READY',
    };
    const readyImage = {
      attachmentId: 'image-ready',
      attachmentVersion: 'image-v1',
      cacheFingerprint: 'cache-ready',
      contentHash: 'sha256:image-ready',
      ocrText: 'READY',
      caption: '',
    };
    const exporter = {
      exportPageSources: jest.fn().mockResolvedValue([page]),
    };
    const imageEnrichment = {
      readReadySource: jest.fn().mockResolvedValue({
        source: enriched,
        readyImages: [readyImage],
        readyExtractionIds: ['extraction-ready'],
        truncatedCount: 0,
      }),
    };
    const spaceCompilation = createSpaceCompilation();
    const compiler = createCompiler();
    const processor = createProcessor({
      exporter,
      compiler,
      imageEnrichment,
      spaceCompilation,
    });

    await processor.handle({
      id: 'cached-image-text-job',
      name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
      data: {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
        trigger: 'page_update',
      },
    } as Job);

    expect(compiler.compileSpace).toHaveBeenCalledWith(
      expect.objectContaining({ sources: [expect.objectContaining(enriched)] }),
    );
    expect(spaceCompilation.queueStandalonePageImages).not.toHaveBeenCalled();
  });

  it('atomically replaces one page with ordered ready image knowledge and advances the merge barrier', async () => {
    const base = {
      ...sourceSnapshot({ text: '正文' }),
      images: [
        {
          attachmentId: 'image-ready',
          fileName: 'first.png',
          mimeType: 'image/png' as const,
          fileSize: 100,
          attachmentVersion: 'image-v1',
        },
        {
          attachmentId: 'image-failed',
          fileName: 'second.png',
          mimeType: 'image/png' as const,
          fileSize: 100,
          attachmentVersion: 'image-v1',
        },
      ],
    };
    const enriched = {
      ...base,
      text: '正文\n\n## 页面图片识别内容\n\n图片 1：first.png\n\nOCR: READY',
    };
    const trx = { id: 'merge-publication-trx' };
    const importer = {
      importCompileResult: jest.fn().mockImplementation(async (input) => {
        expect(input.publicationGuard).toEqual(expect.any(Function));
        expect(await input.publicationGuard(trx)).toBe(true);
        await input.publicationComplete(trx);
        return { importedArtifactCount: 1, quarantinedArtifactCount: 0 };
      }),
    } as unknown as KnowledgeImportService;
    const compilationRepo = createCompilationRepo();
    const spaceCompilation = {
      ...createSpaceCompilation(),
      beginPageMerge: jest.fn().mockResolvedValue(true),
      completePageMergePublication: jest.fn().mockResolvedValue(true),
      dispatchPending: jest.fn().mockResolvedValue(undefined),
    };
    const compiler = createCompiler();
    const processor = createProcessor({
      exporter: { exportPageSources: jest.fn().mockResolvedValue([base]) },
      compiler,
      importer,
      compilationRepo,
      spaceCompilation,
      imageEnrichment: {
        readReadySource: jest.fn().mockResolvedValue({
          source: enriched,
          readyImages: [
            {
              attachmentId: 'image-ready',
              attachmentVersion: 'image-v1',
              cacheFingerprint: 'cache-ready',
              contentHash: 'sha256:image-ready',
              ocrText: 'READY',
              caption: '',
            },
          ],
          readyExtractionIds: ['extraction-ready'],
          truncatedCount: 0,
        }),
      },
    });

    await expect(
      processor.handle({
        id: 'merge-job-1',
        name: QueueJob.KNOWLEDGE_MERGE_PAGE_IMAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'page-1',
          sourceVersion: 'v1',
          sourceContentHash: 'sha256:v1',
          effectiveKnowledgeHash: buildEffectiveKnowledgeHash({
            sourceContentHash: 'sha256:v1',
            compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
            promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
            readyImages: [
              {
                attachmentId: 'image-ready',
                attachmentVersion: 'image-v1',
                cacheFingerprint: 'cache-ready',
                contentHash: 'sha256:image-ready',
                ocrText: 'READY',
                caption: '',
              },
            ],
          }),
          spaceRunId: 'run-1',
          knowledgeGeneration: 3,
          images: base.images,
        },
      } as Job),
    ).resolves.toEqual(
      expect.objectContaining({ type: 'compile-pages', status: 'succeeded' }),
    );

    expect(spaceCompilation.beginPageMerge).toHaveBeenCalled();
    expect(compiler.compileSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [
          expect.objectContaining({
            text: enriched.text,
            effectiveKnowledgeHash: expect.any(String),
          }),
        ],
      }),
    );
    expect(enriched.text.match(/## 页面图片识别内容/g)).toHaveLength(1);
    expect(compilationRepo.succeedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveKnowledgeHash: expect.any(String),
      }),
      trx,
    );
    expect(spaceCompilation.completePageMergePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        sourcePageId: 'page-1',
        mergedEffectiveKnowledgeHash: expect.any(String),
      }),
      trx,
    );
    expect(spaceCompilation.dispatchPending).toHaveBeenCalled();
  });

  it('completes a removed attachment merge as a stale no-op without recompiling', async () => {
    const current = {
      ...sourceSnapshot(),
      images: [],
    };
    const compiler = createCompiler();
    const spaceCompilation = {
      beginPageMerge: jest.fn().mockResolvedValue(true),
      failPageMerge: jest.fn().mockResolvedValue(true),
    };
    const processor = createProcessor({
      exporter: { exportPageSources: jest.fn().mockResolvedValue([current]) },
      compiler,
      spaceCompilation,
    });

    await expect(
      processor.handle({
        id: 'stale-merge-job',
        name: QueueJob.KNOWLEDGE_MERGE_PAGE_IMAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'page-1',
          sourceVersion: 'v1',
          sourceContentHash: 'sha256:v1',
          effectiveKnowledgeHash: 'sha256:old-images',
          spaceRunId: 'run-1',
          knowledgeGeneration: 3,
          images: [
            {
              attachmentId: 'removed-image',
              fileName: 'removed.png',
              mimeType: 'image/png',
              fileSize: 10,
              attachmentVersion: 'image-v1',
            },
          ],
        },
      } as Job),
    ).resolves.toEqual(expect.objectContaining({ sourceCount: 0 }));

    expect(compiler.compileSpace).not.toHaveBeenCalled();
    expect(spaceCompilation.failPageMerge).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', sourcePageId: 'page-1' }),
    );
  });

  it('logs only safe structured provider diagnostics for page failures', async () => {
    const exporter = {
      exportPageSources: jest
        .fn()
        .mockResolvedValue([
          sourceSnapshot({ text: 'PRIVATE SOURCE CONTENT' }),
        ]),
    };
    const compilerError = new KnowledgeCompilerLlmError(
      'provider_error',
      'Knowledge compiler provider request failed.',
      false,
      new Error('PRIVATE UPSTREAM RESPONSE'),
      {
        stage: 'analysis',
        wrapperName: 'AI_RetryError',
        upstreamName: 'AI_APICallError',
        statusCode: 400,
        providerCode: 'InvalidParameter',
        providerType: 'invalid_request_error',
        requestId: 'request-safe-1',
        sdkAttempts: 1,
        providerRetryable: false,
      },
    );
    const compiler = {
      compileSpace: jest.fn().mockRejectedValue(compilerError),
    } as unknown as KnowledgeCompilerAdapter;
    const compilationRepo = createCompilationRepo();
    const processor = new KnowledgeTextJobHandler(
      exporter as unknown as KnowledgeSourceExporterService,
      compiler,
      createImporter(),
      createAccessIndexer(),
      createSourceRepo(),
      createCapsuleRepo(),
      createPageRepo(),
      createTextQueue(),
      createReviewService(),
      createReviewSnapshotService(),
      createAuditService(),
      createReviewApplicationRepo(),
      compilationRepo as never,
      createArtifactCatalog(),
      createSpaceCompilation(),
      createSpaceAggregator(),
      createImageEnrichment(),
    );
    const logger = (
      processor as unknown as {
        logger: { error: (...args: unknown[]) => void };
      }
    ).logger;
    const errorLog = jest.spyOn(logger, 'error').mockImplementation(() => {});

    await expect(
      processor.handle({
        id: 'provider-failed-job',
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1'],
        },
      } as Job),
    ).rejects.toThrow('Knowledge compiler provider request failed.');

    expect(errorLog).toHaveBeenCalledWith({
      event: 'knowledge_compiler_provider_failure',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      compileTaskId: 'provider-failed-job',
      errorCode: 'provider_error',
      retryable: false,
      stage: 'analysis',
      wrapperName: 'AI_RetryError',
      upstreamName: 'AI_APICallError',
      statusCode: 400,
      providerCode: 'InvalidParameter',
      providerType: 'invalid_request_error',
      requestId: 'request-safe-1',
      sdkAttempts: 1,
      providerRetryable: false,
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('PRIVATE');
  });

  it('uses a current ready image cache before the empty-source decision', async () => {
    const imageOnlySource = {
      ...sourceSnapshot({ text: '' }),
      images: [
        {
          attachmentId: 'image-1',
          fileName: 'diagram.png',
          mimeType: 'image/png' as const,
          fileSize: 1024,
          attachmentVersion: 'v1',
        },
      ],
    };
    const exporter = {
      exportPageSources: jest.fn().mockResolvedValue([imageOnlySource]),
    };
    const compiler = createCompiler();
    const importer = createImporter();
    const imageEnrichment = {
      readReadySource: jest.fn().mockResolvedValue({
        source: {
          ...imageOnlySource,
          text: '## 页面图片识别内容\n\n图片说明: 系统架构图',
        },
        imageCount: 1,
        succeededCount: 1,
        failedCount: 0,
        cacheHitCount: 0,
        warnings: [],
        readyImages: [],
      }),
    };
    const processor = createProcessor({
      exporter,
      compiler,
      importer,
      imageEnrichment,
    });

    await processor.handle({
      name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
      data: {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
      },
    } as Job);

    expect(imageEnrichment.readReadySource).toHaveBeenCalledWith(
      imageOnlySource,
    );
    expect(compiler.compileSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [
          expect.objectContaining({
            text: expect.stringContaining('系统架构图'),
          }),
        ],
      }),
    );
    expect(importer.importCompileResult).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          sources: [
            expect.objectContaining({
              text: expect.stringContaining('系统架构图'),
            }),
          ],
        }),
      }),
    );
  });

  it('preserves prior knowledge while an image-only page waits for its image job', async () => {
    const imageOnlySource = {
      ...sourceSnapshot({ text: '' }),
      images: [
        {
          attachmentId: 'image-1',
          fileName: 'diagram.webp',
          mimeType: 'image/webp' as const,
          fileSize: 1024,
          attachmentVersion: 'v1',
        },
      ],
    };
    const exporter = {
      exportPageSources: jest.fn().mockResolvedValue([imageOnlySource]),
    };
    const compiler = createCompiler();
    const importer = createImporter();
    const compilationRepo = createCompilationRepo();
    const sourceRepo = {
      ...createSourceRepo(),
      findLatestActiveSourceByPageId: jest.fn().mockResolvedValue({
        contentHash: imageOnlySource.contentHash,
      }),
    };
    const imageEnrichment = {
      readReadySource: jest.fn().mockResolvedValue({
        source: imageOnlySource,
        imageCount: 1,
        succeededCount: 0,
        failedCount: 1,
        cacheHitCount: 0,
        warnings: [
          {
            attachmentId: 'image-1',
            code: 'provider_error',
            message: 'Image processing failed.',
          },
        ],
        readyImages: [],
      }),
    };
    const spaceCompilation = createSpaceCompilation();
    const processor = createProcessor({
      exporter,
      compiler,
      importer,
      compilationRepo,
      sourceRepo: sourceRepo as unknown as KnowledgeSourceRepo,
      imageEnrichment,
      spaceCompilation,
    });

    await expect(
      processor.handle({
        id: 'image-only-failed-job',
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1'],
        },
      } as Job),
    ).resolves.toEqual(
      expect.objectContaining({ status: 'succeeded', sourceCount: 0 }),
    );

    expect(compiler.compileSpace).not.toHaveBeenCalled();
    expect(importer.importCompileResult).not.toHaveBeenCalled();
    expect(exporter.exportPageSources).toHaveBeenCalledTimes(1);
    expect(compilationRepo.skipAttempt).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: 'image-only-failed-job',
      reasonCode: 'awaiting_images',
      reasonMessage:
        'Text phase completed; the page is awaiting image knowledge.',
    });
    expect(spaceCompilation.queueStandalonePageImages).toHaveBeenCalledWith(
      imageOnlySource,
    );
  });

  it('does not retire an image-only page before its replacement image job finishes', async () => {
    const imageOnlySource = {
      ...sourceSnapshot({ text: '', contentHash: 'sha256:new-image' }),
      images: [
        {
          attachmentId: 'image-2',
          fileName: 'new-diagram.gif',
          mimeType: 'image/gif' as const,
          fileSize: 1024,
          attachmentVersion: 'v2',
        },
      ],
    };
    const exporter = {
      exportPageSources: jest.fn().mockResolvedValue([imageOnlySource]),
    };
    const importer = createImporter();
    const compilationRepo = createCompilationRepo();
    const sourceRepo = {
      ...createSourceRepo(),
      findLatestActiveSourceByPageId: jest.fn().mockResolvedValue({
        contentHash: 'sha256:old-image',
      }),
    };
    const imageEnrichment = {
      readReadySource: jest.fn().mockResolvedValue({
        source: imageOnlySource,
        imageCount: 1,
        succeededCount: 0,
        failedCount: 1,
        cacheHitCount: 0,
        warnings: [],
        readyImages: [],
      }),
    };
    const spaceCompilation = createSpaceCompilation();
    const processor = createProcessor({
      exporter,
      importer,
      compilationRepo,
      sourceRepo: sourceRepo as unknown as KnowledgeSourceRepo,
      imageEnrichment,
      spaceCompilation,
    });

    await expect(
      processor.handle({
        id: 'changed-image-failed-job',
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1'],
        },
      } as Job),
    ).resolves.toEqual(
      expect.objectContaining({ status: 'succeeded', sourceCount: 0 }),
    );

    expect(exporter.exportPageSources).toHaveBeenCalledTimes(1);
    expect(importer.importCompileResult).not.toHaveBeenCalled();
    expect(compilationRepo.skipAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        compileTaskId: 'changed-image-failed-job',
        reasonCode: 'awaiting_images',
      }),
    );
    expect(spaceCompilation.queueStandalonePageImages).toHaveBeenCalledWith(
      imageOnlySource,
    );
  });

  it('publishes Space text without waiting for incomplete images', async () => {
    const mixedSource = {
      ...sourceSnapshot({ text: 'The body is otherwise compilable.' }),
      images: [
        {
          attachmentId: 'image-ready',
          fileName: 'ready.png',
          mimeType: 'image/png' as const,
          fileSize: 1024,
          attachmentVersion: 'v1',
        },
        {
          attachmentId: 'image-busy',
          fileName: 'busy.webp',
          mimeType: 'image/webp' as const,
          fileSize: 1024,
          attachmentVersion: 'v1',
        },
      ],
    };
    const exporter = {
      exportPageSources: jest.fn().mockResolvedValue([mixedSource]),
    };
    const compiler = createCompiler();
    const importer = createImporter();
    const compilationRepo = createCompilationRepo();
    const sourceRepo = {
      ...createSourceRepo(),
      findLatestActiveSourceByPageId: jest.fn(),
    };
    const imageEnrichment = {
      readReadySource: jest.fn().mockResolvedValue({
        source: {
          ...mixedSource,
          text: `${mixedSource.text}\n\n## 页面图片识别内容\n\nready`,
        },
        imageCount: 2,
        succeededCount: 1,
        failedCount: 1,
        cacheHitCount: 1,
        warnings: [
          {
            attachmentId: 'image-busy',
            code: 'image_processing_in_progress',
            message: 'Image processing is in progress.',
          },
        ],
        readyImages: [],
      }),
    };
    const spaceCompilation = {
      isRunActive: jest.fn().mockResolvedValue(true),
      markPageRunning: jest.fn(),
      completePage: jest.fn(),
      catalogForPage: jest.fn(),
    };
    const processor = createProcessor({
      exporter,
      compiler,
      importer,
      compilationRepo,
      sourceRepo: sourceRepo as unknown as KnowledgeSourceRepo,
      imageEnrichment,
      spaceCompilation,
    });

    await expect(
      processor.handle({
        id: 'mixed-image-retry-job',
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1'],
          spaceRunId: 'space-run-1',
        },
        opts: { attempts: 3 },
        attemptsMade: 0,
      } as Job),
    ).resolves.toEqual(
      expect.objectContaining({ status: 'succeeded', sourceCount: 1 }),
    );

    expect(compiler.compileSpace).toHaveBeenCalledTimes(1);
    expect(importer.importCompileResult).toHaveBeenCalledTimes(1);
    expect(sourceRepo.findLatestActiveSourceByPageId).not.toHaveBeenCalled();
    expect(compilationRepo.failAttempt).not.toHaveBeenCalled();
    expect(spaceCompilation.completePage).toHaveBeenCalledWith({
      runId: 'space-run-1',
      sourcePageId: 'page-1',
      status: 'succeeded',
    });
  });

  it('passes the active Space artifact catalog into page compilation', async () => {
    const source = sourceSnapshot();
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest.fn().mockResolvedValue([source]),
    };
    const compiler = createCompiler();
    const catalogService = {
      snapshot: jest.fn().mockResolvedValue({
        entries: [
          {
            artifactId: '22222222-2222-4222-8222-222222222222',
            artifactKind: 'concept',
            canonicalKey: 'event-sourcing',
            title: 'Event sourcing',
            summary: 'Append-only changes.',
          },
        ],
        hash: 'sha256:catalog',
      }),
    };
    const processor = createProcessor({
      exporter,
      compiler,
      catalogService,
    });

    await processor.handle({
      name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
      data: {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
      },
    } as Job);

    expect(catalogService.snapshot).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(jest.mocked(compiler.compileSpace).mock.calls[0][0].catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ canonicalKey: 'event-sourcing' }),
      ]),
    );
  });

  it('uses the immutable run catalog for a Space fan-out page job', async () => {
    const source = sourceSnapshot();
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest.fn().mockResolvedValue([source]),
    };
    const compiler = createCompiler();
    const catalogService = { snapshot: jest.fn() };
    const runEntries = [
      {
        artifactId: '33333333-3333-4333-8333-333333333333',
        artifactKind: 'concept',
        canonicalKey: 'snapshot-concept',
        title: 'Snapshot concept',
        summary: 'Frozen at run creation.',
      },
    ];
    const spaceCompilation = {
      isRunActive: jest.fn().mockResolvedValue(true),
      markPageRunning: jest.fn(),
      completePage: jest.fn(),
      catalogForPage: jest.fn().mockResolvedValue(runEntries),
    };
    const processor = createProcessor({
      exporter,
      compiler,
      catalogService,
      spaceCompilation,
    });

    await processor.handle({
      name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
      data: {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
        spaceRunId: 'space-run-1',
      },
    } as Job);

    expect(spaceCompilation.catalogForPage).toHaveBeenCalledWith({
      runId: 'space-run-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(catalogService.snapshot).not.toHaveBeenCalled();
    expect(jest.mocked(compiler.compileSpace).mock.calls[0][0].catalog).toEqual(
      runEntries,
    );
  });

  it('skips a Space run page whose source changed after the run snapshot', async () => {
    const source = sourceSnapshot({
      sourceVersion: 'v2',
      contentHash: 'hash-2',
    });
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest.fn().mockResolvedValue([source]),
    };
    const compiler = createCompiler();
    const importer = createImporter();
    const compilationRepo = createCompilationRepo();
    const spaceCompilation = {
      isRunActive: jest.fn().mockResolvedValue(true),
      markPageRunning: jest.fn(),
      completePage: jest.fn(),
      catalogForPage: jest.fn(),
    };
    const processor = createProcessor({
      exporter,
      compiler,
      importer,
      compilationRepo,
      spaceCompilation,
    });

    const result = await processor.handle({
      name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
      data: {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
        sourceVersion: 'v1',
        sourceContentHash: 'hash-1',
        spaceRunId: 'space-run-1',
      },
    } as Job);

    expect(compiler.compileSpace).not.toHaveBeenCalled();
    expect(spaceCompilation.catalogForPage).not.toHaveBeenCalled();
    expect(compilationRepo.skipAttempt).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: expect.any(String),
      reasonCode: 'source_changed',
      reasonMessage: 'Knowledge source changed after the Space run snapshot.',
    });
    expect(spaceCompilation.completePage).toHaveBeenCalledWith({
      runId: 'space-run-1',
      sourcePageId: 'page-1',
      status: 'skipped',
      errorCode: 'source_changed',
      errorMessage: 'Knowledge source changed after the Space run snapshot.',
    });
    expect(result).toEqual(
      expect.objectContaining({ status: 'succeeded', sourceCount: 0 }),
    );
  });

  it('rejects page compile batches so one failed page cannot fail its peers', async () => {
    const exporter = createExporter();
    const processor = createProcessor({ exporter });

    await expect(
      processor.handle({
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1', 'page-2'],
        },
      } as Job),
    ).rejects.toThrow('exactly one source page');

    expect(exporter.exportPageSources).not.toHaveBeenCalled();
  });

  it('records page attempt stages and succeeds only after atomic import', async () => {
    const source = sourceSnapshot({ sourceVersion: 'v2' });
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest.fn().mockResolvedValue([source]),
    };
    const compilationRepo = createCompilationRepo();
    const importer = createImporter();
    jest
      .mocked(importer.importCompileResult)
      .mockImplementation(async (input) => {
        await input.onStage?.('validation');
        await input.onStage?.('merge');
        await input.onStage?.('import');
        return { importedArtifactCount: 0, quarantinedArtifactCount: 0 };
      });
    const processor = createProcessor({
      exporter,
      importer,
      compilationRepo,
    });

    await processor.handle({
      id: 'page-job-1',
      name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
      data: {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
      },
    } as Job);

    expect(compilationRepo.startAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        sourcePageId: 'page-1',
        compileTaskId: 'page-job-1',
      }),
    );
    const effectiveKnowledgeHash = buildEffectiveKnowledgeHash({
      sourceContentHash: source.contentHash,
      compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
      promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
      readyImages: [],
    });
    expect(compilationRepo.updateSourceSnapshot).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: 'page-job-1',
      sourceVersion: 'v2',
      sourceContentHash: source.contentHash,
      effectiveKnowledgeHash,
    });
    expect(compilationRepo.updateStage).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: 'page-job-1',
      stage: 'validation',
    });
    expect(compilationRepo.updateStage.mock.calls.slice(-3)).toEqual([
      [
        {
          workspaceId: 'workspace-1',
          sourcePageId: 'page-1',
          compileTaskId: 'page-job-1',
          stage: 'validation',
        },
      ],
      [
        {
          workspaceId: 'workspace-1',
          sourcePageId: 'page-1',
          compileTaskId: 'page-job-1',
          stage: 'merge',
        },
      ],
      [
        {
          workspaceId: 'workspace-1',
          sourcePageId: 'page-1',
          compileTaskId: 'page-job-1',
          stage: 'import',
        },
      ],
    ]);
    expect(compilationRepo.succeedAttempt).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: 'page-job-1',
      sourceVersion: 'v2',
      sourceContentHash: source.contentHash,
      effectiveKnowledgeHash,
    });
  });

  it('advances a durable Space run page through running and succeeded', async () => {
    const source = sourceSnapshot();
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest.fn().mockResolvedValue([source]),
    };
    const spaceCompilation = {
      isRunActive: jest.fn().mockResolvedValue(true),
      markPageRunning: jest.fn().mockResolvedValue(undefined),
      completePage: jest.fn().mockResolvedValue(undefined),
      catalogForPage: jest.fn().mockResolvedValue([]),
    };
    const processor = createProcessor({ exporter, spaceCompilation });

    await processor.handle({
      id: 'page-job-1',
      name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
      data: {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
        spaceRunId: 'space-run-1',
      },
    } as Job);

    expect(spaceCompilation.markPageRunning).toHaveBeenCalledWith({
      runId: 'space-run-1',
      sourcePageId: 'page-1',
    });
    expect(spaceCompilation.completePage).toHaveBeenCalledWith({
      runId: 'space-run-1',
      sourcePageId: 'page-1',
      status: 'succeeded',
    });
  });

  it('runs the durable Space aggregation job after the page barrier opens', async () => {
    const spaceAggregator = {
      aggregate: jest.fn().mockResolvedValue({
        importedArtifactCount: 1,
        quarantinedArtifactCount: 0,
      }),
    };
    const spaceCompilation = createSpaceCompilation();
    const processor = createProcessor({ spaceAggregator, spaceCompilation });

    const result = await processor.handle({
      id: 'knowledge-aggregate-space__space-run-1',
      name: QueueJob.KNOWLEDGE_AGGREGATE_SPACE,
      data: {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        spaceRunId: 'space-run-1',
      },
    } as Job);

    expect(spaceAggregator.aggregate).toHaveBeenCalledWith({
      runId: 'space-run-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      phase: 'initial_aggregate',
    });
    expect(spaceCompilation.dispatchPending).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        type: 'compile-space',
        status: 'succeeded',
        compilerRunId: 'space-run-1',
        importedArtifactCount: 1,
      }),
    );
  });

  it('records export failures after starting the queued page attempt', async () => {
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest
        .fn()
        .mockRejectedValue(new Error('source storage unavailable')),
    };
    const compilationRepo = createCompilationRepo();
    const processor = createProcessor({ exporter, compilationRepo });

    await expect(
      processor.handle({
        id: 'page-job-1',
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1'],
        },
      } as Job),
    ).rejects.toThrow('source storage unavailable');

    expect(compilationRepo.startAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageId: 'page-1',
        compileTaskId: 'page-job-1',
      }),
    );
    expect(compilationRepo.failAttempt).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: 'page-job-1',
      errorCode: 'compile_failed',
      errorMessage: 'Knowledge compilation failed.',
    });
  });

  it('settles a Space run page when attempt startup fails on its final retry', async () => {
    const compilationRepo = createCompilationRepo();
    compilationRepo.startAttempt.mockRejectedValue(
      new Error('diagnostic write failed'),
    );
    const spaceCompilation = {
      isRunActive: jest.fn().mockResolvedValue(true),
      markPageRunning: jest.fn(),
      completePage: jest.fn(),
      catalogForPage: jest.fn(),
    };
    const processor = createProcessor({
      compilationRepo,
      spaceCompilation,
    });

    await expect(
      processor.handle({
        id: 'page-job-start-failed',
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1'],
          spaceRunId: 'space-run-1',
        },
        opts: { attempts: 3 },
        attemptsMade: 2,
      } as Job),
    ).rejects.toThrow('diagnostic write failed');

    expect(compilationRepo.failAttempt).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: 'page-job-start-failed',
      errorCode: 'compile_failed',
      errorMessage: 'Knowledge compilation failed.',
    });
    expect(spaceCompilation.completePage).toHaveBeenCalledWith({
      runId: 'space-run-1',
      sourcePageId: 'page-1',
      status: 'failed',
      errorCode: 'compile_failed',
      errorMessage: 'Knowledge compilation failed.',
    });
  });

  it('finishes a Space run page when its source is no longer available', async () => {
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest.fn().mockResolvedValue([]),
    };
    const compilationRepo = createCompilationRepo();
    const spaceCompilation = {
      isRunActive: jest.fn().mockResolvedValue(true),
      markPageRunning: jest.fn(),
      completePage: jest.fn(),
      catalogForPage: jest.fn(),
    };
    const processor = createProcessor({
      exporter,
      compilationRepo,
      spaceCompilation,
    });

    await expect(
      processor.handle({
        id: 'page-job-missing',
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1'],
          spaceRunId: 'space-run-1',
        },
        opts: { attempts: 3 },
        attemptsMade: 0,
      } as Job),
    ).rejects.toThrow('Knowledge source page is unavailable for compilation.');

    expect(compilationRepo.failAttempt).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: 'page-job-missing',
      errorCode: 'source_unavailable',
      errorMessage: 'Knowledge source page is unavailable for compilation.',
    });
    expect(spaceCompilation.completePage).toHaveBeenCalledWith({
      runId: 'space-run-1',
      sourcePageId: 'page-1',
      status: 'failed',
      errorCode: 'source_unavailable',
      errorMessage: 'Knowledge source page is unavailable for compilation.',
    });
  });

  it('skips an empty source, retires its prior knowledge, and does not invoke the compiler', async () => {
    const source = sourceSnapshot({ text: '   ' });
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest.fn().mockResolvedValue([source]),
    };
    const compiler = createCompiler();
    const importer = createImporter();
    const compilationRepo = createCompilationRepo();
    const sourceRepo = createSourceRepo();
    const capsuleRepo = createCapsuleRepo();
    const processor = createProcessor({
      exporter,
      compiler,
      importer,
      compilationRepo,
      sourceRepo,
      capsuleRepo,
    });
    await expect(
      processor.handle({
        id: 'page-job-empty',
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1'],
        },
      } as Job),
    ).resolves.toEqual(
      expect.objectContaining({ status: 'succeeded', sourceCount: 0 }),
    );

    expect(compiler.compileSpace).not.toHaveBeenCalled();
    expect(exporter.exportPageSources).toHaveBeenCalledTimes(2);
    expect(importer.importCompileResult).toHaveBeenCalledWith(
      expect.objectContaining({
        artifacts: [],
        upsertSources: false,
        retireSources: true,
      }),
    );
    expect(sourceRepo.markSourcesStale).not.toHaveBeenCalled();
    expect(
      capsuleRepo.markSourceArtifactsStaleBySourcePageIds,
    ).not.toHaveBeenCalled();
    expect(compilationRepo.skipAttempt).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: 'page-job-empty',
      reasonCode: 'empty_source',
      reasonMessage: 'Knowledge source page is empty.',
    });
    expect(compilationRepo.failAttempt).not.toHaveBeenCalled();
  });

  it('does not withdraw knowledge when an empty source changes before publication', async () => {
    const empty = sourceSnapshot({
      text: '',
      sourceVersion: 'v1',
      contentHash: 'sha256:empty-v1',
    });
    const changed = sourceSnapshot({
      text: 'new content',
      sourceVersion: 'v2',
      contentHash: 'sha256:content-v2',
    });
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest
        .fn()
        .mockResolvedValueOnce([empty])
        .mockResolvedValueOnce([changed]),
    };
    const importer = createImporter();
    const compilationRepo = createCompilationRepo();
    const processor = createProcessor({
      exporter,
      importer,
      compilationRepo,
    });

    await expect(
      processor.handle({
        id: 'page-job-empty-changed',
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1'],
        },
      } as Job),
    ).resolves.toEqual(
      expect.objectContaining({ status: 'succeeded', sourceCount: 0 }),
    );

    expect(importer.importCompileResult).not.toHaveBeenCalled();
    expect(compilationRepo.skipAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        compileTaskId: 'page-job-empty-changed',
        reasonCode: 'source_changed',
      }),
    );
    expect(compilationRepo.failAttempt).not.toHaveBeenCalled();
  });

  it('counts an empty source as skipped in its active Space run', async () => {
    const source = sourceSnapshot({ text: '\n\t' });
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest.fn().mockResolvedValue([source]),
    };
    const compiler = createCompiler();
    const publicationTrx = { id: 'empty-source-publication-trx' };
    const importer = {
      importCompileResult: jest.fn().mockImplementation(async (input) => {
        await input.publicationGuard(publicationTrx);
        return {
          importedArtifactCount: 0,
          quarantinedArtifactCount: 0,
        };
      }),
    };
    const compilationRepo = createCompilationRepo();
    const spaceCompilation = {
      isRunActive: jest.fn().mockResolvedValue(true),
      isRunActiveForPublication: jest.fn().mockResolvedValue(true),
      markPageRunning: jest.fn(),
      completePage: jest.fn(),
      catalogForPage: jest.fn(),
    };
    const processor = createProcessor({
      exporter,
      compiler,
      importer: importer as unknown as KnowledgeImportService,
      compilationRepo,
      spaceCompilation,
    });

    await expect(
      processor.handle({
        id: 'space-page-job-empty',
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1'],
          spaceRunId: 'space-run-1',
        },
      } as Job),
    ).resolves.toEqual(
      expect.objectContaining({ status: 'succeeded', sourceCount: 0 }),
    );

    expect(spaceCompilation.completePage).toHaveBeenCalledWith({
      runId: 'space-run-1',
      sourcePageId: 'page-1',
      status: 'skipped',
      errorCode: 'empty_source',
      errorMessage: 'Knowledge source page is empty.',
    });
    expect(compilationRepo.skipAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        compileTaskId: 'space-page-job-empty',
        reasonCode: 'empty_source',
      }),
    );
    expect(compiler.compileSpace).not.toHaveBeenCalled();
    expect(spaceCompilation.catalogForPage).not.toHaveBeenCalled();
    expect(spaceCompilation.isRunActiveForPublication).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'space-run-1',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageId: 'page-1',
      }),
      publicationTrx,
    );
  });

  it('completes a superseded Space page as a no-op before exporting', async () => {
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest.fn(),
    };
    const compiler = createCompiler();
    const importer = createImporter();
    const compilationRepo = createCompilationRepo();
    const spaceCompilation = {
      isRunActive: jest.fn().mockResolvedValue(false),
      markPageRunning: jest.fn(),
      completePage: jest.fn(),
      catalogForPage: jest.fn(),
    };
    const processor = createProcessor({
      exporter,
      compiler,
      importer,
      compilationRepo,
      spaceCompilation,
    });

    await expect(
      processor.handle({
        id: 'old-page-job',
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1'],
          spaceRunId: 'old-run',
        },
      } as Job),
    ).resolves.toEqual(
      expect.objectContaining({ status: 'succeeded', sourceCount: 0 }),
    );

    expect(spaceCompilation.isRunActive).toHaveBeenCalledWith({
      runId: 'old-run',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(spaceCompilation.markPageRunning).not.toHaveBeenCalled();
    expect(compilationRepo.startAttempt).not.toHaveBeenCalled();
    expect(compilationRepo.skipAttempt).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: 'old-page-job',
      reasonCode: 'run_superseded',
      reasonMessage: 'Knowledge Space run was superseded.',
    });
    expect(exporter.exportPageSources).not.toHaveBeenCalled();
    expect(compiler.compileSpace).not.toHaveBeenCalled();
    expect(importer.importCompileResult).not.toHaveBeenCalled();
    expect(compilationRepo.failAttempt).not.toHaveBeenCalled();
  });

  it('completes a retry as a no-op when a full Space run starts before the LLM call', async () => {
    const source = sourceSnapshot();
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest.fn().mockResolvedValue([source]),
    };
    const compiler = createCompiler();
    const importer = createImporter();
    const compilationRepo = createCompilationRepo();
    const spaceCompilation = {
      hasActiveRun: jest
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      markPageRunning: jest.fn(),
      completePage: jest.fn(),
      catalogForPage: jest.fn(),
    };
    const processor = createProcessor({
      exporter,
      compiler,
      importer,
      compilationRepo,
      spaceCompilation,
    });

    await expect(
      processor.handle({
        id: 'retry-page-job',
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1'],
          trigger: 'retry_compile',
        },
      } as Job),
    ).resolves.toEqual(
      expect.objectContaining({ status: 'succeeded', sourceCount: 0 }),
    );

    expect(spaceCompilation.hasActiveRun).toHaveBeenCalledTimes(2);
    expect(exporter.exportPageSources).toHaveBeenCalledTimes(1);
    expect(compiler.compileSpace).not.toHaveBeenCalled();
    expect(importer.importCompileResult).not.toHaveBeenCalled();
    expect(compilationRepo.failAttempt).not.toHaveBeenCalled();
    expect(compilationRepo.skipAttempt).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: 'retry-page-job',
      reasonCode: 'space_run_active',
      reasonMessage: 'Knowledge Space compilation is currently running.',
    });
  });

  it.each(['retry_compile', 'page_update'] as const)(
    'terminalizes a queued %s job when a full Space run is already active',
    async (trigger) => {
      const exporter = {
        exportSpaceSources: jest.fn(),
        exportPageSources: jest.fn(),
      };
      const compilationRepo = createCompilationRepo();
      const spaceCompilation = {
        hasActiveRun: jest.fn().mockResolvedValue(true),
        markPageRunning: jest.fn(),
        completePage: jest.fn(),
        catalogForPage: jest.fn(),
      };
      const processor = createProcessor({
        exporter,
        compilationRepo,
        spaceCompilation,
      });

      await processor.handle({
        id: 'retry-page-job-blocked',
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1'],
          trigger,
        },
      } as Job);

      expect(compilationRepo.startAttempt).not.toHaveBeenCalled();
      expect(compilationRepo.skipAttempt).toHaveBeenCalledWith({
        workspaceId: 'workspace-1',
        sourcePageId: 'page-1',
        compileTaskId: 'retry-page-job-blocked',
        reasonCode: 'space_run_active',
        reasonMessage: 'Knowledge Space compilation is currently running.',
      });
      expect(exporter.exportPageSources).not.toHaveBeenCalled();
    },
  );

  it('does not import when a Space run is superseded while the LLM is running', async () => {
    const source = sourceSnapshot();
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest.fn().mockResolvedValue([source]),
    };
    const compiler = createCompiler();
    const importer = createImporter();
    const compilationRepo = createCompilationRepo();
    const spaceCompilation = {
      isRunActive: jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      markPageRunning: jest.fn(),
      completePage: jest.fn(),
      catalogForPage: jest.fn().mockResolvedValue([]),
    };
    const processor = createProcessor({
      exporter,
      compiler,
      importer,
      compilationRepo,
      spaceCompilation,
    });

    await expect(
      processor.handle({
        id: 'old-page-job',
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1'],
          spaceRunId: 'old-run',
        },
      } as Job),
    ).resolves.toEqual(
      expect.objectContaining({ status: 'succeeded', sourceCount: 0 }),
    );

    expect(spaceCompilation.isRunActive).toHaveBeenCalledTimes(3);
    expect(compiler.compileSpace).toHaveBeenCalledTimes(1);
    expect(importer.importCompileResult).not.toHaveBeenCalled();
    expect(compilationRepo.failAttempt).not.toHaveBeenCalled();
    expect(compilationRepo.skipAttempt).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: 'old-page-job',
      reasonCode: 'run_superseded',
      reasonMessage: 'Knowledge Space run was superseded.',
    });
  });

  it('turns a retryable page error into no-op when the Run was superseded', async () => {
    const source = sourceSnapshot();
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest.fn().mockResolvedValue([source]),
    };
    const compiler = createCompiler();
    (compiler.compileSpace as jest.Mock).mockRejectedValue(
      new Error('provider timeout'),
    );
    const compilationRepo = createCompilationRepo();
    const spaceCompilation = {
      isRunActive: jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      markPageRunning: jest.fn(),
      catalogForPage: jest.fn().mockResolvedValue([]),
      completePage: jest.fn(),
    };
    const processor = createProcessor({
      exporter,
      compiler,
      compilationRepo,
      spaceCompilation,
    });

    await expect(
      processor.handle({
        id: 'superseded-error-page-job',
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1'],
          spaceRunId: 'old-run',
        },
      } as Job),
    ).resolves.toEqual(
      expect.objectContaining({ status: 'succeeded', sourceCount: 0 }),
    );

    expect(compilationRepo.failAttempt).not.toHaveBeenCalled();
    expect(compilationRepo.skipAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        compileTaskId: 'superseded-error-page-job',
        reasonCode: 'run_superseded',
      }),
    );
    expect(spaceCompilation.completePage).not.toHaveBeenCalled();
  });

  it('turns an aggregate error into no-op when the Run was superseded', async () => {
    const spaceAggregator = {
      aggregate: jest.fn().mockRejectedValue(new Error('provider timeout')),
    };
    const spaceCompilation = {
      isRunActive: jest.fn().mockResolvedValue(false),
      failAggregation: jest.fn(),
    };
    const processor = createProcessor({
      spaceAggregator,
      spaceCompilation,
    });

    await expect(
      processor.handle({
        id: 'superseded-aggregate-job',
        name: QueueJob.KNOWLEDGE_AGGREGATE_SPACE,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          spaceRunId: 'old-run',
        },
      } as Job),
    ).resolves.toEqual(
      expect.objectContaining({
        type: 'compile-space',
        status: 'succeeded',
        compilerRunId: 'old-run',
      }),
    );

    expect(spaceCompilation.failAggregation).not.toHaveBeenCalled();
  });

  it('discards a compile result when the source changes before import', async () => {
    const before = sourceSnapshot({
      sourceVersion: 'v1',
      contentHash: 'sha256:v1',
    });
    const after = sourceSnapshot({
      sourceVersion: 'v2',
      contentHash: 'sha256:v2',
    });
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest
        .fn()
        .mockResolvedValueOnce([before])
        .mockResolvedValueOnce([after]),
    };
    const importer = createImporter();
    const compilationRepo = createCompilationRepo();
    const processor = createProcessor({
      exporter,
      importer,
      compilationRepo,
    });

    await expect(
      processor.handle({
        id: 'page-job-1',
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1'],
        },
      } as Job),
    ).rejects.toThrow('changed during compilation');

    expect(importer.importCompileResult).not.toHaveBeenCalled();
    expect(compilationRepo.failAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'source_changed' }),
    );
    expect(compilationRepo.succeedAttempt).not.toHaveBeenCalled();
  });

  it('ignores unrelated jobs on the knowledge text queue', async () => {
    const exporter = {
      exportSpaceSources: jest.fn(),
    };
    const processor = new KnowledgeTextJobHandler(
      exporter as unknown as KnowledgeSourceExporterService,
      createCompiler(),
      createImporter(),
      createAccessIndexer(),
      createSourceRepo(),
      createCapsuleRepo(),
      createPageRepo(),
      createTextQueue(),
      createReviewService(),
      createReviewSnapshotService(),
      createAuditService(),
      createReviewApplicationRepo(),
      ...createRequiredProcessorDependencies(),
    );

    await processor.handle({ name: QueueJob.PAGE_CREATED, data: {} } as Job);

    expect(exporter.exportSpaceSources).not.toHaveBeenCalled();
  });

  it('reindexes exact source access when source page ids are provided', async () => {
    const accessIndexer = createAccessIndexer();
    const processor = new KnowledgeTextJobHandler(
      createExporter(),
      createCompiler(),
      createImporter(),
      accessIndexer,
      createSourceRepo(),
      createCapsuleRepo(),
      createPageRepo(),
      createTextQueue(),
      createReviewService(),
      createReviewSnapshotService(),
      createAuditService(),
      createReviewApplicationRepo(),
      ...createRequiredProcessorDependencies(),
    );

    await processor.handle({
      name: QueueJob.KNOWLEDGE_REINDEX_ACCESS,
      data: {
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1', 'page-2'],
      },
    } as Job);

    expect(accessIndexer.reindexSourcePages).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1', 'page-2'],
    });
    expect(accessIndexer.markScopeStale).not.toHaveBeenCalled();
  });

  it('reindexes all known source access when a space id is provided', async () => {
    const accessIndexer = createAccessIndexer();
    const sourceRepo = createSourceRepo();
    jest
      .mocked(sourceRepo.findSourcesBySpace)
      .mockResolvedValue([
        { sourcePageId: 'page-1' },
        { sourcePageId: 'page-2' },
        { sourcePageId: 'page-1' },
      ] as never);
    const processor = new KnowledgeTextJobHandler(
      createExporter(),
      createCompiler(),
      createImporter(),
      accessIndexer,
      sourceRepo,
      createCapsuleRepo(),
      createPageRepo(),
      createTextQueue(),
      createReviewService(),
      createReviewSnapshotService(),
      createAuditService(),
      createReviewApplicationRepo(),
      ...createRequiredProcessorDependencies(),
    );

    await processor.handle({
      name: QueueJob.KNOWLEDGE_REINDEX_ACCESS,
      data: { workspaceId: 'workspace-1', spaceId: 'space-1' },
    } as Job);

    expect(sourceRepo.findSourcesBySpace).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(accessIndexer.reindexSourcePages).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1', 'page-2'],
    });
    expect(accessIndexer.markScopeStale).not.toHaveBeenCalled();
  });

  it('marks sources and dependent capsules stale for source invalidation jobs', async () => {
    const sourceRepo = createSourceRepo();
    const capsuleRepo = createCapsuleRepo();
    const processor = new KnowledgeTextJobHandler(
      createExporter(),
      createCompiler(),
      createImporter(),
      createAccessIndexer(),
      sourceRepo,
      capsuleRepo,
      createPageRepo(),
      createTextQueue(),
      createReviewService(),
      createReviewSnapshotService(),
      createAuditService(),
      createReviewApplicationRepo(),
      ...createRequiredProcessorDependencies(),
    );

    await processor.handle({
      name: QueueJob.KNOWLEDGE_MARK_SOURCES_STALE,
      data: { workspaceId: 'workspace-1', sourcePageIds: ['page-1'] },
    } as Job);

    expect(sourceRepo.markSourcesStale).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1'],
    });
    expect(capsuleRepo.markCapsulesStaleBySourcePageIds).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1'],
    });
  });

  it('marks all known sources in a space stale for admin space invalidation jobs', async () => {
    const sourceRepo = createSourceRepo();
    const capsuleRepo = createCapsuleRepo();
    jest
      .mocked(sourceRepo.findSourcesBySpace)
      .mockResolvedValue([
        { sourcePageId: 'page-1' },
        { sourcePageId: 'page-2' },
        { sourcePageId: 'page-1' },
      ] as never);
    const processor = new KnowledgeTextJobHandler(
      createExporter(),
      createCompiler(),
      createImporter(),
      createAccessIndexer(),
      sourceRepo,
      capsuleRepo,
      createPageRepo(),
      createTextQueue(),
      createReviewService(),
      createReviewSnapshotService(),
      createAuditService(),
      createReviewApplicationRepo(),
      ...createRequiredProcessorDependencies(),
    );

    await processor.handle({
      name: QueueJob.KNOWLEDGE_MARK_SOURCES_STALE,
      data: { workspaceId: 'workspace-1', spaceId: 'space-1' },
    } as Job);

    expect(sourceRepo.findSourcesBySpace).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(sourceRepo.markSourcesStale).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1', 'page-2'],
    });
    expect(capsuleRepo.markCapsulesStaleBySourcePageIds).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1', 'page-2'],
    });
  });

  it('can invalidate only page-owned source artifacts', async () => {
    const sourceRepo = createSourceRepo();
    const capsuleRepo = createCapsuleRepo();
    const processor = new KnowledgeTextJobHandler(
      createExporter(),
      createCompiler(),
      createImporter(),
      createAccessIndexer(),
      sourceRepo,
      capsuleRepo,
      createPageRepo(),
      createTextQueue(),
      createReviewService(),
      createReviewSnapshotService(),
      createAuditService(),
      createReviewApplicationRepo(),
      ...createRequiredProcessorDependencies(),
    );

    await processor.handle({
      name: QueueJob.KNOWLEDGE_MARK_SOURCES_STALE,
      data: {
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1'],
        mode: 'source_artifacts',
      },
    } as Job);

    expect(
      capsuleRepo.markSourceArtifactsStaleBySourcePageIds,
    ).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1'],
    });
    expect(capsuleRepo.markCapsulesStaleBySourcePageIds).not.toHaveBeenCalled();
  });

  it('runs review discover jobs and stores the discovered snapshot', async () => {
    const item = {
      id: 'rev-1',
      type: 'suggestion',
      title: 'Improve launch notes',
      detail: 'Missing operational notes.',
      recommendation: 'Add operational readiness context.',
      relatedDocIds: ['kp-1'],
      searchQueries: [],
      targetDocId: 'kp-1',
    };
    const reviewService = createReviewService();
    jest
      .mocked(reviewService.reviewWiki)
      .mockResolvedValue({ version: '2', items: [item] } as never);
    const snapshotService = createReviewSnapshotService();
    const auditService = createAuditService();
    const capsuleRepo = createCapsuleRepoWithReviewPages();
    const processor = new KnowledgeTextJobHandler(
      createExporter(),
      createCompiler(),
      createImporter(),
      createAccessIndexer(),
      createSourceRepo(),
      capsuleRepo,
      createPageRepo(),
      createTextQueue(),
      reviewService,
      snapshotService,
      auditService,
      createReviewApplicationRepo(),
      ...createRequiredProcessorDependencies(),
    );

    await processor.handle({
      id: 'review-discover__workspace-1__space-1',
      name: QueueJob.REVIEW_DISCOVER,
      data: { workspaceId: 'workspace-1', spaceId: 'space-1', limit: 20 },
    } as Job);

    expect(snapshotService.markJobRunning).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      jobId: 'review-discover__workspace-1__space-1',
    });
    expect(reviewService.reviewWiki).toHaveBeenCalled();
    expect(snapshotService.replaceDiscoveredSnapshot).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      items: [item],
      docs: [{ id: 'kp-1', title: 'Launch plan', sourcePageId: 'page-1' }],
    });
    expect(snapshotService.markJobDone).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      jobId: 'review-discover__workspace-1__space-1',
    });
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'knowledge.review_discovered',
        metadata: expect.objectContaining({
          limit: 20,
          documentCount: 1,
          reviewItemCount: 1,
        }),
      }),
    );
  });

  it('runs review negotiate jobs with authoritative prior history from the snapshot', async () => {
    const item = {
      id: 'rev-2',
      type: 'suggestion',
      title: 'Improve rollback section',
      detail: 'Rollback section needs refinement.',
      recommendation: 'Refine rollback wording.',
      relatedDocIds: ['kp-1'],
      searchQueries: [],
      targetDocId: 'kp-1',
    };
    const priorDraft = {
      title: 'Rollback criteria',
      body: '## Rollback criteria\n\nRollback when error budget burns fast.',
      applyOperation: ['append-section'] as ['append-section'],
      targetDocId: 'kp-1',
      notes: '',
    };
    const nextDraft = {
      ...priorDraft,
      body: '## Rollback criteria\n\nRollback when user-visible errors rise.',
      notes: 'Tightened the trigger.',
    };
    const priorTurn = {
      feedback: '采纳',
      draft: priorDraft,
      deepSearched: false,
      searchResults: [],
    };
    const reviewService = createReviewService();
    jest.mocked(reviewService.negotiateDraft).mockResolvedValue(nextDraft);
    const snapshotService = createReviewSnapshotService();
    jest.mocked(snapshotService.loadSnapshot).mockResolvedValue({
      version: '2',
      items: [item],
      docs: [],
      resolvedReviews: [
        {
          item,
          feedback: '采纳',
          skipped: false,
          deepSearched: false,
          searchResults: [],
          draft: priorDraft,
          applied: null,
          turns: [priorTurn],
        },
      ],
      jobs: [],
      applications: [],
      discoveredAt: '2026-06-22T03:00:00.000Z',
      updatedAt: '2026-06-22T03:10:00.000Z',
    } as never);
    const processor = new KnowledgeTextJobHandler(
      createExporter(),
      createCompiler(),
      createImporter(),
      createAccessIndexer(),
      createSourceRepo(),
      createCapsuleRepo(),
      createPageRepo(),
      createTextQueue(),
      reviewService,
      snapshotService,
      createAuditService(),
      createReviewApplicationRepo(),
      ...createRequiredProcessorDependencies(),
    );

    await processor.handle({
      id: 'review-negotiate__workspace-1__space-1__rev-2',
      name: QueueJob.REVIEW_NEGOTIATE,
      data: {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        item,
        feedback: '把触发条件改得更准确',
      },
    } as Job);

    expect(reviewService.negotiateDraft).toHaveBeenCalledWith(
      expect.anything(),
      item,
      '把触发条件改得更准确',
      [],
      [priorTurn],
    );
    expect(snapshotService.saveResolvedReview).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      resolved: expect.objectContaining({
        item,
        feedback: '把触发条件改得更准确',
        draft: nextDraft,
        turns: [
          priorTurn,
          expect.objectContaining({
            feedback: '把触发条件改得更准确',
            draft: nextDraft,
          }),
        ],
      }),
    });
  });

  it('keeps content-updated pages available and enqueues isolated retryable jobs', async () => {
    const sourceRepo = createSourceRepo();
    const capsuleRepo = createCapsuleRepo();
    const accessIndexer = createAccessIndexer();
    const pageRepo = createPageRepo();
    const textQueue = createTextQueue();
    const compilationRepo = createCompilationRepo();
    jest.mocked(pageRepo.findExistingPageRefs).mockResolvedValue([
      {
        id: 'page-1',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        deletedAt: null,
      },
      {
        id: 'page-2',
        workspaceId: 'workspace-1',
        spaceId: 'space-2',
        deletedAt: null,
      },
    ]);
    const processor = new KnowledgeTextJobHandler(
      createExporter(),
      createCompiler(),
      createImporter(),
      accessIndexer,
      sourceRepo,
      capsuleRepo,
      pageRepo,
      textQueue,
      createReviewService(),
      createReviewSnapshotService(),
      createAuditService(),
      createReviewApplicationRepo(),
      compilationRepo as never,
      createArtifactCatalog(),
      createSpaceCompilation(),
      createSpaceAggregator(),
      createImageEnrichment(),
    );

    await processor.handle({
      name: QueueJob.PAGE_CONTENT_UPDATED,
      data: { workspaceId: 'workspace-1', pageIds: ['page-1', 'page-2'] },
    } as Job);

    expect(sourceRepo.markSourcesStale).not.toHaveBeenCalled();
    expect(
      capsuleRepo.markSourceArtifactsStaleBySourcePageIds,
    ).not.toHaveBeenCalled();
    expect(accessIndexer.reindexSourcePages).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1', 'page-2'],
    });
    expect(pageRepo.findExistingPageRefs).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      pageIds: ['page-1', 'page-2'],
    });
    expect(textQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_PAGES,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
        trigger: 'page_update',
      },
      {
        delay: 5000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 31000 },
        jobId: expect.stringMatching(
          /^knowledge-compile-pages__workspace-1__space-1__page-1__/,
        ),
      },
    );
    expect(compilationRepo.queueAttempt).toHaveBeenCalledTimes(2);
    expect(compilationRepo.queueAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageId: 'page-1',
        sourceVersion: undefined,
        sourceContentHash: undefined,
      }),
    );
    expect(
      compilationRepo.queueAttempt.mock.invocationCallOrder[0],
    ).toBeLessThan(textQueue.add.mock.invocationCallOrder[1]);
    expect(textQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_PAGES,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-2',
        sourcePageIds: ['page-2'],
        trigger: 'page_update',
      },
      {
        delay: 5000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 31000 },
        jobId: expect.stringMatching(
          /^knowledge-compile-pages__workspace-1__space-2__page-2__/,
        ),
      },
    );
  });

  it('routes embedding rebuild jobs directly to the vector service', async () => {
    const vectorIndex = {
      rebuildSpaceEmbeddings: jest
        .fn()
        .mockResolvedValue({ rebuiltChunkCount: 7 }),
    };
    const compiler = createCompiler();
    const imageEnrichment = createImageEnrichment();
    const spaceCompilation = createSpaceCompilation();
    const sourceRepo = createSourceRepo();
    const capsuleRepo = createCapsuleRepo();
    const processor = createProcessor({
      compiler,
      imageEnrichment,
      spaceCompilation,
      sourceRepo,
      capsuleRepo,
      vectorIndex,
    });

    await expect(
      processor.handle({
        id: 'rebuild-embeddings-1',
        name: QueueJob.KNOWLEDGE_REBUILD_EMBEDDINGS,
        data: { workspaceId: 'workspace-1', spaceId: 'space-1' },
      } as Job),
    ).resolves.toEqual({ rebuiltChunkCount: 7 });

    expect(vectorIndex.rebuildSpaceEmbeddings).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(compiler.compileSpace).not.toHaveBeenCalled();
    expect(imageEnrichment.enrichSource).not.toHaveBeenCalled();
    expect(spaceCompilation.startSpaceRun).not.toHaveBeenCalled();
    expect(sourceRepo.markSourcesStale).not.toHaveBeenCalled();
    expect(capsuleRepo.markCapsulesStaleBySourcePageIds).not.toHaveBeenCalled();
    expect(
      capsuleRepo.markSourceArtifactsStaleBySourcePageIds,
    ).not.toHaveBeenCalled();
  });
});

function createExporter(): KnowledgeSourceExporterService {
  return {
    exportSpaceSources: jest.fn().mockResolvedValue([]),
    exportPageSources: jest.fn().mockResolvedValue([]),
  } as unknown as KnowledgeSourceExporterService;
}

function createProcessor(
  overrides: {
    exporter?: unknown;
    compiler?: KnowledgeCompilerAdapter;
    catalogService?: Partial<KnowledgeArtifactCatalogService>;
    spaceCompilation?: Partial<KnowledgeSpaceCompilationService>;
    spaceAggregator?: Partial<KnowledgeSpaceAggregatorService>;
    importer?: KnowledgeImportService;
    compilationRepo?: ReturnType<typeof createCompilationRepo>;
    sourceRepo?: KnowledgeSourceRepo;
    capsuleRepo?: KnowledgeCapsuleRepo;
    imageEnrichment?: Partial<KnowledgeImageEnrichmentService>;
    vectorIndex?: Partial<KnowledgeVectorIndexService>;
  } = {},
): KnowledgeTextJobHandler {
  return new KnowledgeTextJobHandler(
    (overrides.exporter ?? createExporter()) as KnowledgeSourceExporterService,
    overrides.compiler ?? createCompiler(),
    overrides.importer ?? createImporter(),
    createAccessIndexer(),
    overrides.sourceRepo ?? createSourceRepo(),
    overrides.capsuleRepo ?? createCapsuleRepo(),
    createPageRepo(),
    createTextQueue(),
    createReviewService(),
    createReviewSnapshotService(),
    createAuditService(),
    createReviewApplicationRepo(),
    (overrides.compilationRepo ?? createCompilationRepo()) as never,
    (overrides.catalogService ??
      createArtifactCatalog()) as KnowledgeArtifactCatalogService,
    {
      ...createSpaceCompilation(),
      ...(overrides.spaceCompilation ?? {}),
    } as KnowledgeSpaceCompilationService,
    (overrides.spaceAggregator ??
      createSpaceAggregator()) as KnowledgeSpaceAggregatorService,
    (overrides.imageEnrichment ??
      createImageEnrichment()) as KnowledgeImageEnrichmentService,
    (overrides.vectorIndex ?? {
      rebuildSpaceEmbeddings: jest.fn(),
    }) as KnowledgeVectorIndexService,
  );
}

function createCompilationRepo() {
  return {
    queueAttempt: jest.fn().mockResolvedValue(undefined),
    startAttempt: jest.fn().mockResolvedValue(undefined),
    updateSourceSnapshot: jest.fn().mockResolvedValue(undefined),
    updateStage: jest.fn().mockResolvedValue(undefined),
    failAttempt: jest.fn().mockResolvedValue(undefined),
    skipAttempt: jest.fn().mockResolvedValue(undefined),
    succeedAttempt: jest.fn().mockResolvedValue(undefined),
  };
}

function createArtifactCatalog(): KnowledgeArtifactCatalogService {
  return {
    snapshot: jest.fn().mockResolvedValue({
      entries: [],
      hash: 'sha256:empty-catalog',
    }),
  } as unknown as KnowledgeArtifactCatalogService;
}

function createSpaceCompilation(): KnowledgeSpaceCompilationService {
  return {
    startSpaceRun: jest.fn().mockResolvedValue({ id: 'space-run-1' }),
    isRunActive: jest.fn().mockResolvedValue(true),
    hasActiveRun: jest.fn().mockResolvedValue(false),
    markPageRunning: jest.fn().mockResolvedValue(undefined),
    completePage: jest.fn().mockResolvedValue(undefined),
    failAggregation: jest.fn().mockResolvedValue(undefined),
    catalogForPage: jest.fn().mockResolvedValue([]),
    isRunActiveForPublication: jest.fn().mockResolvedValue(true),
    queueStandalonePageImages: jest.fn().mockResolvedValue('image-job-1'),
    dispatchPending: jest.fn().mockResolvedValue(undefined),
  } as unknown as KnowledgeSpaceCompilationService;
}

function createSpaceAggregator(): KnowledgeSpaceAggregatorService {
  return {
    aggregate: jest.fn().mockResolvedValue({
      importedArtifactCount: 0,
      quarantinedArtifactCount: 0,
    }),
  } as unknown as KnowledgeSpaceAggregatorService;
}

function createImageEnrichment(): KnowledgeImageEnrichmentService {
  return {
    readReadySource: jest.fn().mockImplementation(async (source) => ({
      source,
      readyImages: [],
      readyExtractionIds: [],
      truncatedCount: 0,
    })),
    enrichSource: jest.fn().mockImplementation(async ({ source }) => ({
      source,
      imageCount: 0,
      succeededCount: 0,
      failedCount: 0,
      cacheHitCount: 0,
      warnings: [],
      readyImages: [],
    })),
  } as unknown as KnowledgeImageEnrichmentService;
}

function createRequiredProcessorDependencies(): [
  KnowledgeCompilationRepo,
  KnowledgeArtifactCatalogService,
  KnowledgeSpaceCompilationService,
  KnowledgeSpaceAggregatorService,
  KnowledgeImageEnrichmentService,
] {
  return [
    createCompilationRepo() as unknown as KnowledgeCompilationRepo,
    createArtifactCatalog(),
    createSpaceCompilation(),
    createSpaceAggregator(),
    createImageEnrichment(),
  ];
}

function sourceSnapshot(
  overrides: Partial<{
    sourceVersion: string;
    contentHash: string;
    text: string;
  }> = {},
) {
  return {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    sourcePageId: 'page-1',
    sourceVersion: 'v1',
    contentHash: 'sha256:v1',
    title: 'Page',
    text: 'Body',
    references: [],
    ...overrides,
  };
}

function createCompiler(): KnowledgeCompilerAdapter {
  return {
    compileSpace: jest.fn().mockResolvedValue({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sources: [],
      compilerVersion: 'akasha-internal-compiler',
      promptVersion: 'akasha-enterprise-kb-v1',
      compilerRunId: 'run-1',
      artifacts: [],
      diagnostics: { warnings: [], errors: [] },
    }),
  };
}

function createImporter(): KnowledgeImportService {
  return {
    importCompileResult: jest.fn().mockResolvedValue({
      importedArtifactCount: 0,
      quarantinedArtifactCount: 0,
    }),
  } as unknown as KnowledgeImportService;
}

function createAccessIndexer(): KnowledgeAccessIndexerService {
  return {
    reindexSourcePages: jest.fn().mockResolvedValue({ indexedCount: 0 }),
    markScopeStale: jest.fn().mockResolvedValue(undefined),
  } as unknown as KnowledgeAccessIndexerService;
}

function createSourceRepo(): KnowledgeSourceRepo {
  return {
    markSourcesStale: jest.fn().mockResolvedValue(undefined),
    findSourcesBySpace: jest.fn().mockResolvedValue([]),
    findLatestActiveSourceByPageId: jest.fn().mockResolvedValue(undefined),
  } as unknown as KnowledgeSourceRepo;
}

function createCapsuleRepo(): KnowledgeCapsuleRepo {
  return {
    markCapsulesStaleBySourcePageIds: jest.fn().mockResolvedValue(undefined),
    markSourceArtifactsStaleBySourcePageIds: jest
      .fn()
      .mockResolvedValue(undefined),
  } as unknown as KnowledgeCapsuleRepo;
}

function createCapsuleRepoWithReviewPages(): KnowledgeCapsuleRepo {
  return {
    ...createCapsuleRepo(),
    findGraphCandidatesForSpace: jest.fn().mockResolvedValue({
      pages: [
        {
          id: 'kp-1',
          title: 'Launch plan',
          body: 'Launch body',
          folderId: null,
          pageType: 'source_summary',
          tags: [],
          status: 'reviewed',
          confidence: 0.8,
        },
      ],
      pageSources: [{ knowledgePageId: 'kp-1', sourcePageId: 'page-1' }],
      links: [],
      linkSources: [],
      graphEdges: [],
      graphEdgeSources: [],
    }),
    findClaimsByPageIds: jest.fn().mockResolvedValue([]),
  } as unknown as KnowledgeCapsuleRepo;
}

function createPageRepo(): PageRepo {
  return {
    findSpaceIdsForPages: jest.fn().mockResolvedValue([]),
    findExistingPageRefs: jest.fn().mockResolvedValue([]),
  } as unknown as PageRepo;
}

function createTextQueue(): Queue & { add: jest.Mock } {
  return {
    add: jest.fn().mockResolvedValue(undefined),
  } as unknown as Queue & { add: jest.Mock };
}

function createReviewService(): ReviewService {
  return {
    reviewWiki: jest.fn().mockResolvedValue({ version: '2', items: [] }),
    runDeepSearch: jest.fn().mockResolvedValue([]),
    negotiateDraft: jest.fn(),
  } as unknown as ReviewService;
}

function createReviewSnapshotService(): ReviewSnapshotService {
  return {
    beginJob: jest.fn().mockResolvedValue({
      job: {
        jobId: 'job-1',
        kind: 'discover',
        itemId: null,
        status: 'pending',
        error: null,
        createdAt: '2026-06-25T00:00:00.000Z',
        startedAt: null,
        finishedAt: null,
      },
      isNew: false,
    }),
    markJobRunning: jest.fn().mockResolvedValue(undefined),
    markJobDone: jest.fn().mockResolvedValue(undefined),
    markJobFailed: jest.fn().mockResolvedValue(undefined),
    replaceDiscoveredSnapshot: jest.fn().mockResolvedValue(undefined),
    loadSnapshot: jest.fn().mockResolvedValue(null),
    saveResolvedReview: jest.fn().mockResolvedValue(undefined),
  } as unknown as ReviewSnapshotService;
}

function createAuditService(): IAuditService {
  return {
    log: jest.fn(),
  } as unknown as IAuditService;
}

function createReviewApplicationRepo(): KnowledgeReviewApplicationRepo {
  return {
    supersedeDraftsForReviewItem: jest.fn().mockResolvedValue(0),
  } as unknown as KnowledgeReviewApplicationRepo;
}
