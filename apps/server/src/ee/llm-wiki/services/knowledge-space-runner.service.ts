import { Injectable, Logger } from '@nestjs/common';
import {
  KnowledgeSpaceExecutionRepo,
  SpaceExecutionLease,
} from '@akasha/db/repos/llm-wiki/knowledge-space-execution.repo';
import { IKnowledgeSpaceJob } from '../../../integrations/queue/constants/queue.interface';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { KnowledgePageCompilationService } from './knowledge-page-compilation.service';
import { KnowledgeSpaceCompilationService } from './knowledge-space-compilation.service';
import { KnowledgeSpaceFinalizerService } from './knowledge-space-finalizer.service';
import { createBoundedAbortSignal } from './knowledge-operation-budget';
import { decideLeaseCheckpoint } from './knowledge-space-lease-policy';
import { KNOWLEDGE_WORKER_SETTINGS } from './knowledge-worker-settings';

export interface KnowledgeTextLeaseInput extends IKnowledgeSpaceJob {
  spaceJobId: string;
}

export interface SpaceLeaseRunOptions {
  workerId: string;
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
  private readonly logger = new Logger(KnowledgeSpaceRunnerService.name);

  constructor(
    private readonly executionRepo: KnowledgeSpaceExecutionRepo,
    private readonly spaceCompilation: KnowledgeSpaceCompilationService,
    private readonly pageCompilation: KnowledgePageCompilationService,
    private readonly spaceFinalizer: KnowledgeSpaceFinalizerService,
    private readonly environmentService: EnvironmentService,
  ) {}

  async runTextLease(
    input: KnowledgeTextLeaseInput,
    options: SpaceLeaseRunOptions,
  ): Promise<{
    outcome: 'completed' | 'yielded' | 'waiting_images' | 'superseded';
    completedPages: number;
  }> {
    const settings = options.settings ?? {
      maxPages: KNOWLEDGE_WORKER_SETTINGS.leaseMaxPages,
      maxMs: KNOWLEDGE_WORKER_SETTINGS.leaseMaxMs,
      heartbeatMs: KNOWLEDGE_WORKER_SETTINGS.heartbeatMs,
      leaseTtlMs: KNOWLEDGE_WORKER_SETTINGS.executionLeaseTtlMs,
    };
    const monotonicNow = options.monotonicNow ?? (() => performance.now());
    const startedAt = monotonicNow();
    const lease = await this.executionRepo.claimSpaceLease({
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
        .heartbeatSpaceLease(lease, {
          executionLeaseExpiresAt: leaseExpiry(settings.leaseTtlMs),
        })
        .catch(() => {
          this.logger.warn({
            event: 'knowledge_space_heartbeat_failed',
            runId: lease.runId,
            jobId: lease.spaceJobId,
            phase: lease.jobPhase,
          });
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
      let completedPages = 0;
      for (;;) {
        let pendingPages = compactPage(
          await this.executionRepo.claimNextTextPage(lease),
        );
        while (pendingPages.length > 0) {
          let page = pendingPages[0];
          if (!(await this.executionRepo.isLeaseActive(lease))) {
            return { outcome: 'superseded', completedPages };
          }
          if (page.bindingStatus !== 'bound') {
            const binding = await this.spaceCompilation.bindLeasedRunPage(
              lease,
              {
                sourcePageId: page.sourcePageId,
                indexMode: page.indexMode as 'compiled' | 'original',
              },
            );
            if (!binding) {
              return { outcome: 'superseded', completedPages };
            }
            if (binding.outcome !== 'bound') {
              completedPages += 1;
              const heartbeatAccepted =
                await this.executionRepo.heartbeatSpaceLease(lease, {
                  executionLeaseExpiresAt: leaseExpiry(settings.leaseTtlMs),
                });
              if (!heartbeatAccepted) {
                return { outcome: 'superseded', completedPages };
              }
              const decision = await this.decideTextCheckpoint(lease, {
                completedPages,
                elapsedMs: monotonicNow() - startedAt,
                settings,
              });
              if (decision.yield) {
                const yielded = await this.executionRepo.yieldSpaceLease(
                  lease,
                  { reason: decision.reason },
                );
                return {
                  outcome: yielded ? 'yielded' : 'superseded',
                  completedPages,
                };
              }
              pendingPages = compactPage(
                await this.executionRepo.claimNextTextPage(lease),
              );
              continue;
            }
            page = binding.page;
          }
          if (
            page.expectedSourceVersion === null ||
            page.expectedSourceContentHash === null
          ) {
            throw new Error(
              `Bound RunPage ${page.sourcePageId} is missing its source identity.`,
            );
          }
          const boundPage = {
            ...page,
            expectedSourceVersion: page.expectedSourceVersion,
            expectedSourceContentHash: page.expectedSourceContentHash,
          };
          const deadline = createBoundedAbortSignal(
            undefined,
            this.environmentService.getKnowledgePageDeadlineMs(),
          );
          try {
            await this.pageCompilation.compileTextPage(
              {
                data: {
                  workspaceId: input.workspaceId,
                  spaceId: input.spaceId,
                  sourcePageIds: [boundPage.sourcePageId],
                  sourceVersion: boundPage.expectedSourceVersion,
                  sourceContentHash: boundPage.expectedSourceContentHash,
                  spaceRunId: input.spaceRunId,
                  knowledgeGeneration: input.knowledgeGeneration,
                  indexMode: boundPage.indexMode as 'compiled' | 'original',
                },
                compileTaskId: `${input.spaceJobId}__${boundPage.sourcePageId}`,
                execution: this.textExecutionContext(lease, boundPage),
              },
              deadline.signal,
            );
          } finally {
            deadline.dispose();
          }
          if (!(await this.executionRepo.isLeaseActive(lease))) {
            return { outcome: 'superseded', completedPages };
          }
          completedPages += 1;
          const heartbeatAccepted =
            await this.executionRepo.heartbeatSpaceLease(lease, {
              executionLeaseExpiresAt: leaseExpiry(settings.leaseTtlMs),
            });
          if (!heartbeatAccepted) {
            return { outcome: 'superseded', completedPages };
          }
          const decision = await this.decideTextCheckpoint(lease, {
            completedPages,
            elapsedMs: monotonicNow() - startedAt,
            settings,
          });
          if (decision.yield) {
            const yielded = await this.executionRepo.yieldSpaceLease(lease, {
              reason: decision.reason,
            });
            return {
              outcome: yielded ? 'yielded' : 'superseded',
              completedPages,
            };
          }
          pendingPages = compactPage(
            await this.executionRepo.claimNextTextPage(lease),
          );
        }

        const barrier = await this.executionRepo.advanceTextBarrier(lease);
        if (barrier?.reclaimed) continue;
        if (!barrier?.barrierComplete) {
          return { outcome: 'superseded', completedPages };
        }
        if (barrier.imagesRequired || barrier.mergeRequired) {
          return { outcome: 'waiting_images', completedPages };
        }
        // The barrier has consumed the Text lease and created a Finalize
        // outbox. Finalization must never run inside this Text activation.
        return {
          outcome: 'completed',
          completedPages,
        };
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  async runFinalizeLease(
    input: KnowledgeTextLeaseInput,
    options: SpaceLeaseRunOptions,
  ) {
    const settings = options.settings ?? {
      heartbeatMs: KNOWLEDGE_WORKER_SETTINGS.heartbeatMs,
      leaseTtlMs: KNOWLEDGE_WORKER_SETTINGS.executionLeaseTtlMs,
    };
    const lease = await this.executionRepo.claimSpaceLease({
      runId: input.spaceRunId,
      knowledgeGeneration: input.knowledgeGeneration,
      jobPhase: 'finalize',
      spaceJobSequence: input.spaceJobSequence,
      spaceJobId: input.spaceJobId,
      workerId: options.workerId,
      executionLeaseExpiresAt: leaseExpiry(settings.leaseTtlMs),
    });
    if (!lease) return { outcome: 'superseded' as const, completedPages: 0 };
    let heartbeatInFlight = false;
    const heartbeat = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      void this.executionRepo
        .heartbeatSpaceLease(lease, {
          executionLeaseExpiresAt: leaseExpiry(settings.leaseTtlMs),
        })
        .catch(() => {
          this.logger.warn({
            event: 'knowledge_space_heartbeat_failed',
            runId: lease.runId,
            jobId: lease.spaceJobId,
            phase: lease.jobPhase,
          });
        })
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, settings.heartbeatMs);
    heartbeat.unref?.();
    try {
      const finalized = await this.spaceFinalizer.finalizeLeased(lease, {
        workspaceId: input.workspaceId,
        spaceId: input.spaceId,
      });
      if (finalized.outcome === 'superseded')
        return { outcome: 'superseded' as const, completedPages: 0 };
      // The repository checks all child states and derives partial atomically
      // under the Run lock; Text counters alone cannot determine the outcome.
      const finished = await this.executionRepo.finishRun(lease, 'succeeded');
      return {
        outcome: finished ? ('completed' as const) : ('superseded' as const),
        completedPages: 0,
      };
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async decideTextCheckpoint(
    lease: SpaceExecutionLease,
    input: {
      completedPages: number;
      elapsedMs: number;
      settings: { maxPages: number; maxMs: number };
    },
  ) {
    const pending = await this.executionRepo.findPendingTextPages(lease);
    return decideLeaseCheckpoint({
      completedPages: input.completedPages,
      elapsedMs: input.elapsedMs,
      remainingPages: pending.length,
      maxPages: input.settings.maxPages,
      maxMs: input.settings.maxMs,
    });
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
        retryable?: boolean;
        errorCode?: string | null;
        errorMessage?: string | null;
        qualityStatus?: 'normal' | 'degraded' | 'partial_image';
      }) =>
        this.executionRepo.completeTextPage(lease, {
          sourcePageId: page.sourcePageId,
          sourceVersion: page.expectedSourceVersion,
          sourceContentHash: page.expectedSourceContentHash,
          ...outcome,
        }),
      catalog: async () => [],
      bypassCache: async () =>
        (await this.executionRepo.findLeasedRun(lease))?.mode ===
        'force_rebuild',
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
}

function leaseExpiry(ttlMs: number): Date {
  return new Date(Date.now() + ttlMs);
}

function compactPage<T>(page: T | undefined): T[] {
  return page === undefined ? [] : [page];
}
