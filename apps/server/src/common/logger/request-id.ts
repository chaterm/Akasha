import { randomUUID } from 'node:crypto';

const REQUEST_ID_KEY = Symbol.for('akasha.requestId');

const MAX_REQUEST_ID_LENGTH = 128;

export function isValidRequestId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_REQUEST_ID_LENGTH &&
    !/[\s,]/.test(trimmed)
  );
}

type RequestLike = {
  headers?: Record<string, string | string[] | undefined>;
  [key: symbol]: unknown;
};

export function resolveRequestId(req: unknown): string {
  if (!req || typeof req !== 'object') return '';

  const target = req as RequestLike;
  const cached = target[REQUEST_ID_KEY];
  if (typeof cached === 'string') return cached;

  const raw = target.headers?.['x-request-id'];
  const candidate = Array.isArray(raw) ? undefined : raw;
  const requestId = isValidRequestId(candidate)
    ? candidate.trim()
    : randomUUID();

  target[REQUEST_ID_KEY] = requestId;
  return requestId;
}
