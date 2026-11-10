import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { ForbiddenException } from '@nestjs/common';
import { tiptapExtensions } from '../../../collaboration/collaboration.util';
import {
  PageAttachmentRehomeService,
  remapAttachmentsInJson,
  remapAttachmentsInYdoc,
} from './page-attachment-rehome.service';

const OLD_ID = '01900000-0000-7000-8000-000000000001';
const OTHER_ID = '01900000-0000-7000-8000-000000000002';
const NEW_ID = '01900000-0000-7000-8000-0000000000aa';

const target = {
  pageId: 'split-page',
  spaceId: 'space-1',
  workspaceId: 'workspace-1',
};

const attachment = (overrides: Record<string, unknown> = {}) => ({
  id: OLD_ID,
  type: 'file',
  filePath: `workspace-1/files/${OLD_ID}/chart.png`,
  fileName: 'chart.png',
  fileSize: 1024,
  mimeType: 'image/png',
  fileExt: '.png',
  creatorId: 'creator-1',
  workspaceId: 'workspace-1',
  spaceId: 'space-1',
  pageId: 'source-page',
  deletedAt: null,
  ...overrides,
});

const imageDoc = (id: string) => ({
  type: 'doc',
  content: [
    {
      type: 'image',
      attrs: { attachmentId: id, src: `/api/files/${id}/chart.png` },
    },
  ],
});

function createSubject(attachments: unknown[], canView = true) {
  const attachmentRepo = {
    findByIds: jest.fn().mockResolvedValue(attachments),
    insertAttachment: jest.fn().mockResolvedValue(undefined),
  };
  const pageRepo = {
    findById: jest.fn(
      async (id: string): Promise<Record<string, unknown>> => ({
        id,
        spaceId: 'space-1',
      }),
    ),
  };
  const userRepo = {
    findById: jest.fn().mockResolvedValue({ id: 'user-1', role: 'member' }),
  };
  const storageService = { copy: jest.fn().mockResolvedValue(undefined) };
  const pageAccessService = {
    validateCanView: jest.fn(async () => {
      if (!canView) throw new ForbiddenException();
    }),
  };
  const service = new PageAttachmentRehomeService(
    attachmentRepo as any,
    pageRepo as any,
    userRepo as any,
    storageService as any,
    pageAccessService as any,
  );
  return {
    service,
    attachmentRepo,
    pageRepo,
    storageService,
    pageAccessService,
  };
}

describe('PageAttachmentRehomeService', () => {
  it('把其他页面的图片复制到目标页面名下', async () => {
    const { service, attachmentRepo, storageService } = createSubject([
      attachment(),
    ]);

    const remap = await service.copyForeignAttachments(
      [OLD_ID],
      target,
      'user-1',
    );

    const newId = remap.get(OLD_ID);
    expect(newId).toBeDefined();
    expect(storageService.copy).toHaveBeenCalledWith(
      `workspace-1/files/${OLD_ID}/chart.png`,
      `workspace-1/files/${newId}/chart.png`,
    );
    expect(attachmentRepo.insertAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        id: newId,
        pageId: 'split-page',
        spaceId: 'space-1',
        filePath: `workspace-1/files/${newId}/chart.png`,
        mimeType: 'image/png',
      }),
      undefined,
    );
  });

  it('来源页面已在回收站时仍然复制', async () => {
    const { service, pageRepo } = createSubject([attachment()]);
    pageRepo.findById.mockResolvedValueOnce({
      id: 'source-page',
      spaceId: 'space-1',
      deletedAt: new Date(),
    });
    const remap = await service.copyForeignAttachments(
      [OLD_ID],
      target,
      'user-1',
    );
    expect(remap.size).toBe(1);
  });

  it('跳过本页、已删除、其他工作区和非文件类型的附件', async () => {
    const { service, storageService } = createSubject([
      attachment({ pageId: 'split-page' }),
      attachment({ id: OTHER_ID, deletedAt: new Date() }),
      attachment({ id: 'a3', workspaceId: 'workspace-2' }),
      attachment({ id: 'a4', type: 'avatar' }),
      attachment({ id: 'a5', pageId: null }),
    ]);

    const remap = await service.copyForeignAttachments(
      [OLD_ID, OTHER_ID, 'a3', 'a4', 'a5'],
      target,
      'user-1',
    );

    expect(remap.size).toBe(0);
    expect(storageService.copy).not.toHaveBeenCalled();
  });

  it('用户无权查看来源页面时不复制', async () => {
    const { service, storageService } = createSubject([attachment()], false);

    const remap = await service.copyForeignAttachments(
      [OLD_ID],
      target,
      'user-1',
    );

    expect(remap.size).toBe(0);
    expect(storageService.copy).not.toHaveBeenCalled();
  });

  it('复制文件失败时保留原引用并继续处理其他附件', async () => {
    const { service, storageService } = createSubject([
      attachment(),
      attachment({
        id: OTHER_ID,
        filePath: `workspace-1/files/${OTHER_ID}/b.png`,
      }),
    ]);
    storageService.copy.mockRejectedValueOnce(new Error('disk full'));

    const remap = await service.copyForeignAttachments(
      [OLD_ID, OTHER_ID],
      target,
      'user-1',
    );

    expect(remap.has(OLD_ID)).toBe(false);
    expect(remap.has(OTHER_ID)).toBe(true);
  });

  it('同一来源页面只校验一次权限', async () => {
    const { service, pageAccessService } = createSubject([
      attachment(),
      attachment({
        id: OTHER_ID,
        filePath: `workspace-1/files/${OTHER_ID}/b.png`,
      }),
    ]);

    await service.copyForeignAttachments([OLD_ID, OTHER_ID], target, 'user-1');

    expect(pageAccessService.validateCanView).toHaveBeenCalledTimes(1);
  });
});

describe('remapAttachmentsInJson', () => {
  it('改写 attachmentId 和 src，且不修改输入', () => {
    const input = imageDoc(OLD_ID);
    const snapshot = structuredClone(input);

    const output = remapAttachmentsInJson(input, new Map([[OLD_ID, NEW_ID]]));

    expect(input).toEqual(snapshot);
    expect(output.content[0].attrs).toEqual({
      attachmentId: NEW_ID,
      src: `/api/files/${NEW_ID}/chart.png`,
    });
  });

  it('没有 attachmentId 时按 src 识别', () => {
    const input = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: `/api/files/${OLD_ID}/chart.png` } },
      ],
    };

    const output = remapAttachmentsInJson(input, new Map([[OLD_ID, NEW_ID]]));

    expect(output.content[0].attrs).toEqual({
      attachmentId: NEW_ID,
      src: `/api/files/${NEW_ID}/chart.png`,
    });
  });
});

describe('remapAttachmentsInYdoc', () => {
  it('改写 Y.Doc 中嵌套的附件节点', () => {
    const doc = TiptapTransformer.toYdoc(
      {
        type: 'doc',
        content: [
          {
            type: 'blockquote',
            content: [imageDoc(OLD_ID).content[0]],
          },
          imageDoc(OTHER_ID).content[0],
        ],
      },
      'default',
      tiptapExtensions,
    );

    const changed = remapAttachmentsInYdoc(doc, new Map([[OLD_ID, NEW_ID]]));

    expect(changed).toBe(1);
    const json = TiptapTransformer.fromYdoc(doc, 'default') as any;
    expect(json.content[0].content[0].attrs).toMatchObject({
      attachmentId: NEW_ID,
      src: `/api/files/${NEW_ID}/chart.png`,
    });
    expect(json.content[1].attrs.attachmentId).toBe(OTHER_ID);
    doc.destroy();
  });

  it('没有映射时不产生更新', () => {
    const doc = new Y.Doc();
    const onUpdate = jest.fn();
    doc.on('update', onUpdate);

    expect(remapAttachmentsInYdoc(doc, new Map())).toBe(0);
    expect(onUpdate).not.toHaveBeenCalled();
    doc.destroy();
  });
});
