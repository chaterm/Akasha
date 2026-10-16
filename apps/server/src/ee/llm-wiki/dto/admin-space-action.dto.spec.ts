import { validate } from 'class-validator';
import { AdminKnowledgeSpaceActionDto } from './admin-space-action.dto';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';

function dto(
  overrides: Partial<AdminKnowledgeSpaceActionDto> = {},
): AdminKnowledgeSpaceActionDto {
  return Object.assign(new AdminKnowledgeSpaceActionDto(), {
    action: 'rebuild_embeddings',
    spaceIds: [SPACE_ID],
    ...overrides,
  });
}

describe('AdminKnowledgeSpaceActionDto', () => {
  it('accepts an omitted embedding concurrency', async () => {
    await expect(validate(dto())).resolves.toEqual([]);
  });

  it('accepts a concurrency inside the provider-safe range', async () => {
    await expect(validate(dto({ embeddingConcurrency: 1 }))).resolves.toEqual(
      [],
    );
    await expect(validate(dto({ embeddingConcurrency: 50 }))).resolves.toEqual(
      [],
    );
  });

  it('rejects a concurrency outside the bounded range', async () => {
    await expect(
      validate(dto({ embeddingConcurrency: 0 })),
    ).resolves.not.toEqual([]);
    await expect(
      validate(dto({ embeddingConcurrency: 51 })),
    ).resolves.not.toEqual([]);
  });

  it('rejects a non-integer concurrency', async () => {
    await expect(
      validate(dto({ embeddingConcurrency: 2.5 })),
    ).resolves.not.toEqual([]);
  });
});
