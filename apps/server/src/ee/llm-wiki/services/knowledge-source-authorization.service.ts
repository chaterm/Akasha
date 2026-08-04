import { Injectable } from '@nestjs/common';
import { PagePermissionRepo } from '@akasha/db/repos/page/page-permission.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
import { UserRole } from '../../../common/helpers/types/permission';
import { SpaceAuthorizationService } from '../../../core/space/services/space-authorization.service';
import { KnowledgeAuthorizationCache } from './knowledge-source-authorization.cache';

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
    // Optional request-scoped cache. When provided it MUST be bound to the same
    // (workspaceId, userId) — a mismatch fails closed. See KnowledgeAuthorizationCache.
    cache?: KnowledgeAuthorizationCache;
  }): Promise<string[]> {
    if (input.sourcePageIds.length === 0) return [];

    const cache = input.cache;
    try {
      // Scope guard inside the try so a mismatch degrades to "nothing readable".
      cache?.assertScope(input.workspaceId, input.userId);

      // Serve fully-cached page decisions without any query.
      const { knownReadable, unknown } = cache
        ? cache.partitionPages(input.sourcePageIds)
        : { knownReadable: new Set<string>(), unknown: input.sourcePageIds };
      if (unknown.length === 0) {
        return input.sourcePageIds.filter((pageId) =>
          knownReadable.has(pageId),
        );
      }

      const readable = new Set<string>(knownReadable);
      const freshlyReadable = await this.resolveReadable({
        workspaceId: input.workspaceId,
        userId: input.userId,
        pageIds: unknown,
        cache,
      });
      freshlyReadable.forEach((pageId) => readable.add(pageId));

      return input.sourcePageIds.filter((pageId) => readable.has(pageId));
    } catch {
      return [];
    }
  }

  /**
   * Resolves readability for the given (already de-duplicated, uncached) page
   * ids. Records page-level decisions into the cache only after all dependency
   * queries have succeeded, so a partial/failed computation never writes results.
   */
  private async resolveReadable(input: {
    workspaceId: string;
    userId: string;
    pageIds: string[];
    cache?: KnowledgeAuthorizationCache;
  }): Promise<Set<string>> {
    const cache = input.cache;

    const pages = await this.pageRepo.findExistingPageRefs({
      workspaceId: input.workspaceId,
      pageIds: input.pageIds,
    });
    const existingPages = pages.filter((page) => page.deletedAt === null);

    // Missing/deleted pages are a definitive "not readable" decision — cache it
    // so repeated lookups within the request skip the query.
    if (existingPages.length === 0) {
      cache?.recordPages(input.pageIds, new Set());
      return new Set();
    }

    const user = cache
      ? await cache.getUser(() =>
          this.userRepo.findById(input.userId, input.workspaceId),
        )
      : await this.userRepo.findById(input.userId, input.workspaceId);
    if (!user) {
      // No user: definitive not-readable for every queried id.
      cache?.recordPages(input.pageIds, new Set());
      return new Set();
    }

    if (user.role === UserRole.OWNER) {
      const readable = new Set(existingPages.map((page) => page.id));
      // Owners can read every existing page; missing ids stay unreadable.
      cache?.recordPages(input.pageIds, readable);
      return readable;
    }

    const readableSpaceIds = await this.resolveReadableSpaceIds({
      user,
      spaceIds: unique(existingPages.map((page) => page.spaceId)),
      cache,
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

    // All queries succeeded: record a decision for every queried id (readable or
    // not), so both hits and misses are memoized.
    cache?.recordPages(input.pageIds, readable);
    return readable;
  }

  /**
   * Resolves space readability, reusing the request-scoped cache. Only the spaces
   * not already decided are sent to SpaceAuthorizationService.
   */
  private async resolveReadableSpaceIds(input: {
    user: { id: string; role: string; workspaceId: string };
    spaceIds: string[];
    cache?: KnowledgeAuthorizationCache;
  }): Promise<string[]> {
    const cache = input.cache;
    if (!cache) {
      return this.spaceAuthorization.filterReadableSpaceIds({
        user: input.user,
        spaceIds: input.spaceIds,
      });
    }

    const { knownReadable, unknown } = cache.partitionSpaces(input.spaceIds);
    if (unknown.length === 0) {
      return [...knownReadable];
    }

    const freshReadable = await this.spaceAuthorization.filterReadableSpaceIds({
      user: input.user,
      spaceIds: unknown,
    });
    cache.recordSpaces(unknown, new Set(freshReadable));
    return [...knownReadable, ...freshReadable];
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
