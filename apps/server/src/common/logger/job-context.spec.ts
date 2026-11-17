import { Job } from 'bullmq';
import pino from 'pino';
import { createPinoConfig } from './pino.config';
import { getJobContext, runWithJobContext } from './job-context';
import { ContextualWorkerHost } from './contextual-worker.host';
import { WithJobContext } from './with-job-context.decorator';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function makeLogger() {
  const lines: Record<string, any>[] = [];
  const config = createPinoConfig('akasha-server', {
    write(chunk: string) {
      for (const line of chunk.split('\n')) {
        if (line.trim()) lines.push(JSON.parse(line));
      }
    },
  });
  const [options, stream] = config.pinoHttp as [any, any];
  return { logger: pino(options, stream), lines };
}

describe('job log context', () => {
  it('has no context outside a job', () => {
    expect(getJobContext()).toBeUndefined();
  });

  it('generates a requestId and exposes job identity inside the scope', async () => {
    await runWithJobContext(
      { jobId: '42', jobName: 'page.backlinks' },
      async () => {
        const ctx = getJobContext();
        expect(ctx.jobId).toBe('42');
        expect(ctx.jobName).toBe('page.backlinks');
        expect(ctx.requestId).toMatch(UUID_V4);
      },
    );
  });

  it('keeps a caller-supplied requestId', async () => {
    await runWithJobContext(
      { jobId: '1', jobName: 'j', requestId: 'upstream-id' },
      async () => {
        expect(getJobContext().requestId).toBe('upstream-id');
      },
    );
  });

  it('stays isolated between concurrent jobs', async () => {
    const seen: string[] = [];
    const run = (id: string) =>
      runWithJobContext({ jobId: id, jobName: 'j' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(getJobContext().jobId);
      });

    await Promise.all([run('a'), run('b'), run('c')]);
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
  });

  it('puts requestId and job fields on every line logged inside a job', async () => {
    const { logger, lines } = makeLogger();

    await runWithJobContext({ jobId: '7', jobName: 'email.send' }, async () => {
      logger.info({ context: 'EmailProcessor' }, 'sending');
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      msg: 'sending',
      context: 'EmailProcessor',
      jobId: '7',
      jobName: 'email.send',
      service: 'akasha-server',
    });
    expect(lines[0].requestId).toMatch(UUID_V4);
  });

  it('does not add job fields to lines logged outside a job', () => {
    const { logger, lines } = makeLogger();

    logger.info({ context: 'Boot' }, 'starting');

    expect(lines[0].jobId).toBeUndefined();
    expect(lines[0].jobName).toBeUndefined();
  });

  it('lets an explicitly logged field win over the mixin', async () => {
    const { logger, lines } = makeLogger();

    await runWithJobContext({ jobId: '7', jobName: 'j' }, async () => {
      logger.info({ jobId: 'explicit' }, 'msg');
    });

    expect(lines[0].jobId).toBe('explicit');
  });
});

describe('ContextualWorkerHost', () => {
  it('wraps handle() in a context carrying job identity and attempt', async () => {
    const seen: any[] = [];

    class Probe extends ContextualWorkerHost {
      async handle(): Promise<void> {
        seen.push(getJobContext());
      }
    }

    await new Probe().process({
      id: 99,
      name: 'knowledge.image',
      attemptsMade: 1,
    } as unknown as Job);

    expect(seen[0]).toMatchObject({
      jobId: '99',
      jobName: 'knowledge.image',
      attempt: 2,
    });
    expect(seen[0].requestId).toMatch(UUID_V4);
  });

  it('returns the handler result and propagates failures', async () => {
    class Ok extends ContextualWorkerHost {
      async handle(): Promise<string> {
        return 'done';
      }
    }
    class Fails extends ContextualWorkerHost {
      async handle(): Promise<void> {
        throw new Error('boom');
      }
    }

    await expect(
      new Ok().process({ id: 1, name: 'n', attemptsMade: 0 } as unknown as Job),
    ).resolves.toBe('done');
    await expect(
      new Fails().process({
        id: 1,
        name: 'n',
        attemptsMade: 0,
      } as unknown as Job),
    ).rejects.toThrow('boom');
  });
});

describe('WithJobContext', () => {
  it('names the context after the scheduled job', async () => {
    const seen: any[] = [];

    class Scheduler {
      @WithJobContext('trash-cleanup')
      async run(): Promise<string> {
        seen.push(getJobContext());
        return 'ok';
      }
    }

    await expect(new Scheduler().run()).resolves.toBe('ok');
    expect(seen[0]).toMatchObject({ jobId: '', jobName: 'trash-cleanup' });
    expect(seen[0].requestId).toMatch(UUID_V4);
  });

  it('preserves the receiver', async () => {
    class Svc {
      value = 'kept';

      @WithJobContext('j')
      async run(): Promise<string> {
        return this.value;
      }
    }

    await expect(new Svc().run()).resolves.toBe('kept');
  });
});
