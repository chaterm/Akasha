import { AttachmentType } from '../../../core/attachment/attachment.constants';
import { KnowledgeCitationAttachmentResolverService } from './knowledge-citation-attachment-resolver.service';

const WORKSPACE_ID = 'workspace-1';
const UPDATED_AT = new Date('2026-02-01T00:00:00.000Z');

type OccurrenceOverrides = Partial<{
  occurrenceOrder: number;
  attachmentId: string;
  sourcePageId: string;
  sourceVersion: string;
  sourceContentHash: string;
  attachmentUpdatedAt: Date;
}>;

function occurrence(
  attachmentId: string,
  sourcePageId: string,
  overrides: OccurrenceOverrides = {},
) {
  return {
    occurrenceOrder: 0,
    attachmentId,
    sourcePageId,
    sourceVersion: `${sourcePageId}-version`,
    sourceContentHash: `${attachmentId}-content-hash`,
    attachmentUpdatedAt: UPDATED_AT,
    ...overrides,
  };
}

function sourceRef(
  sourcePageId: string,
  overrides: Partial<{
    sourceVersion: string;
    contentHash: string;
  }> = {},
) {
  return {
    sourcePageId,
    sourceVersion: `${sourcePageId}-version`,
    contentHash: overrides.contentHash ?? 'unused',
    sourceRange: null,
    quoteHash: null,
    ...overrides,
  };
}

function fileAttachment(
  id: string,
  pageId: string,
  overrides: Partial<{
    mimeType: string | null;
    fileExt: string;
    fileName: string;
    fileSize: number | null;
    type: string;
    deletedAt: Date | null;
    workspaceId: string;
    updatedAt: Date;
  }> = {},
) {
  return {
    id,
    pageId,
    workspaceId: WORKSPACE_ID,
    fileName: `${id}.pdf`,
    fileExt: 'pdf',
    mimeType: 'application/pdf',
    fileSize: 42,
    type: AttachmentType.File,
    deletedAt: null,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function createService(overrides: {
  relationRows?: any;
  sourceRefRows?: any;
  attachments?: any[];
  generateAttachmentToken?: jest.Mock;
}) {
  const findChunkAttachmentsByChunkIds = jest
    .fn()
    .mockResolvedValue(overrides.relationRows ?? []);
  const findChunkSourceRefsByChunkIds = jest
    .fn()
    .mockResolvedValue(overrides.sourceRefRows ?? []);
  const findByIds = jest.fn().mockResolvedValue(overrides.attachments ?? []);
  const generateAttachmentToken =
    overrides.generateAttachmentToken ??
    jest
      .fn()
      .mockImplementation(async ({ attachmentId }: any) => `jwt-${attachmentId}`);

  const service = new KnowledgeCitationAttachmentResolverService(
    { findByIds } as any,
    { generateAttachmentToken } as any,
    { getAppUrl: () => 'https://akasha.example.com' } as any,
    { findChunkAttachmentsByChunkIds, findChunkSourceRefsByChunkIds } as any,
  );
  return {
    service,
    findChunkAttachmentsByChunkIds,
    findChunkSourceRefsByChunkIds,
    findByIds,
    generateAttachmentToken,
  };
}

describe('KnowledgeCitationAttachmentResolverService', () => {
  it('resolves attachments by direct-hit chunk order with signed URLs', async () => {
    const { service, findChunkAttachmentsByChunkIds } = createService({
      relationRows: [
        { chunkId: 'chunk-a', attachments: [occurrence('att-a', 'page-a')] },
        { chunkId: 'chunk-b', attachments: [occurrence('att-b', 'page-b')] },
      ],
      sourceRefRows: [
        {
          chunkId: 'chunk-a',
          sources: [sourceRef('page-a', { contentHash: 'att-a-content-hash' })],
        },
        {
          chunkId: 'chunk-b',
          sources: [sourceRef('page-b', { contentHash: 'att-b-content-hash' })],
        },
      ],
      attachments: [
        fileAttachment('att-b', 'page-b', { fileName: 'design.pdf' }),
        fileAttachment('att-a', 'page-a', { fileName: 'readme.pdf' }),
      ],
    });

    const result = await service.resolveAttachments({
      workspaceId: WORKSPACE_ID,
      directHitChunkIds: ['chunk-a', 'chunk-b'],
    });

    expect(result.map((a) => a.attachmentId)).toEqual(['att-a', 'att-b']);
    expect(result[0].url).toBe(
      'https://akasha.example.com/api/files/public/att-a/readme.pdf?jwt=jwt-att-a',
    );
    expect(findChunkAttachmentsByChunkIds).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      chunkIds: ['chunk-a', 'chunk-b'],
    });
  });

  it('does not return attachments from adjacent (non-hit) blocks', async () => {
    // Only chunk-a is a direct hit; the repo only returns relation rows for it.
    const { service } = createService({
      relationRows: [
        { chunkId: 'chunk-a', attachments: [occurrence('att-a', 'page-a')] },
      ],
      sourceRefRows: [
        {
          chunkId: 'chunk-a',
          sources: [sourceRef('page-a', { contentHash: 'att-a-content-hash' })],
        },
      ],
      attachments: [fileAttachment('att-a', 'page-a')],
    });

    const result = await service.resolveAttachments({
      workspaceId: WORKSPACE_ID,
      directHitChunkIds: ['chunk-a'],
    });

    expect(result.map((a) => a.attachmentId)).toEqual(['att-a']);
  });

  it('deduplicates the same attachment across multiple hit blocks (first-wins)', async () => {
    const { service, generateAttachmentToken } = createService({
      relationRows: [
        { chunkId: 'chunk-a', attachments: [occurrence('att-shared', 'page-a')] },
        { chunkId: 'chunk-b', attachments: [occurrence('att-shared', 'page-a')] },
      ],
      sourceRefRows: [
        {
          chunkId: 'chunk-a',
          sources: [
            sourceRef('page-a', { contentHash: 'att-shared-content-hash' }),
          ],
        },
        {
          chunkId: 'chunk-b',
          sources: [
            sourceRef('page-a', { contentHash: 'att-shared-content-hash' }),
          ],
        },
      ],
      attachments: [fileAttachment('att-shared', 'page-a')],
    });

    const result = await service.resolveAttachments({
      workspaceId: WORKSPACE_ID,
      directHitChunkIds: ['chunk-a', 'chunk-b'],
    });

    expect(result.map((a) => a.attachmentId)).toEqual(['att-shared']);
    expect(generateAttachmentToken).toHaveBeenCalledTimes(1);
  });

  it('skips an attachment whose attachment_updated_at no longer matches', async () => {
    const { service } = createService({
      relationRows: [
        {
          chunkId: 'chunk-a',
          attachments: [
            occurrence('att-stale', 'page-a', {
              attachmentUpdatedAt: new Date('2026-01-01T00:00:00.000Z'),
            }),
          ],
        },
      ],
      sourceRefRows: [
        {
          chunkId: 'chunk-a',
          sources: [
            sourceRef('page-a', { contentHash: 'att-stale-content-hash' }),
          ],
        },
      ],
      // Live attachment updatedAt differs from the relation snapshot.
      attachments: [
        fileAttachment('att-stale', 'page-a', {
          updatedAt: new Date('2026-03-01T00:00:00.000Z'),
        }),
      ],
    });

    const result = await service.resolveAttachments({
      workspaceId: WORKSPACE_ID,
      directHitChunkIds: ['chunk-a'],
    });

    expect(result).toEqual([]);
  });

  it('skips an attachment whose source_content_hash no longer matches the chunk source', async () => {
    const { service } = createService({
      relationRows: [
        { chunkId: 'chunk-a', attachments: [occurrence('att-a', 'page-a')] },
      ],
      sourceRefRows: [
        {
          chunkId: 'chunk-a',
          sources: [sourceRef('page-a', { contentHash: 'different-hash' })],
        },
      ],
      attachments: [fileAttachment('att-a', 'page-a')],
    });

    const result = await service.resolveAttachments({
      workspaceId: WORKSPACE_ID,
      directHitChunkIds: ['chunk-a'],
    });

    expect(result).toEqual([]);
  });

  it('skips image attachments even when related to a hit block', async () => {
    const { service } = createService({
      relationRows: [
        { chunkId: 'chunk-a', attachments: [occurrence('att-img', 'page-a')] },
      ],
      sourceRefRows: [
        {
          chunkId: 'chunk-a',
          sources: [
            sourceRef('page-a', { contentHash: 'att-img-content-hash' }),
          ],
        },
      ],
      attachments: [
        fileAttachment('att-img', 'page-a', {
          mimeType: 'image/png',
          fileExt: 'png',
          fileName: 'diagram.png',
        }),
      ],
    });

    const result = await service.resolveAttachments({
      workspaceId: WORKSPACE_ID,
      directHitChunkIds: ['chunk-a'],
    });

    expect(result).toEqual([]);
  });

  it('skips a generic-MIME image identified only by extension (e.g. octet-stream + .apng)', async () => {
    const { service } = createService({
      relationRows: [
        { chunkId: 'chunk-a', attachments: [occurrence('att-img', 'page-a')] },
      ],
      sourceRefRows: [
        {
          chunkId: 'chunk-a',
          sources: [
            sourceRef('page-a', { contentHash: 'att-img-content-hash' }),
          ],
        },
      ],
      attachments: [
        fileAttachment('att-img', 'page-a', {
          mimeType: 'application/octet-stream',
          fileExt: 'apng',
          fileName: 'diagram.apng',
        }),
      ],
    });

    const result = await service.resolveAttachments({
      workspaceId: WORKSPACE_ID,
      directHitChunkIds: ['chunk-a'],
    });

    expect(result).toEqual([]);
  });

  it('skips a signing failure and keeps filling up to five valid attachments', async () => {
    const relationRows = Array.from({ length: 7 }, (_, index) => ({
      chunkId: `chunk-${index}`,
      attachments: [occurrence(`att-${index}`, `page-${index}`)],
    }));
    const sourceRefRows = Array.from({ length: 7 }, (_, index) => ({
      chunkId: `chunk-${index}`,
      sources: [
        sourceRef(`page-${index}`, { contentHash: `att-${index}-content-hash` }),
      ],
    }));
    const attachments = Array.from({ length: 7 }, (_, index) =>
      fileAttachment(`att-${index}`, `page-${index}`),
    );
    // att-1 fails signing; the resolver must skip it and continue to reach 5.
    const generateAttachmentToken = jest
      .fn()
      .mockImplementation(async ({ attachmentId }: any) => {
        if (attachmentId === 'att-1') throw new Error('signing failed');
        return `jwt-${attachmentId}`;
      });
    const { service } = createService({
      relationRows,
      sourceRefRows,
      attachments,
      generateAttachmentToken,
    });

    const result = await service.resolveAttachments({
      workspaceId: WORKSPACE_ID,
      directHitChunkIds: relationRows.map((row) => row.chunkId),
    });

    expect(result.map((a) => a.attachmentId)).toEqual([
      'att-0',
      'att-2',
      'att-3',
      'att-4',
      'att-5',
    ]);
  });

  it('returns only the recompiled page attachment in a mixed old/new space (§11.4)', async () => {
    // chunk-old is a pre-WP4 block: it is a direct hit but has no relation row
    // (empty attachments). chunk-new was recompiled after WP4 and carries one.
    const { service } = createService({
      relationRows: [
        { chunkId: 'chunk-old', attachments: [] },
        { chunkId: 'chunk-new', attachments: [occurrence('att-new', 'page-new')] },
      ],
      sourceRefRows: [
        { chunkId: 'chunk-old', sources: [sourceRef('page-old')] },
        {
          chunkId: 'chunk-new',
          sources: [
            sourceRef('page-new', { contentHash: 'att-new-content-hash' }),
          ],
        },
      ],
      attachments: [fileAttachment('att-new', 'page-new')],
    });

    const result = await service.resolveAttachments({
      workspaceId: WORKSPACE_ID,
      directHitChunkIds: ['chunk-old', 'chunk-new'],
    });

    expect(result.map((a) => a.attachmentId)).toEqual(['att-new']);
  });

  it('returns [] when the relation query fails (fail-safe)', async () => {
    const { service } = createService({});
    (service as any).capsuleRepo.findChunkAttachmentsByChunkIds = jest
      .fn()
      .mockRejectedValue(new Error('db down'));

    const result = await service.resolveAttachments({
      workspaceId: WORKSPACE_ID,
      directHitChunkIds: ['chunk-a'],
    });

    expect(result).toEqual([]);
  });

  it('returns [] for an empty directHitChunkIds set without touching the repo', async () => {
    const { service, findChunkAttachmentsByChunkIds } = createService({});

    const result = await service.resolveAttachments({
      workspaceId: WORKSPACE_ID,
      directHitChunkIds: [],
    });

    expect(result).toEqual([]);
    expect(findChunkAttachmentsByChunkIds).not.toHaveBeenCalled();
  });

  it('returns [] when the capsule repo is not injected (DI fail-safe)', async () => {
    const service = new KnowledgeCitationAttachmentResolverService(
      { findByIds: jest.fn() } as any,
      { generateAttachmentToken: jest.fn() } as any,
      { getAppUrl: () => 'https://akasha.example.com' } as any,
    );

    const result = await service.resolveAttachments({
      workspaceId: WORKSPACE_ID,
      directHitChunkIds: ['chunk-a'],
    });

    expect(result).toEqual([]);
  });
});
