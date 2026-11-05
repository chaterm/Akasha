import { UnrecoverableError } from 'bullmq';

/**
 * PostgreSQL SQLSTATE classes that fail the same way on every attempt:
 * 22 data exception, 23 integrity constraint violation, 42 syntax error or
 * access rule violation. Connection (08), transaction rollback (40, deadlock /
 * serialization) and resource (53, 57) classes stay retryable.
 */
const DETERMINISTIC_SQLSTATE_CLASSES = new Set(['22', '23', '42']);

const PROGRAMMING_ERROR_TYPES = [TypeError, ReferenceError, SyntaxError];

/**
 * Job-level retries are only skipped for failures known to be deterministic.
 *
 * Per-page LLM failures never reach the job: the page compiler records them as
 * failed page outcomes. What does reach the job is infrastructure work (lease
 * claims, barriers, DB/Redis calls), where unknown errors are usually
 * transient, so anything not positively classified keeps the retry budget.
 */
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

/**
 * Wraps a deterministic failure so BullMQ skips the remaining attempts while
 * the job's recorded stacktrace still points at the original throw site.
 */
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
