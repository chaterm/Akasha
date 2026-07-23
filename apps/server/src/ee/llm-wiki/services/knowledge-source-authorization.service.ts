import { Injectable } from '@nestjs/common';
import { PagePermissionRepo } from '@akasha/db/repos/page/page-permission.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
import { UserRole } from '../../../common/helpers/types/permission';
import { SpaceAuthorizationService } from '../../../core/space/services/space-authorization.service';

@Injectable()
export class KnowledgeSourceAuthorizationService {
  constructor(
    private readonly pageRepo: PageRepo,
    private readonly userRepo: UserRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly spaceAuthorization: SpaceAuthorizationService,
  ) {}

  async filterReadableSources(input: {
    workspaceId: string;
    userId: string;
    sourcePageIds: string[];
  }): Promise<string[]> {
    if (input.sourcePageIds.length === 0) return [];

    try {
      const pages = await this.pageRepo.findExistingPageRefs({
        workspaceId: input.workspaceId,
        pageIds: input.sourcePageIds,
      });
      const existingPages = pages.filter((page) => page.deletedAt === null);

      if (existingPages.length === 0) {
        return [];
      }

      const user = await this.userRepo.findById(input.userId, input.workspaceId);
      if (!user) {
        return [];
      }

      if (user.role === UserRole.OWNER) {
        return existingPages.map((page) => page.id);
      }

      const readableSpaceIds =
        await this.spaceAuthorization.filterReadableSpaceIds({
          user,
          spaceIds: unique(existingPages.map((page) => page.spaceId)),
        });
      const readableSpaceSet = new Set(readableSpaceIds);
      const pagesInReadableSpaces = existingPages.filter((page) =>
        readableSpaceSet.has(page.spaceId),
      );

      const readable = new Set<string>();
      for (const [spaceId, spacePages] of groupBy(
        pagesInReadableSpaces,
        (page) => page.spaceId,
      )) {
        const allowedPageIds =
          await this.pagePermissionRepo.filterAccessiblePageIds({
            pageIds: spacePages.map((page) => page.id),
            userId: input.userId,
            spaceId,
          });
        allowedPageIds.forEach((pageId) => readable.add(pageId));
      }

      return input.sourcePageIds.filter((pageId) => readable.has(pageId));
    } catch {
      return [];
    }
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function groupBy<T>(
  values: T[],
  keyOf: (value: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = grouped.get(key) ?? [];
    group.push(value);
    grouped.set(key, group);
  }
  return grouped;
}
