import { Logger } from '@nestjs/common';
import type { KyselyDB } from '../../database/types/kysely.types';
import { QueueJob } from '../../integrations/queue/constants';
import { KNOWLEDGE_PAGE_COMPILE_QUIET_PERIOD_MS } from '../../features/llm-wiki/llm-wiki.constants';
import { WeeklyReportOutboxService } from './weekly-report-outbox.service';
import type { WeeklyReportEffect } from './weekly-report.types';

type Entry = {
  id: string;
  pageId: string;
  workspaceId: string;
  userId: string;
  effect: WeeklyReportEffect;
  attempts: number;
  availableAt: Date;
  deliveredAt: Date | null;
};
type PageRow = {
  id: string;
  workspaceId: string;
  spaceId: string;
  title: string;
  deletedAt: Date | null;
};
type Filter = { field: string; operator: string; value: unknown };
class OutboxQuery {
  private filters: Filter[] = [];
  private update: Partial<Entry> = {};
  constructor(
    private readonly db: OutboxDb,
    private readonly table: 'weeklyReportOutbox' | 'pages',
  ) {}
  selectAll() {
    return this;
  }
  select(_fields: string[]) {
    return this;
  }
  where(field: string, operator: string, value: unknown) {
    this.filters.push({ field, operator, value });
    return this;
  }
  orderBy(_field: string) {
    return this;
  }
  forUpdate() {
    this.db.lockedReads++;
    return this;
  }
  skipLocked() {
    this.db.skippedLockedReads++;
    return this;
  }
  limit(_limit: number) {
    return this;
  }
  set(update: Partial<Entry>) {
    this.update = update;
    return this;
  }
  private matching() {
    return (this.table === 'pages' ? this.db.pages : this.db.entries).filter(
      (row) =>
        this.filters.every(({ field, operator, value }) => {
          const actual = (row as unknown as Record<string, unknown>)[field];
          return operator === '<='
            ? (actual as Date).getTime() <= (value as Date).getTime()
            : actual === value;
        }),
    );
  }
  async executeTakeFirst() {
    return this.matching()[0];
  }
  async execute() {
    this.matching().forEach((row) => Object.assign(row, this.update));
  }
}
/** Pending rows are isolated per callback, so a failed transaction cannot retain
 * a delivery checkpoint or a retry counter. PostgreSQL concurrency is tested separately. */
class OutboxDb {
  entries: Entry[] = [];
  pages: PageRow[] = [];
  transactions: OutboxDb[] = [];
  lockedReads = 0;
  skippedLockedReads = 0;
  selectFrom(table: 'weeklyReportOutbox' | 'pages') {
    return new OutboxQuery(this, table);
  }
  updateTable(table: 'weeklyReportOutbox') {
    return new OutboxQuery(this, table);
  }
  transaction() {
    return {
      execute: async <T>(callback: (trx: OutboxDb) => Promise<T>) => {
        const trx = new OutboxDb();
        trx.entries = this.entries.map((row) => ({
          ...row,
          availableAt: new Date(row.availableAt),
          deliveredAt: row.deliveredAt ? new Date(row.deliveredAt) : null,
        }));
        trx.pages = this.pages.map((row) => ({ ...row }));
        this.transactions.push(trx);
        const result = await callback(trx);
        this.entries = trx.entries;
        return result;
      },
    };
  }
}
const entry = (
  effect: WeeklyReportEffect,
  overrides: Partial<Entry> = {},
): Entry => ({
  id: `event-${effect}`,
  pageId: 'page',
  workspaceId: 'workspace',
  userId: 'user',
  effect,
  attempts: 0,
  availableAt: new Date(0),
  deliveredAt: null,
  ...overrides,
});
function fixture(
  effects: WeeklyReportEffect[] = [
    'search',
    'access',
    'watchers',
    'audit',
    'compile',
  ],
) {
  const db = new OutboxDb();
  db.entries = effects.map((effect) => entry(effect));
  db.pages = [
    {
      id: 'page',
      workspaceId: 'workspace',
      spaceId: 'space',
      title: 'Weekly report',
      deletedAt: null,
    },
  ];
  const search = { add: jest.fn().mockResolvedValue(undefined) };
  const knowledge = { add: jest.fn().mockResolvedValue(undefined) };
  const general = { add: jest.fn().mockResolvedValue(undefined) };
  const compilation = {
    scheduleIncrementalCompileForPages: jest.fn().mockResolvedValue(undefined),
  };
  const compileWindow = { isEnabled: jest.fn().mockResolvedValue(true) };
  const audit = { logWithContext: jest.fn().mockResolvedValue(undefined) };
  const environment = {
    getSearchDriver: jest.fn().mockReturnValue('typesense'),
  };
  const service = new WeeklyReportOutboxService(
    db as unknown as KyselyDB,
    environment as any,
    search as any,
    knowledge as any,
    general as any,
    compilation as any,
    compileWindow as any,
    audit as any,
  );
  return {
    db,
    search,
    knowledge,
    general,
    compilation,
    compileWindow,
    audit,
    environment,
    service,
  };
}

describe('WeeklyReportOutboxService durable effect delivery', () => {
  beforeEach(() =>
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
  );
  afterEach(() => jest.restoreAllMocks());

  it('dispatches committed effects serially and checkpoints each independently', async () => {
    const f = fixture();
    let resolveSearch!: () => void;
    f.search.add.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSearch = resolve;
        }),
    );
    expect(f.search.add).not.toHaveBeenCalled();
    const drain = f.service.drain();
    // Let the first queued effect start without settling it.
    for (let i = 0; i < 8 && !f.search.add.mock.calls.length; i++)
      await Promise.resolve();
    expect(f.search.add).toHaveBeenCalledTimes(1);
    expect(f.knowledge.add).not.toHaveBeenCalled();
    expect(f.db.entries.every((row) => row.deliveredAt === null)).toBe(true);
    await f.service.drain(); // An overlapping timer must not dispatch the same row.
    expect(f.search.add).toHaveBeenCalledTimes(1);
    resolveSearch();
    await drain;
    expect(f.db.entries.every((row) => row.deliveredAt instanceof Date)).toBe(
      true,
    );
    expect(f.db.transactions).toHaveLength(6); // Five checkpoints plus the empty poll.
    expect(
      f.db.transactions.every(
        (trx) => trx.lockedReads === 1 && trx.skippedLockedReads === 1,
      ),
    ).toBe(true);
    expect(f.search.add).toHaveBeenCalledWith(
      QueueJob.PAGE_CREATED,
      { pageIds: ['page'] },
      expect.objectContaining({
        jobId: 'weekly-report-event-search',
        attempts: 5,
        removeOnFail: false,
      }),
    );
    expect(f.knowledge.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_REINDEX_ACCESS,
      { workspaceId: 'workspace', sourcePageIds: ['page'] },
      expect.objectContaining({ jobId: 'weekly-report-event-access' }),
    );
    expect(f.general.add).toHaveBeenCalledWith(
      QueueJob.ADD_PAGE_WATCHERS,
      {
        userIds: ['user'],
        pageId: 'page',
        spaceId: 'space',
        workspaceId: 'workspace',
      },
      expect.objectContaining({ jobId: 'weekly-report-event-watchers' }),
    );
    expect(f.audit.logWithContext).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: 'page',
        metadata: { source: 'weekly-report-skill', eventId: 'event-audit' },
      }),
      { workspaceId: 'workspace', actorId: 'user' },
    );
    expect(
      f.compilation.scheduleIncrementalCompileForPages,
    ).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace',
        sourcePageIds: ['page'],
        trigger: 'page_created',
        quietPeriodMs: 0,
      },
      f.db.transactions[4],
    );
    await f.service.drain();
    expect(f.search.add).toHaveBeenCalledTimes(1);
    expect(f.knowledge.add).toHaveBeenCalledTimes(1);
    expect(f.general.add).toHaveBeenCalledTimes(1);
    expect(f.audit.logWithContext).toHaveBeenCalledTimes(1);
    expect(
      f.compilation.scheduleIncrementalCompileForPages,
    ).toHaveBeenCalledTimes(1);
  });

  it('schedules compilation and its delivery checkpoint using the same transaction', async () => {
    const f = fixture(['compile']);
    f.compileWindow.isEnabled.mockResolvedValue(false);
    f.compilation.scheduleIncrementalCompileForPages.mockImplementation(
      async (_input, trx: OutboxDb) => {
        expect(trx).toBe(f.db.transactions[0]);
        expect(trx.entries[0].deliveredAt).toBeNull();
        expect(f.db.entries[0].deliveredAt).toBeNull();
      },
    );
    await f.service.drain();
    expect(
      f.compilation.scheduleIncrementalCompileForPages,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        quietPeriodMs: KNOWLEDGE_PAGE_COMPILE_QUIET_PERIOD_MS,
      }),
      f.db.transactions[0],
    );
    expect(f.db.entries[0].deliveredAt).toBeInstanceOf(Date);
  });

  it('delays a failed effect while allowing independent effects to finish and retaining stable retry IDs', async () => {
    const f = fixture(['search', 'access', 'compile']);
    f.search.add.mockRejectedValueOnce(new Error('Queue unavailable'));
    const before = Date.now();
    await f.service.drain();
    expect(f.db.entries[0]).toMatchObject({ attempts: 1, deliveredAt: null });
    expect(f.db.entries[0].availableAt.getTime()).toBeGreaterThanOrEqual(
      before + 2000,
    );
    expect(
      f.db.entries.slice(1).every((row) => row.deliveredAt instanceof Date),
    ).toBe(true);
    f.db.entries[0].availableAt = new Date(0);
    await f.service.drain();
    expect(f.search.add).toHaveBeenCalledTimes(2);
    expect(f.search.add.mock.calls.map((call) => call[2].jobId)).toEqual([
      'weekly-report-event-search',
      'weekly-report-event-search',
    ]);
    expect(f.knowledge.add).toHaveBeenCalledTimes(1);
    expect(
      f.compilation.scheduleIncrementalCompileForPages,
    ).toHaveBeenCalledTimes(1);
    expect(f.db.entries[0].deliveredAt).toBeInstanceOf(Date);
  });

  it('rolls back on a SQL failure rather than checkpointing within an aborted transaction', async () => {
    const f = fixture(['compile']);
    f.compilation.scheduleIncrementalCompileForPages.mockRejectedValueOnce(
      Object.assign(new Error('Serialization failure'), { code: '40001' }),
    );
    await f.service.drain();
    expect(f.db.entries[0]).toMatchObject({ attempts: 0, deliveredAt: null });
    expect(f.db.transactions).toHaveLength(1);
    await f.service.drain();
    expect(
      f.compilation.scheduleIncrementalCompileForPages,
    ).toHaveBeenCalledTimes(2);
    expect(f.db.entries[0].deliveredAt).toBeInstanceOf(Date);
  });

  it('does not schedule search jobs for a non-Typesense driver', async () => {
    const f = fixture(['search', 'access']);
    f.environment.getSearchDriver.mockReturnValue('postgres');
    await f.service.drain();
    expect(f.search.add).not.toHaveBeenCalled();
    expect(f.knowledge.add).toHaveBeenCalledTimes(1);
    expect(f.db.entries.every((row) => row.deliveredAt instanceof Date)).toBe(
      true,
    );
  });

  it.each(['deleted', 'missing', 'foreign'] as const)(
    'checkpoints an obsolete %s page without emitting effects',
    async (condition) => {
      const f = fixture();
      if (condition === 'deleted') f.db.pages[0].deletedAt = new Date();
      if (condition === 'missing') f.db.pages = [];
      if (condition === 'foreign')
        f.db.pages[0].workspaceId = 'other-workspace';
      await f.service.drain();
      expect(f.search.add).not.toHaveBeenCalled();
      expect(f.knowledge.add).not.toHaveBeenCalled();
      expect(f.general.add).not.toHaveBeenCalled();
      expect(f.audit.logWithContext).not.toHaveBeenCalled();
      expect(
        f.compilation.scheduleIncrementalCompileForPages,
      ).not.toHaveBeenCalled();
      expect(f.db.entries.every((row) => row.deliveredAt instanceof Date)).toBe(
        true,
      );
    },
  );
});
