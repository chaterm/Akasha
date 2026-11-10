import { KnowledgeSourceRetirementService } from './knowledge-source-retirement.service';

describe('KnowledgeSourceRetirementService', () => {
  it('does not retire a contribution that still belongs to the live page Space', async () => {
    const fixture = createFixture({ liveSpaceId: 'space-1' });

    await expect(
      fixture.service.retireOutOfScopeSources({
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1'],
      }),
    ).resolves.toEqual({
      retiredSourceCount: 0,
      skippedActiveSourceCount: 1,
      affectedSpaceCount: 0,
    });
    expect(fixture.importService.importCompileResult).not.toHaveBeenCalled();
  });

  it('materializes survivors behind a contribution snapshot fence', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.retireOutOfScopeSources({
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1'],
      }),
    ).resolves.toEqual({
      retiredSourceCount: 1,
      skippedActiveSourceCount: 0,
      affectedSpaceCount: 1,
    });

    expect(fixture.importService.importCompileResult).toHaveBeenCalledWith(
      expect.objectContaining({
        artifacts: [],
        upsertSources: false,
        retireSources: true,
        input: expect.objectContaining({
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          compileMode: 'pages',
          sources: [
            expect.objectContaining({
              sourcePageId: 'page-1',
              sourceVersion: 'v1',
              contentHash: 'hash-1',
            }),
          ],
        }),
        publicationGuard: expect.any(Function),
      }),
    );
    expect(fixture.linkResolver.resolveSpace).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
  });

  it.each([
    { name: 'hard deletion', liveSpaceId: undefined, deleted: false },
    { name: 'soft deletion', liveSpaceId: 'space-1', deleted: true },
    { name: 'cross-Space move', liveSpaceId: 'space-2', deleted: false },
  ])('retires an original index after $name without an LLM', async (state) => {
    const fixture = createFixture({ ...state, original: true });

    await expect(
      fixture.service.retireOutOfScopeSources({
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1'],
      }),
    ).resolves.toEqual({
      retiredSourceCount: 1,
      skippedActiveSourceCount: 0,
      affectedSpaceCount: 1,
    });

    const scope = {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageIds: ['page-1'],
    };
    expect(fixture.sourceRepo.markSpaceSourcesStale).toHaveBeenCalledWith(
      scope,
      fixture.transactionQuery,
    );
    expect(
      fixture.capsuleRepo.markSourceArtifactsStaleBySourcePageIds,
    ).toHaveBeenCalledWith(scope, fixture.transactionQuery);
    expect(fixture.importService.importCompileResult).not.toHaveBeenCalled();
    expect(fixture.query.forUpdate).toHaveBeenCalledTimes(1);
    expect(fixture.linkResolver.resolveSpace).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
  });

  it('preserves the rebuilt original index in the destination Space', async () => {
    const fixture = createFixture({ original: true, liveSpaceId: 'space-2' });
    fixture.capsuleRepo.findSourceArtifactScopes.mockResolvedValue([
      { sourcePageId: 'page-1', spaceId: 'space-1' },
      { sourcePageId: 'page-1', spaceId: 'space-2' },
    ]);

    await expect(
      fixture.service.retireOutOfScopeSources({
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1'],
      }),
    ).resolves.toEqual({
      retiredSourceCount: 1,
      skippedActiveSourceCount: 1,
      affectedSpaceCount: 1,
    });
    expect(
      fixture.capsuleRepo.markSourceArtifactsStaleBySourcePageIds,
    ).toHaveBeenCalledTimes(1);
    expect(fixture.sourceRepo.markSpaceSourcesStale).toHaveBeenCalledTimes(1);
  });

  it('does not retire an original index after the page moves back before cleanup', async () => {
    const fixture = createFixture({ original: true, liveSpaceId: 'space-2' });
    fixture.query.executeTakeFirst
      .mockResolvedValueOnce({ spaceId: 'space-2', deletedAt: null })
      .mockResolvedValueOnce({ spaceId: 'space-1', deletedAt: null });

    await expect(
      fixture.service.retireOutOfScopeSources({
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1'],
      }),
    ).resolves.toEqual({
      retiredSourceCount: 0,
      skippedActiveSourceCount: 0,
      affectedSpaceCount: 0,
    });
    expect(fixture.sourceRepo.markSpaceSourcesStale).not.toHaveBeenCalled();
    expect(
      fixture.capsuleRepo.markSourceArtifactsStaleBySourcePageIds,
    ).not.toHaveBeenCalled();
    expect(fixture.linkResolver.resolveSpace).not.toHaveBeenCalled();
  });

  it('retires a source only once when both discovery paths find it', async () => {
    const fixture = createFixture();
    fixture.capsuleRepo.findSourceArtifactScopes.mockResolvedValue([
      { sourcePageId: 'page-1', spaceId: 'space-1' },
    ]);

    const result = await fixture.service.retireOutOfScopeSources({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1'],
    });

    expect(result.retiredSourceCount).toBe(1);
    expect(fixture.importService.importCompileResult).toHaveBeenCalledTimes(1);
  });
});

function createFixture(
  input: { liveSpaceId?: string; deleted?: boolean; original?: boolean } = {},
) {
  const contribution = {
    id: 'contribution-1',
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    sourcePageId: 'page-1',
    sourceVersion: 'v1',
    sourceContentHash: 'hash-1',
    artifactId: 'artifact-1',
    artifactKind: 'concept',
    canonicalKey: 'concept-1',
    compilerVersion: 'compiler-v1',
    promptVersion: 'prompt-v1',
    compilerRunId: 'run-1',
    compileTaskId: 'task-1',
    artifact: { artifactId: 'artifact-1', contentMarkdown: 'body' },
  };
  const contributionRepo = {
    findSourceScopes: jest
      .fn()
      .mockResolvedValue(
        input.original ? [] : [{ sourcePageId: 'page-1', spaceId: 'space-1' }],
      ),
    findBySourcePage: jest
      .fn()
      .mockResolvedValue(input.original ? [] : [contribution]),
    findByArtifactIds: jest.fn().mockResolvedValue([contribution]),
  };
  const query = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    forUpdate: jest.fn().mockReturnThis(),
    $if: jest
      .fn()
      .mockImplementation((condition, callback) =>
        condition ? callback(query) : query,
      ),
    execute: jest.fn().mockResolvedValue(
      input.liveSpaceId
        ? [
            {
              id: 'page-1',
              spaceId: input.liveSpaceId,
              deletedAt: input.deleted ? new Date() : null,
            },
          ]
        : [],
    ),
    executeTakeFirst: jest.fn().mockResolvedValue(
      input.liveSpaceId
        ? {
            spaceId: input.liveSpaceId,
            deletedAt: input.deleted ? new Date() : null,
          }
        : undefined,
    ),
  };
  const db = { selectFrom: jest.fn().mockReturnValue(query) };
  const transactionQuery = {
    selectFrom: jest.fn().mockReturnValue(query),
  };
  Object.assign(db, {
    transaction: jest.fn().mockReturnValue({
      execute: jest
        .fn()
        .mockImplementation((callback) => callback(transactionQuery)),
    }),
  });
  const importService = {
    importCompileResult: jest.fn().mockImplementation(async (request) => {
      const allowed = await request.publicationGuard(transactionQuery);
      return allowed
        ? { importedArtifactCount: 1, quarantinedArtifactCount: 0 }
        : {
            importedArtifactCount: 0,
            quarantinedArtifactCount: 0,
            skippedReason: 'run_superseded',
          };
    }),
  };
  const linkResolver = { resolveSpace: jest.fn() };
  const capsuleRepo = {
    findSourceArtifactScopes: jest
      .fn()
      .mockResolvedValue(
        input.original ? [{ sourcePageId: 'page-1', spaceId: 'space-1' }] : [],
      ),
    markSourceArtifactsStaleBySourcePageIds: jest
      .fn()
      .mockResolvedValue(undefined),
  };
  const sourceRepo = {
    markSpaceSourcesStale: jest.fn().mockResolvedValue(undefined),
  };
  const service = new KnowledgeSourceRetirementService(
    db as never,
    contributionRepo as never,
    importService as never,
    linkResolver as never,
    capsuleRepo as never,
    sourceRepo as never,
  );
  return {
    service,
    contributionRepo,
    importService,
    linkResolver,
    capsuleRepo,
    sourceRepo,
    query,
    transactionQuery,
  };
}
