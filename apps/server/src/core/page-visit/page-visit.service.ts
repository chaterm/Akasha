import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PageVisitRepo } from '@akasha/db/repos/page/page-visit.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { PagePermissionRepo } from '@akasha/db/repos/page/page-permission.repo';
import { PageAccessService } from '../page/page-access/page-access.service';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import { User, Workspace } from '@akasha/db/types/entity.types';
import { UserRole } from '../../common/helpers/types/permission';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../casl/interfaces/space-ability.type';

const RETENTION_DAYS = 30;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

function retentionCutoff(): Date {
  return new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

@Injectable()
export class PageVisitService {
  private readonly logger = new Logger(PageVisitService.name);

  constructor(
    private readonly pageVisitRepo: PageVisitRepo,
    private readonly pageRepo: PageRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly pageAccessService: PageAccessService,
    private readonly spaceAbility: SpaceAbilityFactory,
  ) {}

  async record(
    pageId: string,
    user: User,
    workspace: Workspace,
  ): Promise<void> {
    const page = await this.pageRepo.findById(pageId);

    if (!page || page.deletedAt || page.workspaceId !== workspace.id) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanView(page, user);
    await this.pageVisitRepo.upsert({
      workspaceId: workspace.id,
      userId: user.id,
      pageId: page.id,
    });
  }

  async findRecent(input: {
    user: User;
    workspace: Workspace;
    spaceId?: string;
    limit: number;
  }) {
    const candidateLimit = Math.min(Math.max(input.limit * 5, 50), 100);
    const candidates = await this.pageVisitRepo.findRecent({
      workspaceId: input.workspace.id,
      userId: input.user.id,
      cutoff: retentionCutoff(),
      spaceId: input.spaceId,
      limit: candidateLimit,
    });

    if (candidates.length === 0) return { items: [] };

    let readableSpaceIds = new Set(candidates.map((item) => item.spaceId));
    let readablePageIds = new Set(candidates.map((item) => item.pageId));

    if (input.user.role !== UserRole.OWNER) {
      const spaceIds = [...readableSpaceIds];
      const spaceChecks = await Promise.all(
        spaceIds.map(async (spaceId) => {
          try {
            const ability = await this.spaceAbility.createForUser(
              input.user,
              spaceId,
            );
            return ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)
              ? null
              : spaceId;
          } catch (error) {
            // Visit history can outlive the user's space membership.
            if (error instanceof NotFoundException) return null;
            throw error;
          }
        }),
      );
      readableSpaceIds = new Set(spaceChecks.filter(Boolean) as string[]);

      if (readableSpaceIds.size === 0) return { items: [] };

      const accessibleIds =
        await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds: candidates
            .filter((item) => readableSpaceIds.has(item.spaceId))
            .map((item) => item.pageId),
          userId: input.user.id,
          spaceId: input.spaceId,
        });
      readablePageIds = new Set(accessibleIds);
    }

    const items = candidates
      .filter(
        (item) =>
          readableSpaceIds.has(item.spaceId) &&
          readablePageIds.has(item.pageId),
      )
      .slice(0, input.limit)
      .map((item) => ({
        id: item.id,
        pageId: item.pageId,
        lastVisitedAt: item.lastVisitedAt,
        page: {
          title: item.title,
          icon: item.icon,
          slugId: item.slugId,
        },
        space: {
          id: item.spaceId,
          name: item.spaceName,
          slug: item.spaceSlug,
          logo: item.spaceLogo,
        },
      }));

    return { items };
  }

  @Interval('page-visit-cleanup', CLEANUP_INTERVAL_MS)
  async cleanupExpiredVisits(): Promise<void> {
    try {
      const deleted =
        await this.pageVisitRepo.deleteOlderThan(retentionCutoff());
      if (deleted > 0) {
        this.logger.log(`Deleted ${deleted} expired page visit records`);
      }
    } catch (error) {
      this.logger.error('Failed to clean up expired page visits', error);
    }
  }
}
