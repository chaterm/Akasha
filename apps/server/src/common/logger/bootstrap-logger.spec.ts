import * as fs from 'node:fs';
import { bootstrapLogger } from './bootstrap-logger';
import { SERVICE_NAME_COLLAB, SERVICE_NAME_SERVER } from './log-service-name';

describe('bootstrapLogger — pre-DI log line contract (plan §3, §4.4, scenario 13)', () => {
  let writeSyncSpy: jest.SpyInstance;
  let originalEnv: string | undefined;
  let originalServiceName: string | undefined;

  function writtenPayloads(): string[] {
    return writeSyncSpy.mock.calls
      .filter((call) => call[0] === 1)
      .map((call) => String(call[1]));
  }

  function singleWrittenLine(): Record<string, any> {
    const payloads = writtenPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].endsWith('\n')).toBe(true);
    expect(payloads[0].trimEnd()).not.toContain('\n');
    return JSON.parse(payloads[0]);
  }

  beforeAll(() => {
    originalEnv = process.env.NODE_ENV;
    originalServiceName = process.env.SERVICE_NAME;
  });

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    writeSyncSpy = jest
      .spyOn(fs, 'writeSync')
      .mockImplementation(() => 0 as unknown as number);
  });

  afterEach(() => {
    writeSyncSpy.mockRestore();
    if (originalServiceName === undefined) delete process.env.SERVICE_NAME;
    else process.env.SERVICE_NAME = originalServiceName;
  });

  afterAll(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('writes one valid JSON line carrying every §3 field, with "" for the request-scoped ids', () => {
    bootstrapLogger.error({ context: 'AppModule', msg: 'boot failed' });

    const line = singleWrittenLine();

    expect(line).toMatchObject({
      level: 'error',
      msg: 'boot failed',
      context: 'AppModule',
      service: SERVICE_NAME_SERVER,
      env: 'production',
      requestId: '',
      workspaceId: '',
      userId: '',
    });
    expect(typeof line.time).toBe('string');
    expect(new Date(line.time).toISOString()).toBe(line.time);
    expect(typeof line.pid).toBe('number');
    expect(typeof line.hostname).toBe('string');
  });

  it('writes to fd 1 (stdout) so Vector sees it in the same stream as pino output', () => {
    bootstrapLogger.warn({ context: 'EnvValidation', msg: 'missing var' });

    expect(writeSyncSpy).toHaveBeenCalledTimes(1);
    expect(writeSyncSpy.mock.calls[0][0]).toBe(1);
  });

  it.each(['debug', 'info', 'warn', 'error', 'fatal'] as const)(
    'emits the %s level as a pino-compatible label',
    (level) => {
      bootstrapLogger[level]({ context: 'Ctx', msg: 'm' });

      expect(singleWrittenLine().level).toBe(level);
    },
  );

  it('serializes an Error into {type,message,stack}, matching the pino err serializer', () => {
    bootstrapLogger.fatal({
      context: 'Bootstrap',
      msg: 'crashed',
      err: new TypeError('bad type'),
    });

    const line = singleWrittenLine();

    expect(line.err).toEqual({
      type: 'TypeError',
      message: 'bad type',
      stack: expect.stringContaining('bad type'),
    });
  });

  it('serializes a non-Error thrown value without losing the line', () => {
    bootstrapLogger.error({
      context: 'Bootstrap',
      msg: 'crashed',
      err: 'oops',
    });

    expect(singleWrittenLine().err).toEqual({
      type: 'string',
      message: 'oops',
    });
  });

  it('omits err entirely when no error was passed', () => {
    bootstrapLogger.info({ context: 'Ctx', msg: 'fine' });

    expect(singleWrittenLine()).not.toHaveProperty('err');
  });

  it('keeps extra fields alongside the contract fields', () => {
    bootstrapLogger.info({ context: 'Ctx', msg: 'm', pageId: 'p-1' });

    expect(singleWrittenLine().pageId).toBe('p-1');
  });

  it('reads the service name from SERVICE_NAME so collab bootstrap lines are attributable', () => {
    process.env.SERVICE_NAME = SERVICE_NAME_COLLAB;

    bootstrapLogger.info({ context: 'CollabBootstrap', msg: 'starting' });

    expect(singleWrittenLine().service).toBe(SERVICE_NAME_COLLAB);
  });

  it('falls back to safeStringify on a circular object instead of throwing', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    expect(() =>
      bootstrapLogger.error({ context: 'Ctx', msg: 'circular', circular }),
    ).not.toThrow();

    const line = singleWrittenLine();
    expect(line.msg).toBe('circular');
    expect(line.circular).toEqual({ name: 'loop', self: '[Circular]' });
  });

  it('falls back to safeStringify on a BigInt instead of throwing', () => {
    expect(() =>
      bootstrapLogger.error({ context: 'Ctx', msg: 'bigint', size: 10n }),
    ).not.toThrow();

    expect(singleWrittenLine().size).toBe('10');
  });

  it('never lets a failing fd 1 write break the shutdown path it logs from', () => {
    writeSyncSpy.mockImplementation(() => {
      throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' });
    });
    const stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    expect(() =>
      bootstrapLogger.fatal({ context: 'Ctx', msg: 'exiting' }),
    ).not.toThrow();
    expect(stdoutSpy).toHaveBeenCalledTimes(1);

    stdoutSpy.mockRestore();
  });
});
