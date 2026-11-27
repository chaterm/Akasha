import { validate } from 'class-validator';
import { SpacePaginationOptions } from './space-pagination-options.dto';

describe('SpacePaginationOptions', () => {
  it.each(['public', 'personal', 'created-personal', 'favorites'] as const)(
    'accepts the %s space type',
    async (type) => {
      const pagination = new SpacePaginationOptions();
      pagination.type = type;
      await expect(validate(pagination)).resolves.toEqual([]);
    },
  );

  it('rejects unsupported space types', async () => {
    const pagination = Object.assign(new SpacePaginationOptions(), {
      type: 'private',
    });
    const errors = await validate(pagination);
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('type');
  });

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
