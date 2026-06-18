import { createHash } from 'crypto';
import { KnowledgeCapsuleRepo } from '@docmost/db/repos/llm-wiki/knowledge-capsule.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { KnowledgeSourceAuthorizationService } from './knowledge-source-authorization.service';
import { KnowledgeCitationResolverService } from './knowledge-citation-resolver.service';

describe('KnowledgeCitationResolverService', () => {
  it('resolves citations only from finally readable dependency source pages', async () => {
    const capsuleRepo = {
      findDependencySourcePageIds: jest
        .fn()
        .mockResolvedValueOnce(['source-1', 'source-2'])
        .mockResolvedValueOnce(['source-3']),
    };
    const sourceAuthorization = {
      filterReadableSources: jest
        .fn()
        .mockResolvedValueOnce(['source-1'])
        .mockResolvedValueOnce(['source-3']),
    };
    const pageRepo = {
      findManyByIds: jest
        .fn()
        .mockResolvedValue([
          page('source-1', 'Readable 1', 'slug-1'),
          page('source-3', 'Readable 3', 'slug-3'),
        ]),
    };
    const service = new KnowledgeCitationResolverService(
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
      sourceAuthorization as unknown as KnowledgeSourceAuthorizationService,
      pageRepo as unknown as PageRepo,
    );

    await expect(
      service.resolveForCapsules({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        capsules: [capsule('kp-1'), capsule('kp-2')],
      }),
    ).resolves.toEqual([
      {
        capsule: capsule('kp-1'),
        citations: [
          {
            sourcePageId: 'source-1',
            title: 'Readable 1',
            url: '/p/slug-1',
          },
        ],
      },
      {
        capsule: capsule('kp-2'),
        citations: [
          {
            sourcePageId: 'source-3',
            title: 'Readable 3',
            url: '/p/slug-3',
          },
        ],
      },
    ]);

    expect(sourceAuthorization.filterReadableSources).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      sourcePageIds: ['source-1', 'source-2'],
    });
    expect(pageRepo.findManyByIds).toHaveBeenCalledWith(
      ['source-1', 'source-3'],
      { workspaceId: 'workspace-1' },
    );
  });

  it('does not query pages when there are no readable dependency sources', async () => {
    const pageRepo = {
      findManyByIds: jest.fn(),
    };
    const service = new KnowledgeCitationResolverService(
      {
        findDependencySourcePageIds: jest.fn().mockResolvedValue(['source-1']),
      } as unknown as KnowledgeCapsuleRepo,
      {
        filterReadableSources: jest.fn().mockResolvedValue([]),
      } as unknown as KnowledgeSourceAuthorizationService,
      pageRepo as unknown as PageRepo,
    );

    await expect(
      service.resolveForCapsules({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        capsules: [capsule('kp-1')],
      }),
    ).resolves.toEqual([{ capsule: capsule('kp-1'), citations: [] }]);

    expect(pageRepo.findManyByIds).not.toHaveBeenCalled();
  });

  it('resolves chunk citations from the chunk source pages without falling back to whole capsule dependencies', async () => {
    const capsuleRepo = {
      findDependencySourcePageIds: jest.fn(),
      findChunkSourceRefsByChunkIds: jest.fn().mockResolvedValue([]),
    };
    const sourceAuthorization = {
      filterReadableSources: jest.fn(),
    };
    const pageRepo = {
      findManyByIds: jest
        .fn()
        .mockResolvedValue([
          page('source-date', 'Chaterm', 'chaterm-MKu8iUqhlD'),
          page('source-kms', 'KMS_Blog', 'kms-blog'),
        ]),
    };
    const service = new KnowledgeCitationResolverService(
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
      sourceAuthorization as unknown as KnowledgeSourceAuthorizationService,
      pageRepo as unknown as PageRepo,
    );

    await expect(
      service.resolveForChunks({
        workspaceId: 'workspace-1',
        chunks: [
          {
            chunk: chunk('chunk-date', 'kp-chaterm'),
            page: capsule('kp-chaterm', 'Chaterm'),
            sourcePageIds: ['source-date'],
            rankReasons: [],
          },
          {
            chunk: chunk('chunk-kms', 'kp-kms'),
            page: capsule('kp-kms', 'KMS_Blog'),
            sourcePageIds: ['source-kms'],
            rankReasons: [],
          },
        ],
      }),
    ).resolves.toEqual([
      {
        chunk: chunk('chunk-date', 'kp-chaterm'),
        pageTitle: 'Chaterm',
        retrievalReasons: [],
        sourceWindows: [],
        warnings: [],
        citations: [
          {
            sourcePageId: 'source-date',
            title: 'Chaterm',
            url: '/p/chaterm-MKu8iUqhlD',
          },
        ],
      },
      {
        chunk: chunk('chunk-kms', 'kp-kms'),
        pageTitle: 'KMS_Blog',
        retrievalReasons: [],
        sourceWindows: [],
        warnings: [],
        citations: [
          {
            sourcePageId: 'source-kms',
            title: 'KMS_Blog',
            url: '/p/kms-blog',
          },
        ],
      },
    ]);

    expect(capsuleRepo.findDependencySourcePageIds).not.toHaveBeenCalled();
    expect(sourceAuthorization.filterReadableSources).not.toHaveBeenCalled();
    expect(pageRepo.findManyByIds).toHaveBeenCalledWith(
      ['source-date', 'source-kms'],
      { workspaceId: 'workspace-1', includeTextContent: true },
    );
  });

  it('returns source windows only when source range and quote hash validate against readable page text', async () => {
    const sourceText = 'Before exact supporting quote after';
    const quote = 'exact supporting quote';
    const sourceRange = {
      startOffset: sourceText.indexOf(quote),
      endOffset: sourceText.indexOf(quote) + quote.length,
    };
    const capsuleRepo = {
      findDependencySourcePageIds: jest.fn(),
      findChunkSourceRefsByChunkIds: jest.fn().mockResolvedValue([
        {
          chunkId: 'chunk-1',
          sources: [
            {
              sourcePageId: 'source-readable',
              sourceVersion: 'v1',
              contentHash: 'sha256:readable',
              sourceRange,
              quoteHash: quoteHash(quote),
            },
            {
              sourcePageId: 'source-readable-invalid',
              sourceVersion: 'v1',
              contentHash: 'sha256:invalid',
              sourceRange,
              quoteHash: quoteHash('wrong quote'),
            },
            {
              sourcePageId: 'source-not-in-final-result',
              sourceVersion: 'v1',
              contentHash: 'sha256:hidden',
              sourceRange,
              quoteHash: quoteHash(quote),
            },
          ],
        },
      ]),
    };
    const pageRepo = {
      findManyByIds: jest
        .fn()
        .mockResolvedValue([
          page('source-readable', 'Readable', 'readable', sourceText),
          page(
            'source-readable-invalid',
            'Invalid readable',
            'invalid',
            sourceText,
          ),
        ]),
    };
    const service = new KnowledgeCitationResolverService(
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
      {
        filterReadableSources: jest.fn(),
      } as unknown as KnowledgeSourceAuthorizationService,
      pageRepo as unknown as PageRepo,
    );

    await expect(
      service.resolveForChunks({
        workspaceId: 'workspace-1',
        chunks: [
          {
            chunk: chunk('chunk-1', 'kp-1'),
            page: capsule('kp-1', 'Readable summary'),
            sourcePageIds: ['source-readable', 'source-readable-invalid'],
            rankReasons: ['lexical', 'sidecar-prefiltered'],
          },
        ],
      }),
    ).resolves.toEqual([
      {
        chunk: chunk('chunk-1', 'kp-1'),
        pageTitle: 'Readable summary',
        retrievalReasons: ['lexical', 'sidecar-prefiltered'],
        warnings: [],
        citations: [
          {
            sourcePageId: 'source-readable',
            title: 'Readable',
            url: '/p/readable',
          },
          {
            sourcePageId: 'source-readable-invalid',
            title: 'Invalid readable',
            url: '/p/invalid',
          },
        ],
        sourceWindows: [
          {
            sourcePageId: 'source-readable',
            title: 'Readable',
            url: '/p/readable',
            text: quote,
            sourceRange,
            quoteHash: quoteHash(quote),
          },
        ],
      },
    ]);

    expect(capsuleRepo.findChunkSourceRefsByChunkIds).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      chunkIds: ['chunk-1'],
    });
    expect(JSON.stringify(pageRepo.findManyByIds.mock.calls)).not.toContain(
      'source-not-in-final-result',
    );
  });
});

function capsule(id: string, title = `Title ${id}`) {
  return {
    id,
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    compileScope: 'space',
    title,
    slug: id,
    pageType: null,
    body: `Body ${id}`,
    summary: null,
    compiledAt: new Date('2026-06-16T00:00:00.000Z'),
    compilerVersion: 'compiler@1',
    compilerRunId: 'run-1',
    compileTaskId: 'task-1',
    staleAt: null,
    createdAt: new Date('2026-06-16T00:00:00.000Z'),
    updatedAt: new Date('2026-06-16T00:00:00.000Z'),
  };
}

function chunk(id: string, knowledgePageId: string) {
  return {
    id,
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    knowledgePageId,
    claimId: null,
    text: `Text ${id}`,
    contentHash: `hash-${id}`,
    embedding: [0.1, 0.2],
    compilerRunId: 'run-1',
    compileTaskId: 'task-1',
    staleAt: null,
    createdAt: new Date('2026-06-16T00:00:00.000Z'),
  };
}

function page(id: string, title: string, slugId: string, textContent?: string) {
  return {
    id,
    title,
    slugId,
    textContent,
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    deletedAt: null,
  };
}

function quoteHash(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  return `sha256:${createHash('sha256').update(normalized).digest('hex')}`;
}
