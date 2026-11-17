import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger as PinoLoggerService, LoggerModule } from 'nestjs-pino';
import { createPinoConfig } from './pino.config';
import { runWithJobContext } from './job-context';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const lines: Record<string, any>[] = [];

const captureStream = {
  write(chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (line.trim()) lines.push(JSON.parse(line));
    }
  },
};

describe('new Logger() delegates to pino once app.useLogger is set', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot(
          createPinoConfig('akasha-server', captureStream as any),
        ),
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.useLogger(app.get(PinoLoggerService));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  it('routes a plain new Logger() call into the pino stream', () => {
    new Logger('PlainNestLogger').log('hello');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      context: 'PlainNestLogger',
      service: 'akasha-server',
    });
  });

  it('picks up job context from the mixin, so non-DI loggers are correlated too', async () => {
    await runWithJobContext(
      { jobId: '5', jobName: 'trash-cleanup' },
      async () => {
        new Logger('TrashCleanupService').log('purged');
      },
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      context: 'TrashCleanupService',
      jobId: '5',
      jobName: 'trash-cleanup',
    });
    expect(lines[0].requestId).toMatch(UUID_V4);
  });
});
