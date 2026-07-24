import { knowledgeSpaceAggregateSchema } from './knowledge-space-aggregate.schema';

describe('knowledgeSpaceAggregateSchema', () => {
  it('accepts only a non-empty overview title and Markdown body', () => {
    expect(
      knowledgeSpaceAggregateSchema.parse({
        title: 'Space overview',
        markdown: '# Space overview\n\nSummary.',
      }),
    ).toEqual({
      title: 'Space overview',
      markdown: '# Space overview\n\nSummary.',
    });
    expect(() =>
      knowledgeSpaceAggregateSchema.parse({
        title: 'Space overview',
        markdown: '',
      }),
    ).toThrow();
    expect(() =>
      knowledgeSpaceAggregateSchema.parse({
        title: 'Space overview',
        markdown: 'Summary.',
        hidden: 'not allowed',
      }),
    ).toThrow();
  });
});
