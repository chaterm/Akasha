import { Injectable } from '@nestjs/common';
import { SearchDTO, SearchSuggestionDTO } from './dto/search.dto';
import { SearchResponseDto } from './dto/search-response.dto';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import { sql } from 'kysely';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@akasha/db/repos/space/space-member.repo';
import { ShareRepo } from '@akasha/db/repos/share/share.repo';
import { PagePermissionRepo } from '@akasha/db/repos/page/page-permission.repo';
import { UserRole } from '../../common/helpers/types/permission';
import { LabelType } from '@akasha/db/repos/label/label.repo';

// 页面搜索最多返回的结果数（按相关度取前 N 条），再多对用户没有意义
const MAX_PAGE_SEARCH_RESULTS = 500;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tsquery = require('pg-tsquery')();

function hasLabelFilters(searchParams: SearchDTO) {
  return Boolean(
    searchParams.labelIds?.length || searchParams.labelNames?.length,
  );
}

function modifiedToUpperBound(value: string) {
  const date = new Date(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return date;
}

@Injectable()
export class SearchService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private pageRepo: PageRepo,
    private shareRepo: ShareRepo,
    private spaceMemberRepo: SpaceMemberRepo,
    private pagePermissionRepo: PagePermissionRepo,
  ) {}

  async searchPage(
    searchParams: SearchDTO,
    opts: {
      userId?: string;
      workspaceId: string;
    },
  ): Promise<{ items: SearchResponseDto[]; total: number }> {
    const { query } = searchParams;

    if (query.length < 1) {
      return { items: [], total: 0 };
    }
    const searchQuery = tsquery(query.trim() + '*');
    const limit = searchParams.limit || 50;
    const offset = searchParams.offset || 0;

    // 第一阶段只取相关度最高的前 500 个命中 id + rank：权限过滤后得到准确总数，
    // 再按 offset/limit 切出当前页，避免对全部结果计算 ts_headline。
    let queryResults = this.db
      .selectFrom('pages')
      .select([
        'id',
        sql<number>`ts_rank(tsv, to_tsquery('english', f_unaccent(${searchQuery})))`.as(
          'rank',
        ),
      ])
      .where((eb) =>
        searchParams.titleOnly
          ? eb(
              sql`LOWER(f_unaccent(pages.title))`,
              'like',
              sql`LOWER(f_unaccent(${`%${query.trim()}%`}))`,
            )
          : eb.or([
              eb(
                'tsv',
                '@@',
                sql<string>`to_tsquery('english', f_unaccent(${searchQuery}))`,
              ),
              eb(
                sql`LOWER(f_unaccent(pages.title))`,
                'like',
                sql`LOWER(f_unaccent(${`%${query.trim()}%`}))`,
              ),
              eb(
                sql`LOWER(f_unaccent(pages.text_content))`,
                'like',
                sql`LOWER(f_unaccent(${`%${query.trim()}%`}))`,
              ),
            ]),
      )
      .$if(Boolean(searchParams.creatorId), (qb) =>
        qb.where('creatorId', '=', searchParams.creatorId),
      )
      .$if(Boolean(searchParams.modifiedFrom), (qb) =>
        qb.where('updatedAt', '>=', new Date(searchParams.modifiedFrom!)),
      )
      .$if(Boolean(searchParams.modifiedTo), (qb) =>
        qb.where(
          'updatedAt',
          '<',
          modifiedToUpperBound(searchParams.modifiedTo!),
        ),
      )
      .$if(hasLabelFilters(searchParams), (qb) =>
        qb.where(
          sql<boolean>`exists (
            select 1
            from page_labels pl
            inner join labels l on l.id = pl.label_id
            where pl.page_id = pages.id
              and l.workspace_id = ${opts.workspaceId}
              and l.type = ${LabelType.PAGE}
              and (
                ${searchParams.labelIds?.length ? sql`l.id in (${sql.join(searchParams.labelIds.map((id) => sql`${id}`))})` : sql`false`}
                or
                ${searchParams.labelNames?.length ? sql`l.name in (${sql.join(searchParams.labelNames.map((name) => sql`${name}`))})` : sql`false`}
              )
          )`,
        ),
      )
      .where('deletedAt', 'is', null)
      .orderBy('rank', 'desc')
      .orderBy('id', 'asc')
      .limit(MAX_PAGE_SEARCH_RESULTS);

    if (searchParams.spaceId) {
      // search by spaceId
      queryResults = queryResults.where('spaceId', '=', searchParams.spaceId);
    } else if (opts.userId && !searchParams.spaceId) {
      // only search spaces the user is a member of
      queryResults = queryResults
        .where(
          'spaceId',
          'in',
          this.spaceMemberRepo.getUserSpaceIdsQuery(opts.userId),
        )
        .where('workspaceId', '=', opts.workspaceId);
    } else if (searchParams.shareId && !searchParams.spaceId && !opts.userId) {
      // search in shares
      const shareId = searchParams.shareId;
      const share = await this.shareRepo.findById(shareId);
      if (!share || share.workspaceId !== opts.workspaceId) {
        return { items: [], total: 0 };
      }

      const isRestricted = await this.pagePermissionRepo.hasRestrictedAncestor(
        share.pageId,
      );
      if (isRestricted) {
        return { items: [], total: 0 };
      }

      const pageIdsToSearch = [];
      if (share.includeSubPages) {
        const pageList =
          await this.pageRepo.getPageAndDescendantsExcludingRestricted(
            share.pageId,
            {
              includeContent: false,
            },
          );

        pageIdsToSearch.push(...pageList.map((page) => page.id));
      } else {
        pageIdsToSearch.push(share.pageId);
      }

      if (pageIdsToSearch.length > 0) {
        queryResults = queryResults
          .where('id', 'in', pageIdsToSearch)
          .where('workspaceId', '=', opts.workspaceId);
      } else {
        return { items: [], total: 0 };
      }
    } else {
      return { items: [], total: 0 };
    }

    let candidates = await queryResults.execute();

    // Filter results by page-level permissions (if user is authenticated)
    if (opts.userId && candidates.length > 0) {
      const accessibleIds =
        await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds: candidates.map((r) => r.id),
          userId: opts.userId,
          spaceId: searchParams.spaceId,
        });
      const accessibleSet = new Set(accessibleIds);
      candidates = candidates.filter((r) => accessibleSet.has(r.id));
    }

    const total = candidates.length;
    const pageIds = candidates
      .slice(offset, offset + limit)
      .map((r) => r.id);
    if (pageIds.length === 0) {
      return { items: [], total };
    }

    // 第二阶段：只为当前页取详情和高亮片段
    let detailQuery = this.db
      .selectFrom('pages')
      .select([
        'id',
        'slugId',
        'title',
        'icon',
        'parentPageId',
        'creatorId',
        'createdAt',
        'updatedAt',
        sql<number>`ts_rank(tsv, to_tsquery('english', f_unaccent(${searchQuery})))`.as(
          'rank',
        ),
        sql<string>`ts_headline('english', text_content, to_tsquery('english', f_unaccent(${searchQuery})),'MinWords=9, MaxWords=10, MaxFragments=3')`.as(
          'highlight',
        ),
      ])
      .where('id', 'in', pageIds);

    if (!searchParams.shareId) {
      detailQuery = detailQuery.select((eb) => this.pageRepo.withSpace(eb));
    }

    const details: any[] = await detailQuery.execute();
    const detailById = new Map(details.map((d) => [d.id, d]));

    const searchResults = pageIds
      .map((id) => detailById.get(id))
      .filter(Boolean)
      .map((result: SearchResponseDto) => {
        if (result.highlight) {
          result.highlight = result.highlight
            .replace(/\r\n|\r|\n/g, ' ')
            .replace(/\s+/g, ' ');
        }
        return result;
      });

    return { items: searchResults, total };
  }

  async searchAttachments(
    searchParams: SearchDTO,
    opts: {
      userId: string;
      userRole: string | null;
      workspaceId: string;
    },
  ) {
    const query = searchParams.query.trim();
    if (!query) {
      return { items: [] };
    }

    const limit = searchParams.limit || 25;
    const offset = searchParams.offset || 0;
    // 有上限地多取候选结果，以复用现有页面权限过滤；
    // 仅当受限页面经常导致结果不足时再改为 SQL 过滤。
    const candidateLimit = Math.min((offset + limit) * 5, 500);

    let attachmentsQuery = this.db
      .selectFrom('attachments')
      .innerJoin('pages', 'pages.id', 'attachments.pageId')
      .innerJoin('spaces', 'spaces.id', 'pages.spaceId')
      .select([
        'attachments.id',
        'attachments.fileName',
        'attachments.pageId',
        'attachments.creatorId',
        'attachments.createdAt',
        'attachments.updatedAt',
        'spaces.id as spaceId',
        'spaces.name as spaceName',
        'spaces.slug as spaceSlug',
        'spaces.logo as spaceIcon',
        'pages.title as pageTitle',
        'pages.slugId as pageSlugId',
      ])
      .where('attachments.workspaceId', '=', opts.workspaceId)
      .where('attachments.deletedAt', 'is', null)
      .where('attachments.type', '=', 'file')
      .where('pages.workspaceId', '=', opts.workspaceId)
      .where('pages.deletedAt', 'is', null)
      .where('attachments.fileName', 'ilike', `%${query}%`)
      .$if(Boolean(searchParams.creatorId), (qb) =>
        qb.where('attachments.creatorId', '=', searchParams.creatorId),
      )
      .$if(Boolean(searchParams.modifiedFrom), (qb) =>
        qb.where(
          'attachments.updatedAt',
          '>=',
          new Date(searchParams.modifiedFrom!),
        ),
      )
      .$if(Boolean(searchParams.modifiedTo), (qb) =>
        qb.where(
          'attachments.updatedAt',
          '<',
          modifiedToUpperBound(searchParams.modifiedTo!),
        ),
      )
      .$if(hasLabelFilters(searchParams), (qb) =>
        qb.where(
          sql<boolean>`exists (
            select 1
            from page_labels pl
            inner join labels l on l.id = pl.label_id
            where pl.page_id = pages.id
              and l.workspace_id = ${opts.workspaceId}
              and l.type = ${LabelType.PAGE}
              and (
                ${searchParams.labelIds?.length ? sql`l.id in (${sql.join(searchParams.labelIds.map((id) => sql`${id}`))})` : sql`false`}
                or
                ${searchParams.labelNames?.length ? sql`l.name in (${sql.join(searchParams.labelNames.map((name) => sql`${name}`))})` : sql`false`}
              )
          )`,
        ),
      )
      .orderBy('attachments.fileName', 'asc')
      .limit(candidateLimit);

    if (searchParams.spaceId) {
      attachmentsQuery = attachmentsQuery.where(
        'pages.spaceId',
        '=',
        searchParams.spaceId,
      );
    } else if (opts.userRole !== UserRole.OWNER) {
      attachmentsQuery = attachmentsQuery.where(
        'pages.spaceId',
        'in',
        this.spaceMemberRepo.getUserSpaceIdsQuery(opts.userId),
      );
    }

    const candidates = await attachmentsQuery.execute();
    if (candidates.length === 0) {
      return { items: [] };
    }

    let accessibleSet: Set<string> | undefined;
    if (opts.userRole !== UserRole.OWNER) {
      const pageIds = [...new Set(candidates.map((item) => item.pageId))];
      const accessiblePageIds =
        await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds,
          userId: opts.userId,
          spaceId: searchParams.spaceId,
        });
      accessibleSet = new Set(accessiblePageIds);
    }

    const items = candidates
      .filter((item) => !accessibleSet || accessibleSet.has(item.pageId))
      .slice(offset, offset + limit)
      .map((item) => ({
        id: item.id,
        fileName: item.fileName,
        pageId: item.pageId,
        creatorId: item.creatorId,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        rank: 0,
        highlight: '',
        space: {
          id: item.spaceId,
          name: item.spaceName,
          slug: item.spaceSlug,
          icon: item.spaceIcon,
        },
        page: {
          id: item.pageId,
          title: item.pageTitle,
          slugId: item.pageSlugId,
        },
      }));

    return { items };
  }

  async searchSuggestions(
    suggestion: SearchSuggestionDTO,
    userId: string,
    workspaceId: string,
  ) {
    let users = [];
    let groups = [];
    let pages = [];

    const limit = suggestion?.limit || 10;
    const query = suggestion.query.toLowerCase().trim();

    if (suggestion.includeUsers) {
      const userQuery = this.db
        .selectFrom('users')
        .select(['id', 'name', 'email', 'avatarUrl'])
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .where((eb) =>
          eb.or([
            eb(
              sql`LOWER(f_unaccent(users.name))`,
              'like',
              sql`LOWER(f_unaccent(${`%${query}%`}))`,
            ),
            eb(sql`users.email`, 'ilike', sql`f_unaccent(${`%${query}%`})`),
          ]),
        )
        .limit(limit);

      users = await userQuery.execute();
    }

    if (suggestion.includeGroups) {
      groups = await this.db
        .selectFrom('groups')
        .select(['id', 'name', 'description'])
        .where((eb) =>
          eb(
            sql`LOWER(f_unaccent(groups.name))`,
            'like',
            sql`LOWER(f_unaccent(${`%${query}%`}))`,
          ),
        )
        .where('workspaceId', '=', workspaceId)
        .limit(limit)
        .execute();
    }

    if (suggestion.includePages) {
      let pageSearch = this.db
        .selectFrom('pages')
        .select(['id', 'slugId', 'title', 'icon', 'spaceId'])
        .select((eb) => this.pageRepo.withSpace(eb))
        .where((eb) =>
          eb(
            sql`LOWER(f_unaccent(pages.title))`,
            'like',
            sql`LOWER(f_unaccent(${`%${query}%`}))`,
          ),
        )
        .where('deletedAt', 'is', null)
        .where('workspaceId', '=', workspaceId)
        .limit(limit);

      // search all spaces the user has access to, prioritizing the current space
      const userSpaceIds = await this.spaceMemberRepo.getUserSpaceIds(userId);

      if (userSpaceIds?.length > 0) {
        pageSearch = pageSearch.where('spaceId', 'in', userSpaceIds);

        if (suggestion?.spaceId) {
          pageSearch = pageSearch.orderBy(
            sql`CASE WHEN pages."space_id" = ${suggestion.spaceId} THEN 0 ELSE 1 END`,
            'asc',
          );
        }

        pages = await pageSearch.execute();
      }

      // Filter by page-level permissions
      if (pages.length > 0) {
        const pageIds = pages.map((p) => p.id);
        const accessibleIds =
          await this.pagePermissionRepo.filterAccessiblePageIds({
            pageIds,
            userId,
          });
        const accessibleSet = new Set(accessibleIds);
        pages = pages.filter((p) => accessibleSet.has(p.id));
      }
    }

    return { users, groups, pages };
  }

  /**
   * Title, icon and link of the given pages, limited to the ones the user can
   * read: same workspace, not deleted, in a space they belong to, and allowed
   * by page-level permissions. Pages they cannot see are simply left out.
   */
  async resolvePages(pageIds: string[], userId: string, workspaceId: string) {
    const ids = [...new Set(pageIds)];
    if (!ids.length) return { pages: [] };
    const spaceIds = await this.spaceMemberRepo.getUserSpaceIds(userId);
    if (!spaceIds?.length) return { pages: [] };

    const pages = await this.db
      .selectFrom('pages')
      .select(['id', 'slugId', 'title', 'icon', 'spaceId'])
      .select((eb) => this.pageRepo.withSpace(eb))
      .where('id', 'in', ids)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .where('spaceId', 'in', spaceIds)
      .execute();
    if (!pages.length) return { pages: [] };

    const accessible = new Set(
      await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds: pages.map((page) => page.id),
        userId,
      }),
    );
    return { pages: pages.filter((page) => accessible.has(page.id)) };
  }
}
