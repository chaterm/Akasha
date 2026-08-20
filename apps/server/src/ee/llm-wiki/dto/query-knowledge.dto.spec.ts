import { validate } from 'class-validator';
import { QueryKnowledgeDto } from './query-knowledge.dto';
import { KnowledgeQueryType } from './query-knowledge.dto';

describe('QueryKnowledgeDto', () => {
  it('accepts more than one hundred unique space UUIDs', async () => {
    const dto = createDto({
      spaceIds: Array.from(
        { length: 101 },
        (_, index) =>
          `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      ),
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it.each([
    [
      'duplicate',
      [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000001',
      ],
    ],
    ['invalid UUID', ['space-1']],
  ])('rejects %s space IDs', async (_label, spaceIds) => {
    const errors = await validate(createDto({ spaceIds }));

    expect(errors).not.toEqual([]);
  });

  it('accepts up to thirty chat context entries of four thousand characters', async () => {
    const dto = createDto({ chatContext: Array(30).fill('x'.repeat(4000)) });

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it.each([KnowledgeQueryType.USER, KnowledgeQueryType.ROBOT])(
    'accepts the %s query type',
    async (type) => {
      await expect(validate(createDto({ type }))).resolves.toEqual([]);
    },
  );

  it('rejects an unknown query type', async () => {
    const errors = await validate(createDto({ type: 'service' as never }));
    expect(errors).not.toEqual([]);
  });

  it.each([
    ['more than thirty entries', Array(31).fill('context')],
    ['an entry longer than four thousand characters', ['x'.repeat(4001)]],
  ])('rejects chat context with %s', async (_label, chatContext) => {
    const errors = await validate(createDto({ chatContext }));

    expect(errors).not.toEqual([]);
  });
});

function createDto(
  overrides: Partial<QueryKnowledgeDto> = {},
): QueryKnowledgeDto {
  return Object.assign(new QueryKnowledgeDto(), {
    query: 'How do we use Kafka?',
    spaceIds: ['00000000-0000-4000-8000-000000000001'],
    ...overrides,
  });
}
