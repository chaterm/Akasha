import 'reflect-metadata';
import { validate } from './environment.validation';

const baseEnvironment = {
  DATABASE_URL: 'postgresql://localhost:5432/akasha',
  REDIS_URL: 'redis://localhost:6379',
  APP_SECRET: 'a'.repeat(32),
};

describe('environment validation', () => {
  it.each([
    ['10000', '300000'],
    ['120000', '300000'],
    ['270000', '600000'],
  ])('accepts knowledge compiler timeout %s', (timeout, aggregateDeadline) => {
    expect(
      validate({
        ...baseEnvironment,
        KNOWLEDGE_COMPILER_TIMEOUT_MS: timeout,
        KNOWLEDGE_AGGREGATE_DEADLINE_MS: aggregateDeadline,
      }).KNOWLEDGE_COMPILER_TIMEOUT_MS,
    ).toBe(Number(timeout));
  });

  it.each(['9999', '600001', 'not-a-number'])(
    'rejects invalid knowledge compiler timeout %s',
    (timeout) => {
      const consoleSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('invalid environment');
      });

      expect(() =>
        validate({
          ...baseEnvironment,
          KNOWLEDGE_COMPILER_TIMEOUT_MS: timeout,
        }),
      ).toThrow('invalid environment');

      exitSpy.mockRestore();
      consoleSpy.mockRestore();
    },
  );

  it.each(['10000', '120000', '600000'])(
    'accepts knowledge image timeout %s',
    (timeout) => {
      expect(
        validate({
          ...baseEnvironment,
          KNOWLEDGE_IMAGE_TIMEOUT_MS: timeout,
        }).KNOWLEDGE_IMAGE_TIMEOUT_MS,
      ).toBe(Number(timeout));
    },
  );

  it.each(['9999', '600001', 'not-a-number'])(
    'rejects invalid knowledge image timeout %s',
    (timeout) => {
      const consoleSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('invalid environment');
      });

      expect(() =>
        validate({
          ...baseEnvironment,
          KNOWLEDGE_IMAGE_TIMEOUT_MS: timeout,
        }),
      ).toThrow('invalid environment');

      exitSpy.mockRestore();
      consoleSpy.mockRestore();
    },
  );

  it('accepts an optional vision model override', () => {
    expect(
      validate({
        ...baseEnvironment,
        AI_VISION_MODEL: 'custom-vision-model',
      }).AI_VISION_MODEL,
    ).toBe('custom-vision-model');
  });

  it('accepts bounded database and compilation runtime settings', () => {
    const config = validate({
      ...baseEnvironment,
      DATABASE_MAX_POOL: '25',
      DATABASE_STATEMENT_TIMEOUT_MS: '30000',
      KNOWLEDGE_COMPILER_TIMEOUT_MS: '120000',
      KNOWLEDGE_PAGE_DEADLINE_MS: '900000',
      KNOWLEDGE_AGGREGATE_DEADLINE_MS: '300000',
      KNOWLEDGE_IMAGE_JOB_DEADLINE_MS: '180000',
    });

    expect(config.DATABASE_MAX_POOL).toBe(25);
    expect(config.DATABASE_STATEMENT_TIMEOUT_MS).toBe(30_000);
    expect(config.KNOWLEDGE_PAGE_DEADLINE_MS).toBe(900_000);
    expect(config.KNOWLEDGE_AGGREGATE_DEADLINE_MS).toBe(300_000);
    expect(config.KNOWLEDGE_IMAGE_JOB_DEADLINE_MS).toBe(180_000);
  });

  it.each([
    ['DATABASE_MAX_POOL', '0'],
    ['DATABASE_MAX_POOL', '101'],
    ['DATABASE_STATEMENT_TIMEOUT_MS', '4999'],
    ['DATABASE_STATEMENT_TIMEOUT_MS', '120001'],
    ['KNOWLEDGE_PAGE_DEADLINE_MS', '299999'],
    ['KNOWLEDGE_PAGE_DEADLINE_MS', '900001'],
    ['KNOWLEDGE_AGGREGATE_DEADLINE_MS', '59999'],
    ['KNOWLEDGE_AGGREGATE_DEADLINE_MS', '600001'],
    ['KNOWLEDGE_IMAGE_JOB_DEADLINE_MS', '119999'],
    ['KNOWLEDGE_IMAGE_JOB_DEADLINE_MS', '300001'],
  ])('rejects invalid bounded setting %s=%s', (key, value) => {
    expectInvalidEnvironment({ [key]: value });
  });

  it('rejects a compiler timeout pair that leaves no aggregate headroom', () => {
    expectInvalidEnvironment({
      KNOWLEDGE_COMPILER_TIMEOUT_MS: '150000',
      KNOWLEDGE_AGGREGATE_DEADLINE_MS: '300000',
    });
  });
});

function expectInvalidEnvironment(overrides: Record<string, string>): void {
  const consoleSpy = jest
    .spyOn(console, 'error')
    .mockImplementation(() => undefined);
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('invalid environment');
  });

  try {
    expect(() => validate({ ...baseEnvironment, ...overrides })).toThrow(
      'invalid environment',
    );
  } finally {
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  }
}
