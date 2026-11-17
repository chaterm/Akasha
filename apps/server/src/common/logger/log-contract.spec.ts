import {
  BadRequestException,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  InternalServerErrorException,
  MiddlewareConsumer,
  Module,
  NestMiddleware,
  NestModule,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  Logger as PinoLoggerService,
  LoggerModule as PinoLoggerModule,
  PinoLogger,
} from 'nestjs-pino';
import { ClsModule } from 'nestjs-cls';
import { createPinoConfig } from './pino.config';
import { resolveRequestId } from './request-id';
import { SERVICE_NAME_COLLAB, SERVICE_NAME_SERVER } from './log-service-name';
import { AllExceptionsFilter } from '../filters/all-exceptions.filter';
import { LogContextInterceptor } from '../interceptors/log-context.interceptor';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const TEST_WORKSPACE_ID = 'ws-log-contract';
const TEST_USER_ID = 'user-log-contract';
const BUSINESS_CONTEXT = 'LogProbeService';

type LogLine = Record<string, any>;

const logLines: LogLine[] = [];

const captureStream = {
  write(chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (line.trim().length === 0) continue;
      logLines.push(JSON.parse(line));
    }
  },
};

function accessLogs(): LogLine[] {
  return logLines.filter((line) => line.responseTime !== undefined);
}

function logsWithContext(context: string): LogLine[] {
  return logLines.filter((line) => line.context === context);
}

function businessLogs(): LogLine[] {
  return logsWithContext(BUSINESS_CONTEXT);
}

@Controller()
class LogProbeController {
  constructor(private readonly logger: PinoLoggerService) {}

  @Get('ok')
  ok() {
    return { ok: true };
  }

  @Get('boom/client')
  clientError() {
    throw new BadRequestException('invalid payload');
  }

  @Get('boom/server')
  serverError() {
    throw new InternalServerErrorException('downstream unavailable');
  }

  @Get('boom/unknown')
  unknownError(): never {
    throw new Error('boom');
  }

  @Get('boom/object')
  objectError(): never {
    throw {
      code: 'OBJECT_FAILURE',
      reason: 'serialized',
      nested: { attempt: 2 },
    };
  }

  @Get('boom/circular')
  circularError(): never {
    const error: Record<string, unknown> = {
      code: 'CIRCULAR_FAILURE',
      reason: 'serialized',
    };
    error.self = error;
    throw error;
  }

  @Get('boom/http-error')
  httpErrorShape(): never {
    throw Object.assign(new Error('Request body is too large'), {
      statusCode: 413,
    });
  }

  @Get('log/business')
  businessLog() {
    this.logger.log({ msg: 'business step done' }, BUSINESS_CONTEXT);
    return { ok: true };
  }

  @Get('log/sensitive')
  sensitiveLog() {
    this.logger.log(
      {
        msg: 'sensitive payload',
        password: 'pw-plain',
        token: 'tk-plain',
        secret: 'sc-plain',
        accessToken: 'at-plain',
        refreshToken: 'rt-plain',
        authorization: 'Bearer plain',
        cookie: 'session=plain',
        user: { token: 'nested-tk', password: 'nested-pw', name: 'keep-me' },
        a: { b: { token: 'deep-tk' } },
        keptField: 'visible',
      },
      BUSINESS_CONTEXT,
    );
    return { ok: true };
  }

  @Get('log/real-error')
  realErrorLog() {
    this.logger.error(
      { msg: 'real error logged', err: new TypeError('serializer probe') },
      BUSINESS_CONTEXT,
    );
    return { ok: true };
  }

  @Get('log/shaped-error')
  shapedErrorLog() {
    this.logger.error(
      {
        msg: 'shaped error logged',
        err: {
          type: 'BadRequestException',
          message: 'shaped',
          statusCode: 400,
        },
      },
      BUSINESS_CONTEXT,
    );
    return { ok: true };
  }
}

@Controller('health')
class LogProbeHealthController {
  @Get()
  check() {
    return { status: 'ok' };
  }

  @Get('live')
  live() {
    return 'ok';
  }
}

@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    request.user = {
      user: { id: TEST_USER_ID },
      workspace: { id: TEST_WORKSPACE_ID },
    };
    return true;
  }
}

@Injectable()
class FakeDomainMiddleware implements NestMiddleware {
  constructor(private readonly pinoLogger: PinoLogger) {}

  use(_req: unknown, _res: unknown, next: () => void) {
    this.pinoLogger.assign({ workspaceId: TEST_WORKSPACE_ID });
    next();
  }
}

@Module({ providers: [FakeDomainMiddleware] })
class FakeDomainModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(FakeDomainMiddleware).forRoutes('*');
  }
}

async function createLogTestApp(
  options: { registerExceptionFilter: boolean } = {
    registerExceptionFilter: true,
  },
): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ClsModule.forRoot({
        global: true,
        middleware: {
          mount: true,
          generateId: true,
          idGenerator: (req) => resolveRequestId(req),
          setup: (cls, _req, res) => {
            res.setHeader('x-request-id', cls.getId());
          },
        },
      }),
      PinoLoggerModule.forRoot(
        createPinoConfig(SERVICE_NAME_SERVER, captureStream),
      ),
      FakeDomainModule,
    ],
    controllers: [LogProbeController, LogProbeHealthController],
    providers: [
      { provide: APP_GUARD, useClass: FakeAuthGuard },
      { provide: APP_INTERCEPTOR, useClass: LogContextInterceptor },
    ],
  }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );

  app.setGlobalPrefix('api');
  app.useLogger(app.get(PinoLoggerService));

  if (options.registerExceptionFilter) {
    app.useGlobalFilters(
      new AllExceptionsFilter(app.getHttpAdapter(), app.get(PinoLoggerService)),
    );
  }

  await app.init();
  return app;
}

describe('log field contract over a real Fastify request chain (plan §7.1)', () => {
  let app: NestFastifyApplication;
  let originalNodeEnv: string | undefined;

  beforeAll(async () => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    app = await createLogTestApp();
  });

  afterAll(async () => {
    await app?.close();
    process.env.NODE_ENV = originalNodeEnv;
  });

  beforeEach(() => {
    logLines.length = 0;
  });

  describe('requestId propagation (scenarios 1, 2, 10)', () => {
    it('scenario 1: adopts a clean inbound x-request-id and echoes it back', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/ok',
        headers: { 'x-request-id': 'inbound-req-id-1' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['x-request-id']).toBe('inbound-req-id-1');
      expect(accessLogs()).toHaveLength(1);
      expect(accessLogs()[0].requestId).toBe('inbound-req-id-1');
    });

    it('scenario 2: generates a UUID requestId when the header is absent, and echoes it', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/ok' });

      const generated = accessLogs()[0].requestId;
      expect(generated).toMatch(UUID_V4);
      expect(response.headers['x-request-id']).toBe(generated);
    });

    it('scenario 10: rejects a dirty x-request-id and logs a clean generated one instead', async () => {
      await app.inject({
        method: 'GET',
        url: '/api/ok',
        headers: { 'x-request-id': 'dirty, value' },
      });

      const { requestId } = accessLogs()[0];
      expect(requestId).toMatch(UUID_V4);
      expect(requestId).not.toContain(',');
      expect(requestId).not.toMatch(/\s/);
    });
  });

  describe('access log coverage (scenario 3)', () => {
    it('emits an access log carrying the full §3 request/response fields', async () => {
      await app.inject({ method: 'GET', url: '/api/ok?q=1' });

      expect(accessLogs()).toHaveLength(1);
      const line = accessLogs()[0];
      expect(line).toMatchObject({
        level: 'info',
        service: SERVICE_NAME_SERVER,
        env: 'production',
        req: {
          method: 'GET',
          url: '/api/ok?q=1',
        },
        res: { statusCode: 200 },
      });
      expect(typeof line.responseTime).toBe('number');
      expect(typeof line.pid).toBe('number');
      expect(typeof line.hostname).toBe('string');
      expect(new Date(line.time).toISOString()).toBe(line.time);
    });

    it('drops the health probes, which would otherwise dominate production log volume', async () => {
      const health = await app.inject({ method: 'GET', url: '/api/health' });
      const live = await app.inject({ method: 'GET', url: '/api/health/live' });

      expect(health.statusCode).toBe(200);
      expect(live.statusCode).toBe(200);
      expect(accessLogs()).toHaveLength(0);
    });

    it('ignores health by path only, so a query string cannot smuggle one back in', async () => {
      await app.inject({ method: 'GET', url: '/api/health?verbose=1' });

      expect(accessLogs()).toHaveLength(0);
    });

    it('still logs a non-health route in the same app, proving autoLogging is on', async () => {
      await app.inject({ method: 'GET', url: '/api/health/live' });
      await app.inject({ method: 'GET', url: '/api/ok' });

      expect(accessLogs()).toHaveLength(1);
      expect(accessLogs()[0].req.url).toBe('/api/ok');
    });
  });

  describe('exception logging levels and err shape (scenarios 4a, 4b, 4d)', () => {
    const FILTER_CONTEXT = 'AllExceptionsFilter';

    it('scenario 4b: logs a 4xx at warn, carrying message and statusCode', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/boom/client',
      });

      expect(response.statusCode).toBe(400);
      const filterLogs = logsWithContext(FILTER_CONTEXT);
      expect(filterLogs).toHaveLength(1);
      expect(filterLogs[0].level).toBe('warn');
      expect(filterLogs[0].err).toEqual({
        type: 'BadRequestException',
        message: 'invalid payload',
        statusCode: 400,
      });
    });

    it('scenario 4a (5xx HttpException): logs at error with a non-empty stack', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/boom/server',
      });

      expect(response.statusCode).toBe(500);
      const filterLogs = logsWithContext(FILTER_CONTEXT);
      expect(filterLogs).toHaveLength(1);
      expect(filterLogs[0].level).toBe('error');
      expect(filterLogs[0].err).toMatchObject({
        message: 'downstream unavailable',
        statusCode: 500,
        stack: expect.stringContaining('InternalServerErrorException'),
      });
    });

    it('scenario 4a (non-HttpException): logs at error with message and stack', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/boom/unknown',
      });

      expect(response.statusCode).toBe(500);
      const filterLogs = logsWithContext(FILTER_CONTEXT);
      expect(filterLogs).toHaveLength(1);
      expect(filterLogs[0].level).toBe('error');
      expect(filterLogs[0].err).toMatchObject({
        message: 'boom',
        stack: expect.stringContaining('boom'),
      });
    });

    it('scenario 4a (plain object): serializes the original fields into details', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/boom/object',
      });

      expect(response.statusCode).toBe(500);
      const filterLogs = logsWithContext(FILTER_CONTEXT);
      expect(filterLogs).toHaveLength(1);
      expect(filterLogs[0].level).toBe('error');
      expect(filterLogs[0].err).toMatchObject({
        type: 'Object',
        message: expect.stringContaining('"OBJECT_FAILURE"'),
        details: {
          code: 'OBJECT_FAILURE',
          reason: 'serialized',
          nested: { attempt: 2 },
        },
      });
    });

    it('scenario 4a (circular object): replaces cycles with a marker instead of throwing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/boom/circular',
      });

      expect(response.statusCode).toBe(500);
      const filterLogs = logsWithContext(FILTER_CONTEXT);
      expect(filterLogs).toHaveLength(1);
      expect(filterLogs[0].err).toMatchObject({
        type: 'Object',
        details: {
          code: 'CIRCULAR_FAILURE',
          reason: 'serialized',
          self: '[Circular]',
        },
      });
    });

    it('carries requestId on the exception log so it joins the access log', async () => {
      await app.inject({
        method: 'GET',
        url: '/api/boom/unknown',
        headers: { 'x-request-id': 'err-correlation-id' },
      });

      expect(logsWithContext(FILTER_CONTEXT)[0].requestId).toBe(
        'err-correlation-id',
      );
      expect(accessLogs()[0].requestId).toBe('err-correlation-id');
    });

    it('scenario 4d: a non-HttpException produces exactly one error log, not a second ExceptionsHandler copy', async () => {
      await app.inject({ method: 'GET', url: '/api/boom/unknown' });

      const errorLines = logLines.filter(
        (line) => line.level === 'error' && line.responseTime === undefined,
      );
      expect(errorLines).toHaveLength(1);
      expect(errorLines[0].context).toBe(FILTER_CONTEXT);
      expect(logsWithContext('ExceptionsHandler')).toHaveLength(0);
    });

    it('classifies the failing request access log by status, not by exception type', async () => {
      await app.inject({ method: 'GET', url: '/api/boom/client' });
      expect(accessLogs()[0]).toMatchObject({
        level: 'warn',
        res: { statusCode: 400 },
      });

      logLines.length = 0;
      await app.inject({ method: 'GET', url: '/api/boom/unknown' });
      expect(accessLogs()[0]).toMatchObject({
        level: 'error',
        res: { statusCode: 500 },
      });
    });
  });

  describe('tenant and user injection (scenarios 8, 9)', () => {
    it('scenario 8: the access log carries workspaceId and userId, which requires assignResponse:true', async () => {
      await app.inject({ method: 'GET', url: '/api/ok' });

      expect(accessLogs()).toHaveLength(1);
      expect(accessLogs()[0]).toMatchObject({
        workspaceId: TEST_WORKSPACE_ID,
        userId: TEST_USER_ID,
      });
    });

    it('scenario 9: a business log after assign shares the access log requestId and carries both ids', async () => {
      await app.inject({
        method: 'GET',
        url: '/api/log/business',
        headers: { 'x-request-id': 'business-corr-id' },
      });

      expect(businessLogs()).toHaveLength(1);
      expect(businessLogs()[0]).toMatchObject({
        level: 'info',
        msg: 'business step done',
        service: SERVICE_NAME_SERVER,
        env: 'production',
        requestId: 'business-corr-id',
        workspaceId: TEST_WORKSPACE_ID,
        userId: TEST_USER_ID,
      });
      expect(businessLogs()[0].requestId).toBe(accessLogs()[0].requestId);
    });

    it('carries workspaceId and userId onto exception logs too', async () => {
      await app.inject({ method: 'GET', url: '/api/boom/unknown' });

      expect(logsWithContext('AllExceptionsFilter')[0]).toMatchObject({
        workspaceId: TEST_WORKSPACE_ID,
        userId: TEST_USER_ID,
      });
    });
  });

  describe('redaction of explicitly logged secrets (scenario 5)', () => {
    it('masks the depth-1 and depth-2 sensitive paths, and leaves everything else readable', async () => {
      await app.inject({ method: 'GET', url: '/api/log/sensitive' });

      expect(businessLogs()).toHaveLength(1);
      const line = businessLogs()[0];

      expect(line.password).toBe('[REDACTED]');
      expect(line.token).toBe('[REDACTED]');
      expect(line.secret).toBe('[REDACTED]');
      expect(line.accessToken).toBe('[REDACTED]');
      expect(line.refreshToken).toBe('[REDACTED]');
      expect(line.authorization).toBe('[REDACTED]');
      expect(line.cookie).toBe('[REDACTED]');

      expect(line.user.token).toBe('[REDACTED]');
      expect(line.user.password).toBe('[REDACTED]');
      expect(line.user.name).toBe('keep-me');

      expect(line.keptField).toBe('visible');
      expect(line.msg).toBe('sensitive payload');
    });

    it('does NOT reach depth 3, because `*` is a single-level wildcard', async () => {
      await app.inject({ method: 'GET', url: '/api/log/sensitive' });

      expect(businessLogs()[0].a.b.token).toBe('deep-tk');
    });

    it('does not redact request headers, because the req serializer never emits them', async () => {
      await app.inject({
        method: 'GET',
        url: '/api/ok',
        headers: { authorization: 'Bearer should-not-be-logged' },
      });

      const line = accessLogs()[0];
      expect(line.req).not.toHaveProperty('headers');
      expect(JSON.stringify(line)).not.toContain('should-not-be-logged');
    });
  });

  describe('err serializer dual path (scenario 11)', () => {
    it('serializes a real Error into type/message/stack', async () => {
      await app.inject({ method: 'GET', url: '/api/log/real-error' });

      expect(businessLogs()).toHaveLength(1);
      expect(businessLogs()[0].err).toMatchObject({
        type: 'TypeError',
        message: 'serializer probe',
        stack: expect.stringContaining('serializer probe'),
      });
    });

    it('keeps a non-Error object that has no `message` key completely untouched', async () => {
      await app.inject({ method: 'GET', url: '/api/log/shaped-error' });

      expect(businessLogs()).toHaveLength(1);
      expect(businessLogs()[0].err.statusCode).toBe(400);
    });
  });

  describe('out-of-context logging (scenario 7)', () => {
    it('does not throw and emits the base fields when there is no request ALS', () => {
      const logger = app.get(PinoLoggerService);

      expect(() =>
        logger.log({ msg: 'background job finished' }, 'BackgroundJob'),
      ).not.toThrow();

      const line = logsWithContext('BackgroundJob')[0];
      expect(line).toMatchObject({
        level: 'info',
        msg: 'background job finished',
        service: SERVICE_NAME_SERVER,
        env: 'production',
      });
    });

    it('omits requestId/workspaceId/userId keys entirely rather than emitting ""', () => {
      const logger = app.get(PinoLoggerService);

      logger.log({ msg: 'no request context' }, 'BackgroundJob');

      const line = logsWithContext('BackgroundJob')[0];
      expect(line).not.toHaveProperty('requestId');
      expect(line).not.toHaveProperty('workspaceId');
      expect(line).not.toHaveProperty('userId');
    });

    it('confirms assign() outside a request throws, which is why callers guard it', async () => {
      const pinoLogger = await app.resolve(PinoLogger);

      expect(() => pinoLogger.assign({ workspaceId: 'ws-x' })).toThrow(
        /out of request scope/,
      );
    });
  });

  describe('service field per process (scenario 6)', () => {
    it('stamps akasha-server and akasha-collab from the serviceName argument', () => {
      const serverConfig = createPinoConfig(SERVICE_NAME_SERVER, captureStream);
      const collabConfig = createPinoConfig(SERVICE_NAME_COLLAB, captureStream);

      expect(serverConfig.pinoHttp[0].base).toMatchObject({
        service: 'akasha-server',
        env: 'production',
      });
      expect(collabConfig.pinoHttp[0].base).toMatchObject({
        service: 'akasha-collab',
        env: 'production',
      });
    });

    it('keeps pid and hostname, which an explicit base would otherwise drop', () => {
      const { base } = createPinoConfig(SERVICE_NAME_SERVER, captureStream)
        .pinoHttp[0];

      expect(typeof base.pid).toBe('number');
      expect(typeof base.hostname).toBe('string');
    });

    it('exposes assignResponse at the Params level, not inside pinoHttp', () => {
      const config = createPinoConfig(SERVICE_NAME_SERVER, captureStream);

      expect(config.assignResponse).toBe(true);
      expect(config.pinoHttp[0]).not.toHaveProperty('assignResponse');
    });
  });

  describe('shaped err payloads survive pino-http serializer wrapping (scenarios 4b, 11)', () => {
    it('keeps the exception class name in err.type for a 4xx', async () => {
      await app.inject({ method: 'GET', url: '/api/boom/client' });

      expect(logsWithContext('AllExceptionsFilter')[0].err.type).toBe(
        'BadRequestException',
      );
    });

    it('leaves a 4xx with no err.stack key at all', async () => {
      await app.inject({ method: 'GET', url: '/api/boom/client' });

      expect(logsWithContext('AllExceptionsFilter')[0].err).not.toHaveProperty(
        'stack',
      );
    });

    it('keeps the class name for a 5xx HttpException and a raw Error', async () => {
      await app.inject({ method: 'GET', url: '/api/boom/server' });
      const serverErr = logsWithContext('AllExceptionsFilter')[0].err;
      expect(serverErr.type).toBe('InternalServerErrorException');
      expect(typeof serverErr.stack).toBe('string');
      expect(serverErr.stack.length).toBeGreaterThan(0);

      logLines.length = 0;
      await app.inject({ method: 'GET', url: '/api/boom/unknown' });
      expect(logsWithContext('AllExceptionsFilter')[0].err.type).toBe('Error');
    });

    it('passes through a shaped err logged by business code unchanged', async () => {
      await app.inject({ method: 'GET', url: '/api/log/shaped-error' });

      expect(businessLogs()[0].err).toEqual({
        type: 'BadRequestException',
        message: 'shaped',
        statusCode: 400,
      });
    });

    it('produces the same shape in and out of a request', () => {
      const logger = app.get(PinoLoggerService);

      logger.error(
        {
          msg: 'shaped out of context',
          err: {
            type: 'BadRequestException',
            message: 'shaped',
            statusCode: 400,
          },
        },
        'BackgroundJob',
      );

      expect(logsWithContext('BackgroundJob')[0].err).toEqual({
        type: 'BadRequestException',
        message: 'shaped',
        statusCode: 400,
      });
    });
  });
});

describe('exception responses are byte-identical with and without the filter (scenario 4c)', () => {
  let appWithFilter: NestFastifyApplication;
  let appWithoutFilter: NestFastifyApplication;
  let originalNodeEnv: string | undefined;

  const EXCEPTION_ROUTES: Array<[string, string]> = [
    ['4xx HttpException', '/api/boom/client'],
    ['5xx HttpException', '/api/boom/server'],
    ['non-HttpException', '/api/boom/unknown'],
    ['http-error shape carrying statusCode 413', '/api/boom/http-error'],
  ];

  beforeAll(async () => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    appWithFilter = await createLogTestApp({ registerExceptionFilter: true });
    appWithoutFilter = await createLogTestApp({
      registerExceptionFilter: false,
    });
  });

  afterAll(async () => {
    await appWithFilter?.close();
    await appWithoutFilter?.close();
    process.env.NODE_ENV = originalNodeEnv;
  });

  beforeEach(() => {
    logLines.length = 0;
  });

  it.each(EXCEPTION_ROUTES)(
    'keeps status and payload unchanged for a %s',
    async (_label, url) => {
      const withFilter = await appWithFilter.inject({ method: 'GET', url });
      const withoutFilter = await appWithoutFilter.inject({
        method: 'GET',
        url,
      });

      expect(withFilter.statusCode).toBe(withoutFilter.statusCode);
      expect(withFilter.payload).toBe(withoutFilter.payload);
    },
  );

  it('preserves the 413 from an http-error shape rather than collapsing it to 500', async () => {
    const response = await appWithFilter.inject({
      method: 'GET',
      url: '/api/boom/http-error',
    });

    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.payload)).toEqual({
      statusCode: 413,
      message: 'Request body is too large',
    });
  });

  it('keeps the NestJS HttpException body shape the client reads', async () => {
    const response = await appWithFilter.inject({
      method: 'GET',
      url: '/api/boom/client',
    });

    expect(JSON.parse(response.payload)).toEqual({
      statusCode: 400,
      message: 'invalid payload',
      error: 'Bad Request',
    });
  });

  it('without the filter, the framework logs its own ExceptionsHandler line', async () => {
    await appWithoutFilter.inject({ method: 'GET', url: '/api/boom/unknown' });

    expect(logsWithContext('ExceptionsHandler')).toHaveLength(1);
    expect(logsWithContext('AllExceptionsFilter')).toHaveLength(0);
  });

  it('with the filter, that framework line is replaced by exactly one structured record', async () => {
    await appWithFilter.inject({ method: 'GET', url: '/api/boom/unknown' });

    expect(logsWithContext('ExceptionsHandler')).toHaveLength(0);
    expect(logsWithContext('AllExceptionsFilter')).toHaveLength(1);
  });
});

describe('global filters cannot reach the WS pipeline (scenario 4e)', () => {
  it('the filter returns without logging or replying for a non-http host', () => {
    const logger = {
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as PinoLoggerService;
    const httpAdapter = { reply: jest.fn() };
    const filter = new AllExceptionsFilter(httpAdapter as never, logger);

    const wsHost = {
      getType: () => 'ws',
      switchToHttp: () => {
        throw new Error('switchToHttp must not be called for a ws host');
      },
    };

    expect(() =>
      filter.catch(new Error('ws boom'), wsHost as never),
    ).not.toThrow();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(httpAdapter.reply).not.toHaveBeenCalled();
  });
});

describe('createPinoConfig err serializer, called directly (scenario 11)', () => {
  let originalNodeEnv: string | undefined;
  let errSerializer: (err: unknown) => any;

  beforeAll(() => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    errSerializer = createPinoConfig(SERVICE_NAME_SERVER, captureStream)
      .pinoHttp[0].serializers.err;
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('converts a real Error into enumerable type/message/stack', () => {
    const serialized = errSerializer(new TypeError('direct probe'));

    expect(JSON.parse(JSON.stringify(serialized))).toMatchObject({
      type: 'TypeError',
      message: 'direct probe',
      stack: expect.stringContaining('direct probe'),
    });
  });

  it('leaves a non-Error object untouched, without rewriting type to "Object"', () => {
    const shaped = {
      type: 'BadRequestException',
      message: 'invalid payload',
      statusCode: 400,
    };

    expect(errSerializer(shaped)).toEqual(shaped);
    expect(errSerializer(shaped)).not.toHaveProperty('stack');
  });

  it('passes primitives and null through without throwing', () => {
    expect(errSerializer('a string')).toBe('a string');
    expect(errSerializer(null)).toBeNull();
    expect(errSerializer(undefined)).toBeUndefined();
  });
});
