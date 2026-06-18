import { KnowledgeArtifactValidatorService } from './knowledge-artifact-validator.service';
import {
  CompiledKnowledgeArtifact,
  CompileSpaceInput,
} from '../types/compiler-artifact.types';

describe('KnowledgeArtifactValidatorService', () => {
  const service = new KnowledgeArtifactValidatorService();
  const input: CompileSpaceInput = {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    compilerVersion: 'compiler@1',
    promptVersion: 'prompt@1',
    sources: [
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageId: 'source-1',
        sourceVersion: 'v1',
        contentHash: 'hash-1',
        title: 'Source',
        text: 'Source text',
        references: [],
      },
    ],
  };

  it('accepts artifacts whose scope and synthesis lineage match the compile input', () => {
    const artifact = validArtifact();

    expect(
      service.validateCompileResult({ input, artifacts: [artifact] }),
    ).toEqual({
      accepted: [artifact],
      quarantined: [],
    });
  });

  it('quarantines artifacts outside the compile scope', () => {
    const artifact = { ...validArtifact(), spaceId: 'space-2' };

    const result = service.validateCompileResult({
      input,
      artifacts: [artifact],
    });

    expect(result.accepted).toEqual([]);
    expect(result.quarantined).toMatchObject([
      {
        artifact,
        reasons: ['artifact scope does not match compile scope'],
      },
    ]);
  });

  it('quarantines artifacts whose artifact id cannot be stored as a UUID', () => {
    const artifact = { ...validArtifact(), artifactId: 'not-a-uuid' };

    const result = service.validateCompileResult({
      input,
      artifacts: [artifact],
    });

    expect(result.accepted).toEqual([]);
    expect(result.quarantined[0].reasons).toEqual([
      'artifact id must be a UUID',
    ]);
  });

  it('quarantines synthesis artifacts with missing lineage', () => {
    const artifact = {
      ...validArtifact(),
      compilerRunId: undefined,
      compileTaskId: undefined,
      inputSourceRefs: [],
    };

    const result = service.validateCompileResult({
      input,
      artifacts: [artifact],
    });

    expect(result.accepted).toEqual([]);
    expect(result.quarantined[0].reasons).toEqual([
      'synthesis lineage is incomplete',
    ]);
  });

  it('quarantines artifacts whose artifact kind is unsupported', () => {
    const artifact = {
      ...validArtifact(),
      artifactKind: 'unsupported_kind',
    } as unknown as CompiledKnowledgeArtifact;

    const result = service.validateCompileResult({
      input,
      artifacts: [artifact],
    });

    expect(result.accepted).toEqual([]);
    expect(result.quarantined[0].reasons).toEqual([
      'artifact kind is not supported',
    ]);
  });

  it('quarantines artifacts that depend on sources outside the compile input', () => {
    const artifact = {
      ...validArtifact(),
      inputSourceRefs: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'source-2',
          sourceVersion: 'v1',
          contentHash: 'hash-2',
        },
      ],
    };

    const result = service.validateCompileResult({
      input,
      artifacts: [artifact],
    });

    expect(result.accepted).toEqual([]);
    expect(result.quarantined[0].reasons).toEqual([
      'artifact source is not in compile input',
    ]);
  });

  it('quarantines artifacts whose declared source page ids are not fully represented in lineage', () => {
    const artifact = {
      ...validArtifact(),
      sourcePageIds: ['source-1', 'source-2'],
      inputSourceRefs: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'source-1',
          sourceVersion: 'v1',
          contentHash: 'hash-1',
        },
      ],
    };

    const result = service.validateCompileResult({
      input,
      artifacts: [artifact],
    });

    expect(result.accepted).toEqual([]);
    expect(result.quarantined[0].reasons).toEqual([
      'artifact source page ids must match synthesis lineage',
    ]);
  });

  it('quarantines claims, chunks, and links with source refs outside the compile input', () => {
    const artifact = {
      ...validArtifact(),
      claims: [
        {
          text: 'Bad claim',
          inputSourceRefs: [outsideSourceRef()],
        },
      ],
      chunks: [
        {
          text: 'Bad chunk',
          inputSourceRefs: [outsideSourceRef()],
        },
      ],
      links: [
        {
          linkType: 'same_space_reference',
          linkText: 'Bad link',
          inputSourceRefs: [outsideSourceRef()],
        },
      ],
      graphEdges: [
        {
          toKnowledgePageId: '22222222-2222-4222-8222-222222222222',
          relation: 'bad edge',
          inputSourceRefs: [outsideSourceRef()],
        },
      ],
    };

    const result = service.validateCompileResult({
      input,
      artifacts: [artifact],
    });

    expect(result.accepted).toEqual([]);
    expect(result.quarantined[0].reasons).toEqual([
      'claim source is not in compile input',
      'chunk source is not in compile input',
      'link source is not in compile input',
      'graph edge source is not in compile input',
    ]);
  });

  it('quarantines child artifacts that do not carry explicit lineage', () => {
    const artifact = {
      ...validArtifact(),
      claims: [
        {
          text: 'Claim without lineage',
        },
      ],
      chunks: [
        {
          text: 'Chunk without lineage',
        },
      ],
      links: [
        {
          linkType: 'same_space_reference',
          linkText: 'Link without lineage',
        },
      ],
      graphEdges: [
        {
          toKnowledgePageId: '22222222-2222-4222-8222-222222222222',
          relation: 'edge_without_lineage',
        },
      ],
    };

    const result = service.validateCompileResult({
      input,
      artifacts: [artifact],
    });

    expect(result.accepted).toEqual([]);
    expect(result.quarantined[0].reasons).toEqual([
      'claim lineage is incomplete',
      'chunk lineage is incomplete',
      'link lineage is incomplete',
      'graph edge lineage is incomplete',
    ]);
  });

  it('quarantines source refs with invalid source ranges', () => {
    const artifact = {
      ...validArtifact(),
      chunks: [
        {
          text: 'Source text',
          inputSourceRefs: [
            {
              ...sourceRef(),
              sourceRange: { startOffset: 0, endOffset: 999 },
              quoteHash: quoteHash('Source text'),
            },
          ],
        },
      ],
    };

    const result = service.validateCompileResult({
      input,
      artifacts: [artifact],
    });

    expect(result.accepted).toEqual([]);
    expect(result.quarantined[0].reasons).toEqual([
      'chunk source range is invalid',
    ]);
  });

  it('quarantines source refs whose quote hash does not match the selected range', () => {
    const artifact = {
      ...validArtifact(),
      chunks: [
        {
          text: 'Source text',
          inputSourceRefs: [
            {
              ...sourceRef(),
              sourceRange: { startOffset: 0, endOffset: 6 },
              quoteHash: quoteHash('wrong'),
            },
          ],
        },
      ],
    };

    const result = service.validateCompileResult({
      input,
      artifacts: [artifact],
    });

    expect(result.accepted).toEqual([]);
    expect(result.quarantined[0].reasons).toEqual([
      'chunk quote hash does not match source range',
    ]);
  });

  it('accepts exact source refs when range and quote hash match the source text', () => {
    const artifact = {
      ...validArtifact(),
      chunks: [
        {
          text: 'Source',
          inputSourceRefs: [
            {
              ...sourceRef(),
              sourceRange: { startOffset: 0, endOffset: 6 },
              quoteHash: quoteHash('Source'),
            },
          ],
        },
      ],
    };

    expect(
      service.validateCompileResult({ input, artifacts: [artifact] }),
    ).toEqual({
      accepted: [artifact],
      quarantined: [],
    });
  });

  it('quarantines graph edges whose target compiled page id is not a UUID', () => {
    const artifact = {
      ...validArtifact(),
      graphEdges: [
        {
          toKnowledgePageId: 'not-a-uuid',
          relation: 'depends_on',
          inputSourceRefs: [sourceRef()],
        },
      ],
    };

    const result = service.validateCompileResult({
      input,
      artifacts: [artifact],
    });

    expect(result.accepted).toEqual([]);
    expect(result.quarantined[0].reasons).toEqual([
      'graph edge target id must be a UUID',
    ]);
  });

  it('quarantines cross-space links that materialize target content', () => {
    const artifact = {
      ...validArtifact(),
      links: [
        {
          linkType: 'cross_space_reference',
          targetSpaceId: 'space-2',
          isOpaque: false,
          inputSourceRefs: [sourceRef()],
        },
      ],
    };

    const result = service.validateCompileResult({
      input,
      artifacts: [artifact],
    });

    expect(result.accepted).toEqual([]);
    expect(result.quarantined[0].reasons).toEqual([
      'cross-space references must be opaque',
    ]);
  });
});

function validArtifact(): CompiledKnowledgeArtifact {
  return {
    artifactId: '11111111-1111-4111-8111-111111111111',
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    title: 'Compiled',
    contentMarkdown: '# Compiled',
    sourcePageIds: ['source-1'],
    compilerVersion: 'compiler@1',
    promptVersion: 'prompt@1',
    compilerRunId: 'run-1',
    compileTaskId: 'task-1',
    inputSourceRefs: [
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageId: 'source-1',
        sourceVersion: 'v1',
        contentHash: 'hash-1',
      },
    ],
    links: [],
  };
}

function outsideSourceRef() {
  return {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    sourcePageId: 'source-2',
    sourceVersion: 'v1',
    contentHash: 'hash-2',
  };
}

function sourceRef() {
  return {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    sourcePageId: 'source-1',
    sourceVersion: 'v1',
    contentHash: 'hash-1',
  };
}

function quoteHash(text: string): string {
  const { createHash } = jest.requireActual(
    'crypto',
  ) as typeof import('crypto');
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}
