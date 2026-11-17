import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpServer,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Logger as PinoLoggerService } from 'nestjs-pino';
import { ClsServiceManager } from 'nestjs-cls';
import { FastifyReply } from 'fastify';

const LOG_CONTEXT = 'AllExceptionsFilter';
const OBJECT_MESSAGE_MAX_LENGTH = 2000;

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, current) => {
      if (typeof current === 'bigint') return current.toString();
      if (typeof current === 'object' && current !== null) {
        if (seen.has(current)) return '[Circular]';
        seen.add(current);
      }
      return current;
    });
  }
}

function toLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol' || typeof value === 'function') {
    return String(value);
  }
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return serializeUnknownException(value);
  if (seen.has(value)) return '[Circular]';

  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => toLogValue(item, seen));
  }

  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    output[key] = toLogValue((value as Record<string, unknown>)[key], seen);
  }
  return output;
}

function buildObjectMessage(value: unknown): string {
  if (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof (value as { message?: unknown }).message === 'string'
  ) {
    return (value as { message: string }).message;
  }

  const serialized = safeStringify(toLogValue(value));
  if (!serialized) return String(value);
  if (serialized.length <= OBJECT_MESSAGE_MAX_LENGTH) return serialized;
  return `${serialized.slice(0, OBJECT_MESSAGE_MAX_LENGTH)}...`;
}

function readStatusCode(value: unknown): number | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'statusCode' in value &&
    typeof (value as { statusCode?: unknown }).statusCode === 'number'
  ) {
    return (value as { statusCode: number }).statusCode;
  }
  return undefined;
}

function serializeUnknownException(
  exception: unknown,
): Record<string, unknown> {
  if (exception instanceof Error) {
    const extraFields: Record<string, unknown> = {};
    const record = exception as unknown as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key === 'name' || key === 'message' || key === 'stack') continue;
      extraFields[key] = toLogValue(record[key]);
    }

    return {
      type: exception.constructor?.name ?? 'Error',
      message: exception.message,
      stack: exception.stack,
      ...extraFields,
    };
  }

  const details = toLogValue(exception);
  const statusCode = readStatusCode(exception);
  return {
    type:
      (exception as { constructor?: { name?: string } })?.constructor?.name ??
      typeof exception,
    message: buildObjectMessage(exception),
    ...(statusCode !== undefined && { statusCode }),
    ...(typeof exception === 'object' && exception !== null && { details }),
  };
}

@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  constructor(
    httpAdapter: HttpServer,
    private readonly logger: PinoLoggerService,
  ) {
    super(httpAdapter);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') return;

    const requestId = ClsServiceManager.getClsService().getId() ?? '';
    const reply = host.switchToHttp().getResponse<FastifyReply>();

    const responseAlreadySent =
      reply?.sent === true || reply?.raw?.headersSent === true;

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const isClientError = statusCode >= 400 && statusCode < 500;
      const err = {
        type: exception.constructor?.name ?? 'Error',
        message: exception.message,
        statusCode,
        ...(isClientError ? {} : { stack: exception.stack }),
      };
      const fields = {
        err,
        requestId,
        ...(responseAlreadySent && { responseAlreadySent: true }),
      };
      const msg = `Request failed with status ${statusCode}`;

      if (isClientError && !responseAlreadySent) {
        this.logger.warn(fields, msg, LOG_CONTEXT);
      } else {
        this.logger.error(fields, msg, LOG_CONTEXT);
      }

      if (responseAlreadySent) return;
      return super.catch(exception, host);
    }

    const err = serializeUnknownException(exception);
    this.logger.error(
      {
        err,
        requestId,
        ...(responseAlreadySent && { responseAlreadySent: true }),
      },
      'Unhandled exception while processing request',
      LOG_CONTEXT,
    );

    if (responseAlreadySent) return;

    const body = this.isHttpError(exception)
      ? { statusCode: exception.statusCode, message: exception.message }
      : { statusCode: 500, message: 'Internal server error' };
    const applicationRef =
      this.applicationRef ?? this.httpAdapterHost?.httpAdapter;
    applicationRef?.reply(reply, body, body.statusCode);
  }
}
