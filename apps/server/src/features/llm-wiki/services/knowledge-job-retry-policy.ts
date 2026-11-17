import { UnrecoverableError } from 'bullmq';

const DETERMINISTIC_SQLSTATE_CLASSES = new Set(['22', '23', '42']);

const PROGRAMMING_ERROR_TYPES = [TypeError, ReferenceError, SyntaxError];

export function isDeterministicJobFailure(error: unknown): boolean {
  if (error instanceof UnrecoverableError) return true;
  if (PROGRAMMING_ERROR_TYPES.some((type) => error instanceof type)) {
    return true;
  }
  if (!error || typeof error !== 'object') return false;
  const { retryable, code } = error as { retryable?: unknown; code?: unknown };
  if (retryable === false) return true;
  return (
    typeof code === 'string' &&
    /^[0-9A-Z]{5}$/.test(code) &&
    DETERMINISTIC_SQLSTATE_CLASSES.has(code.slice(0, 2))
  );
}

export function toUnrecoverableJobError(error: unknown): UnrecoverableError {
  if (error instanceof UnrecoverableError) return error;
  const unrecoverable = new UnrecoverableError(
    error instanceof Error ? error.message : String(error),
  );
  if (error instanceof Error && error.stack) unrecoverable.stack = error.stack;
  Object.defineProperty(unrecoverable, 'cause', {
    value: error,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return unrecoverable;
}
