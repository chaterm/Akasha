import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import {
  CursorPaginationResult,
  executeWithCursorPagination,
} from '@akasha/db/pagination/cursor-pagination';

export interface RecentPageVisitRow {
  id: string;
  pageId: string;
  lastVisitedAt: Date;
  title: string | null;
  icon: string | null;
  slugId: string;
  spaceId: string;
  spaceName: string | null;
  spaceSlug: string;
  spaceLogo: string | null;
}

@Injectable()
export class PageVisitRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async upsert(input: {
    workspaceId: string;
    userId: string;
    pageId: string;
    visitedAt?: Date;
  }): Promise<void> {
    const lastVisitedAt = input.visitedAt ?? new Date();

    await this.db
      .insertInto('pageVisits')
      .values({
        workspaceId: input.workspaceId,
        userId: input.userId,
        pageId: input.pageId,
        lastVisitedAt,
      })
      .onConflict((oc) =>
        oc.columns(['userId', 'pageId']).doUpdateSet({
          lastVisitedAt: sql<Date>`greatest(page_visits.last_visited_at, excluded.last_visited_at)`,
        }),
      )
      .execute();
  }

  async findRecent(input: {
    workspaceId: string;
    userId: string;
    cutoff: Date;
    spaceId?: string;
    limit: number;
    cursor?: string;
  }): Promise<CursorPaginationResult<RecentPageVisitRow, true>> {
    let query = this.db
      .selectFrom('pageVisits')
      .innerJoin('pages', 'pages.id', 'pageVisits.pageId')
      .innerJoin('spaces', 'spaces.id', 'pages.spaceId')
      .select([
        'pageVisits.id',
        'pageVisits.pageId',
        'pageVisits.lastVisitedAt',
        'pages.title',
        'pages.icon',
        'pages.slugId',
        'pages.spaceId',
        'spaces.name as spaceName',
        'spaces.slug as spaceSlug',
        'spaces.logo as spaceLogo',
      ])
      .where('pageVisits.workspaceId', '=', input.workspaceId)
      .where('pageVisits.userId', '=', input.userId)
      .where('pageVisits.lastVisitedAt', '>=', input.cutoff)
      .where('pages.deletedAt', 'is', null)
      .where('spaces.deletedAt', 'is', null);

    if (input.spaceId) {
      query = query.where('pages.spaceId', '=', input.spaceId);
    }

    return executeWithCursorPagination(query, {
      perPage: input.limit,
      cursor: input.cursor,
      cursorPerRow: true,
      fields: [
        { expression: 'pageVisits.lastVisitedAt', direction: 'desc' },
        { expression: 'pageVisits.id', direction: 'desc' },
      ],
      parseCursor: (cursor) => ({
        lastVisitedAt: new Date(cursor.lastVisitedAt),
        id: cursor.id,
      }),
    });
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const result = await this.db
      .deleteFrom('pageVisits')
      .where('lastVisitedAt', '<', cutoff)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0);
  }
}
