import { KnowledgeArtifactValidatorService } from './knowledge-artifact-validator.service';
import {
  CompiledKnowledgeArtifact,
  CompileSpaceInput,
} from '../types/compiler-artifact.types';
import { buildAttachmentEvidenceContent } from '../adapters/knowledge-attachment-evidence';
import { attachmentMarker } from './knowledge-source-serializer';

describe('KnowledgeArtifactValidatorService', () => {
  const service = new KnowledgeArtifactValidatorService();
  const input: CompileSpaceInput = {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    compilerVersion: 'compiler@1',
    promptVersion: 'prompt@1',
    compileMode: 'pages',
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

  it.each(['unsupported_kind', 'overview'])(
    'quarantines the non-page artifact kind %s',
    (artifactKind) => {
      const artifact = {
        ...validArtifact(),
        artifactKind,
      } as unknown as CompiledKnowledgeArtifact;

      const result = service.validateCompileResult({
        input,
        artifacts: [artifact],
      });

      expect(result.accepted).toEqual([]);
      expect(result.quarantined[0].reasons).toEqual([
        'artifact kind is not supported',
      ]);
    },
  );

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

  it('quarantines chunks and links with source refs outside the compile input', () => {
    const artifact = {
      ...validArtifact(),
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
    };

    const result = service.validateCompileResult({
      input,
      artifacts: [artifact],
    });

    expect(result.accepted).toEqual([]);
    expect(result.quarantined[0].reasons).toEqual([
      'chunk source is not in compile input',
      'link source is not in compile input',
    ]);
  });

  it('quarantines child artifacts that do not carry explicit lineage', () => {
    const artifact = {
      ...validArtifact(),
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
    };

    const result = service.validateCompileResult({
      input,
      artifacts: [artifact],
    });

    expect(result.accepted).toEqual([]);
    expect(result.quarantined[0].reasons).toEqual([
      'chunk lineage is incomplete',
      'link lineage is incomplete',
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

  it('accepts an attachment relation that matches a reconstructed source block', () => {
    const { input, chunk } = legitAttachmentFixture();
    const artifact = { ...validArtifact(), chunks: [chunk] };

    const result = service.validateCompileResult({
      input,
      artifacts: [artifact],
    });

    expect(result.accepted).toEqual([artifact]);
    expect(result.quarantined).toEqual([]);
  });

  it('quarantines a fabricated, image or hallucinated attachment id', () => {
    const { input, chunk } = legitAttachmentFixture();
    const artifact = {
      ...validArtifact(),
      chunks: [
        {
          ...chunk,
          attachmentOccurrences: [
            {
              ...chunk.attachmentOccurrences![0],
              attachmentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
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
      'chunk attachment occurrence is not backed by a deterministic source block',
    ]);
  });

  it('quarantines an attachment relation whose snapshot metadata drifted', () => {
    const { input, chunk } = legitAttachmentFixture();
    const artifact = {
      ...validArtifact(),
      chunks: [
        {
          ...chunk,
          attachmentOccurrences: [
            {
              ...chunk.attachmentOccurrences![0],
              attachmentUpdatedAt: '2020-01-01T00:00:00.000Z',
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
      'chunk attachment occurrence does not match source snapshot',
    ]);
  });

  it('quarantines a fabricated chunk that wraps a real occurrence in a huge self-declared range', () => {
    // The architect's core adversarial case: a real occurrence copied verbatim
    // onto an unrelated chunk with a giant range that "covers" the marker. It
    // matches no reconstructed deterministic block, so it must be rejected.
    const { input, chunk } = legitAttachmentFixture();
    const artifact = {
      ...validArtifact(),
      chunks: [
        {
          text: 'unrelated body that never appears in the serialized source',
          stableKey: 'source:forged',
          startOffset: 0,
          endOffset: 999999,
          inputSourceRefs: [sourceRef()],
          attachmentOccurrences: chunk.attachmentOccurrences,
        },
      ],
    };

    const result = service.validateCompileResult({
      input,
      artifacts: [artifact],
    });

    expect(result.accepted).toEqual([]);
    expect(result.quarantined[0].reasons).toEqual([
      'chunk attachment occurrence is not backed by a deterministic source block',
    ]);
  });

  it('quarantines an attachment relation when the source omits serialized text (fail-closed)', () => {
    // Without attachmentSerializedText there is no verifiable block set, so any
    // relation riding on the source must be rejected rather than trusted.
    const { input, chunk } = legitAttachmentFixture();
    const strippedInput: CompileSpaceInput = {
      ...input,
      sources: input.sources.map((source) => ({
        ...source,
        attachmentSerializedText: undefined,
      })),
    };
    const artifact = { ...validArtifact(), chunks: [chunk] };

    const result = service.validateCompileResult({
      input: strippedInput,
      artifacts: [artifact],
    });

    expect(result.accepted).toEqual([]);
    expect(result.quarantined[0].reasons).toEqual([
      'chunk attachment occurrence is not backed by a deterministic source block',
    ]);
  });
});

const ATTACHMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTACHMENT_UPDATED_AT = '2026-01-01T00:00:00.000Z';

/**
 * Builds a real serialized source (marker + occurrence) and runs it through the
 * production attachment-evidence builder, so the returned chunk is exactly what
 * a legitimate compile would emit. Tests then either use it as-is (accept) or
 * tamper with a single field (reject), which mirrors how the validator now
 * re-derives trust from `attachmentSerializedText` rather than trusting the
 * artifact's self-declared range.
 */
function legitAttachmentFixture(): {
  input: CompileSpaceInput;
  chunk: NonNullable<CompiledKnowledgeArtifact['chunks']>[number];
} {
  const fileName = 'config.xlsx';
  const marker = attachmentMarker(ATTACHMENT_ID);
  const serializedText = `${fileName} ${marker}`;
  const occurrence = {
    attachmentId: ATTACHMENT_ID,
    sourcePageId: 'source-1',
    attachmentUpdatedAt: ATTACHMENT_UPDATED_AT,
    startOffset: 0,
    endOffset: serializedText.length,
  };
  const source = {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    sourcePageId: 'source-1',
    sourceVersion: 'v1',
    contentHash: 'hash-1',
    title: 'Source',
    text: 'Source text',
    references: [],
    attachmentOccurrences: [occurrence],
    attachmentSerializedText: serializedText,
  };

  const evidence = buildAttachmentEvidenceContent({
    source,
    sourceRef: {
      workspaceId: source.workspaceId,
      spaceId: source.spaceId,
      sourcePageId: source.sourcePageId,
      sourceVersion: source.sourceVersion,
      contentHash: source.contentHash,
    },
    pageTitle: source.title,
  });
  const chunk = evidence.chunks.find(
    (candidate) => (candidate.attachmentOccurrences?.length ?? 0) > 0,
  );
  if (!chunk) {
    throw new Error('fixture did not produce an attachment evidence chunk');
  }

  return {
    input: {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      compilerVersion: 'compiler@1',
      promptVersion: 'prompt@1',
      compileMode: 'pages',
      sources: [source],
    },
    chunk,
  };
}

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
