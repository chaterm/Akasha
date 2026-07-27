import 'reflect-metadata';
import { validate } from './environment.validation';

const baseEnvironment = {
  DATABASE_URL: 'postgresql://localhost:5432/akasha',
  REDIS_URL: 'redis://localhost:6379',
  APP_SECRET: 'a'.repeat(32),
};

describe('environment validation', () => {
  it.each(['10000', '120000', '600000'])(
    'accepts knowledge compiler timeout %s',
    (timeout) => {
      expect(
        validate({
          ...baseEnvironment,
          KNOWLEDGE_COMPILER_TIMEOUT_MS: timeout,
        }).KNOWLEDGE_COMPILER_TIMEOUT_MS,
      ).toBe(Number(timeout));
    },
  );

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
});
