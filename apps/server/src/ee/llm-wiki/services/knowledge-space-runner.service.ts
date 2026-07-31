import { Injectable } from '@nestjs/common';
import {
  KnowledgeSpaceExecutionRepo,
  SpaceExecutionLease,
} from '@akasha/db/repos/llm-wiki/knowledge-space-execution.repo';
import {
  IKnowledgeMergePageImagesJob,
  IKnowledgeSpaceSliceJob,
} from '../../../integrations/queue/constants/queue.interface';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { KnowledgePageCompilationService } from './knowledge-page-compilation.service';
import { KnowledgeSpaceCompilationService } from './knowledge-space-compilation.service';
import { KnowledgeSpaceAggregatorService } from './knowledge-space-aggregator.service';
import { createBoundedAbortSignal } from './knowledge-operation-budget';
import { decideSpaceSliceCheckpoint } from './knowledge-space-slice-policy';
import { KNOWLEDGE_WORKER_SETTINGS } from './knowledge-worker-settings';
import { KnowledgeArtifactCatalogEntry } from '../types/compiler-artifact.types';

export interface KnowledgeTextSliceInput extends IKnowledgeSpaceSliceJob {
  spaceJobId: string;
}

export interface SpaceSliceRunOptions {
  workerId: string;
  finalAttempt: boolean;
  settings?: {
    maxPages: number;
    maxMs: number;
    heartbeatMs: number;
    leaseTtlMs: number;
  };
  monotonicNow?: () => number;
}

@Injectable()
export class KnowledgeSpaceRunnerService {
  constructor(
    private readonly executionRepo: KnowledgeSpaceExecutionRepo,
    private readonly spaceCompilation: KnowledgeSpaceCompilationService,
    private readonly pageCompilation: KnowledgePageCompilationService,
    private readonly spaceAggregator: KnowledgeSpaceAggregatorService,
    private readonly environmentService: EnvironmentService,
  ) {}

  async runTextSlice(
    input: KnowledgeTextSliceInput,
    options: SpaceSliceRunOptions,
  ): Promise<{
    outcome: 'completed' | 'yielded' | 'waiting_images' | 'superseded';
    completedPages: number;
  }> {
    const settings = options.settings ?? {
      maxPages: KNOWLEDGE_WORKER_SETTINGS.sliceMaxPages,
      maxMs: KNOWLEDGE_WORKER_SETTINGS.sliceMaxMs,
      heartbeatMs: KNOWLEDGE_WORKER_SETTINGS.heartbeatMs,
      leaseTtlMs: KNOWLEDGE_WORKER_SETTINGS.executionLeaseTtlMs,
    };
    const monotonicNow = options.monotonicNow ?? (() => performance.now());
    const startedAt = monotonicNow();
    const lease = await this.executionRepo.claimSpaceSlice({
      runId: input.spaceRunId,
      knowledgeGeneration: input.knowledgeGeneration,
      jobPhase: 'text',
      spaceJobSequence: input.spaceJobSequence,
      spaceJobId: input.spaceJobId,
      workerId: options.workerId,
      executionLeaseExpiresAt: leaseExpiry(settings.leaseTtlMs),
    });
    if (!lease) return { outcome: 'superseded', completedPages: 0 };

    let heartbeatInFlight = false;
    const heartbeat = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      void this.executionRepo
        .heartbeatSpaceSlice(lease, {
          executionLeaseExpiresAt: leaseExpiry(settings.leaseTtlMs),
        })
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, settings.heartbeatMs);
    heartbeat.unref?.();

    try {
      const initialization =
        await this.spaceCompilation.initializeLeasedRun(lease);
      if (!initialization) {
        return { outcome: 'superseded', completedPages: 0 };
      }
      let pendingPages = await this.executionRepo.findPendingTextPages(lease);
      if (
        pendingPages.length === 0 &&
        !initialization.pageCompilationRequired &&
        !initialization.aggregateRequired
      ) {
        const finished = await this.executionRepo.finishRun(lease, 'succeeded');
        return {
          outcome: finished ? 'completed' : 'superseded',
          completedPages: 0,
        };
      }

      let completedPages = 0;
      while (pendingPages.length > 0) {
        const page = pendingPages[0];
        if (!(await this.executionRepo.isLeaseActive(lease))) {
          return { outcome: 'superseded', completedPages };
        }
        const deadline = createBoundedAbortSignal(
          undefined,
          this.environmentService.getKnowledgePageDeadlineMs(),
        );
        let outcome;
        try {
          outcome = await this.pageCompilation.compileTextPage(
            {
              data: {
                workspaceId: input.workspaceId,
                spaceId: input.spaceId,
                sourcePageIds: [page.sourcePageId],
                sourceVersion: page.expectedSourceVersion,
                sourceContentHash: page.expectedSourceContentHash,
                spaceRunId: input.spaceRunId,
                knowledgeGeneration: input.knowledgeGeneration,
                trigger: 'manual_compile',
              },
              compileTaskId: `${input.spaceJobId}__${page.sourcePageId}`,
              finalAttempt: options.finalAttempt,
              execution: this.textExecutionContext(lease, page),
            },
            deadline.signal,
          );
        } finally {
          deadline.dispose();
        }
        if (outcome.outcome === 'failed' && outcome.retryable) {
          throw outcome.cause;
        }
        if (!(await this.executionRepo.isLeaseActive(lease))) {
          return { outcome: 'superseded', completedPages };
        }
        completedPages += 1;
        const heartbeatAccepted = await this.executionRepo.heartbeatSpaceSlice(
          lease,
          {
            executionLeaseExpiresAt: leaseExpiry(settings.leaseTtlMs),
          },
        );
        if (!heartbeatAccepted) {
          return { outcome: 'superseded', completedPages };
        }
        pendingPages = await this.executionRepo.findPendingTextPages(lease);
        const decision = decideSpaceSliceCheckpoint({
          completedPages,
          elapsedMs: monotonicNow() - startedAt,
          remainingPages: pendingPages.length,
          maxPages: settings.maxPages,
          maxMs: settings.maxMs,
        });
        if (decision.yield) {
          const yielded = await this.executionRepo.yieldSpaceSlice(lease, {
            reason: decision.reason,
          });
          return {
            outcome: yielded ? 'yielded' : 'superseded',
            completedPages,
          };
        }
      }

      const barrier = await this.executionRepo.advanceTextBarrier(lease);
      if (!barrier?.barrierComplete) {
        return { outcome: 'superseded', completedPages };
      }
      const aggregate = await this.spaceAggregator.aggregateLeased(lease, {
        workspaceId: input.workspaceId,
        spaceId: input.spaceId,
      });
      if (!(await this.executionRepo.isLeaseActive(lease))) {
        return { outcome: 'superseded', completedPages };
      }
      const imagesRequired = await this.executionRepo.hasImageWork(lease);
      const advanced = await this.executionRepo.completeInitialAggregate(
        lease,
        {
          catalogHash: aggregate.catalogHash,
          importedArtifactCount: aggregate.importedArtifactCount,
          quarantinedArtifactCount: aggregate.quarantinedArtifactCount,
          imagesRequired,
        },
      );
      if (!advanced) return { outcome: 'superseded', completedPages };
      if (imagesRequired) return { outcome: 'waiting_images', completedPages };

      const current = await this.executionRepo.findLeasedRun(lease);
      const finishOutcome = current?.failedPageCount ? 'partial' : 'succeeded';
      const finished = await this.executionRepo.finishRun(
        lease,
        finishOutcome,
        {
          importedArtifactCount: aggregate.importedArtifactCount,
          quarantinedArtifactCount: aggregate.quarantinedArtifactCount,
          catalogHash: aggregate.catalogHash,
        },
      );
      return {
        outcome: finished ? 'completed' : 'superseded',
        completedPages,
      };
    } finally {
      clearInterval(heartbeat);
    }
  }

  async runImageMergeSlice(
    input: KnowledgeTextSliceInput,
    options: SpaceSliceRunOptions,
  ): Promise<{
    outcome: 'completed' | 'yielded' | 'superseded';
    completedPages: number;
  }> {
    const settings = options.settings ?? {
      maxPages: KNOWLEDGE_WORKER_SETTINGS.sliceMaxPages,
      maxMs: KNOWLEDGE_WORKER_SETTINGS.sliceMaxMs,
      heartbeatMs: KNOWLEDGE_WORKER_SETTINGS.heartbeatMs,
      leaseTtlMs: KNOWLEDGE_WORKER_SETTINGS.executionLeaseTtlMs,
    };
    const monotonicNow = options.monotonicNow ?? (() => performance.now());
    const startedAt = monotonicNow();
    const lease = await this.executionRepo.claimSpaceSlice({
      runId: input.spaceRunId,
      knowledgeGeneration: input.knowledgeGeneration,
      jobPhase: 'image_merge',
      spaceJobSequence: input.spaceJobSequence,
      spaceJobId: input.spaceJobId,
      workerId: options.workerId,
      executionLeaseExpiresAt: leaseExpiry(settings.leaseTtlMs),
    });
    if (!lease) return { outcome: 'superseded', completedPages: 0 };

    let heartbeatInFlight = false;
    const heartbeat = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      void this.executionRepo
        .heartbeatSpaceSlice(lease, {
          executionLeaseExpiresAt: leaseExpiry(settings.leaseTtlMs),
        })
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, settings.heartbeatMs);
    heartbeat.unref?.();

    try {
      let pendingPages = await this.executionRepo.findPendingMergePages(lease);
      let completedPages = 0;
      while (pendingPages.length > 0) {
        const page = pendingPages[0];
        if (!(await this.executionRepo.isLeaseActive(lease))) {
          return { outcome: 'superseded', completedPages };
        }
        const deadline = createBoundedAbortSignal(
          undefined,
          this.environmentService.getKnowledgePageDeadlineMs(),
        );
        let outcome;
        try {
          outcome = await this.pageCompilation.mergePageImages(
            {
              data: {
                workspaceId: input.workspaceId,
                spaceId: input.spaceId,
                sourcePageId: page.sourcePageId,
                sourceVersion: page.expectedSourceVersion,
                sourceContentHash: page.expectedSourceContentHash,
                effectiveKnowledgeHash:
                  page.targetEffectiveKnowledgeHash ??
                  page.expectedSourceContentHash,
                spaceRunId: input.spaceRunId,
                knowledgeGeneration: input.knowledgeGeneration,
                images: page.images as IKnowledgeMergePageImagesJob['images'],
              },
              compileTaskId: `${input.spaceJobId}__${page.sourcePageId}`,
              finalAttempt: options.finalAttempt,
              execution: this.imageMergeExecutionContext(lease, page),
            },
            deadline.signal,
          );
        } finally {
          deadline.dispose();
        }
        if (outcome.outcome === 'failed' && outcome.retryable) {
          throw outcome.cause;
        }
        if (!(await this.executionRepo.isLeaseActive(lease))) {
          return { outcome: 'superseded', completedPages };
        }
        completedPages += 1;
        const heartbeatAccepted = await this.executionRepo.heartbeatSpaceSlice(
          lease,
          {
            executionLeaseExpiresAt: leaseExpiry(settings.leaseTtlMs),
          },
        );
        if (!heartbeatAccepted) {
          return { outcome: 'superseded', completedPages };
        }
        pendingPages = await this.executionRepo.findPendingMergePages(lease);
        const decision = decideSpaceSliceCheckpoint({
          completedPages,
          elapsedMs: monotonicNow() - startedAt,
          remainingPages: pendingPages.length,
          maxPages: settings.maxPages,
          maxMs: settings.maxMs,
        });
        if (decision.yield) {
          const yielded = await this.executionRepo.yieldSpaceSlice(lease, {
            reason: decision.reason,
          });
          return {
            outcome: yielded ? 'yielded' : 'superseded',
            completedPages,
          };
        }
      }

      const barrier = await this.executionRepo.advanceMergeBarrier(lease);
      if (!barrier?.barrierComplete) {
        return { outcome: 'superseded', completedPages };
      }
      const aggregate = await this.spaceAggregator.aggregateLeased(lease, {
        workspaceId: input.workspaceId,
        spaceId: input.spaceId,
      });
      if (!(await this.executionRepo.isLeaseActive(lease))) {
        return { outcome: 'superseded', completedPages };
      }
      const partial = await this.executionRepo.hasPartialOutcome(lease);
      const finished = await this.executionRepo.finishRun(
        lease,
        partial ? 'partial' : 'succeeded',
        {
          importedArtifactCount: aggregate.importedArtifactCount,
          quarantinedArtifactCount: aggregate.quarantinedArtifactCount,
          catalogHash: aggregate.catalogHash,
        },
      );
      return {
        outcome: finished ? 'completed' : 'superseded',
        completedPages,
      };
    } finally {
      clearInterval(heartbeat);
    }
  }

  private textExecutionContext(
    lease: SpaceExecutionLease,
    page: {
      sourcePageId: string;
      expectedSourceVersion: string;
      expectedSourceContentHash: string;
    },
  ) {
    return {
      isActive: () => this.executionRepo.isLeaseActive(lease),
      completePage: (outcome: {
        status: 'succeeded' | 'failed' | 'skipped';
        errorCode?: string | null;
        errorMessage?: string | null;
      }) =>
        this.executionRepo.completeTextPage(lease, {
          sourcePageId: page.sourcePageId,
          sourceVersion: page.expectedSourceVersion,
          sourceContentHash: page.expectedSourceContentHash,
          ...outcome,
        }),
      catalog: async () => {
        const run = await this.executionRepo.findLeasedRun(lease);
        return Array.isArray(run?.catalogSnapshot)
          ? (run.catalogSnapshot as unknown as KnowledgeArtifactCatalogEntry[])
          : [];
      },
      publicationGuard: (
        trx: Parameters<
          KnowledgeSpaceExecutionRepo['isLeaseActiveForPublication']
        >[2],
      ) =>
        this.executionRepo.isLeaseActiveForPublication(
          lease,
          {
            sourcePageId: page.sourcePageId,
            sourceVersion: page.expectedSourceVersion,
            sourceContentHash: page.expectedSourceContentHash,
          },
          trx,
        ),
    };
  }

  private imageMergeExecutionContext(
    lease: SpaceExecutionLease,
    page: {
      sourcePageId: string;
      expectedSourceVersion: string;
      expectedSourceContentHash: string;
    },
  ) {
    const pageIdentity = {
      sourcePageId: page.sourcePageId,
      sourceVersion: page.expectedSourceVersion,
      sourceContentHash: page.expectedSourceContentHash,
    };
    return {
      isActive: () => this.executionRepo.isLeaseActive(lease),
      completePage: (outcome: {
        status: 'failed' | 'skipped';
        errorCode?: string | null;
        errorMessage?: string | null;
      }) =>
        this.executionRepo.failMergePage(lease, {
          ...pageIdentity,
          errorCode: outcome.errorCode,
          errorMessage: outcome.errorMessage,
        }),
      catalog: async () => {
        const run = await this.executionRepo.findLeasedRun(lease);
        return Array.isArray(run?.catalogSnapshot)
          ? (run.catalogSnapshot as unknown as KnowledgeArtifactCatalogEntry[])
          : [];
      },
      publicationGuard: (
        trx: Parameters<
          KnowledgeSpaceExecutionRepo['isLeaseActiveForMergePublication']
        >[2],
      ) =>
        this.executionRepo.isLeaseActiveForMergePublication(
          lease,
          pageIdentity,
          trx,
        ),
      publicationComplete: (
        trx: Parameters<
          KnowledgeSpaceExecutionRepo['completeMergePagePublicationInTransaction']
        >[2],
        effectiveKnowledgeHash: string,
      ) =>
        this.executionRepo.completeMergePagePublicationInTransaction(
          lease,
          { ...pageIdentity, effectiveKnowledgeHash },
          trx,
        ),
    };
  }
}

function leaseExpiry(ttlMs: number): Date {
  return new Date(Date.now() + ttlMs);
}
