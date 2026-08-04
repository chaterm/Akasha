import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { BacklinkRepo } from '@akasha/db/repos/backlink/backlink.repo';
import { AttachmentRepo } from '@akasha/db/repos/attachment/attachment.repo';
import { KnowledgeSourceExporterService } from './knowledge-source-exporter.service';

describe('KnowledgeSourceExporterService', () => {
  it('keyset-paginates a space inside one repeatable-read read-only snapshot', async () => {
    const pages = Array.from({ length: 201 }, (_, index) => ({
      id: `page-${String(index).padStart(3, '0')}`,
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      title: `Page ${index}`,
      textContent: 'Body',
      content: { type: 'doc', content: [] },
      updatedAt: new Date(
        `2026-07-30T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      ),
    }));
    const pageRepo = {
      findPagesForKnowledgeExport: jest
        .fn()
        .mockResolvedValueOnce(pages.slice(0, 200))
        .mockResolvedValueOnce(pages.slice(200)),
    };
    const backlinkRepo = {
      findOutgoingPageReferences: jest.fn().mockResolvedValue([]),
    };
    const trx = { id: 'snapshot-trx' };
    const execute = jest.fn(async (callback) => callback(trx));
    const setAccessMode = jest.fn(() => ({ execute }));
    const setIsolationLevel = jest.fn(() => ({ setAccessMode }));
    const db = {
      transaction: jest.fn(() => ({ setIsolationLevel })),
    };
    const service = new KnowledgeSourceExporterService(
      pageRepo as unknown as PageRepo,
      backlinkRepo as unknown as BacklinkRepo,
      createEmptyAttachmentRepo(),
      db as never,
    );

    await expect(
      service.exportSpaceSources({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toHaveLength(201);

    expect(setIsolationLevel).toHaveBeenCalledWith('repeatable read');
    expect(setAccessMode).toHaveBeenCalledWith('read only');
    expect(pageRepo.findPagesForKnowledgeExport).toHaveBeenNthCalledWith(
      1,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        limit: 200,
      },
      trx,
    );
    expect(pageRepo.findPagesForKnowledgeExport).toHaveBeenNthCalledWith(
      2,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        limit: 200,
        afterId: pages[199].id,
      },
      trx,
    );
    expect(backlinkRepo.findOutgoingPageReferences).toHaveBeenCalledWith(
      expect.any(Object),
      trx,
    );
  });

  it('exports page snapshots for one workspace and space', async () => {
    const pageRepo = {
      findPagesForKnowledgeExport: jest.fn().mockResolvedValue([
        {
          id: 'page-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          title: 'Page 1',
          textContent: 'Page body',
          content: { type: 'doc', content: [] },
          updatedAt: new Date('2026-06-16T00:00:00.000Z'),
        },
      ]),
    };
    const backlinkRepo = {
      findOutgoingPageReferences: jest.fn().mockResolvedValue([
        {
          sourcePageId: 'page-1',
          targetPageId: 'page-2',
          targetSpaceId: 'space-1',
        },
      ]),
    };
    const service = new KnowledgeSourceExporterService(
      pageRepo as unknown as PageRepo,
      backlinkRepo as unknown as BacklinkRepo,
      createEmptyAttachmentRepo(),
    );

    const snapshots = await service.exportSpaceSources({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });

    expect(pageRepo.findPagesForKnowledgeExport).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      limit: 200,
    });
    expect(snapshots).toEqual([
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageId: 'page-1',
        sourceVersion: '2026-06-16T00:00:00.000Z',
        contentHash: expect.stringMatching(/^sha256:/),
        title: 'Page 1',
        text: 'Page body',
        content: { type: 'doc', content: [] },
        references: [
          {
            sourcePageId: 'page-1',
            targetPageId: 'page-2',
            targetSpaceId: 'space-1',
            kind: 'same_space_reference',
            mode: 'opaque',
          },
        ],
      },
    ]);
  });

  it('uses empty text when a page has no text content', async () => {
    const pageRepo = {
      findPagesForKnowledgeExport: jest.fn().mockResolvedValue([
        {
          id: 'page-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          title: 'Empty',
          textContent: null,
          updatedAt: new Date('2026-06-16T00:00:00.000Z'),
        },
      ]),
    };
    const backlinkRepo = {
      findOutgoingPageReferences: jest.fn().mockResolvedValue([]),
    };
    const service = new KnowledgeSourceExporterService(
      pageRepo as unknown as PageRepo,
      backlinkRepo as unknown as BacklinkRepo,
      createEmptyAttachmentRepo(),
    );

    await expect(
      service.exportSpaceSources({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toMatchObject([{ text: '' }]);
  });

  it('exports only the requested pages for incremental compilation', async () => {
    const pageRepo = {
      findPagesByIdsForKnowledgeExport: jest.fn().mockResolvedValue([
        {
          id: 'page-2',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          title: 'Changed page',
          textContent: 'Changed body',
          content: { type: 'doc' },
          updatedAt: new Date('2026-07-20T00:00:00.000Z'),
        },
      ]),
    };
    const backlinkRepo = {
      findOutgoingPageReferences: jest.fn().mockResolvedValue([]),
    };
    const service = new KnowledgeSourceExporterService(
      pageRepo as unknown as PageRepo,
      backlinkRepo as unknown as BacklinkRepo,
      createEmptyAttachmentRepo(),
    );

    const snapshots = await service.exportPageSources({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageIds: ['page-2'],
    });

    expect(pageRepo.findPagesByIdsForKnowledgeExport).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      pageIds: ['page-2'],
    });
    expect(snapshots.map((source) => source.sourcePageId)).toEqual(['page-2']);
  });

  it('captures only page-owned safe raster attachments in document order', async () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'image',
          attrs: { attachmentId: 'image-1', alt: 'System diagram' },
        },
        { type: 'image', attrs: { attachmentId: 'foreign-image' } },
        { type: 'image', attrs: { attachmentId: 'image-1' } },
      ],
    };
    const pageRepo = {
      findPagesForKnowledgeExport: jest.fn().mockResolvedValue([
        {
          id: 'page-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          title: 'Image page',
          textContent: '',
          content,
          updatedAt: new Date('2026-07-27T00:00:00.000Z'),
        },
      ]),
    };
    const backlinkRepo = {
      findOutgoingPageReferences: jest.fn().mockResolvedValue([]),
    };
    const attachmentRepo = {
      findByIds: jest.fn().mockResolvedValue([
        {
          id: 'image-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          pageId: 'page-1',
          type: 'file',
          fileName: 'diagram.png',
          fileExt: '.png',
          fileSize: 2048,
          mimeType: 'image/png',
          updatedAt: new Date('2026-07-27T00:01:00.000Z'),
          deletedAt: null,
        },
        {
          id: 'foreign-image',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          pageId: 'other-page',
          type: 'file',
          fileName: 'foreign.jpg',
          fileExt: '.jpg',
          fileSize: 1024,
          mimeType: 'image/jpeg',
          updatedAt: new Date('2026-07-27T00:01:00.000Z'),
          deletedAt: null,
        },
      ]),
    };
    const service = new KnowledgeSourceExporterService(
      pageRepo as unknown as PageRepo,
      backlinkRepo as unknown as BacklinkRepo,
      attachmentRepo as unknown as AttachmentRepo,
    );

    const [snapshot] = await service.exportSpaceSources({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });

    expect(attachmentRepo.findByIds).toHaveBeenCalledWith([
      'image-1',
      'foreign-image',
    ]);
    expect(snapshot.images).toEqual([
      {
        attachmentId: 'image-1',
        fileName: 'diagram.png',
        mimeType: 'image/png',
        fileSize: 2048,
        attachmentVersion: '2026-07-27T00:01:00.000Z',
        altText: 'System diagram',
      },
    ]);
    expect(snapshot.contentHash).toMatch(/^sha256:/);
  });

  it('changes the source hash when a page image attachment version changes', async () => {
    const page = {
      id: 'page-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      title: 'Versioned image',
      textContent: 'Body',
      content: {
        type: 'doc',
        content: [
          { type: 'image', attrs: { attachmentId: 'image-versioned' } },
        ],
      },
      updatedAt: new Date('2026-07-27T00:00:00.000Z'),
    };
    const pageRepo = {
      findPagesForKnowledgeExport: jest.fn().mockResolvedValue([page]),
    };
    const backlinkRepo = {
      findOutgoingPageReferences: jest.fn().mockResolvedValue([]),
    };
    const attachment = (updatedAt: string) => ({
      id: 'image-versioned',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      pageId: 'page-1',
      type: 'file',
      fileName: 'diagram.png',
      fileExt: '.png',
      fileSize: 2048,
      mimeType: 'image/png',
      updatedAt: new Date(updatedAt),
      deletedAt: null,
    });
    const attachmentRepo = {
      findByIds: jest
        .fn()
        .mockResolvedValueOnce([attachment('2026-07-27T00:01:00.000Z')])
        .mockResolvedValueOnce([attachment('2026-07-27T00:02:00.000Z')]),
    };
    const service = new KnowledgeSourceExporterService(
      pageRepo as unknown as PageRepo,
      backlinkRepo as unknown as BacklinkRepo,
      attachmentRepo as unknown as AttachmentRepo,
    );

    const [before] = await service.exportSpaceSources({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    const [after] = await service.exportSpaceSources({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });

    expect(after.images?.[0]?.attachmentVersion).not.toBe(
      before.images?.[0]?.attachmentVersion,
    );
    expect(after.contentHash).not.toBe(before.contentHash);
  });

  it('accepts convertible raster formats and excludes SVG attachments', async () => {
    const formats = [
      ['gif', 'image/gif', '.gif', 'image/gif'],
      ['webp', 'image/webp', '.webp', 'image/webp'],
      ['avif', 'image/avif', '.avif', 'image/avif'],
      ['tiff', 'image/x-tiff', '.tif', 'image/tiff'],
      ['bmp', 'image/x-ms-bmp', '.bmp', 'image/bmp'],
      ['apng', 'image/apng', '.apng', 'image/apng'],
      ['generic-png', 'application/octet-stream', '.png', 'image/png'],
    ] as const;
    const attachmentIds = [...formats.map(([id]) => id), 'svg-as-png'];
    const pageRepo = {
      findPagesForKnowledgeExport: jest.fn().mockResolvedValue([
        {
          id: 'page-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          title: 'Raster formats',
          textContent: '',
          content: {
            type: 'doc',
            content: attachmentIds.map((attachmentId) => ({
              type: 'image',
              attrs: { attachmentId },
            })),
          },
          updatedAt: new Date('2026-07-27T00:00:00.000Z'),
        },
      ]),
    };
    const backlinkRepo = {
      findOutgoingPageReferences: jest.fn().mockResolvedValue([]),
    };
    const attachment = (id: string, mimeType: string, fileExt: string) => ({
      id,
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      pageId: 'page-1',
      type: 'file',
      fileName: `${id}${fileExt}`,
      fileExt,
      fileSize: 1024,
      mimeType,
      updatedAt: new Date('2026-07-27T00:01:00.000Z'),
      deletedAt: null,
    });
    const attachmentRepo = {
      findByIds: jest.fn().mockResolvedValue([
        ...formats.map(([id, mimeType, fileExt]) =>
          attachment(id, mimeType, fileExt),
        ),
        // An active format must not enter the raster conversion boundary even
        // when the extension is deliberately misleading.
        attachment('svg-as-png', 'image/svg+xml', '.png'),
      ]),
    };
    const service = new KnowledgeSourceExporterService(
      pageRepo as unknown as PageRepo,
      backlinkRepo as unknown as BacklinkRepo,
      attachmentRepo as unknown as AttachmentRepo,
    );

    const [snapshot] = await service.exportSpaceSources({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });

    expect(
      snapshot.images?.map(({ attachmentId, mimeType }) => ({
        attachmentId,
        mimeType,
      })),
    ).toEqual(
      formats.map(([attachmentId, , , mimeType]) => ({
        attachmentId,
        mimeType,
      })),
    );
  });
});

function createEmptyAttachmentRepo(): AttachmentRepo {
  return {
    findByIds: jest.fn().mockResolvedValue([]),
  } as unknown as AttachmentRepo;
}
