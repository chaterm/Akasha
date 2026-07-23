import { LlmWikiFileCompilerAdapter } from './llm-wiki-file-compiler.adapter';
import { LlmWikiCompilerRunner } from './llm-wiki-file-compiler.runner';

describe('LlmWikiFileCompilerAdapter', () => {
  it('delegates space-scoped compile input to the configured runner', async () => {
    const runner: LlmWikiCompilerRunner = {
      compileSpace: jest.fn().mockResolvedValue({
        compilerRunId: 'run-1',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sources: [],
        compilerVersion: 'compiler@1',
        promptVersion: 'prompt@1',
        artifacts: [],
        diagnostics: { warnings: [], errors: [] },
      }),
    };
    const adapter = new LlmWikiFileCompilerAdapter(runner);

    await expect(
      adapter.compileSpace({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        compilerVersion: 'compiler@1',
        promptVersion: 'prompt@1',
        sources: [
          {
            workspaceId: 'workspace-1',
            spaceId: 'space-1',
            sourcePageId: 'page-1',
            sourceVersion: 'v1',
            contentHash: 'hash-1',
            title: 'Page',
            text: 'Body',
            references: [],
          },
        ],
      }),
    ).resolves.toMatchObject({
      compilerRunId: 'run-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });

    expect(runner.compileSpace).toHaveBeenCalledTimes(1);
  });

  it('rejects sources outside the compile space', async () => {
    const runner: LlmWikiCompilerRunner = {
      compileSpace: jest.fn(),
    };
    const adapter = new LlmWikiFileCompilerAdapter(runner);

    await expect(
      adapter.compileSpace({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        compilerVersion: 'compiler@1',
        promptVersion: 'prompt@1',
        sources: [
          {
            workspaceId: 'workspace-1',
            spaceId: 'space-2',
            sourcePageId: 'page-1',
            sourceVersion: 'v1',
            contentHash: 'hash-1',
            title: 'Page',
            text: 'Body',
            references: [],
          },
        ],
      }),
    ).rejects.toThrow('compile input contains sources outside workspaceId+spaceId');

    expect(runner.compileSpace).not.toHaveBeenCalled();
  });
});
