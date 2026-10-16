import { OriginalDocumentCompilerRunner } from './original-document-compiler.runner';

describe('OriginalDocumentCompilerRunner', () => {
  it('builds a source-backed evidence index without semantic artifacts', async () => {
    const runner = new OriginalDocumentCompilerRunner();
    const result = await runner.compileSpace({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      spaceId: '22222222-2222-4222-8222-222222222222',
      compilerVersion: 'compiler@1',
      promptVersion: 'prompt@1',
      compileTaskId: 'task-1',
      compileMode: 'pages',
      indexMode: 'original',
      sources: [
        {
          workspaceId: '11111111-1111-4111-8111-111111111111',
          spaceId: '22222222-2222-4222-8222-222222222222',
          sourcePageId: '33333333-3333-4333-8333-333333333333',
          sourceVersion: 'version-1',
          contentHash: 'hash-1',
          title: 'Original page',
          text: '# Heading\n\nThe source text is searchable.',
          content: {
            type: 'doc',
            content: [
              {
                type: 'heading',
                attrs: { level: 1 },
                content: [{ type: 'text', text: 'Heading' }],
              },
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'The source text is searchable.' },
                ],
              },
            ],
          },
          references: [],
        },
      ],
    });

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toEqual(
      expect.objectContaining({
        artifactKind: 'original_source',
        generationMode: 'original',
        contentMarkdown: '',
      }),
    );
    expect(result.artifacts[0].claims).toBeUndefined();
    expect(result.artifacts[0].links).toBeUndefined();
    expect(result.artifacts[0].graphEdges).toBeUndefined();
    expect(result.artifacts[0].chunks?.[0]).toEqual(
      expect.objectContaining({
        retrievalChannel: 'evidence',
        chunkRole: 'child',
      }),
    );
  });
});
