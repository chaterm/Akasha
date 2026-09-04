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

  it('defaults attachments to disabled when omitted', async () => {
    const dto = createDto();
    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto.attachments).toBeUndefined();
  });

  it('accepts the attachments opt-in flag', async () => {
    await expect(validate(createDto({ attachments: true }))).resolves.toEqual(
      [],
    );
  });

  it('accepts the citation materials opt-in flag', async () => {
    await expect(
      validate(createDto({ includeCitations: true })),
    ).resolves.toEqual([]);
  });

  it('accepts the general knowledge opt-in flag', async () => {
    await expect(
      validate(createDto({ generalKnowledgeEnabled: true })),
    ).resolves.toEqual([]);
  });

  it('accepts a custom semantic score threshold', async () => {
    await expect(validate(createDto({ scoreThreshold: 0.6 }))).resolves.toEqual(
      [],
    );
  });

  it.each([
    ['a non-number', '0.6' as never],
    ['a negative number', -0.1],
    ['a number above the cosine distance range', 2.1],
  ])('rejects %s score threshold', async (_label, scoreThreshold) => {
    const errors = await validate(createDto({ scoreThreshold }));
    expect(errors).not.toEqual([]);
  });

  it('rejects a non-boolean attachments flag', async () => {
    const errors = await validate(createDto({ attachments: 'true' as never }));
    expect(errors).not.toEqual([]);
  });

  it('rejects a non-boolean citation materials flag', async () => {
    const errors = await validate(
      createDto({ includeCitations: 'true' as never }),
    );
    expect(errors).not.toEqual([]);
  });

  it('rejects a non-boolean general knowledge flag', async () => {
    const errors = await validate(
      createDto({ generalKnowledgeEnabled: 'true' as never }),
    );
    expect(errors).not.toEqual([]);
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
