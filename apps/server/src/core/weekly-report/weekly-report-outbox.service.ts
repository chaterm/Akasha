import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectKysely } from 'nestjs-kysely';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { KyselyDB } from '../../database/types/kysely.types';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { KnowledgeSpaceCompilationRepo } from '../../database/repos/llm-wiki/knowledge-space-compilation.repo';
import { KnowledgeCompileWindowRepo } from '../../database/repos/llm-wiki/knowledge-compile-window.repo';
import { KNOWLEDGE_PAGE_COMPILE_QUIET_PERIOD_MS } from '../../features/llm-wiki/llm-wiki.constants';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';

/** Each effect has an independent durable checkpoint; the producer never emits early. */
@Injectable()
export class WeeklyReportOutboxService {
  private readonly logger = new Logger(WeeklyReportOutboxService.name);
  private running = false;

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly environment: EnvironmentService,
    @InjectQueue(QueueName.SEARCH_QUEUE) private readonly search: Queue,
    @InjectQueue(QueueName.KNOWLEDGE_TEXT_QUEUE)
    private readonly knowledge: Queue,
    @InjectQueue(QueueName.GENERAL_QUEUE) private readonly general: Queue,
    private readonly compilation: KnowledgeSpaceCompilationRepo,
    private readonly compileWindow: KnowledgeCompileWindowRepo,
    @Inject(AUDIT_SERVICE) private readonly audit: IAuditService,
  ) {}

  @Interval('weekly-report-outbox', 5000)
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (let i = 0; i < 25; i++) {
        const processed = await this.db.transaction().execute(async (trx) => {
          const entry = await trx
            .selectFrom('weeklyReportOutbox')
            .selectAll()
            .where('deliveredAt', 'is', null)
            .where('availableAt', '<=', new Date())
            .orderBy('createdAt')
            .orderBy('id')
            .forUpdate()
            .skipLocked()
            .limit(1)
            .executeTakeFirst();
          if (!entry) return false;
          try {
            const page = await trx
              .selectFrom('pages')
              .select(['id', 'workspaceId', 'spaceId', 'title', 'deletedAt'])
              .where('id', '=', entry.pageId)
              .where('workspaceId', '=', entry.workspaceId)
              .executeTakeFirst();
            if (page && !page.deletedAt) {
              const options = {
                jobId: `weekly-report-${entry.id}`,
                removeOnComplete: { age: 86400 },
                removeOnFail: false,
                attempts: 5,
                backoff: { type: 'exponential', delay: 2000 },
              };
              switch (entry.effect) {
                case 'search':
                  if (this.environment.getSearchDriver() === 'typesense') {
                    await this.search.add(
                      QueueJob.PAGE_CREATED,
                      { pageIds: [page.id] },
                      options,
                    );
                  }
                  break;
                case 'access':
                  await this.knowledge.add(
                    QueueJob.KNOWLEDGE_REINDEX_ACCESS,
                    {
                      workspaceId: entry.workspaceId,
                      sourcePageIds: [page.id],
                    },
                    options,
                  );
                  break;
                case 'compile':
                  await this.compilation.scheduleIncrementalCompileForPages(
                    {
                      workspaceId: entry.workspaceId,
                      sourcePageIds: [page.id],
                      trigger: 'page_created',
                      quietPeriodMs: (await this.compileWindow.isEnabled(
                        entry.workspaceId,
                      ))
                        ? 0
                        : KNOWLEDGE_PAGE_COMPILE_QUIET_PERIOD_MS,
                    },
                    trx,
                  );
                  break;
                case 'watchers':
                  await this.general.add(
                    QueueJob.ADD_PAGE_WATCHERS,
                    {
                      userIds: [entry.userId],
                      pageId: page.id,
                      spaceId: page.spaceId,
                      workspaceId: entry.workspaceId,
                    },
                    options,
                  );
                  break;
                case 'audit':
                  await this.audit.logWithContext(
                    {
                      event: AuditEvent.PAGE_CREATED,
                      resourceType: AuditResource.PAGE,
                      resourceId: page.id,
                      spaceId: page.spaceId,
                      changes: {
                        after: { title: page.title, spaceId: page.spaceId },
                      },
                      metadata: {
                        source: 'weekly-report-skill',
                        eventId: entry.id,
                      },
                    },
                    { workspaceId: entry.workspaceId, actorId: entry.userId },
                  );
                  break;
              }
            }
            await trx
              .updateTable('weeklyReportOutbox')
              .set({ deliveredAt: new Date() })
              .where('id', '=', entry.id)
              .execute();
          } catch (error) {
            // SQL failures abort the transaction. Let the outer handler roll it back;
            // queue/service failures can safely checkpoint a delayed retry here.
            if ((error as any)?.code?.match?.(/^[0-9A-Z]{5}$/)) throw error;
            await trx
              .updateTable('weeklyReportOutbox')
              .set({
                attempts: entry.attempts + 1,
                availableAt: new Date(
                  Date.now() +
                    Math.min(300_000, 2000 * 2 ** Math.min(entry.attempts, 8)),
                ),
              })
              .where('id', '=', entry.id)
              .execute();
            this.logger.warn(
              `Weekly report ${entry.effect} delivery will retry (${entry.id})`,
            );
          }
          return true;
        });
        if (!processed) break;
      }
    } catch {
      this.logger.warn(
        'Weekly report outbox delivery deferred; it will retry on the next interval',
      );
    } finally {
      this.running = false;
    }
  }
}
