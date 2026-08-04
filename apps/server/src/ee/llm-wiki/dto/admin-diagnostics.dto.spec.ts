import 'reflect-metadata';
import { validate } from 'class-validator';
import {
  AdminKnowledgePageLogDto,
  AdminKnowledgeQuarantineListDto,
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

  it('bounds on-demand quarantine pagination and Space scope', async () => {
    const dto = Object.assign(new AdminKnowledgeQuarantineListDto(), {
      spaceIds: Array.from({ length: 101 }, () => 'not-a-uuid'),
      page: 0,
      limit: 101,
    });

    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['spaceIds', 'page', 'limit']),
    );
  });

  it('bounds page-log pagination and validates status/time filters', async () => {
    const dto = Object.assign(new AdminKnowledgePageLogDto(), {
      statuses: ['mystery'],
      from: 'not-a-date',
      page: 0,
      limit: 101,
    });

    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['statuses', 'from', 'page', 'limit']),
    );
  });

  it('accepts a valid page-log query', async () => {
    const dto = Object.assign(new AdminKnowledgePageLogDto(), {
      statuses: ['succeeded', 'failed'],
      search: 'runbook',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-03T00:00:00.000Z',
      page: 1,
      limit: 50,
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });
});
