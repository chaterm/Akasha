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
});

function createFixture(input: { liveSpaceId?: string } = {}) {
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
      .mockResolvedValue([{ sourcePageId: 'page-1', spaceId: 'space-1' }]),
    findBySourcePage: jest.fn().mockResolvedValue([contribution]),
    findByArtifactIds: jest.fn().mockResolvedValue([contribution]),
  };
  const query = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest
      .fn()
      .mockResolvedValue(
        input.liveSpaceId
          ? [{ id: 'page-1', spaceId: input.liveSpaceId, deletedAt: null }]
          : [],
      ),
    executeTakeFirst: jest.fn().mockResolvedValue(undefined),
  };
  const db = { selectFrom: jest.fn().mockReturnValue(query) };
  const transactionQuery = {
    selectFrom: jest.fn().mockReturnValue(query),
  };
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
  const service = new KnowledgeSourceRetirementService(
    db as never,
    contributionRepo as never,
    importService as never,
    linkResolver as never,
  );
  return { service, contributionRepo, importService, linkResolver };
}
