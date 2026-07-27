import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Interval } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { JsonValue } from '@akasha/db/types/db';
import { KyselyTransaction } from '@akasha/db/types/kysely.types';
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
  buildKnowledgeRetryPageJobId,
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
    requestedAt?: Date;
    sources: KnowledgeSourceSnapshot[];
  }) {
    const catalog = await this.catalogService.snapshot({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
    });
    const { created, run, supersededJobIds } = await this.runRepo.createRun({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
      trigger: input.trigger,
      compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
      promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
      catalogSnapshot: catalog.entries as unknown as JsonValue,
      catalogHash: catalog.hash,
      requestedAt: input.requestedAt,
      sources: input.sources.map((source) => ({
        sourcePageId: source.sourcePageId,
        sourceVersion: source.sourceVersion,
        sourceContentHash: source.contentHash,
      })),
    });
    if (created === false) {
      return null;
    }
    await this.removeSupersededJobs(supersededJobIds);
    await this.dispatchPending();
    return run;
  }

  async hasActiveRun(input: {
    workspaceId: string;
    spaceId: string;
  }): Promise<boolean> {
    return this.runRepo.hasActiveRun(input);
  }

  async isRunActive(input: {
    runId: string;
    workspaceId: string;
    spaceId: string;
  }): Promise<boolean> {
    return this.runRepo.isRunActive(input);
  }

  async isRunActiveForPublication(
    input: { runId: string; workspaceId: string; spaceId: string },
    trx: KyselyTransaction,
  ): Promise<boolean> {
    return this.runRepo.isRunActiveForPublication(input, trx);
  }

  async queuePageRetry(source: KnowledgeSourceSnapshot): Promise<string> {
    const jobId = buildKnowledgeRetryPageJobId({
      workspaceId: source.workspaceId,
      spaceId: source.spaceId,
      sourcePageId: source.sourcePageId,
      sourceContentHash: source.contentHash,
    });
    await this.compilationRepo.queueAttempt({
      workspaceId: source.workspaceId,
      spaceId: source.spaceId,
      sourcePageId: source.sourcePageId,
      sourceVersion: source.sourceVersion,
      sourceContentHash: source.contentHash,
      compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
      promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
      compilerRunId: jobId,
      compileTaskId: jobId,
    });
    await this.aiQueue.add(
      QueueJob.KNOWLEDGE_COMPILE_PAGES,
      {
        workspaceId: source.workspaceId,
        spaceId: source.spaceId,
        sourcePageIds: [source.sourcePageId],
        sourceVersion: source.sourceVersion,
        sourceContentHash: source.contentHash,
        trigger: 'retry_compile',
      },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    return jobId;
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
          const accepted = await this.runRepo.markPageQueued({
            runId: page.runId,
            sourcePageId: page.sourcePageId,
            jobId,
          });
          if (!accepted) {
            await this.removeRejectedOutboxJob(jobId);
            await this.compilationRepo.skipAttempt({
              workspaceId: page.workspaceId,
              sourcePageId: page.sourcePageId,
              compileTaskId: jobId,
              reasonCode: 'run_superseded',
              reasonMessage:
                'Knowledge Space run was superseded before dispatch.',
            });
          }
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
          const accepted = await this.runRepo.markAggregationQueued({
            runId: run.id,
            jobId,
          });
          if (!accepted) {
            await this.removeRejectedOutboxJob(jobId);
          }
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

  private async removeSupersededJobs(jobIds: string[]): Promise<void> {
    for (const jobId of [...new Set(jobIds)]) {
      try {
        const job = await this.aiQueue.getJob(jobId);
        if (!job) continue;
        const state = await job.getState();
        if (isRemovableSupersededJobState(state)) {
          await job.remove();
        }
      } catch (error) {
        this.logger.warn(
          `Unable to cancel superseded knowledge job ${jobId}; worker fencing will prevent publication.`,
        );
      }
    }
  }

  private async removeRejectedOutboxJob(jobId: string): Promise<void> {
    try {
      const job = await this.aiQueue.getJob(jobId);
      if (!job) return;
      const state = await job.getState();
      if (isRemovableSupersededJobState(state)) {
        await job.remove();
      }
    } catch (error) {
      this.logger.warn(
        `Unable to cancel rejected knowledge outbox job ${jobId}; worker fencing will prevent publication.`,
      );
    }
  }
}

function isRemovableSupersededJobState(state: string): boolean {
  return state === 'waiting' || state === 'delayed' || state === 'paused';
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
