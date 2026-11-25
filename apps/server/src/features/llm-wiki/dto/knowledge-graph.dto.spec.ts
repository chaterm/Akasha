import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { KnowledgeGraphDto } from './knowledge-graph.dto';

describe('KnowledgeGraphDto', () => {
  it('accepts a space id', async () => {
    const dto = plainToInstance(KnowledgeGraphDto, { spaceId: 'space-1' });

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto.spaceId).toBe('space-1');
  });

  it('rejects a missing space id', async () => {
    const dto = plainToInstance(KnowledgeGraphDto, {});

    const errors = await validate(dto);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('spaceId');
  });
});
