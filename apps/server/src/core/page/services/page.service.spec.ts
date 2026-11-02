jest.mock('../../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class CollaborationGateway {},
}));

import { PageService } from './page.service';
import {
  jsonToNode,
  jsonToText,
} from '../../../collaboration/collaboration.util';
import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import { WEEKLY_REPORT_DRAFT_TEXT } from '../../weekly-report/weekly-report-draft';

describe('PageService', () => {
  it('strictly validates the second-step JSON and leaves compilation to the content commit', async () => {
    const pending = {
      id: 'page-1',
      spaceId: 'space-1',
      workspaceId: 'workspace-1',
      contributorIds: [],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: WEEKLY_REPORT_DRAFT_TEXT }],
          },
        ],
      },
    } as any;
    const pageRepo = {
      updatePage: jest.fn(),
      findById: jest.fn().mockResolvedValue(pending),
    };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const gateway = { handleYjsEvent: jest.fn().mockResolvedValue(undefined) };
    const service = new PageService(
      pageRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      queue as any,
      {} as any,
      gateway as any,
      {} as any,
      {} as any,
    );
    const dto = {
      pageId: pending.id,
      operation: 'replace' as const,
      format: 'json' as const,
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Finished report' }],
          },
        ],
      },
    };
    await service.update(pending, dto, { id: 'writer' } as any);
    expect(pageRepo.updatePage).toHaveBeenCalledWith(
      expect.anything(),
      pending.id,
      undefined,
      { skipKnowledgeCompile: true },
    );
    expect(gateway.handleYjsEvent).toHaveBeenCalledWith(
      'updatePageContent',
      'page.page-1',
      expect.objectContaining({
        operation: 'replace',
        prosemirrorJson: jsonToNode(dto.content).toJSON(),
      }),
    );
    pageRepo.updatePage.mockClear();
    gateway.handleYjsEvent.mockClear();
    await expect(
      service.update(
        pending,
        { ...dto, content: { type: 'doc', content: [{ type: 'invented' }] } },
        { id: 'writer' } as any,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'INVALID_CONTENT' }),
    });
    expect(pageRepo.updatePage).not.toHaveBeenCalled();
    expect(gateway.handleYjsEvent).not.toHaveBeenCalled();
    await expect(
      service.update({ ...pending, isLocked: true }, dto, {
        id: 'writer',
      } as any),
    ).rejects.toMatchObject({ status: 403 });
    expect(pageRepo.updatePage).not.toHaveBeenCalled();
  });
  function createSubject() {
    const pageRepo = {
      insertPage: jest.fn(async (page) => page),
      findById: jest.fn(),
    };
    const generalQueue = { add: jest.fn().mockResolvedValue(undefined) };
    const service = new PageService(
      pageRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      generalQueue as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(service, 'nextPagePosition').mockResolvedValue('a0');
    return { service, pageRepo, generalQueue };
  }

  it('creation stores one normalized source for JSON, text and Y.Doc without mutating input', async () => {
    const { service, pageRepo } = createSubject();
    const raw = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { unsupported: 'discard' },
          content: [{ type: 'text', text: 'hello' }],
        },
      ],
    };
    const snapshot = structuredClone(raw);
    await service.create('user-1', 'workspace-1', {
      spaceId: 'space-1',
      content: raw,
      format: 'json',
    });
    const saved = pageRepo.insertPage.mock.calls[0][0] as any;
    expect(raw).toEqual(snapshot);
    expect(saved.content).toEqual(jsonToNode(raw).toJSON());
    expect(saved.content.content[0].attrs).not.toHaveProperty('unsupported');
    expect(saved.textContent).toBe(jsonToText(saved.content));
    const ydoc = new Y.Doc();
    try {
      Y.applyUpdate(ydoc, saved.ydoc);
      expect(
        jsonToNode(TiptapTransformer.fromYdoc(ydoc, 'default')).toJSON(),
      ).toEqual(saved.content);
    } finally {
      ydoc.destroy();
    }
  });

  it('transactional creation passes the transaction and suppresses precommit effects', async () => {
    const { service, pageRepo, generalQueue } = createSubject();
    const trx = {} as any;
    await service.create(
      'user-1',
      'workspace-1',
      {
        spaceId: 'space-1',
        content: { type: 'doc', content: [{ type: 'paragraph' }] },
        format: 'json',
      },
      { trx, deferCreatedEffects: true },
    );
    expect(pageRepo.insertPage).toHaveBeenCalledWith(expect.anything(), trx, {
      deferCreatedEvent: true,
    });
    expect(service.nextPagePosition).toHaveBeenCalledWith(
      'space-1',
      undefined,
      trx,
    );
    expect(generalQueue.add).not.toHaveBeenCalled();
  });

  it('正常更新页面时清除来源最后修改者并记录真实用户', async () => {
    const pageRepo = {
      updatePage: jest.fn().mockResolvedValue(undefined),
      findById: jest.fn().mockResolvedValue({ id: 'page-1' }),
    };
    const generalQueue = { add: jest.fn().mockResolvedValue(undefined) };
    const service = new PageService(
      pageRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      generalQueue as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await service.update(
      {
        id: 'page-1',
        spaceId: 'space-1',
        workspaceId: 'workspace-1',
        contributorIds: [],
      } as any,
      { pageId: 'page-1', title: '新标题' },
      { id: 'editing-user' } as any,
    );

    expect(pageRepo.updatePage).toHaveBeenCalledWith(
      expect.objectContaining({
        lastUpdatedById: 'editing-user',
        sourceLastUpdatedByName: null,
      }),
      'page-1',
    );
  });
});
