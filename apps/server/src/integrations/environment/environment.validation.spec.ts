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
    ['300000', '300000'],
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

  it('accepts the dedicated knowledge compiler profile', () => {
    const config = validate({
      ...baseEnvironment,
      KNOWLEDGE_COMPILER_MODEL: 'qwen3.8-max',
      KNOWLEDGE_COMPILER_THINKING: 'false',
      KNOWLEDGE_COMPILER_MAX_OUTPUT_TOKENS: '16384',
      KNOWLEDGE_IMAGE_MERGE_MAX_OUTPUT_TOKENS: '8192',
    });

    expect(config.KNOWLEDGE_COMPILER_MODEL).toBe('qwen3.8-max');
    expect(config.KNOWLEDGE_COMPILER_THINKING).toBe('false');
    expect(config.KNOWLEDGE_COMPILER_MAX_OUTPUT_TOKENS).toBe(16_384);
    expect(config.KNOWLEDGE_IMAGE_MERGE_MAX_OUTPUT_TOKENS).toBe(8_192);
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
      KNOWLEDGE_SPACE_CONCURRENCY: '10',
      KNOWLEDGE_IMAGE_CONCURRENCY: '5',
      KNOWLEDGE_SPACE_SLICE_MAX_PAGES: '5',
      KNOWLEDGE_SPACE_SLICE_MAX_MS: '300000',
      KNOWLEDGE_SPACE_HEARTBEAT_MS: '30000',
      KNOWLEDGE_SPACE_LEASE_TTL_MS: '180000',
    });

    expect(config.DATABASE_MAX_POOL).toBe(25);
    expect(config.DATABASE_STATEMENT_TIMEOUT_MS).toBe(30_000);
    expect(config.KNOWLEDGE_PAGE_DEADLINE_MS).toBe(900_000);
    expect(config.KNOWLEDGE_AGGREGATE_DEADLINE_MS).toBe(300_000);
    expect(config.KNOWLEDGE_IMAGE_JOB_DEADLINE_MS).toBe(180_000);
    expect(config.KNOWLEDGE_SPACE_CONCURRENCY).toBe(10);
    expect(config.KNOWLEDGE_IMAGE_CONCURRENCY).toBe(5);
    expect(config.KNOWLEDGE_SPACE_SLICE_MAX_PAGES).toBe(5);
    expect(config.KNOWLEDGE_SPACE_SLICE_MAX_MS).toBe(300_000);
    expect(config.KNOWLEDGE_SPACE_HEARTBEAT_MS).toBe(30_000);
    expect(config.KNOWLEDGE_SPACE_LEASE_TTL_MS).toBe(180_000);
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
    ['KNOWLEDGE_SPACE_CONCURRENCY', '0'],
    ['KNOWLEDGE_SPACE_CONCURRENCY', '11'],
    ['KNOWLEDGE_SPACE_CONCURRENCY', '1.5'],
    ['KNOWLEDGE_IMAGE_CONCURRENCY', '0'],
    ['KNOWLEDGE_IMAGE_CONCURRENCY', '11'],
    ['KNOWLEDGE_SPACE_SLICE_MAX_PAGES', '0'],
    ['KNOWLEDGE_SPACE_SLICE_MAX_PAGES', '51'],
    ['KNOWLEDGE_SPACE_SLICE_MAX_MS', '59999'],
    ['KNOWLEDGE_SPACE_SLICE_MAX_MS', '900001'],
    ['KNOWLEDGE_SPACE_HEARTBEAT_MS', '9999'],
    ['KNOWLEDGE_SPACE_HEARTBEAT_MS', '60001'],
    ['KNOWLEDGE_SPACE_LEASE_TTL_MS', '119999'],
    ['KNOWLEDGE_SPACE_LEASE_TTL_MS', '600001'],
    ['KNOWLEDGE_COMPILER_THINKING', 'true'],
    ['KNOWLEDGE_COMPILER_MAX_OUTPUT_TOKENS', '0'],
    ['KNOWLEDGE_COMPILER_MAX_OUTPUT_TOKENS', '131073'],
    ['KNOWLEDGE_IMAGE_MERGE_MAX_OUTPUT_TOKENS', '0'],
    ['KNOWLEDGE_IMAGE_MERGE_MAX_OUTPUT_TOKENS', '131073'],
  ])('rejects invalid bounded setting %s=%s', (key, value) => {
    expectInvalidEnvironment({ [key]: value });
  });

  it('rejects heartbeat greater than or equal to the execution lease TTL', () => {
    expectInvalidEnvironment({
      KNOWLEDGE_SPACE_HEARTBEAT_MS: '60000',
      KNOWLEDGE_SPACE_LEASE_TTL_MS: '60000',
    });
  });

  it('rejects local worker concurrency above the database pool budget', () => {
    expectInvalidEnvironment({
      DATABASE_MAX_POOL: '24',
      KNOWLEDGE_SPACE_CONCURRENCY: '10',
      KNOWLEDGE_IMAGE_CONCURRENCY: '5',
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
