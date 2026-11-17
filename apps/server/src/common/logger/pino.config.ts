import { hostname } from 'node:os';
import { Params } from 'nestjs-pino';
import { Options } from 'pino-http';
import { DestinationStream, stdSerializers, stdTimeFunctions } from 'pino';
import { redactSensitiveUrl } from '../helpers/utils';
import { resolveRequestId } from './request-id';
import { getJobContext } from './job-context';
import { IGNORED_LOG_CONTEXTS } from './ignored-contexts';

const REDACT_PATHS = [
  'password',
  'token',
  'secret',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  '*.password',
  '*.token',
  '*.secret',
  '*.accessToken',
  '*.refreshToken',
  '*.authorization',
  '*.cookie',
  'err.details.password',
  'err.details.token',
  'err.details.secret',
  'err.details.accessToken',
  'err.details.refreshToken',
  'err.details.authorization',
  'err.details.cookie',
  'err.details.*.password',
  'err.details.*.token',
  'err.details.*.secret',
  'err.details.*.accessToken',
  'err.details.*.refreshToken',
  'err.details.*.authorization',
  'err.details.*.cookie',
];

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

export function resolveLogLevel(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.LOG_LEVEL?.trim().toLowerCase();
  if (explicit && LOG_LEVELS.includes(explicit)) return explicit;

  const isProduction = env.NODE_ENV?.toLowerCase() === 'production';
  const isDebugMode = env.DEBUG_MODE?.toLowerCase() === 'true';
  return isProduction && !isDebugMode ? 'info' : 'debug';
}

export function createPinoConfig(
  serviceName: string,
  destination?: DestinationStream,
): Params {
  const isProduction = process.env.NODE_ENV?.toLowerCase() === 'production';
  const isDebugMode = process.env.DEBUG_MODE?.toLowerCase() === 'true';
  const logHttp = process.env.LOG_HTTP?.toLowerCase() === 'true';

  const autoLogging = {
    ignore: (req) => {
      const originalUrl: string = req.originalUrl ?? req.url ?? '';
      const path = originalUrl.split('?')[0];
      return path === '/api/health' || path === '/api/health/live';
    },
  };

  const options: Options = {
    level: resolveLogLevel(),
    timestamp: stdTimeFunctions.isoTime,
    base: {
      service: serviceName,
      env: process.env.NODE_ENV ?? '',
      pid: process.pid,
      hostname: hostname(),
    },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    customProps: (req) => ({ requestId: resolveRequestId(req) }),
    genReqId: (req) => resolveRequestId(req),
    mixin: () => {
      const job = getJobContext();
      return job ? { ...job } : {};
    },
    transport:
      !isProduction && !destination
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              singleLine: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
    formatters: {
      level: (label) => ({ level: label }),
    },
    hooks: {
      logMethod(inputArgs, method) {
        if (isProduction && !isDebugMode) {
          for (const arg of inputArgs) {
            if (typeof arg === 'object' && arg !== null && 'context' in arg) {
              const context = (arg as Record<string, unknown>)['context'];
              if (
                typeof context === 'string' &&
                IGNORED_LOG_CONTEXTS.includes(context)
              ) {
                return;
              }
            }
          }
        }
        return method.apply(this, inputArgs);
      },
    },
    serializers: {
      req: (req) => ({
        method: req.method,
        url: redactSensitiveUrl(req.url),
        ip: req.ip || req.remoteAddress,
        userAgent: req.headers?.['user-agent'],
      }),
      res: (res) => ({
        statusCode: res.statusCode,
      }),
      err: (err) => {
        if (err instanceof Error) return stdSerializers.err(err);
        const raw = (err as { raw?: unknown })?.raw;
        if (raw && !(raw instanceof Error)) return raw;
        return err;
      },
    },
    customLogLevel: (_req, res, err) => {
      if (res.statusCode >= 500 || err) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    autoLogging: isProduction || logHttp ? autoLogging : false,
  };

  return {
    assignResponse: true,
    pinoHttp: destination ? [options, destination] : options,
  };
}
