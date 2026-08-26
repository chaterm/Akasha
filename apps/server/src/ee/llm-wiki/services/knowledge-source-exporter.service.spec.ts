import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { BacklinkRepo } from '@akasha/db/repos/backlink/backlink.repo';
import { AttachmentRepo } from '@akasha/db/repos/attachment/attachment.repo';
import { KnowledgeSourceExporterService } from './knowledge-source-exporter.service';

describe('KnowledgeSourceExporterService', () => {
  it('batches requested pages inside one repeatable-read read-only snapshot', async () => {
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
      findPagesByIdsForKnowledgeExport: jest
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
      service.exportPageSources({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: pages.map((page) => page.id),
      }),
    ).resolves.toHaveLength(201);

    expect(setIsolationLevel).toHaveBeenCalledWith('repeatable read');
    expect(setAccessMode).toHaveBeenCalledWith('read only');
    expect(pageRepo.findPagesByIdsForKnowledgeExport).toHaveBeenNthCalledWith(
      1,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        pageIds: pages.slice(0, 200).map((page) => page.id),
      },
      trx,
    );
    expect(pageRepo.findPagesByIdsForKnowledgeExport).toHaveBeenNthCalledWith(
      2,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        pageIds: [pages[200].id],
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
      findPagesByIdsForKnowledgeExport: jest.fn().mockResolvedValue([
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

    const snapshots = await service.exportPageSources({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageIds: ['page-1'],
    });

    expect(pageRepo.findPagesByIdsForKnowledgeExport).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      pageIds: ['page-1'],
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
      findPagesByIdsForKnowledgeExport: jest.fn().mockResolvedValue([
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
      service.exportPageSources({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
      }),
    ).resolves.toMatchObject([{ text: '' }]);
  });

  it('rebuilds table text from structured content instead of stale flattened text', async () => {
    const pageRepo = {
      findPagesByIdsForKnowledgeExport: jest.fn().mockResolvedValue([
        {
          id: 'page-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          title: 'Example inventory',
          textContent:
            'Service Version Primary IP Contact service-alpha 5.7-test 192.0.2.8 owner-a',
          content: {
            type: 'doc',
            content: [
              {
                type: 'table',
                content: [
                  {
                    type: 'tableRow',
                    content: [
                      cell('tableHeader', 'Service'),
                      cell('tableHeader', 'Version'),
                      cell('tableHeader', 'Primary IP'),
                      cell('tableHeader', 'Contact'),
                    ],
                  },
                  {
                    type: 'tableRow',
                    content: [
                      cell('tableCell', 'service-alpha'),
                      cell('tableCell', '5.7-test'),
                      cell('tableCell', '192.0.2.8'),
                      cell('tableCell', 'owner-a'),
                    ],
                  },
                ],
              },
            ],
          },
          updatedAt: new Date('2026-08-25T00:00:00.000Z'),
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

    const [snapshot] = await service.exportPageSources({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageIds: ['page-1'],
    });

    expect(snapshot.text).toContain(
      'Service=service-alpha；Version=5.7-test；Primary IP=192.0.2.8；Contact=owner-a',
    );
    expect(snapshot.text).not.toContain('Service Version Primary IP Contact');
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
        {
          type: 'image',
          attrs: {
            src: '/api/files/00000000-0000-4000-8000-000000000001/diagram-from-src.png',
            alt: 'Imported diagram',
          },
        },
        { type: 'image', attrs: { attachmentId: 'foreign-image' } },
        { type: 'image', attrs: { attachmentId: 'image-1' } },
      ],
    };
    const pageRepo = {
      findPagesByIdsForKnowledgeExport: jest.fn().mockResolvedValue([
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
          id: '00000000-0000-4000-8000-000000000001',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          pageId: 'page-1',
          type: 'file',
          fileName: 'diagram-from-src.png',
          fileExt: '.png',
          fileSize: 4096,
          mimeType: 'image/png',
          updatedAt: new Date('2026-07-27T00:02:00.000Z'),
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

    const [snapshot] = await service.exportPageSources({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageIds: ['page-1'],
    });

    expect(attachmentRepo.findByIds).toHaveBeenCalledWith([
      'image-1',
      '00000000-0000-4000-8000-000000000001',
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
      {
        attachmentId: '00000000-0000-4000-8000-000000000001',
        fileName: 'diagram-from-src.png',
        mimeType: 'image/png',
        fileSize: 4096,
        attachmentVersion: '2026-07-27T00:02:00.000Z',
        altText: 'Imported diagram',
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
      findPagesByIdsForKnowledgeExport: jest.fn().mockResolvedValue([page]),
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

    const [before] = await service.exportPageSources({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageIds: ['page-1'],
    });
    const [after] = await service.exportPageSources({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageIds: ['page-1'],
    });

    expect(after.images?.[0]?.attachmentVersion).not.toBe(
      before.images?.[0]?.attachmentVersion,
    );
    expect(after.contentHash).not.toBe(before.contentHash);
  });

  it('ignores non-image attachment nodes when fingerprinting page content', async () => {
    const page = (fileName: string, fileSize: number) => ({
      id: 'page-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      title: 'Attachment metadata',
      textContent: 'Stable body',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Stable body' }],
          },
          {
            type: 'attachment',
            attrs: {
              attachmentId: 'file-1',
              name: fileName,
              size: fileSize,
              mime: 'application/pdf',
            },
          },
        ],
      },
      updatedAt: new Date('2026-07-27T00:00:00.000Z'),
    });
    const pageRepo = {
      findPagesByIdsForKnowledgeExport: jest
        .fn()
        .mockResolvedValueOnce([page('before.pdf', 100)])
        .mockResolvedValueOnce([page('after.pdf', 200)]),
    };
    const service = new KnowledgeSourceExporterService(
      pageRepo as unknown as PageRepo,
      {
        findOutgoingPageReferences: jest.fn().mockResolvedValue([]),
      } as unknown as BacklinkRepo,
      createEmptyAttachmentRepo(),
    );

    const [before] = await service.exportPageSources({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageIds: ['page-1'],
    });
    const [after] = await service.exportPageSources({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageIds: ['page-1'],
    });

    expect(after.contentHash).toBe(before.contentHash);
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
      findPagesByIdsForKnowledgeExport: jest.fn().mockResolvedValue([
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

    const [snapshot] = await service.exportPageSources({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageIds: ['page-1'],
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

function cell(type: string, text: string) {
  return {
    type,
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text }],
      },
    ],
  };
}
