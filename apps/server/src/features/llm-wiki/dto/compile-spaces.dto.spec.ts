import { validate } from 'class-validator';
import { CompileSpacesDto } from './compile-spaces.dto';

describe('CompileSpacesDto', () => {
  it('accepts between one and one hundred unique UUIDs', async () => {
    const dto = Object.assign(new CompileSpacesDto(), {
      spaceIds: Array.from(
        { length: 100 },
        (_, index) =>
          `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      ),
    });
    await expect(validate(dto)).resolves.toEqual([]);
  });

  it.each([
    ['empty', []],
    [
      'duplicate',
      [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000001',
      ],
    ],
    [
      'too many',
      Array.from(
        { length: 101 },
        (_, index) =>
          `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      ),
    ],
    ['invalid UUID', ['space-1']],
  ])('rejects %s space IDs', async (_label, spaceIds) => {
    const dto = Object.assign(new CompileSpacesDto(), { spaceIds });
    await expect(validate(dto)).resolves.not.toEqual([]);
  });
});
