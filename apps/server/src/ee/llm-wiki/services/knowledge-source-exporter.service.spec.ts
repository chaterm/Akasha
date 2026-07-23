import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { BacklinkRepo } from '@akasha/db/repos/backlink/backlink.repo';
import { KnowledgeSourceExporterService } from './knowledge-source-exporter.service';

describe('KnowledgeSourceExporterService', () => {
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
    );

    const snapshots = await service.exportSpaceSources({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });

    expect(pageRepo.findPagesForKnowledgeExport).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
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
});
