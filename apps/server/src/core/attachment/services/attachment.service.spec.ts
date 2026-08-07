import { EventEmitter2 } from '@nestjs/event-emitter';
import { AttachmentRepo } from '@akasha/db/repos/attachment/attachment.repo';
import { Attachment } from '@akasha/db/types/entity.types';
import { EventName } from '../../../common/events/event.contants';
import { AttachmentType } from '../attachment.constants';
import { AttachmentService } from './attachment.service';

describe('AttachmentService', () => {
  it('emits a page update when a page raster attachment is deleted by path', async () => {
    const { service, attachmentRepo, eventEmitter } = createService();
    attachmentRepo.deleteAttachmentByFilePath.mockResolvedValue(
      attachmentRow({
        type: AttachmentType.File,
        pageId: 'page-1',
        mimeType: 'image/png',
        fileExt: '.png',
      }),
    );

    await service.deleteRedundantFile('files/workspace-1/attachment-1/a.png');

    expect(eventEmitter.emit).toHaveBeenCalledWith(EventName.PAGE_UPDATED, {
      pageIds: ['page-1'],
      workspaceId: 'workspace-1',
    });
  });

  it('does not emit a page update for non-page image attachments', async () => {
    const { service, attachmentRepo, eventEmitter } = createService();
    attachmentRepo.deleteAttachmentByFilePath.mockResolvedValue(
      attachmentRow({
        type: AttachmentType.Avatar,
        pageId: null,
        mimeType: 'image/png',
        fileExt: '.png',
      }),
    );

    await service.deleteRedundantFile('avatars/workspace-1/a.png');

    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });
});

function createService() {
  const storageService = { delete: jest.fn().mockResolvedValue(undefined) };
  const attachmentRepo = {
    deleteAttachmentByFilePath: jest.fn(),
  };
  const eventEmitter = { emit: jest.fn() };
  const service = new AttachmentService(
    storageService as never,
    attachmentRepo as unknown as AttachmentRepo,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    eventEmitter as unknown as EventEmitter2,
  );
  return { service, attachmentRepo, eventEmitter };
}

function attachmentRow(
  overrides: Partial<Attachment> & Pick<Attachment, 'type'>,
): Attachment {
  return {
    id: 'attachment-1',
    fileName: 'a.png',
    filePath: 'files/workspace-1/attachment-1/a.png',
    fileSize: '123',
    fileExt: '.png',
    mimeType: 'image/png',
    textContent: null,
    type: AttachmentType.File,
    creatorId: 'user-1',
    pageId: 'page-1',
    spaceId: 'space-1',
    aiChatId: null,
    workspaceId: 'workspace-1',
    createdAt: new Date('2026-08-07T00:00:00.000Z'),
    updatedAt: new Date('2026-08-07T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  } as unknown as Attachment;
}
