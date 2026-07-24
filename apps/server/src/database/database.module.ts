import { Global, Logger, Module, OnModuleInit } from '@nestjs/common';
import { InjectKysely, KyselyModule } from 'nestjs-kysely';
import { EnvironmentService } from '../integrations/environment/environment.service';
import { CamelCasePlugin, LogEvent, sql } from 'kysely';
import { GroupRepo } from '@akasha/db/repos/group/group.repo';
import { WorkspaceRepo } from '@akasha/db/repos/workspace/workspace.repo';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
import { GroupUserRepo } from '@akasha/db/repos/group/group-user.repo';
import { SpaceRepo } from '@akasha/db/repos/space/space.repo';
import { SpaceMemberRepo } from '@akasha/db/repos/space/space-member.repo';
import { PageRepo } from './repos/page/page.repo';
import { PagePermissionRepo } from './repos/page/page-permission.repo';
import { CommentRepo } from './repos/comment/comment.repo';
import { PageTransclusionsRepo } from './repos/page-transclusions/page-transclusions.repo';
import { PageTransclusionReferencesRepo } from './repos/page-transclusions/page-transclusion-references.repo';
import { PageHistoryRepo } from './repos/page/page-history.repo';
import { AttachmentRepo } from './repos/attachment/attachment.repo';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import * as process from 'node:process';
import { MigrationService } from '@akasha/db/services/migration.service';
import { UserTokenRepo } from './repos/user-token/user-token.repo';
import { UserSessionRepo } from '@akasha/db/repos/session/user-session.repo';
import { BacklinkRepo } from '@akasha/db/repos/backlink/backlink.repo';
import { ShareRepo } from '@akasha/db/repos/share/share.repo';
import { NotificationRepo } from '@akasha/db/repos/notification/notification.repo';
import { WatcherRepo } from '@akasha/db/repos/watcher/watcher.repo';
import { LabelRepo } from '@akasha/db/repos/label/label.repo';
import { FavoriteRepo } from '@akasha/db/repos/favorite/favorite.repo';
import { TemplateRepo } from '@akasha/db/repos/template/template.repo';
import { PageListener } from '@akasha/db/listeners/page.listener';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../common/helpers';
import { KnowledgeSourceRepo } from '@akasha/db/repos/llm-wiki/knowledge-source.repo';
import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeAccessPolicyRepo } from '@akasha/db/repos/llm-wiki/knowledge-access-policy.repo';
import { KnowledgeQueryAuditRepo } from '@akasha/db/repos/llm-wiki/knowledge-query-audit.repo';
import { KnowledgeQuarantineRepo } from '@akasha/db/repos/llm-wiki/knowledge-quarantine.repo';
import { KnowledgeCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-compilation.repo';
import { KnowledgeArtifactContributionRepo } from '@akasha/db/repos/llm-wiki/knowledge-artifact-contribution.repo';
import { KnowledgeSpaceCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-space-compilation.repo';
import { KnowledgeReviewApplicationRepo } from '@akasha/db/repos/llm-wiki/knowledge-review-application.repo';
import { KnowledgeReviewSnapshotRepo } from '@akasha/db/repos/llm-wiki/knowledge-review-snapshot.repo';
import { AiChatRepo } from '@akasha/db/repos/ai-chat/ai-chat.repo';

@Global()
@Module({
  imports: [
    KyselyModule.forRootAsync({
      imports: [],
      inject: [EnvironmentService],
      useFactory: (environmentService: EnvironmentService) => ({
        dialect: new PostgresJSDialect({
          postgres: postgres(
            normalizePostgresUrl(environmentService.getDatabaseURL()),
            {
              max: environmentService.getDatabaseMaxPool(),
              onnotice: () => {},
              types: {
                bigint: {
                  to: 20,
                  from: [20, 1700],
                  serialize: (value: number) => value.toString(),
                  parse: (value: string) => Number.parseInt(value),
                },
              },
            },
          ),
        }),
        plugins: [new CamelCasePlugin()],
        log: (event: LogEvent) => {
          if (environmentService.getNodeEnv() !== 'development') return;
          const logger = new Logger(DatabaseModule.name);
          if (process.env.DEBUG_DB?.toLowerCase() === 'true') {
            logger.debug(event.query.sql);
            logger.debug('query time: ' + event.queryDurationMillis + ' ms');
          }
        },
      }),
    }),
  ],
  providers: [
    MigrationService,
    WorkspaceRepo,
    UserRepo,
    GroupRepo,
    GroupUserRepo,
    SpaceRepo,
    SpaceMemberRepo,
    PageRepo,
    PagePermissionRepo,
    PageTransclusionsRepo,
    PageTransclusionReferencesRepo,
    PageHistoryRepo,
    CommentRepo,
    FavoriteRepo,
    AttachmentRepo,
    UserTokenRepo,
    UserSessionRepo,
    BacklinkRepo,
    ShareRepo,
    NotificationRepo,
    WatcherRepo,
    LabelRepo,
    TemplateRepo,
    KnowledgeSourceRepo,
    KnowledgeCapsuleRepo,
    KnowledgeAccessPolicyRepo,
    KnowledgeQueryAuditRepo,
    KnowledgeReviewApplicationRepo,
    KnowledgeReviewSnapshotRepo,
    KnowledgeQuarantineRepo,
    KnowledgeCompilationRepo,
    KnowledgeArtifactContributionRepo,
    KnowledgeSpaceCompilationRepo,
    AiChatRepo,
    PageListener,
  ],
  exports: [
    WorkspaceRepo,
    UserRepo,
    GroupRepo,
    GroupUserRepo,
    SpaceRepo,
    SpaceMemberRepo,
    PageRepo,
    PagePermissionRepo,
    PageTransclusionsRepo,
    PageTransclusionReferencesRepo,
    PageHistoryRepo,
    CommentRepo,
    FavoriteRepo,
    AttachmentRepo,
    UserTokenRepo,
    UserSessionRepo,
    BacklinkRepo,
    ShareRepo,
    NotificationRepo,
    WatcherRepo,
    LabelRepo,
    TemplateRepo,
    KnowledgeSourceRepo,
    KnowledgeCapsuleRepo,
    KnowledgeAccessPolicyRepo,
    KnowledgeQueryAuditRepo,
    KnowledgeReviewApplicationRepo,
    KnowledgeReviewSnapshotRepo,
    KnowledgeQuarantineRepo,
    KnowledgeCompilationRepo,
    KnowledgeArtifactContributionRepo,
    KnowledgeSpaceCompilationRepo,
    AiChatRepo,
  ],
})
export class DatabaseModule implements OnModuleInit {
  private readonly logger = new Logger(DatabaseModule.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly migrationService: MigrationService,
    private readonly environmentService: EnvironmentService,
  ) {}

  async onModuleInit() {
    await this.establishConnection();

    if (this.environmentService.getNodeEnv() === 'production') {
      await this.migrationService.migrateToLatest();
    }
  }

  async establishConnection() {
    const retryAttempts = 15;
    const retryDelay = 3000;

    this.logger.log('Establishing database connection');
    for (let i = 0; i < retryAttempts; i++) {
      try {
        await sql`SELECT 1=1`.execute(this.db);
        this.logger.log('Database connection successful');
        break;
      } catch (err) {
        if (err['errors']) {
          this.logger.error(err['errors'][0]);
        } else {
          this.logger.error(err);
        }

        if (i < retryAttempts - 1) {
          this.logger.log(
            `Retrying [${i + 1}/${retryAttempts}] in ${retryDelay / 1000} seconds`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        } else {
          this.logger.error(
            `Failed to connect to database after ${retryAttempts} attempts. Exiting...`,
          );
          process.exit(1);
        }
      }
    }
  }
}
