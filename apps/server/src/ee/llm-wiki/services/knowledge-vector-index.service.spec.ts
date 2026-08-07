import { KnowledgeVectorIndexService } from './knowledge-vector-index.service';

describe('KnowledgeVectorIndexService', () => {
  it('rejects unsafe profiles and invalid dimensions before executing SQL', async () => {
    const service = serviceWithExecutor(jest.fn());

    await expect(
      service.ensureProfileIndex({
        profile: "abc'; DROP TABLE pages",
        dimensions: 3,
      }),
    ).rejects.toThrow('profile');
    await expect(
      service.ensureProfileIndex({ profile: 'a'.repeat(64), dimensions: 0 }),
    ).rejects.toThrow('dimensions');
    await expect(
      service.ensureProfileIndex({ profile: 'a'.repeat(64), dimensions: 3.5 }),
    ).rejects.toThrow('dimensions');
  });

  it('uses exact search when dimensions exceed vector HNSW support', async () => {
    const execute = jest.fn();
    const service = serviceWithExecutor(execute);

    await expect(
      service.ensureProfileIndex({ profile: 'b'.repeat(64), dimensions: 2001 }),
    ).resolves.toBe('exact-only');
    expect(execute).not.toHaveBeenCalled();
  });

  it('creates a profile-scoped expression index with safe identifiers', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ exists: false }] })
      .mockResolvedValueOnce({ rows: [] });
    const service = serviceWithExecutor(execute);

    await expect(
      service.ensureProfileIndex({ profile: 'c'.repeat(64), dimensions: 1024 }),
    ).resolves.toBe('created');

    const ddl = execute.mock.calls[1][0] as string;
    expect(ddl).toContain('idx_kc_hnsw_cccccccccccc_1024');
    expect(ddl).toContain('embedding::vector(1024)');
    expect(ddl).toContain(`embedding_profile = '${'c'.repeat(64)}'`);
    expect(ddl).toContain('embedding_dimensions = 1024');
    expect(ddl).toContain('embedding IS NOT NULL');
  });

  it('returns exists without issuing DDL for an existing profile index', async () => {
    const execute = jest.fn().mockResolvedValue({ rows: [{ exists: true }] });
    const service = serviceWithExecutor(execute);

    await expect(
      service.ensureProfileIndex({ profile: 'd'.repeat(64), dimensions: 768 }),
    ).resolves.toBe('exists');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('coalesces duplicate concurrent index requests', async () => {
    let release: (value: { rows: Array<{ exists: boolean }> }) => void;
    const pending = new Promise<{ rows: Array<{ exists: boolean }> }>(
      (resolve) => {
        release = resolve;
      },
    );
    const execute = jest
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce({ rows: [] });
    const service = serviceWithExecutor(execute);
    const input = { profile: 'e'.repeat(64), dimensions: 1536 };

    const first = service.ensureProfileIndex(input);
    const second = service.ensureProfileIndex(input);
    release!({ rows: [{ exists: false }] });

    await expect(Promise.all([first, second])).resolves.toEqual([
      'created',
      'created',
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('rebuilds embeddings only from existing non-stale chunks and replaces their vector metadata', async () => {
    const embeddingProvider = {
      embedQuery: jest
        .fn()
        .mockResolvedValueOnce({
          vector: [0.1, 0.2],
          profile: 'a'.repeat(64),
          model: 'embedding-v2',
          dimensions: 2,
        })
        .mockResolvedValueOnce({
          vector: [0.3, 0.4],
          profile: 'a'.repeat(64),
          model: 'embedding-v2',
          dimensions: 2,
        }),
    };
    const findActiveChunks = jest.fn().mockResolvedValue([
      {
        id: 'chunk-1',
        text: 'First body',
        headingPath: ['Guide', 'First'],
      },
      { id: 'chunk-2', text: 'Second body', headingPath: [] },
    ]);
    const persistEmbeddings = jest.fn().mockResolvedValue(undefined);
    const ensureProfileIndex = jest.fn().mockResolvedValue('created');
    const service = serviceWithRebuilder({
      embeddingProvider,
      findActiveChunks,
      persistEmbeddings,
      ensureProfileIndex,
    });

    await expect(
      service.rebuildSpaceEmbeddings({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual({ rebuiltChunkCount: 2 });

    expect(findActiveChunks).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      afterChunkId: undefined,
      limit: 50,
    });
    expect(embeddingProvider.embedQuery).toHaveBeenNthCalledWith(
      1,
      'Guide > First\n\nFirst body',
    );
    expect(embeddingProvider.embedQuery).toHaveBeenNthCalledWith(
      2,
      'Second body',
    );
    expect(persistEmbeddings).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      chunks: [
        expect.objectContaining({
          id: 'chunk-1',
          profile: 'a'.repeat(64),
          model: 'embedding-v2',
          dimensions: 2,
          vector: [0.1, 0.2],
        }),
        expect.objectContaining({ id: 'chunk-2', vector: [0.3, 0.4] }),
      ],
    });
    expect(ensureProfileIndex).toHaveBeenCalledWith({
      profile: 'a'.repeat(64),
      dimensions: 2,
    });
  });

  it('commits successful embeddings when one chunk fails', async () => {
    const embeddingProvider = {
      embedQuery: jest
        .fn()
        .mockResolvedValueOnce({
          vector: [0.1],
          profile: 'b'.repeat(64),
          model: 'embedding-v2',
          dimensions: 1,
        })
        .mockResolvedValueOnce(null),
    };
    const persistEmbeddings = jest.fn();
    const service = serviceWithRebuilder({
      embeddingProvider,
      findActiveChunks: jest.fn().mockResolvedValue([
        { id: 'chunk-1', text: 'One', headingPath: [] },
        { id: 'chunk-2', text: 'Two', headingPath: [] },
      ]),
      persistEmbeddings,
      ensureProfileIndex: jest.fn(),
    });

    await expect(
      service.rebuildSpaceEmbeddings({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual({
      rebuiltChunkCount: 1,
      failedChunkIds: ['chunk-2'],
    });
    expect(persistEmbeddings).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      chunks: [expect.objectContaining({ id: 'chunk-1', vector: [0.1] })],
    });
  });

  it('never receives historical overview chunks from the active rebuild query', async () => {
    const embeddingProvider = {
      embedQuery: jest.fn().mockResolvedValue({
        vector: [0.1],
        profile: 'b'.repeat(64),
        model: 'embedding-v2',
        dimensions: 1,
      }),
    };
    const service = serviceWithRebuilder({
      embeddingProvider,
      findActiveChunks: jest.fn().mockResolvedValue([]),
      persistEmbeddings: jest.fn().mockResolvedValue(undefined),
      ensureProfileIndex: jest.fn().mockResolvedValue('created'),
    });

    await service.rebuildSpaceEmbeddings({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });

    expect(embeddingProvider.embedQuery).not.toHaveBeenCalled();
  });

  it('limits a maintenance batch to 50 chunks and embeds at concurrency 2', async () => {
    let active = 0;
    let maxActive = 0;
    const embeddingProvider = {
      embedQuery: jest.fn().mockImplementation(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return {
          vector: [0.1],
          profile: 'c'.repeat(64),
          model: 'embedding-v2',
          dimensions: 1,
        };
      }),
    };
    const chunks = Array.from({ length: 50 }, (_, index) => ({
      id: `chunk-${String(index).padStart(3, '0')}`,
      text: `body-${index}`,
      headingPath: [],
    }));
    const service = serviceWithRebuilder({
      embeddingProvider,
      findActiveChunks: jest.fn().mockResolvedValue(chunks),
      persistEmbeddings: jest.fn().mockResolvedValue(undefined),
      ensureProfileIndex: jest.fn().mockResolvedValue('created'),
    });

    await expect(
      service.rebuildSpaceEmbeddings({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toMatchObject({
      rebuiltChunkCount: 50,
      nextCursor: 'chunk-049',
    });
    expect(maxActive).toBe(2);
    expect(embeddingProvider.embedQuery).toHaveBeenCalledTimes(50);
  });

  it('finishes an empty active chunk scope without provider or database writes', async () => {
    const embeddingProvider = { embedQuery: jest.fn() };
    const persistEmbeddings = jest.fn();
    const ensureProfileIndex = jest.fn();
    const service = serviceWithRebuilder({
      embeddingProvider,
      findActiveChunks: jest.fn().mockResolvedValue([]),
      persistEmbeddings,
      ensureProfileIndex,
    });

    await expect(
      service.rebuildSpaceEmbeddings({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual({ rebuiltChunkCount: 0 });
    expect(embeddingProvider.embedQuery).not.toHaveBeenCalled();
    expect(persistEmbeddings).not.toHaveBeenCalled();
    expect(ensureProfileIndex).not.toHaveBeenCalled();
  });
});

function serviceWithExecutor(execute: jest.Mock): KnowledgeVectorIndexService {
  class TestService extends KnowledgeVectorIndexService {
    protected executeStatement(statement: string) {
      return execute(statement);
    }
  }

  return new TestService({} as never, { embedQuery: jest.fn() } as never);
}

function serviceWithRebuilder(input: {
  embeddingProvider: { embedQuery: jest.Mock };
  findActiveChunks: jest.Mock;
  persistEmbeddings: jest.Mock;
  ensureProfileIndex: jest.Mock;
}): KnowledgeVectorIndexService {
  class TestService extends KnowledgeVectorIndexService {
    protected findActiveChunksForSpace(scope: {
      workspaceId: string;
      spaceId: string;
      afterChunkId?: string;
      limit: number;
    }) {
      return input.findActiveChunks(scope);
    }

    protected persistRebuiltEmbeddings(payload: unknown) {
      return input.persistEmbeddings(payload);
    }

    ensureProfileIndex(scope: { profile: string; dimensions: number }) {
      return input.ensureProfileIndex(scope);
    }
  }

  return new TestService({} as never, input.embeddingProvider as never);
}
