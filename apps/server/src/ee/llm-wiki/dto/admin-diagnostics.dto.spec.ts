import 'reflect-metadata';
import { validate } from 'class-validator';
import {
  AdminKnowledgeDiagnosticsDto,
  AdminKnowledgeRunListDto,
  AdminKnowledgeRunPagesQueryDto,
} from './admin-diagnostics.dto';

describe('AdminKnowledgeDiagnosticsDto', () => {
  it('rejects an unbounded Space scope', async () => {
    const dto = Object.assign(new AdminKnowledgeDiagnosticsDto(), {
      spaceIds: Array.from(
        { length: 101 },
        (_, index) =>
          `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      ),
    });

    await expect(validate(dto)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: 'spaceIds' }),
      ]),
    );
  });

  it('rejects malformed Space IDs', async () => {
    const dto = Object.assign(new AdminKnowledgeDiagnosticsDto(), {
      spaceIds: ['not-a-space-id'],
    });

    await expect(validate(dto)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: 'spaceIds' }),
      ]),
    );
  });

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
