import 'reflect-metadata';
import { validate } from 'class-validator';
import {
  AdminKnowledgeDelayedPageListDto,
  AdminKnowledgeImmediateCompileDelayedPageDto,
  AdminKnowledgeRemoveDelayedPageDto,
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

  it('bounds delayed-page pagination and validates status filters', async () => {
    const dto = Object.assign(new AdminKnowledgeDelayedPageListDto(), {
      statuses: ['dispatching'],
      page: 0,
      limit: 101,
    });

    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['statuses', 'page', 'limit']),
    );
  });

  it('requires a bounded page name for immediate delayed compilation', async () => {
    const missing = new AdminKnowledgeImmediateCompileDelayedPageDto();
    const tooLong = Object.assign(
      new AdminKnowledgeImmediateCompileDelayedPageDto(),
      { confirmationPageName: 'x'.repeat(256) },
    );

    expect((await validate(missing)).map((error) => error.property)).toContain(
      'confirmationPageName',
    );
    expect((await validate(tooLong)).map((error) => error.property)).toContain(
      'confirmationPageName',
    );
  });

  it('requires a bounded page name before removing a delayed page', async () => {
    const missing = new AdminKnowledgeRemoveDelayedPageDto();
    const tooLong = Object.assign(new AdminKnowledgeRemoveDelayedPageDto(), {
      confirmationPageName: 'x'.repeat(256),
    });

    expect((await validate(missing)).map((error) => error.property)).toContain(
      'confirmationPageName',
    );
    expect((await validate(tooLong)).map((error) => error.property)).toContain(
      'confirmationPageName',
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
