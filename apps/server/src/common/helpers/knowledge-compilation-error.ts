import { PostgresError } from 'postgres';

// Keep the original error identity: publication fences and retry classifiers
// rely on instanceof checks. The closest failing operation wins.
type CompilationOperation = { operation: string; artifactId?: string };
const operations = new WeakMap<object, CompilationOperation>();

export async function runKnowledgeCompilationOperation<T>(
  operation: string,
  execute: () => Promise<T>,
  context?: { artifactId: string },
): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    if (error !== null && typeof error === 'object' && !operations.has(error)) {
      operations.set(error, { operation, artifactId: context?.artifactId });
    }
    throw error;
  }
}

export function describeKnowledgeCompilationError(error: unknown) {
  const context =
    error !== null && typeof error === 'object'
      ? operations.get(error)
      : undefined;
  const errorName =
    error instanceof Error
      ? (identifier(error.name) ?? 'Error')
      : 'UnknownError';
  // Exclude the first stack line (which contains the raw error message).
  const stackFrames =
    error instanceof Error
      ? error.stack
          ?.split('\n')
          .filter((line) => /^\s+at /.test(line))
          .slice(0, 12)
          .join('\n')
      : undefined;

  if (error instanceof PostgresError) {
    const database = {
      sqlState: /^[0-9A-Z]{5}$/.test(error.code) ? error.code : undefined,
      schema: identifier(error.schema_name),
      table: identifier(error.table_name),
      column: identifier(error.column_name),
      constraint: identifier(error.constraint_name),
      routine: identifier(error.routine),
    };
    const fields = Object.entries(database)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`);
    // PostgreSQL detail, where, query and parameters may contain page text or
    // credentials. Persist only SQLSTATE and schema metadata, never the error.
    return {
      ...context,
      errorName,
      errorMessage: `Database operation failed (${fields.join('; ')}).`,
      database,
      stackFrames,
    };
  }

  return {
    ...context,
    errorName,
    errorMessage:
      error instanceof Error
        ? sanitizeMessage(error.message)
        : 'A non-Error value was thrown during compilation.',
    database: undefined,
    stackFrames,
  };
}

export function compilationFailureMessage(error: unknown, message: string) {
  const context =
    error !== null && typeof error === 'object'
      ? operations.get(error)
      : undefined;
  const operation = context
    ? `[${context.operation}${context.artifactId ? `; artifactId=${context.artifactId}` : ''}] `
    : '';
  return `${operation}${message}`.slice(0, 500);
}

function identifier(value: string | undefined): string | undefined {
  return value?.replace(/\p{Cc}/gu, ' ').slice(0, 80) || undefined;
}

function sanitizeMessage(message: string): string {
  return message
    .replace(/\b(?:https?|postgres(?:ql)?):\/\/[^\s]+/gi, '[REDACTED_URL]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(password|token|secret|api[_-]?key|authorization)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[REDACTED]',
    )
    .replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, 300);
}
