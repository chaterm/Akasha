import { AttachmentType } from '../../../core/attachment/attachment.constants';
import { KnowledgeCitationAttachmentResolverService } from './knowledge-citation-attachment-resolver.service';

describe('KnowledgeCitationAttachmentResolverService', () => {
  it('returns non-deleted attachments for cited pages with signed URLs', async () => {
    const attachmentRepo = {
      findByPageIds: jest.fn().mockResolvedValue([
        {
          id: 'attachment-2',
          pageId: 'page-2',
          workspaceId: 'workspace-1',
          fileName: 'design.pdf',
          mimeType: 'application/pdf',
          fileSize: 42,
          createdAt: new Date('2026-01-02'),
          type: AttachmentType.File,
        },
        {
          id: 'attachment-1',
          pageId: 'page-1',
          workspaceId: 'workspace-1',
          fileName: 'readme.txt',
          mimeType: 'text/plain',
          fileSize: 7,
          createdAt: new Date('2026-01-01'),
          type: AttachmentType.File,
        },
      ]),
    };
    const tokenService = {
      generateAttachmentToken: jest
        .fn()
        .mockImplementation(
          async ({ attachmentId }: any) => `jwt-${attachmentId}`,
        ),
    };
    const service = new KnowledgeCitationAttachmentResolverService(
      attachmentRepo as any,
      tokenService as any,
      { getAppUrl: () => 'https://akasha.example.com' } as any,
    );

    await expect(
      service.resolveAttachments({
        workspaceId: 'workspace-1',
        citations: [
          { sourcePageId: 'page-1', title: 'Page 1', url: '/p/page-1' },
          { sourcePageId: 'page-2', title: 'Page 2', url: '/p/page-2' },
        ],
      }),
    ).resolves.toEqual([
      {
        attachmentId: 'attachment-1',
        sourcePageId: 'page-1',
        fileName: 'readme.txt',
        mimeType: 'text/plain',
        fileSize: 7,
        url: 'https://akasha.example.com/api/files/public/attachment-1/readme.txt?jwt=jwt-attachment-1',
      },
      {
        attachmentId: 'attachment-2',
        sourcePageId: 'page-2',
        fileName: 'design.pdf',
        mimeType: 'application/pdf',
        fileSize: 42,
        url: 'https://akasha.example.com/api/files/public/attachment-2/design.pdf?jwt=jwt-attachment-2',
      },
    ]);
  });

  it('limits the returned attachment list to fifteen items', async () => {
    const attachments = Array.from({ length: 16 }, (_, index) => ({
      id: `attachment-${String(index + 1).padStart(2, '0')}`,
      pageId: 'page-1',
      workspaceId: 'workspace-1',
      fileName: `file-${index + 1}.pdf`,
      mimeType: 'application/pdf',
      fileSize: 42,
      createdAt: new Date(`2026-01-${String(index + 1).padStart(2, '0')}`),
      type: AttachmentType.File,
    }));
    const attachmentRepo = {
      findByPageIds: jest.fn().mockResolvedValue(attachments),
    };
    const tokenService = {
      generateAttachmentToken: jest
        .fn()
        .mockImplementation(
          async ({ attachmentId }: any) => `jwt-${attachmentId}`,
        ),
    };
    const service = new KnowledgeCitationAttachmentResolverService(
      attachmentRepo as any,
      tokenService as any,
      { getAppUrl: () => 'https://akasha.example.com' } as any,
    );

    const result = await service.resolveAttachments({
      workspaceId: 'workspace-1',
      citations: [
        { sourcePageId: 'page-1', title: 'Page 1', url: '/p/page-1' },
      ],
    });

    expect(result).toHaveLength(15);
    expect(result[0].attachmentId).toBe('attachment-01');
    expect(result[14].attachmentId).toBe('attachment-15');
    expect(
      result.some(({ attachmentId }) => attachmentId === 'attachment-16'),
    ).toBe(false);
    expect(tokenService.generateAttachmentToken).toHaveBeenCalledTimes(15);
  });

  it('excludes non-file attachment types even when they belong to a cited page', async () => {
    const attachmentRepo = {
      findByPageIds: jest.fn().mockResolvedValue([
        {
          id: 'file-attachment',
          pageId: 'page-1',
          workspaceId: 'workspace-1',
          fileName: 'document.pdf',
          mimeType: 'application/pdf',
          fileSize: 42,
          createdAt: new Date('2026-01-01'),
          type: AttachmentType.File,
        },
        {
          id: 'avatar-attachment',
          pageId: 'page-1',
          workspaceId: 'workspace-1',
          fileName: 'avatar.png',
          mimeType: 'image/png',
          fileSize: 7,
          createdAt: new Date('2026-01-02'),
          type: AttachmentType.Avatar,
        },
      ]),
    };
    const tokenService = {
      generateAttachmentToken: jest
        .fn()
        .mockImplementation(
          async ({ attachmentId }: any) => `jwt-${attachmentId}`,
        ),
    };
    const service = new KnowledgeCitationAttachmentResolverService(
      attachmentRepo as any,
      tokenService as any,
      { getAppUrl: () => 'https://akasha.example.com' } as any,
    );

    const result = await service.resolveAttachments({
      workspaceId: 'workspace-1',
      citations: [
        { sourcePageId: 'page-1', title: 'Page 1', url: '/p/page-1' },
      ],
    });

    expect(result.map(({ attachmentId }) => attachmentId)).toEqual([
      'file-attachment',
    ]);
    expect(tokenService.generateAttachmentToken).toHaveBeenCalledTimes(1);
  });
});
