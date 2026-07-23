import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { KnowledgeGraphDto } from './knowledge-graph.dto';

describe('KnowledgeGraphDto', () => {
  it('accepts the graph page request limit used by the client', async () => {
    const dto = plainToInstance(KnowledgeGraphDto, {
      spaceId: 'space-1',
      limit: '3000',
    });

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto.limit).toBe(3000);
  });

  it('rejects limits above the graph service hard limit', async () => {
    const dto = plainToInstance(KnowledgeGraphDto, {
      spaceId: 'space-1',
      limit: '5001',
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.constraints?.max).toBeDefined();
  });
});
