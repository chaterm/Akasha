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

  it('rejects a ninth generated artifact', () => {
    const summary = {
      kind: 'source_summary',
      canonicalKey: 'source-page-1',
      title: 'Source summary',
      markdown: 'Source summary body.',
      claims: [],
      links: [],
      tags: [],
    };
    const artifacts = [
      summary,
      ...Array.from({ length: 8 }, (_, index) => ({
        ...summary,
        kind: 'concept',
        canonicalKey: `concept-${index}`,
      })),
    ];

    expect(() =>
      parseSemanticGenerationJson(JSON.stringify({ version: '1', artifacts })),
    ).toThrow();
  });

  it.each([
    ['entities', 32, analysisEntity],
    ['concepts', 32, analysisConcept],
    ['claims', 64, analysisClaim],
    ['relations', 64, analysisRelation],
    ['comparisons', 16, analysisComparison],
    ['contradictions', 16, analysisContradiction],
  ] as const)(
    'rejects %s beyond the confirmed limit',
    (field, limit, factory) => {
      const value = baseAnalysis();
      Object.assign(value, {
        [field]: Array.from({ length: limit + 1 }, (_, index) =>
          factory(index),
        ),
      });

      expect(() => parseSemanticAnalysisJson(JSON.stringify(value))).toThrow();
    },
  );

  it('rejects a fourth evidence quote on one analysis item', () => {
    const value = baseAnalysis();
    value.entities = [
      {
        ...analysisEntity(0),
        evidenceQuotes: ['one', 'two', 'three', 'four'],
      },
    ];

    expect(() => parseSemanticAnalysisJson(JSON.stringify(value))).toThrow();
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

function baseAnalysis() {
  return {
    version: '1',
    synopsis: 'Summary',
    language: 'en',
    entities: [] as unknown[],
    concepts: [] as unknown[],
    claims: [] as unknown[],
    relations: [] as unknown[],
    comparisons: [] as unknown[],
    contradictions: [] as unknown[],
  };
}

function analysisEntity(index: number) {
  return {
    canonicalKey: `entity-${index}`,
    name: `Entity ${index}`,
    description: 'Description',
    evidenceQuotes: ['Evidence'],
  };
}

function analysisConcept(index: number) {
  return {
    canonicalKey: `concept-${index}`,
    name: `Concept ${index}`,
    description: 'Description',
    evidenceQuotes: ['Evidence'],
  };
}

function analysisClaim(index: number) {
  return { text: `Claim ${index}`, evidenceQuote: 'Evidence' };
}

function analysisRelation(index: number) {
  return {
    fromCanonicalKey: `entity-${index}`,
    toCanonicalKey: `concept-${index}`,
    relation: 'relates to',
  };
}

function analysisComparison(index: number) {
  return {
    canonicalKey: `comparison-${index}`,
    title: `Comparison ${index}`,
    subjects: [`subject-${index}-a`, `subject-${index}-b`],
    summary: 'Summary',
    evidenceQuotes: ['Evidence'],
  };
}

function analysisContradiction(index: number) {
  return {
    description: `Contradiction ${index}`,
    relatedCanonicalKeys: [],
    evidenceQuotes: ['Evidence'],
  };
}
