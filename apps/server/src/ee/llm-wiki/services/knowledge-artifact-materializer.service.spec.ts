import { KnowledgeArtifactContribution } from '@akasha/db/types/entity.types';
import { KnowledgeCompilerLlmProvider } from '../compiler/knowledge-compiler-llm.provider';
import { CompiledKnowledgeArtifact } from '../types/compiler-artifact.types';
import { KnowledgeArtifactMaterializerService } from './knowledge-artifact-materializer.service';

describe('KnowledgeArtifactMaterializerService', () => {
  it('materializes a single source contribution without another LLM call', async () => {
    const provider = createProvider();
    const service = new KnowledgeArtifactMaterializerService(provider);
    const incoming = artifact('page-1', 'Source title', 'New body');

    await expect(
      service.materializeSourceUpdate({
        sourcePageId: 'page-1',
        previousSourceContributions: [],
        affectedContributions: [],
        incomingArtifacts: [incoming],
      }),
    ).resolves.toEqual({
      artifacts: [incoming],
      removedArtifactIds: [],
    });
    expect(provider.completeMerge).not.toHaveBeenCalled();
  });

  it('merges multiple source contributions and unions typed lineage', async () => {
    const provider = createProvider();
    provider.completeMerge.mockResolvedValue(
      JSON.stringify({ title: 'Event sourcing', markdown: 'Merged body' }),
    );
    const service = new KnowledgeArtifactMaterializerService(provider);
    const incoming = artifact('page-1', 'Event sourcing', 'Incoming body');
    const other = artifact('page-2', 'Event sourcing', 'Existing body');

    const result = await service.materializeSourceUpdate({
      sourcePageId: 'page-1',
      previousSourceContributions: [],
      affectedContributions: [contribution('page-2', other)],
      incomingArtifacts: [incoming],
    });

    expect(provider.completeMerge).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('strict JSON'),
        prompt: expect.stringContaining('Incoming body'),
      }),
    );
    expect(result.artifacts[0]).toMatchObject({
      title: 'Event sourcing',
      contentMarkdown: 'Merged body',
      sourcePageIds: ['page-1', 'page-2'],
      inputSourceRefs: [
        expect.objectContaining({ sourcePageId: 'page-1' }),
        expect.objectContaining({ sourcePageId: 'page-2' }),
      ],
    });
  });

  it('marks an old artifact removed when the updated source no longer contributes it', async () => {
    const provider = createProvider();
    const service = new KnowledgeArtifactMaterializerService(provider);
    const previous = contribution(
      'page-1',
      artifact('page-1', 'Retracted concept', 'Old body', 'artifact-old'),
    );

    await expect(
      service.materializeSourceUpdate({
        sourcePageId: 'page-1',
        previousSourceContributions: [previous],
        affectedContributions: [previous],
        incomingArtifacts: [],
      }),
    ).resolves.toEqual({ artifacts: [], removedArtifactIds: ['artifact-old'] });
  });

  it('fails the source update when a shared artifact merge fails', async () => {
    const provider = createProvider();
    provider.completeMerge.mockRejectedValue(new Error('provider failed'));
    const service = new KnowledgeArtifactMaterializerService(provider);

    await expect(
      service.materializeSourceUpdate({
        sourcePageId: 'page-1',
        previousSourceContributions: [],
        affectedContributions: [
          contribution(
            'page-2',
            artifact('page-2', 'Shared', 'Existing body'),
          ),
        ],
        incomingArtifacts: [artifact('page-1', 'Shared', 'Incoming body')],
      }),
    ).rejects.toThrow('provider failed');
  });

  it('keeps the current source run metadata on a shared materialization', async () => {
    const provider = createProvider();
    provider.completeMerge.mockResolvedValue(
      JSON.stringify({ title: 'Shared', markdown: 'Merged body' }),
    );
    const service = new KnowledgeArtifactMaterializerService(provider);
    const current = artifact('page-2', 'Shared', 'Current body');
    const existing = artifact('page-1', 'Shared', 'Existing body');

    const result = await service.materializeSourceUpdate({
      sourcePageId: 'page-2',
      previousSourceContributions: [],
      affectedContributions: [contribution('page-1', existing)],
      incomingArtifacts: [current],
    });

    expect(result.artifacts[0]).toMatchObject({
      compilerRunId: 'run-page-2',
      compileTaskId: 'task-page-2',
    });
  });
});

function createProvider() {
  return {
    analyze: jest.fn(),
    generate: jest.fn(),
    completeMerge: jest.fn(),
  } as unknown as jest.Mocked<KnowledgeCompilerLlmProvider>;
}

function artifact(
  sourcePageId: string,
  title: string,
  contentMarkdown: string,
  artifactId = 'artifact-shared',
): CompiledKnowledgeArtifact {
  const sourceRef = {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    sourcePageId,
    sourceVersion: 'v1',
    contentHash: `hash-${sourcePageId}`,
  };
  return {
    artifactId,
    artifactKind: 'concept',
    canonicalKey: 'event-sourcing',
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    title,
    contentMarkdown,
    sourcePageIds: [sourcePageId],
    compilerVersion: 'compiler-v1',
    promptVersion: 'prompt-v1',
    compilerRunId: `run-${sourcePageId}`,
    compileTaskId: `task-${sourcePageId}`,
    inputSourceRefs: [sourceRef],
    claims: [{ text: `${title} claim`, inputSourceRefs: [sourceRef] }],
    chunks: [{ text: `${title} chunk`, inputSourceRefs: [sourceRef] }],
    links: [],
    graphEdges: [],
  };
}

function contribution(
  sourcePageId: string,
  value: CompiledKnowledgeArtifact,
): KnowledgeArtifactContribution {
  return {
    id: `contribution-${sourcePageId}`,
    workspaceId: value.workspaceId,
    spaceId: value.spaceId,
    sourcePageId,
    sourceVersion: 'v1',
    sourceContentHash: `hash-${sourcePageId}`,
    artifactId: value.artifactId,
    artifactKind: value.artifactKind!,
    canonicalKey: value.canonicalKey!,
    compilerVersion: value.compilerVersion,
    promptVersion: value.promptVersion,
    compilerRunId: value.compilerRunId!,
    compileTaskId: value.compileTaskId!,
    artifact: value as never,
    createdAt: new Date('2026-07-21T00:00:00.000Z'),
    updatedAt: new Date('2026-07-21T00:00:00.000Z'),
  };
}
