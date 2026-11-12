import { ShareService } from './share.service';

const WORKSPACE_ID = '019a7c00-0000-7000-8000-000000000001';
const ROOT_PAGE_ID = '019a7c00-0000-7000-8000-000000000002';
const SUBPAGE_ID = '019a7c00-0000-7000-8000-000000000003';

describe('ShareService.getSharedPage', () => {
  const makeService = () => {
    const pageRepo = {
      findById: jest.fn(async (pageId: string) => ({
        id: pageId,
        title: 'Subpage title',
        content: { type: 'doc' },
        deletedAt: null,
      })),
    };
    const pagePermissionRepo = {
      hasRestrictedAncestor: jest.fn(async () => false),
    };

    const service = new ShareService(
      {} as any,
      pageRepo as any,
      pagePermissionRepo as any,
      {} as any,
      {} as any,
      {} as any,
    );

    jest.spyOn(service, 'getShareForPage').mockResolvedValue({
      id: 'share-1',
      searchIndexing: true,
      pageId: ROOT_PAGE_ID,
      includeSubPages: true,
      level: 1,
      sharedPage: {
        id: ROOT_PAGE_ID,
        slugId: 'rootslug01',
        title: 'Share root title',
        icon: null,
      },
    } as any);

    const updatePublicAttachments = jest
      .spyOn(service, 'updatePublicAttachments')
      .mockResolvedValue({ type: 'doc', tokenized: true });

    return { service, pageRepo, updatePublicAttachments };
  };

  it('returns the requested subpage title, not the share root title', async () => {
    const { service } = makeService();

    const { page } = await service.getSharedPage(
      { pageId: SUBPAGE_ID },
      WORKSPACE_ID,
      { includeContent: false },
    );

    expect(page.title).toBe('Subpage title');
  });

  it('skips content loading and attachment tokenizing when content is not wanted', async () => {
    const { service, pageRepo, updatePublicAttachments } = makeService();

    await service.getSharedPage({ pageId: SUBPAGE_ID }, WORKSPACE_ID, {
      includeContent: false,
    });

    expect(pageRepo.findById).toHaveBeenCalledWith(SUBPAGE_ID);
    expect(updatePublicAttachments).not.toHaveBeenCalled();
  });

  it('still loads content and tokenizes attachments by default', async () => {
    const { service, pageRepo, updatePublicAttachments } = makeService();

    const { page } = await service.getSharedPage(
      { pageId: SUBPAGE_ID },
      WORKSPACE_ID,
    );

    expect(pageRepo.findById).toHaveBeenCalledWith(SUBPAGE_ID, {
      includeContent: true,
      includeCreator: true,
    });
    expect(updatePublicAttachments).toHaveBeenCalled();
    expect(page.content).toEqual({ type: 'doc', tokenized: true });
  });
});
