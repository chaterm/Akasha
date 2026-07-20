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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tsquery = require('pg-tsquery')();

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
  ): Promise<{ items: SearchResponseDto[] }> {
    const { query } = searchParams;

    if (query.length < 1) {
      return { items: [] };
    }
    const searchQuery = tsquery(query.trim() + '*');

    let queryResults = this.db
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
      .where(
        'tsv',
        '@@',
        sql<string>`to_tsquery('english', f_unaccent(${searchQuery}))`,
      )
      .$if(Boolean(searchParams.creatorId), (qb) =>
        qb.where('creatorId', '=', searchParams.creatorId),
      )
      .where('deletedAt', 'is', null)
      .orderBy('rank', 'desc')
      .limit(searchParams.limit || 25)
      .offset(searchParams.offset || 0);

    if (!searchParams.shareId) {
      queryResults = queryResults.select((eb) => this.pageRepo.withSpace(eb));
    }

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
        return { items: [] };
      }

      const isRestricted = await this.pagePermissionRepo.hasRestrictedAncestor(
        share.pageId,
      );
      if (isRestricted) {
        return { items: [] };
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
        return { items: [] };
      }
    } else {
      return { items: [] };
    }

    //@ts-ignore
    let results: any[] = await queryResults.execute();

    // Filter results by page-level permissions (if user is authenticated)
    if (opts.userId && results.length > 0) {
      const pageIds = results.map((r: any) => r.id);
      const accessibleIds =
        await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds,
          userId: opts.userId,
          spaceId: searchParams.spaceId,
        });
      const accessibleSet = new Set(accessibleIds);
      results = results.filter((r: any) => accessibleSet.has(r.id));
    }

    //@ts-ignore
    const searchResults = results.map((result: SearchResponseDto) => {
      if (result.highlight) {
        result.highlight = result.highlight
          .replace(/\r\n|\r|\n/g, ' ')
          .replace(/\s+/g, ' ');
      }
      return result;
    });

    return { items: searchResults };
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
}
