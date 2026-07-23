import { SearchService } from './search.service';
import { UserRole } from '../../common/helpers/types/permission';

describe('SearchService attachment search', () => {
  it('returns only attachments whose pages the user can access', async () => {
    const rows = [
      attachmentRow('attachment-visible', 'page-visible'),
      attachmentRow('attachment-hidden', 'page-hidden'),
    ];
    const query = fluentQuery(rows);
    const spaceMemberRepo = {
      getUserSpaceIdsQuery: jest.fn().mockReturnValue('readable-space-ids'),
    };
    const pagePermissionRepo = {
      filterAccessiblePageIds: jest.fn().mockResolvedValue(['page-visible']),
    };
    const service = new SearchService(
      { selectFrom: jest.fn().mockReturnValue(query) } as never,
      {} as never,
      {} as never,
      spaceMemberRepo as never,
      pagePermissionRepo as never,
    );

    expect(typeof (service as any).searchAttachments).toBe('function');

    await expect(
      (service as any).searchAttachments(
        { query: 'guide', limit: 10 },
        {
          userId: 'user-1',
          userRole: UserRole.MEMBER,
          workspaceId: 'workspace-1',
        },
      ),
    ).resolves.toEqual({
      items: [
        {
          id: 'attachment-visible',
          fileName: 'guide.pdf',
          pageId: 'page-visible',
          creatorId: 'user-1',
          createdAt: rows[0].createdAt,
          updatedAt: rows[0].updatedAt,
          rank: 0,
          highlight: '',
          space: {
            id: 'space-1',
            name: 'Engineering',
            slug: 'engineering',
            icon: null,
          },
          page: {
            id: 'page-visible',
            title: 'Setup guide',
            slugId: 'setup-guide',
          },
        },
      ],
    });
    expect(spaceMemberRepo.getUserSpaceIdsQuery).toHaveBeenCalledWith('user-1');
    expect(pagePermissionRepo.filterAccessiblePageIds).toHaveBeenCalledWith({
      pageIds: ['page-visible', 'page-hidden'],
      userId: 'user-1',
      spaceId: undefined,
    });
  });

  it('lets the workspace owner search attachments in all spaces', async () => {
    const rows = [
      attachmentRow('attachment-1', 'page-1'),
      attachmentRow('attachment-2', 'page-2'),
    ];
    const query = fluentQuery(rows);
    const spaceMemberRepo = {
      getUserSpaceIdsQuery: jest.fn().mockReturnValue('readable-space-ids'),
    };
    const pagePermissionRepo = {
      filterAccessiblePageIds: jest.fn().mockResolvedValue([]),
    };
    const service = new SearchService(
      { selectFrom: jest.fn().mockReturnValue(query) } as never,
      {} as never,
      {} as never,
      spaceMemberRepo as never,
      pagePermissionRepo as never,
    );

    const result = await (service as any).searchAttachments(
      { query: 'guide', limit: 10 },
      {
        userId: 'owner-1',
        userRole: UserRole.OWNER,
        workspaceId: 'workspace-1',
      },
    );

    expect(result.items.map((item: { id: string }) => item.id)).toEqual([
      'attachment-1',
      'attachment-2',
    ]);
    expect(spaceMemberRepo.getUserSpaceIdsQuery).not.toHaveBeenCalled();
    expect(pagePermissionRepo.filterAccessiblePageIds).not.toHaveBeenCalled();
  });
});

function attachmentRow(id: string, pageId: string) {
  return {
    id,
    fileName: 'guide.pdf',
    pageId,
    creatorId: 'user-1',
    createdAt: new Date('2026-07-17T00:00:00.000Z'),
    updatedAt: new Date('2026-07-17T00:00:00.000Z'),
    spaceId: 'space-1',
    spaceName: 'Engineering',
    spaceSlug: 'engineering',
    spaceIcon: null,
    pageTitle: 'Setup guide',
    pageSlugId: 'setup-guide',
  };
}

function fluentQuery(result: unknown[]) {
  const query = {
    innerJoin: jest.fn(),
    select: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    offset: jest.fn(),
    execute: jest.fn().mockResolvedValue(result),
  };

  for (const method of [
    query.innerJoin,
    query.select,
    query.where,
    query.orderBy,
    query.limit,
    query.offset,
  ]) {
    method.mockReturnValue(query);
  }

  return query;
}
