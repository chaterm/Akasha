import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { getQueueToken } from '@nestjs/bullmq';
import { SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { PersistenceExtension } from './persistence.extension';
import { tiptapExtensions } from '../collaboration.util';

describe('PersistenceExtension', () => {
  it('publishes page content updates through the knowledge text queue', () => {
    expect(
      Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, PersistenceExtension),
    ).toContainEqual({
      index: 2,
      param: getQueueToken(QueueName.KNOWLEDGE_TEXT_QUEUE),
    });
  });

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
    const attachmentRehome = {
      copyForeignAttachments: jest.fn().mockResolvedValue(new Map()),
    };
    const extension = new PersistenceExtension(
      pageRepo as any,
      db as any,
      queue as any,
      queue as any,
      queue as any,
      collabHistory as any,
      transclusionService as any,
      attachmentRehome as any,
    );

    return { extension, pageRepo, knowledgeQueue: queue, attachmentRehome };
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
    const { extension, pageRepo, knowledgeQueue } = createSubject(oldContent);

    await extension.onStoreDocument(payload() as any);

    expect(pageRepo.updatePage).toHaveBeenCalledWith(
      expect.objectContaining({
        lastUpdatedById: 'editing-user',
        sourceLastUpdatedByName: null,
      }),
      'page-1',
      expect.anything(),
    );
    expect(knowledgeQueue.add).toHaveBeenCalledWith(
      QueueJob.PAGE_CONTENT_UPDATED,
      { pageIds: ['page-1'], workspaceId: 'workspace-1' },
    );
  });

  it('页面事务失败时不发布知识更新任务', async () => {
    const oldContent = { type: 'doc', content: [] };
    const newContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [] }],
    };
    jest.spyOn(TiptapTransformer, 'fromYdoc').mockReturnValue(newContent);
    const { extension, pageRepo, knowledgeQueue } = createSubject(oldContent);
    pageRepo.updatePage.mockRejectedValueOnce(new Error('write failed'));

    await extension.onStoreDocument(payload() as any);

    expect(knowledgeQueue.add).not.toHaveBeenCalledWith(
      QueueJob.PAGE_CONTENT_UPDATED,
      expect.anything(),
    );
  });

  it('保存时把引用其他页面的图片复制到本页并改写 Y.Doc', async () => {
    const oldId = '01900000-0000-7000-8000-000000000001';
    const newId = '01900000-0000-7000-8000-0000000000aa';
    const document = Object.assign(
      TiptapTransformer.toYdoc(
        {
          type: 'doc',
          content: [
            {
              type: 'image',
              attrs: {
                attachmentId: oldId,
                src: `/api/files/${oldId}/chart.png`,
              },
            },
          ],
        },
        'default',
        tiptapExtensions,
      ),
      { broadcastStateless: jest.fn() },
    );
    const { extension, pageRepo, attachmentRehome } = createSubject({
      type: 'doc',
      content: [],
    });
    attachmentRehome.copyForeignAttachments.mockResolvedValue(
      new Map([[oldId, newId]]),
    );

    await extension.onStoreDocument({ ...payload(), document } as any);

    expect(attachmentRehome.copyForeignAttachments).toHaveBeenCalledWith(
      [oldId],
      { pageId: 'page-1', spaceId: 'space-1', workspaceId: 'workspace-1' },
      'editing-user',
    );
    const saved = pageRepo.updatePage.mock.calls[0][0];
    expect(saved.content.content[0].attrs).toMatchObject({
      attachmentId: newId,
      src: `/api/files/${newId}/chart.png`,
    });
    const savedDoc = new Y.Doc();
    Y.applyUpdate(savedDoc, saved.ydoc);
    expect(
      (TiptapTransformer.fromYdoc(savedDoc, 'default') as any).content[0].attrs
        .attachmentId,
    ).toBe(newId);
    savedDoc.destroy();
    document.destroy();
  });

  it('附件改写失败时仍保存原内容', async () => {
    const oldId = '01900000-0000-7000-8000-000000000001';
    const document = Object.assign(
      TiptapTransformer.toYdoc(
        {
          type: 'doc',
          content: [{ type: 'image', attrs: { attachmentId: oldId } }],
        },
        'default',
        tiptapExtensions,
      ),
      { broadcastStateless: jest.fn() },
    );
    const { extension, pageRepo, attachmentRehome } = createSubject({
      type: 'doc',
      content: [],
    });
    attachmentRehome.copyForeignAttachments.mockRejectedValue(
      new Error('db down'),
    );

    await extension.onStoreDocument({ ...payload(), document } as any);

    expect(
      pageRepo.updatePage.mock.calls[0][0].content.content[0].attrs
        .attachmentId,
    ).toBe(oldId);
    document.destroy();
  });

  it('内容没有变化时不更新页面也不清除来源最后修改者', async () => {
    const content = { type: 'doc', content: [] };
    jest.spyOn(TiptapTransformer, 'fromYdoc').mockReturnValue(content);
    const { extension, pageRepo } = createSubject(content);

    await extension.onStoreDocument(payload() as any);

    expect(pageRepo.updatePage).not.toHaveBeenCalled();
  });
});
