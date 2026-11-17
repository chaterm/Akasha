import { writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolveServiceName } from './log-service-name';

type BootstrapLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type BootstrapLogFields = {
  context: string;
  msg: string;
  err?: unknown;
  [key: string]: unknown;
};

function serializeError(err: unknown): Record<string, unknown> | undefined {
  if (err === undefined || err === null) return undefined;
  if (err instanceof Error) {
    return {
      type: err.constructor?.name ?? 'Error',
      message: err.message,
      stack: err.stack,
    };
  }
  return { type: typeof err, message: String(err) };
}

function safeStringify(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'bigint') return String(val);
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });
  }
}

function emit(level: BootstrapLogLevel, fields: BootstrapLogFields): void {
  const { context, msg, err, ...rest } = fields;
  const line: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    msg,
    context,
    service: resolveServiceName(),
    env: process.env.NODE_ENV ?? '',
    requestId: '',
    workspaceId: '',
    userId: '',
    pid: process.pid,
    hostname: hostname(),
    ...rest,
  };

  const serializedError = serializeError(err);
  if (serializedError) line.err = serializedError;

  const payload = `${safeStringify(line)}\n`;

  try {
    writeSync(1, payload);
  } catch {
    process.stdout.write(payload);
  }
}

export const bootstrapLogger = {
  debug: (fields: BootstrapLogFields) => emit('debug', fields),
  info: (fields: BootstrapLogFields) => emit('info', fields),
  warn: (fields: BootstrapLogFields) => emit('warn', fields),
  error: (fields: BootstrapLogFields) => emit('error', fields),
  fatal: (fields: BootstrapLogFields) => emit('fatal', fields),
};
