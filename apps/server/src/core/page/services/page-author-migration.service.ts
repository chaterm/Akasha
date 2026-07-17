import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import { UpdatablePage } from '@akasha/db/types/entity.types';
import { RestorePageAuthorItemDto } from '../dto/restore-page-authors.dto';

type PageAuthorMigrationResult =
  | { pageId: string; status: 'updated' | 'unchanged' }
  | { pageId: string; status: 'skipped'; reason: 'page_not_found' }
  | { pageId: string; status: 'failed'; error: string };

type AuthorTarget = {
  userId?: string;
  name?: string;
};

@Injectable()
export class PageAuthorMigrationService {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async restorePageAuthors(
    items: RestorePageAuthorItemDto[],
    workspaceId: string,
  ): Promise<{ results: PageAuthorMigrationResult[] }> {
    if (items.length === 0) {
      return { results: [] };
    }

    const pageIds = unique(items.map((item) => item.pageId));
    const taskIds = unique(items.map((item) => item.importTaskId));
    const userIds = unique(
      items.flatMap((item) =>
        [item.creatorUserId, item.lastUpdatedByUserId].filter(Boolean),
      ) as string[],
    );

    const [pages, fileTasks, users] = await Promise.all([
      this.db
        .selectFrom('pages')
        .select([
          'id',
          'workspaceId',
          'spaceId',
          'creatorId',
          'lastUpdatedById',
          'sourceCreatorName',
          'sourceLastUpdatedByName',
        ])
        .where('id', 'in', pageIds)
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .execute(),
      this.db
        .selectFrom('fileTasks')
        .select([
          'id',
          'workspaceId',
          'spaceId',
          'type',
          'source',
          'status',
        ])
        .where('id', 'in', taskIds)
        .execute(),
      userIds.length > 0
        ? this.db
            .selectFrom('users')
            .select(['id', 'workspaceId', 'deletedAt'])
            .where('id', 'in', userIds)
            .execute()
        : Promise.resolve([]),
    ]);

    const pagesById = new Map(pages.map((page) => [page.id, page]));
    const tasksById = new Map(fileTasks.map((task) => [task.id, task]));
    const usersById = new Map(users.map((user) => [user.id, user]));
    const results: PageAuthorMigrationResult[] = [];

    for (const item of items) {
      const page = pagesById.get(item.pageId);
      if (!page) {
        results.push({
          pageId: item.pageId,
          status: 'skipped',
          reason: 'page_not_found',
        });
        continue;
      }

      const task = tasksById.get(item.importTaskId);
      if (
        !task ||
        task.workspaceId !== workspaceId ||
        task.spaceId !== page.spaceId ||
        task.type !== 'import' ||
        task.source !== 'confluence' ||
        task.status !== 'success'
      ) {
        results.push({
          pageId: item.pageId,
          status: 'failed',
          error: 'invalid_import_task',
        });
        continue;
      }

      const creator = this.resolveTarget(
        item.creatorUserId,
        item.creatorName,
        'invalid_creator',
      );
      if ('error' in creator) {
        results.push({
          pageId: item.pageId,
          status: 'failed',
          error: creator.error,
        });
        continue;
      }

      const lastUpdatedBy = this.resolveTarget(
        item.lastUpdatedByUserId,
        item.lastUpdatedByName,
        'invalid_last_updated_by',
      );
      if ('error' in lastUpdatedBy) {
        results.push({
          pageId: item.pageId,
          status: 'failed',
          error: lastUpdatedBy.error,
        });
        continue;
      }

      const requestedUserIds = [creator.userId, lastUpdatedBy.userId].filter(
        Boolean,
      ) as string[];
      const invalidUser = requestedUserIds.some((userId) => {
        const user = usersById.get(userId);
        return (
          !user ||
          user.workspaceId !== workspaceId ||
          user.deletedAt !== null
        );
      });
      if (invalidUser) {
        results.push({
          pageId: item.pageId,
          status: 'failed',
          error: 'user_not_found',
        });
        continue;
      }

      const patch: UpdatablePage = {};
      this.applyTarget(
        patch,
        page,
        creator,
        'creatorId',
        'sourceCreatorName',
      );
      this.applyTarget(
        patch,
        page,
        lastUpdatedBy,
        'lastUpdatedById',
        'sourceLastUpdatedByName',
      );

      if (Object.keys(patch).length === 0) {
        results.push({ pageId: item.pageId, status: 'unchanged' });
        continue;
      }

      await this.db
        .updateTable('pages')
        .set(patch)
        .where('id', '=', page.id)
        .where('workspaceId', '=', workspaceId)
        .executeTakeFirst();
      Object.assign(page, patch);
      results.push({ pageId: item.pageId, status: 'updated' });
    }

    return { results };
  }

  private resolveTarget(
    userId: string | undefined,
    sourceName: string | undefined,
    error: string,
  ): AuthorTarget | { error: string } {
    if (userId && sourceName !== undefined) {
      return { error };
    }

    if (sourceName !== undefined) {
      const name = sourceName.trim();
      if (!name || name.length > 255) {
        return { error };
      }
      return { name };
    }

    return userId ? { userId } : {};
  }

  private applyTarget(
    patch: UpdatablePage,
    page: {
      creatorId: string | null;
      lastUpdatedById: string | null;
      sourceCreatorName: string | null;
      sourceLastUpdatedByName: string | null;
    },
    target: AuthorTarget,
    userIdField: 'creatorId' | 'lastUpdatedById',
    nameField: 'sourceCreatorName' | 'sourceLastUpdatedByName',
  ) {
    if (target.userId) {
      if (page[userIdField] !== target.userId) {
        patch[userIdField] = target.userId;
      }
      if (page[nameField] !== null) {
        patch[nameField] = null;
      }
      return;
    }

    if (target.name && page[nameField] !== target.name) {
      patch[nameField] = target.name;
    }
  }
}

function unique(values: string[]) {
  return [...new Set(values)];
}
