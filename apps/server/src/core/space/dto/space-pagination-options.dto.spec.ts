import { validate } from 'class-validator';
import { SpacePaginationOptions } from './space-pagination-options.dto';

describe('SpacePaginationOptions', () => {
  it('keeps the default spaces page size bounded at 20', () => {
    expect(new SpacePaginationOptions().limit).toBe(20);
  });

  it('accepts a page size of 5000', async () => {
    const pagination = new SpacePaginationOptions();
    pagination.limit = 5000;

    await expect(validate(pagination)).resolves.toEqual([]);
  });

  it('rejects a page size greater than 5000', async () => {
    const pagination = new SpacePaginationOptions();
    pagination.limit = 5001;

    const errors = await validate(pagination);

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('limit');
    expect(errors[0].constraints).toHaveProperty('max');
  });
});
