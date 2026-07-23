import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { PersistenceExtension } from './persistence.extension';

describe('PersistenceExtension', () => {
  const createSubject = (storedContent: unknown) => {
    const pageRepo = {
      findById: jest.fn().mockResolvedValue({
        id: 'page-1',
        slugId: 'page-slug',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        creatorId: 'creator-1',
        contributorIds: [],
        content: storedContent,
        createdAt: new Date(),
      }),
      updatePage: jest.fn().mockResolvedValue(undefined),
    };
    const db = {
      transaction: () => ({
        execute: (callback: (trx: unknown) => unknown) => callback({}),
      }),
    };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const collabHistory = {
      addContributors: jest.fn().mockResolvedValue(undefined),
    };
    const transclusionService = {
      syncPageTransclusions: jest.fn().mockResolvedValue(undefined),
      syncPageReferences: jest.fn().mockResolvedValue(undefined),
    };
    const extension = new PersistenceExtension(
      pageRepo as any,
      db as any,
      queue as any,
      queue as any,
      queue as any,
      collabHistory as any,
      transclusionService as any,
    );

    return { extension, pageRepo };
  };

  const payload = () => ({
    documentName: 'page.page-1',
    document: Object.assign(new Y.Doc(), {
      broadcastStateless: jest.fn(),
    }),
    context: {
      user: {
        id: 'editing-user',
        name: '编辑用户',
        avatarUrl: null,
      },
    },
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('内容真正变化时清除来源最后修改者', async () => {
    const oldContent = { type: 'doc', content: [] };
    const newContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [] }],
    };
    jest.spyOn(TiptapTransformer, 'fromYdoc').mockReturnValue(newContent);
    const { extension, pageRepo } = createSubject(oldContent);

    await extension.onStoreDocument(payload() as any);

    expect(pageRepo.updatePage).toHaveBeenCalledWith(
      expect.objectContaining({
        lastUpdatedById: 'editing-user',
        sourceLastUpdatedByName: null,
      }),
      'page-1',
      expect.anything(),
    );
  });

  it('内容没有变化时不更新页面也不清除来源最后修改者', async () => {
    const content = { type: 'doc', content: [] };
    jest.spyOn(TiptapTransformer, 'fromYdoc').mockReturnValue(content);
    const { extension, pageRepo } = createSubject(content);

    await extension.onStoreDocument(payload() as any);

    expect(pageRepo.updatePage).not.toHaveBeenCalled();
  });
});
