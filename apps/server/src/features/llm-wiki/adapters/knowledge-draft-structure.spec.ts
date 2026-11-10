import {
  buildDraftStructuralContent,
  normalizeStoredContributionStructure,
} from './knowledge-draft-structure';
import { CompiledKnowledgeArtifact } from '../types/compiler-artifact.types';

const MARKDOWN = '# 概述\n\nShared heading text.\n\n## 细节\n\nMore text.';

describe('knowledge draft structure', () => {
  it('gives two sources with the same heading path disjoint parent and child keys', () => {
    const a = buildDraftStructuralContent({
      title: 'Concept',
      markdown: MARKDOWN,
      sourceRef: ref('source-a'),
    });
    const b = buildDraftStructuralContent({
      title: 'Concept',
      markdown: MARKDOWN,
      sourceRef: ref('source-b'),
    });

    const aParents = new Set(
      a.parentSections.map((parent) => parent.stableKey),
    );
    expect(
      b.parentSections.some((parent) => aParents.has(parent.stableKey)),
    ).toBe(false);
    const aChildren = new Set(a.chunks.map((chunk) => chunk.stableKey));
    expect(b.chunks.some((chunk) => aChildren.has(chunk.stableKey))).toBe(
      false,
    );
  });

  it('points every child at a parent produced by the same run and fits varchar(64)', () => {
    const content = buildDraftStructuralContent({
      title: 'Concept',
      markdown: MARKDOWN,
      sourceRef: ref('source-a'),
    });
    const parentKeys = new Set(
      content.parentSections.map((parent) => parent.stableKey),
    );
    for (const chunk of content.chunks) {
      expect(parentKeys.has(chunk.parentStableKey!)).toBe(true);
      expect(chunk.stableKey!.length).toBeLessThanOrEqual(64);
      expect(chunk.retrievalChannel).toBe('memory');
    }
  });

  it('rebuilds legacy colliding keys idempotently and keeps table rows and attachments', () => {
    const legacy = storedContribution('source-a', {
      parentSections: [
        { stableKey: 'legacy-parent', headingPath: ['概述'], text: 'x' },
        { stableKey: 'source:attachment-parent', headingPath: [], text: 'a' },
      ],
      chunks: [
        {
          text: 'old child',
          stableKey: 'legacy-child',
          parentStableKey: 'legacy-parent',
        },
        { text: 'row', stableKey: 'table-row:0:0', parentStableKey: null },
        {
          text: 'attachment block',
          stableKey: 'source:attachment-child',
          parentStableKey: 'source:attachment-parent',
          attachmentOccurrences: [
            {
              attachmentId: 'att-1',
              sourcePageId: 'source-a',
              sourceVersion: 'v1',
              sourceContentHash: 'hash-1',
              attachmentUpdatedAt: '2026-11-09T00:00:00.000Z',
              startOffset: 0,
              endOffset: 4,
            },
          ],
        },
      ],
    });

    const once = normalizeStoredContributionStructure(legacy)!;
    const twice = normalizeStoredContributionStructure(once)!;

    const expected = buildDraftStructuralContent({
      title: legacy.title,
      markdown: legacy.contentMarkdown,
      sourceRef: ref('source-a'),
    });
    const keys = (value: CompiledKnowledgeArtifact) =>
      value.chunks!.map((chunk) => chunk.stableKey);
    expect(keys(once)).toEqual([
      ...expected.chunks.map((chunk) => chunk.stableKey),
      'table-row:0:0',
      'source:attachment-child',
    ]);
    expect(keys(twice)).toEqual(keys(once));
    const channelOf = (stableKey: string) =>
      once.chunks!.find((chunk) => chunk.stableKey === stableKey)!
        .retrievalChannel;
    for (const chunk of expected.chunks) {
      expect(channelOf(chunk.stableKey!)).toBe('memory');
    }
    // Deterministic evidence keeps whatever channel it was published with.
    expect(channelOf('table-row:0:0')).toBeUndefined();
    expect(once.parentSections!.map((parent) => parent.stableKey)).toEqual([
      ...expected.parentSections.map((parent) => parent.stableKey),
      'source:attachment-parent',
    ]);
    expect(keys(once)).not.toContain('legacy-child');
  });

  it('refuses to guess a source for a contribution not attributable to one source', () => {
    expect(
      normalizeStoredContributionStructure({
        ...storedContribution('source-a'),
        sourcePageIds: ['source-a', 'source-b'],
      }),
    ).toBeNull();
    expect(
      normalizeStoredContributionStructure({
        ...storedContribution('source-a'),
        inputSourceRefs: [],
      }),
    ).toBeNull();
  });
});

function ref(sourcePageId: string) {
  return {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    sourcePageId,
    sourceVersion: 'v1',
    contentHash: 'hash-1',
  };
}

function storedContribution(
  sourcePageId: string,
  overrides: Partial<CompiledKnowledgeArtifact> = {},
): CompiledKnowledgeArtifact {
  return {
    artifactId: 'concept-1',
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    title: 'Concept',
    contentMarkdown: MARKDOWN,
    sourcePageIds: [sourcePageId],
    artifactKind: 'concept',
    canonicalKey: 'concept-1',
    compilerVersion: 'compiler@1',
    promptVersion: 'prompt@1',
    inputSourceRefs: [ref(sourcePageId)],
    ...overrides,
  };
}
