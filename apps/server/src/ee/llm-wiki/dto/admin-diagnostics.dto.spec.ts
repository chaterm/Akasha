import 'reflect-metadata';
import { validate } from 'class-validator';
import {
  AdminKnowledgeRunListDto,
  AdminKnowledgeRunPagesQueryDto,
} from './admin-diagnostics.dto';

describe('bounded knowledge diagnostics DTOs', () => {
  it('bounds Run list pagination and validates status/phase filters', async () => {
    const dto = Object.assign(new AdminKnowledgeRunListDto(), {
      page: 0,
      limit: 101,
      statuses: ['mystery'],
      phases: ['unknown'],
    });

    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['page', 'limit', 'statuses', 'phases']),
    );
  });

  it('bounds on-demand RunPage detail pagination', async () => {
    const dto = Object.assign(new AdminKnowledgeRunPagesQueryDto(), {
      page: 1,
      limit: 500,
    });

    await expect(validate(dto)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ property: 'limit' })]),
    );
  });
});
