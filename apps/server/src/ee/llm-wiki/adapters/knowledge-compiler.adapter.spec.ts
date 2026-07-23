import { KnowledgeCompilerAdapter } from './knowledge-compiler.adapter';
import {
  CompileSpaceInput,
  CompileSpaceResult,
} from '../types/compiler-artifact.types';

class DummyKnowledgeCompilerAdapter implements KnowledgeCompilerAdapter {
  async compileSpace(input: CompileSpaceInput): Promise<CompileSpaceResult> {
    return {
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
      sources: input.sources,
      compilerVersion: 'dummy-compiler@1',
      promptVersion: 'dummy-prompt@1',
      compilerRunId: 'run_001',
      artifacts: [
        {
          workspaceId: input.workspaceId,
          spaceId: input.spaceId,
          artifactId: 'artifact_001',
          title: 'Compiled wiki',
          contentMarkdown: '# Compiled wiki',
          sourcePageIds: input.sources.map((source) => source.sourcePageId),
          compilerVersion: 'dummy-compiler@1',
          promptVersion: 'dummy-prompt@1',
          compilerRunId: 'run_001',
        },
      ],
      diagnostics: {
        warnings: [],
        errors: [],
      },
    };
  }
}

describe('KnowledgeCompilerAdapter', () => {
  it('allows an adapter implementation to return a compile result', async () => {
    const adapter: KnowledgeCompilerAdapter = new DummyKnowledgeCompilerAdapter();
    const input: CompileSpaceInput = {
      workspaceId: 'workspace_001',
      spaceId: 'space_001',
      sources: [
        {
          workspaceId: 'workspace_001',
          spaceId: 'space_001',
          sourcePageId: 'page_001',
          sourceVersion: 'version_001',
          contentHash: 'sha256:source',
          title: 'Page',
          text: 'Body',
          references: [],
        },
      ],
      compilerVersion: 'dummy-compiler@1',
      promptVersion: 'dummy-prompt@1',
    };

    const result = await adapter.compileSpace(input);

    expect(result).toMatchObject({
      workspaceId: 'workspace_001',
      spaceId: 'space_001',
      compilerVersion: 'dummy-compiler@1',
      promptVersion: 'dummy-prompt@1',
      compilerRunId: 'run_001',
      diagnostics: {
        warnings: [],
        errors: [],
      },
    });
    expect(result.sources).toHaveLength(1);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].rawArtifactKey).toBeUndefined();
  });
});
