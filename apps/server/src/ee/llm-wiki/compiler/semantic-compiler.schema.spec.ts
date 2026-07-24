import {
  parseSemanticAnalysisJson,
  parseSemanticGenerationJson,
  repairSemanticCompilerOutput,
} from './semantic-compiler.schema';

describe('semantic compiler schemas', () => {
  it('parses a strict Stage 1 analysis JSON object', () => {
    expect(
      parseSemanticAnalysisJson(
        JSON.stringify({
          version: '1',
          synopsis: 'The source introduces retrieval augmented generation.',
          language: 'en',
          entities: [],
          concepts: [
            {
              canonicalKey: 'retrieval-augmented-generation',
              name: 'Retrieval augmented generation',
              description: 'A grounding technique.',
              evidenceQuotes: ['retrieval augmented generation'],
            },
          ],
          claims: [],
          relations: [],
          comparisons: [],
          contradictions: [],
        }),
      ).concepts[0].canonicalKey,
    ).toBe('retrieval-augmented-generation');
  });

  it('accepts one fenced JSON object but rejects explanatory prose', () => {
    const value = {
      version: '1',
      synopsis: 'Summary',
      language: 'zh',
      entities: [],
      concepts: [],
      claims: [],
      relations: [],
      comparisons: [],
      contradictions: [],
    };

    expect(
      parseSemanticAnalysisJson(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``),
    ).toEqual(value);
    expect(() =>
      parseSemanticAnalysisJson(`Here is the JSON: ${JSON.stringify(value)}`),
    ).toThrow('strict JSON object');
  });

  it('normalizes harmless JSON-mode variations from compatible models', () => {
    const parsed = parseSemanticAnalysisJson(
      JSON.stringify({
        version: 1,
        synopsis: 'Summary',
        language: 'zh',
        entities: [
          {
            canonicalKey: 'user_api',
            name: '用户接口',
            description: '查询用户信息。',
            evidenceQuotes: '查询用户信息',
          },
        ],
        concepts: [],
        claims: [],
        relations: [],
        comparisons: [],
        contradictions: [],
      }),
    );

    expect(parsed.version).toBe('1');
    expect(parsed.entities[0].evidenceQuotes).toEqual(['查询用户信息']);
  });

  it('rejects unsafe canonical keys and unknown fields', () => {
    const base = {
      version: '1',
      synopsis: 'Summary',
      language: 'en',
      entities: [],
      concepts: [],
      claims: [],
      relations: [],
      comparisons: [],
      contradictions: [],
    };

    expect(() =>
      parseSemanticAnalysisJson(
        JSON.stringify({
          ...base,
          concepts: [
            {
              canonicalKey: '../../private',
              name: 'Private',
              description: 'Unsafe',
              evidenceQuotes: [],
            },
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      parseSemanticAnalysisJson(JSON.stringify({ ...base, hidden: true })),
    ).toThrow();
  });

  it('requires exactly one source summary in Stage 2 output', () => {
    const artifact = {
      kind: 'concept',
      canonicalKey: 'distributed-systems',
      title: 'Distributed systems',
      markdown: 'A distributed system coordinates multiple nodes.',
      claims: [],
      links: [],
      tags: [],
    };

    expect(() =>
      parseSemanticGenerationJson(
        JSON.stringify({ version: '1', artifacts: [artifact] }),
      ),
    ).toThrow('exactly one source_summary');

    expect(
      parseSemanticGenerationJson(
        JSON.stringify({
          version: '1',
          artifacts: [
            {
              ...artifact,
              kind: 'source_summary',
              canonicalKey: 'source-page-1',
              title: 'Source summary',
            },
            artifact,
          ],
        }),
      ).artifacts,
    ).toHaveLength(2);
  });

  it('normalizes null optional artifact collections to empty arrays', () => {
    const parsed = parseSemanticGenerationJson(
      JSON.stringify({
        version: '1',
        artifacts: [
          {
            kind: 'source_summary',
            canonicalKey: 'source-page-1',
            title: 'Source summary',
            markdown: 'Source summary body.',
            claims: null,
            links: null,
            tags: null,
          },
        ],
      }),
    );

    expect(parsed.artifacts[0]).toEqual(
      expect.objectContaining({ claims: [], links: [], tags: [] }),
    );
  });

  it('rejects unsupported generated artifact kinds', () => {
    expect(() =>
      parseSemanticGenerationJson(
        JSON.stringify({
          version: '1',
          artifacts: [
            {
              kind: 'overview',
              canonicalKey: 'overview',
              title: 'Overview',
              markdown: 'Overview',
              claims: [],
              links: [],
              tags: [],
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it('extracts fenced or prose-wrapped JSON and normalizes field aliases', () => {
    const repaired = repairSemanticCompilerOutput(
      'generation',
      `Here is the result:\n\`\`\`json\n${JSON.stringify({
        version: 1,
        pages: [
          {
            type: 'summary',
            canonical_key: 'API Overview',
            name: 'API overview',
            body: 'Source-grounded API overview.',
          },
        ],
      })}\n\`\`\``,
    );

    expect(repaired).toEqual({
      version: '1',
      artifacts: [
        {
          kind: 'source_summary',
          canonicalKey: 'api-overview',
          title: 'API overview',
          markdown: 'Source-grounded API overview.',
          claims: [],
          links: [],
          tags: [],
        },
      ],
    });
  });
});
