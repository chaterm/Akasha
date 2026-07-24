import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Interval } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { JsonValue } from '@akasha/db/types/db';
import { KnowledgeCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-compilation.repo';
import { KnowledgeSpaceCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-space-compilation.repo';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import {
  DEFAULT_KNOWLEDGE_COMPILER_VERSION,
  DEFAULT_KNOWLEDGE_PROMPT_VERSION,
} from '../llm-wiki.constants';
import { KnowledgeSourceSnapshot } from '../types/source-snapshot.types';
import {
  buildKnowledgeAggregateSpaceJobId,
  buildKnowledgeCompilePageJobId,
} from './knowledge-queue.utils';
import { KnowledgeArtifactCatalogService } from './knowledge-artifact-catalog.service';
import { KnowledgeArtifactCatalogEntry } from '../types/compiler-artifact.types';
import { KnowledgeCompilerLlmError } from '../compiler/knowledge-compiler-llm.provider';

@Injectable()
export class KnowledgeSpaceCompilationService implements OnModuleInit {
  private readonly logger = new Logger(KnowledgeSpaceCompilationService.name);
  private dispatching = false;

  constructor(
    @InjectQueue(QueueName.AI_QUEUE) private readonly aiQueue: Queue,
    private readonly runRepo: KnowledgeSpaceCompilationRepo,
    private readonly compilationRepo: KnowledgeCompilationRepo,
    private readonly catalogService: KnowledgeArtifactCatalogService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.dispatchPending();
  }

  @Interval('knowledge-space-compile-outbox', 5_000)
  async recoverPendingDispatches(): Promise<void> {
    await this.dispatchPending();
  }

  async startSpaceRun(input: {
    workspaceId: string;
    spaceId: string;
    trigger: string;
    sources: KnowledgeSourceSnapshot[];
  }) {
    const catalog = await this.catalogService.snapshot({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
    });
    const run = await this.runRepo.createRun({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
      trigger: input.trigger,
      compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
      promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
      catalogSnapshot: catalog.entries as unknown as JsonValue,
      catalogHash: catalog.hash,
      sources: input.sources.map((source) => ({
        sourcePageId: source.sourcePageId,
        sourceVersion: source.sourceVersion,
        sourceContentHash: source.contentHash,
      })),
    });
    await this.dispatchPending();
    return run;
  }

  async markPageRunning(input: {
    runId: string;
    sourcePageId: string;
  }): Promise<void> {
    await this.runRepo.markPageRunning(input);
  }

  async catalogForPage(input: {
    runId: string;
    workspaceId: string;
    spaceId: string;
  }): Promise<KnowledgeArtifactCatalogEntry[]> {
    const run = await this.runRepo.findRun(input.runId);
    if (
      !run ||
      run.workspaceId !== input.workspaceId ||
      run.spaceId !== input.spaceId
    ) {
      throw new KnowledgeCompilerLlmError(
        'configuration_error',
        'Knowledge Space run catalog is unavailable.',
        false,
      );
    }
    if (!Array.isArray(run.catalogSnapshot)) return [];
    return (run.catalogSnapshot as unknown[]).filter(isCatalogEntry);
  }

  async completePage(input: {
    runId: string;
    sourcePageId: string;
    status: 'succeeded' | 'failed' | 'skipped';
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<void> {
    const result = await this.runRepo.completePage(input);
    if (result?.aggregationReady) {
      await this.dispatchPending();
    }
  }

  async failAggregation(input: {
    runId: string;
    errorCode: string;
    errorMessage: string;
    terminal: boolean;
  }): Promise<void> {
    await this.runRepo.failAggregation(input);
  }

  async dispatchPending(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      const pages = await this.runRepo.findPendingPageDispatches();
      for (const page of pages) {
        const jobId = buildKnowledgeCompilePageJobId({
          workspaceId: page.workspaceId,
          spaceId: page.spaceId,
          sourcePageId: page.sourcePageId,
          runKey: page.runId,
        });
        try {
          await this.compilationRepo.queueAttempt({
            workspaceId: page.workspaceId,
            spaceId: page.spaceId,
            sourcePageId: page.sourcePageId,
            sourceVersion: page.expectedSourceVersion,
            sourceContentHash: page.expectedSourceContentHash,
            compilerVersion: page.compilerVersion,
            promptVersion: page.promptVersion,
            compilerRunId: page.runId,
            compileTaskId: jobId,
          });
          await this.aiQueue.add(
            QueueJob.KNOWLEDGE_COMPILE_PAGES,
            {
              workspaceId: page.workspaceId,
              spaceId: page.spaceId,
              sourcePageIds: [page.sourcePageId],
              sourceVersion: page.expectedSourceVersion,
              sourceContentHash: page.expectedSourceContentHash,
              spaceRunId: page.runId,
              trigger: page.trigger,
            },
            {
              jobId,
              attempts: 3,
              backoff: { type: 'exponential', delay: 1_000 },
            },
          );
          await this.runRepo.markPageQueued({
            runId: page.runId,
            sourcePageId: page.sourcePageId,
            jobId,
          });
        } catch (error) {
          this.logger.warn(
            `Knowledge page outbox dispatch will retry for run ${page.runId}.`,
          );
        }
      }

      const runs = await this.runRepo.findAggregatePendingRuns();
      for (const run of runs) {
        const jobId = buildKnowledgeAggregateSpaceJobId({ runId: run.id });
        try {
          await this.aiQueue.add(
            QueueJob.KNOWLEDGE_AGGREGATE_SPACE,
            {
              workspaceId: run.workspaceId,
              spaceId: run.spaceId,
              spaceRunId: run.id,
            },
            {
              jobId,
              attempts: 3,
              backoff: { type: 'exponential', delay: 1_000 },
            },
          );
          await this.runRepo.markAggregationQueued({ runId: run.id, jobId });
        } catch (error) {
          this.logger.warn(
            `Knowledge aggregate outbox dispatch will retry for run ${run.id}.`,
          );
        }
      }
    } finally {
      this.dispatching = false;
    }
  }
}

function isCatalogEntry(
  value: unknown,
): value is KnowledgeArtifactCatalogEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.artifactId === 'string' &&
    typeof entry.artifactKind === 'string' &&
    typeof entry.canonicalKey === 'string' &&
    typeof entry.title === 'string' &&
    (entry.summary === undefined || typeof entry.summary === 'string')
  );
}
