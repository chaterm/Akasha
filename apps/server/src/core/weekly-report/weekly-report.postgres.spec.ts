jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class CollaborationGateway {},
}));

import { ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import type { JSONContent } from '@tiptap/core';
import { PageRepo } from '../../database/repos/page/page.repo';
import { SpaceRepo } from '../../database/repos/space/space.repo';
import { KnowledgeSpaceCompilationRepo } from '../../database/repos/llm-wiki/knowledge-space-compilation.repo';
import { up as migrate } from '../../database/migrations/20261030T120000-weekly-reports';
import { PageService } from '../page/services/page.service';
import { WeeklyReportService } from './weekly-report.service';
import { WeeklyReportOutboxService } from './weekly-report-outbox.service';
import { normalizeWeeklyReportContent } from './weekly-report-content';
import { WEEKLY_REPORT_DRAFT_TEXT } from './weekly-report-draft';
import { createYdocFromJson } from '../../common/helpers/prosemirror/utils';
import { withApiKeyAccess } from '../../common/auth/api-key-access';
import { ApiKeyType } from '../../common/auth/api-key-type';
import { EventName } from '../../common/events/event.contants';
import { QueueJob } from '../../integrations/queue/constants';
import { jsonToNode, jsonToText } from '../../collaboration/collaboration.util';
import {
  BUILTIN_TEMPLATES,
  BUILTIN_WEEKLY_REPORT_ID,
} from '../template/builtin-templates';

const databaseUrl = process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = databaseUrl ? describe : describe.skip;
const ids = {
  workspace: randomUUID(),
  user: randomUUID(),
  space: randomUUID(),
};
const period = {
  period: 'custom' as const,
  periodStart: '2026-10-26',
  periodEnd: '2026-11-01',
};
const document = (text = 'Delivered verified work'): JSONContent => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** All DDL/DML is confined to a new schema on an explicitly supplied test URL. */
describePostgres(
  'Weekly reports PostgreSQL transactions and durable effects',
  () => {
    const schema = `akasha_weekly_report_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    let db: Kysely<any>;
    let secondDb: Kysely<any>;
    let first: ReturnType<typeof services>;
    let second: ReturnType<typeof services>;
    let outbox: WeeklyReportOutboxService;
    let compilation: KnowledgeSpaceCompilationRepo;
    let compilationSpy: jest.SpyInstance;
    const events = new EventEmitter2();
    const listener = jest.fn();
    const emitted = jest.spyOn(events, 'emit');
    const queues = {
      search: { add: jest.fn().mockResolvedValue(undefined) },
      knowledge: { add: jest.fn().mockResolvedValue(undefined) },
      general: { add: jest.fn().mockResolvedValue(undefined) },
      attachment: { add: jest.fn().mockResolvedValue(undefined) },
    };
    const audit = {
      log: jest.fn(),
      logWithContext: jest.fn().mockResolvedValue(undefined),
    };
    const environment = {
      getAppSecret: () => 'isolated-postgres-test-signing-secret',
      getSearchDriver: () => 'typesense',
    };
    const denied = new Set<string>();
    const acl = {
      validateCanView: jest.fn(async (page: { id: string }) => {
        if (denied.has(page.id)) throw new ForbiddenException();
      }),
      validateCanEdit: jest.fn().mockResolvedValue(undefined),
    };
    const template = {
      id: BUILTIN_WEEKLY_REPORT_ID,
      icon: '📅',
      title: '周报',
      content: document(),
      templateFingerprint: 'prepared-fingerprint',
    };
    const templates = { getForSpace: jest.fn(async () => ({ ...template })) };
    const ability = {
      createForUser: jest.fn().mockResolvedValue({ cannot: () => false }),
    };
    const ctx = {
      user: withApiKeyAccess(
        {
          id: ids.user,
          workspaceId: ids.workspace,
          name: 'Reporter',
          timezone: 'Asia/Shanghai',
        } as any,
        {
          apiKeyId: randomUUID(),
          keyType: ApiKeyType.PERSONAL,
          personalSpaceId: null,
        },
      ),
      workspace: { id: ids.workspace, name: 'Integration workspace' } as any,
    };

    function services(connection: Kysely<any>) {
      const pageRepo = new PageRepo(connection as never, undefined, events);
      const spaceRepo = new SpaceRepo(connection as never, events);
      const pageService = new PageService(
        pageRepo,
        undefined,
        undefined,
        connection as never,
        undefined,
        queues.attachment as never,
        queues.general as never,
        events,
        undefined,
        undefined,
        undefined,
      );
      const weekly = new WeeklyReportService(
        connection as never,
        spaceRepo,
        pageRepo,
        pageService,
        acl as never,
        ability as never,
        templates as never,
        environment as never,
      );
      return { pageRepo, spaceRepo, pageService, weekly };
    }

    async function connect() {
      const client = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
      return new Kysely<any>({
        dialect: new PostgresJSDialect({ postgres: client }),
        plugins: [new CamelCasePlugin()],
      });
    }

    beforeAll(async () => {
      db = await connect();
      await sql.raw(`create schema "${schema}"`).execute(db);
      await sql.raw(`set search_path to "${schema}"`).execute(db);
      await fixture(db);
      await migrate(db);
      secondDb = await connect();
      await sql.raw(`set search_path to "${schema}"`).execute(secondDb);
      first = services(db);
      second = services(secondDb);
      compilation = new KnowledgeSpaceCompilationRepo(db as never);
      compilationSpy = jest.spyOn(
        compilation,
        'scheduleIncrementalCompileForPages',
      );
      outbox = new WeeklyReportOutboxService(
        db as never,
        environment as never,
        queues.search as never,
        queues.knowledge as never,
        queues.general as never,
        compilation,
        { isEnabled: async () => false } as never,
        audit as never,
      );
      events.on(EventName.PAGE_CREATED, listener);
    }, 30_000);

    afterAll(async () => {
      if (db) {
        try {
          await sql
            .raw(`drop schema if exists "${schema}" cascade`)
            .execute(db);
          const remaining = await sql<{ present: boolean }>`select exists(
          select 1 from pg_catalog.pg_namespace where nspname = ${schema}
        ) as present`.execute(db);
          expect(remaining.rows[0].present).toBe(false);
        } finally {
          await secondDb?.destroy();
          await db.destroy();
        }
      }
      events.removeAllListeners();
    });

    beforeEach(async () => {
      await sql`truncate weekly_report_save_receipts, weekly_report_records, weekly_report_outbox,
      knowledge_page_compile_schedules, pages, spaces`.execute(db);
      await db
        .insertInto('spaces')
        .values({
          id: ids.space,
          workspaceId: ids.workspace,
          personalOwnerId: ids.user,
          name: 'Personal',
        })
        .execute();
      denied.clear();
      template.templateFingerprint = 'prepared-fingerprint';
      jest.clearAllMocks();
    });

    async function counts() {
      const result = await sql<{
        pages: number;
        reports: number;
        receipts: number;
        outbox: number;
        schedules: number;
      }>`select
      (select count(*)::int from pages) as pages,
      (select count(*)::int from weekly_report_records) as reports,
      (select count(*)::int from weekly_report_save_receipts) as receipts,
      (select count(*)::int from weekly_report_outbox) as outbox,
      (select count(*)::int from knowledge_page_compile_schedules) as schedules`.execute(
        db,
      );
      return result.rows[0];
    }

    async function prepare(parentPageId?: string) {
      const prepared = await first.weekly.prepare(ctx, {
        ...period,
        ...(parentPageId ? { parentPageId } : {}),
      });
      if (!('saveToken' in prepared))
        throw new Error('Expected fresh preparation');
      return prepared;
    }

    async function parent(title = 'Explicit parent') {
      const id = randomUUID();
      await db
        .insertInto('pages')
        .values({
          id,
          slugId: id.slice(0, 10),
          title,
          spaceId: ids.space,
          workspaceId: ids.workspace,
          creatorId: ids.user,
          lastUpdatedById: ids.user,
          content: document('Preserve this parent body'),
          position: 'a0',
        })
        .execute();
      return id;
    }

    function noExternalEffects() {
      expect(emitted).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      for (const queue of Object.values(queues))
        expect(queue.add).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(audit.logWithContext).not.toHaveBeenCalled();
      expect(compilationSpy).not.toHaveBeenCalled();
    }

    it('serializes two independent prepared tokens into one directory/report and two receipts', async () => {
      const [a, b] = await Promise.all([
        first.weekly.prepare(ctx, period),
        second.weekly.prepare(ctx, period),
      ]);
      if (!('saveToken' in a) || !('saveToken' in b))
        throw new Error('Expected fresh tokens');
      expect(a.saveToken).not.toBe(b.saveToken);
      expect(a.target).toMatchObject({
        spaceId: ids.space,
        parentPageId: null,
        willCreateParent: true,
      });
      expect(await counts()).toEqual({
        pages: 0,
        reports: 0,
        receipts: 0,
        outbox: 0,
        schedules: 0,
      });
      const results = await Promise.all([
        first.weekly.save(ctx, {
          saveToken: a.saveToken,
          content: document('First attempt'),
        }),
        second.weekly.save(ctx, {
          saveToken: b.saveToken,
          content: document('Second attempt'),
        }),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        'created',
        'existing',
      ]);
      expect(results[0].pageId).toBe(results[1].pageId);
      expect(await counts()).toEqual({
        pages: 2,
        reports: 1,
        receipts: 2,
        outbox: 9,
        schedules: 0,
      });
      const roots = await db
        .selectFrom('pages')
        .selectAll()
        .where('parentPageId', 'is', null)
        .execute();
      expect(roots).toHaveLength(1);
      expect(roots[0]).toMatchObject({
        title: '周报',
        icon: '📅',
        creatorId: ids.user,
        lastUpdatedById: ids.user,
      });
      const report = await db
        .selectFrom('pages')
        .selectAll()
        .where('id', '=', results[0].pageId)
        .executeTakeFirstOrThrow();
      expect(report.parentPageId).toBe(roots[0].id);
      noExternalEffects();
    });

    it('replays a committed token with changed/invalid content without overwriting or repeating effects', async () => {
      const { saveToken } = await prepare();
      const created = await first.weekly.save(ctx, {
        saveToken,
        title: 'Original',
        content: document('Original facts'),
      });
      const stored = await db
        .selectFrom('pages')
        .selectAll()
        .where('id', '=', created.pageId)
        .executeTakeFirstOrThrow();
      const result = await second.weekly.save(ctx, {
        saveToken,
        title: 'Replacement',
        content: { type: 'unknown' },
      });
      expect(result).toMatchObject({
        pageId: created.pageId,
        title: 'Original',
        status: 'replayed',
        parentCreated: true,
      });
      expect(
        await db
          .selectFrom('pages')
          .selectAll()
          .where('id', '=', created.pageId)
          .executeTakeFirstOrThrow(),
      ).toEqual(stored);
      expect(await counts()).toEqual({
        pages: 2,
        reports: 1,
        receipts: 1,
        outbox: 9,
        schedules: 0,
      });
      noExternalEffects();
    });

    it.each([
      {
        type: 'doc',
        content: [
          {
            type: 'madeUpNode',
            content: [{ type: 'text', text: 'must not disappear' }],
          },
        ],
      },
      {
        type: 'doc',
        content: [
          { type: 'paragraph', attrs: { undeclared: 'must not disappear' } },
        ],
      },
      { type: 'doc', content: [{ type: 'tableRow' }] },
    ])(
      'rejects invalid/lossy schema before creating any database state',
      async (content) => {
        const { saveToken } = await prepare();
        await expect(
          first.weekly.save(ctx, { saveToken, content }),
        ).rejects.toMatchObject({ response: { code: 'INVALID_CONTENT' } });
        expect(await counts()).toEqual({
          pages: 0,
          reports: 0,
          receipts: 0,
          outbox: 0,
          schedules: 0,
        });
        noExternalEffects();
        const corrected = await first.weekly.save(ctx, {
          saveToken,
          content: document('Corrected'),
        });
        expect(corrected.status).toBe('created');
      },
    );

    it('rolls back the actual parent insert when a database trigger rejects the report insert', async () => {
      const { saveToken } = await prepare();
      await expect(
        first.weekly.save(ctx, {
          saveToken,
          title: 'FAIL_AFTER_PARENT',
          content: document(),
        }),
      ).rejects.toThrow('injected report insert failure after parent creation');
      expect(await counts()).toEqual({
        pages: 0,
        reports: 0,
        receipts: 0,
        outbox: 0,
        schedules: 0,
      });
      noExternalEffects();
      expect(
        (
          await first.weekly.save(ctx, {
            saveToken,
            content: document('Retry after rollback'),
          })
        ).status,
      ).toBe('created');
    });

    it.each(['MJ3eqsj1Ac', '-MJ3eqsj1Ac'])(
      'looks up unique configured short ID %s and signs the canonical page UUID',
      async (value) => {
        const parentPageId = await parent();
        await db
          .updateTable('pages')
          .set({ slugId: 'MJ3eqsj1Ac' })
          .where('id', '=', parentPageId)
          .execute();
        const configured = {
          ...ctx,
          weeklyReportDefaults: { parentPageId: value },
        };
        const ready = await first.weekly.prepare(configured, period);
        if (!('saveToken' in ready)) throw new Error('Expected preparation');
        expect(ready.target.parentPageId).toBe(parentPageId);
        const created = await first.weekly.save(configured, {
          saveToken: ready.saveToken,
          content: document(),
        });
        expect(created.parentPageId).toBe(parentPageId);
      },
    );

    it('keeps the short first-step page resumable without compiling the placeholder', async () => {
      const { saveToken } = await prepare();
      const created = await first.weekly.save(ctx, {
        saveToken,
        content: document(WEEKLY_REPORT_DRAFT_TEXT),
      });
      expect(created.contentPending).toBe(true);
      expect(await counts()).toMatchObject({
        pages: 2,
        reports: 1,
        receipts: 1,
        outbox: 8,
        schedules: 0,
      });
      await expect(second.weekly.prepare(ctx, period)).resolves.toMatchObject({
        pageId: created.pageId,
        contentPending: true,
      });
      await outbox.drain();
      expect(compilationSpy).not.toHaveBeenCalled();
      expect((await counts()).schedules).toBe(0);
      // Emulate a later committed collaboration document: the persisted content
      // decides recovery, so completed pages are never mistaken for placeholders.
      const content = normalizeWeeklyReportContent(
        document('Verified completed body'),
      );
      await db
        .updateTable('pages')
        .set({
          content,
          textContent: jsonToText(content),
          ydoc: createYdocFromJson(content),
        })
        .where('id', '=', created.pageId)
        .execute();
      await expect(first.weekly.prepare(ctx, period)).resolves.toMatchObject({
        pageId: created.pageId,
        contentPending: false,
      });
      expect((await counts()).reports).toBe(1);
    });

    it('creates a direct child of an explicit parent and preserves its existing body', async () => {
      const parentPageId = await parent();
      const original = await db
        .selectFrom('pages')
        .selectAll()
        .where('id', '=', parentPageId)
        .executeTakeFirstOrThrow();
      const { saveToken } = await prepare(parentPageId);
      const result = await first.weekly.save(ctx, {
        saveToken,
        content: document(),
      });
      expect(result).toMatchObject({ parentPageId, parentCreated: false });
      expect(
        await db
          .selectFrom('pages')
          .selectAll()
          .where('id', '=', parentPageId)
          .executeTakeFirstOrThrow(),
      ).toEqual(original);
      expect(await counts()).toEqual({
        pages: 2,
        reports: 1,
        receipts: 1,
        outbox: 5,
        schedules: 0,
      });
      noExternalEffects();
    });

    it('rejects a parent locked before preparation or between preparation and saving', async () => {
      const parentPageId = await parent('周报');
      await db
        .updateTable('pages')
        .set({ isLocked: true })
        .where('id', '=', parentPageId)
        .execute();
      await expect(
        first.weekly.prepare(ctx, { ...period, parentPageId }),
      ).rejects.toMatchObject({ response: { code: 'PARENT_LOCKED' } });
      await db
        .updateTable('pages')
        .set({ isLocked: false })
        .where('id', '=', parentPageId)
        .execute();
      const { saveToken } = await prepare();
      await db
        .updateTable('pages')
        .set({ isLocked: true })
        .where('id', '=', parentPageId)
        .execute();
      await expect(
        first.weekly.save(ctx, { saveToken, content: document() }),
      ).rejects.toMatchObject({ response: { code: 'PARENT_LOCKED' } });
      expect(await counts()).toEqual({
        pages: 1,
        reports: 0,
        receipts: 0,
        outbox: 0,
        schedules: 0,
      });
      noExternalEffects();
    });

    it('returns the actual moved result and refuses to recreate deleted or newly inaccessible results', async () => {
      const { saveToken } = await prepare();
      const created = await first.weekly.save(ctx, {
        saveToken,
        content: document(),
      });
      const destination = await parent('Moved destination');
      await db
        .updateTable('pages')
        .set({ parentPageId: destination })
        .where('id', '=', created.pageId)
        .execute();
      await db
        .updateTable('pages')
        .set({ isLocked: true })
        .where('id', '=', created.parentPageId)
        .execute();
      expect(await first.weekly.prepare(ctx, period)).toMatchObject({
        status: 'existing',
        pageId: created.pageId,
        parentPageId: destination,
        locationChanged: true,
        // date columns come back from the driver as Dates; results stay calendar dates.
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
      });
      expect(
        await first.weekly.save(ctx, {
          saveToken,
          content: document('Changed'),
        }),
      ).toMatchObject({
        status: 'replayed',
        pageId: created.pageId,
        parentPageId: destination,
        locationChanged: true,
      });
      denied.add(created.pageId);
      await expect(first.weekly.prepare(ctx, period)).rejects.toMatchObject({
        response: { code: 'RESULT_UNAVAILABLE' },
      });
      denied.clear();
      await db
        .updateTable('pages')
        .set({ deletedAt: new Date() })
        .where('id', '=', created.pageId)
        .execute();
      await expect(first.weekly.prepare(ctx, period)).rejects.toMatchObject({
        response: { code: 'RESULT_UNAVAILABLE' },
      });
      await expect(
        first.weekly.save(ctx, { saveToken, content: document() }),
      ).rejects.toMatchObject({ response: { code: 'RESULT_UNAVAILABLE' } });
      expect(await counts()).toEqual({
        pages: 3,
        reports: 1,
        receipts: 1,
        outbox: 9,
        schedules: 0,
      });
      noExternalEffects();
    });

    it('retains the preparation fingerprint after an ordinary template edit', async () => {
      const { saveToken } = await prepare();
      template.templateFingerprint = 'edited-during-generation';
      const result = await first.weekly.save(ctx, {
        saveToken,
        content: document('Generated from original template'),
      });
      const record = await db
        .selectFrom('weeklyReportRecords')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(record.templateFingerprint).toBe('prepared-fingerprint');
      expect(result.status).toBe('created');
      expect(templates.getForSpace).toHaveBeenCalledTimes(2);
    });

    it('stores one normalized document consistently in JSON, extracted text and actual Y.Doc bytes', async () => {
      const { saveToken } = await prepare();
      const content = structuredClone(
        BUILTIN_TEMPLATES.find(
          (value) => value.id === BUILTIN_WEEKLY_REPORT_ID,
        )!.content,
      ) as JSONContent;
      content.content!.push({
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Verified source',
            marks: [
              { type: 'bold' },
              { type: 'link', attrs: { href: 'https://example.com/source' } },
            ],
          },
        ],
      });
      const normalized = normalizeWeeklyReportContent(content);
      const result = await first.weekly.save(ctx, { saveToken, content });
      const page = await first.pageRepo.findById(result.pageId, {
        includeContent: true,
        includeTextContent: true,
        includeYdoc: true,
      });
      expect(page.content).toEqual(normalized);
      expect(page.textContent).toBe(jsonToText(normalized));
      expect(page.ydoc).toBeInstanceOf(Buffer);
      const ydoc = new Y.Doc();
      try {
        Y.applyUpdate(ydoc, page.ydoc!);
        const restored = TiptapTransformer.fromYdoc(
          ydoc,
          'default',
        ) as JSONContent;
        expect(jsonToNode(restored).toJSON()).toEqual(normalized);
        expect(jsonToText(restored)).toBe(page.textContent);
      } finally {
        ydoc.destroy();
      }
    });

    it('rolls back compilation scheduling with a failed outbox checkpoint and recovers on retry', async () => {
      const { saveToken } = await prepare();
      const result = await first.weekly.save(ctx, {
        saveToken,
        content: document(),
      });
      await sql`create function fail_compile_checkpoint() returns trigger language plpgsql as $$
      begin
        if NEW.effect = 'compile' and NEW.delivered_at is not null then
          raise exception 'injected compile delivery checkpoint failure';
        end if;
        return NEW;
      end
    $$`.execute(db);
      await sql`create trigger fail_compile_checkpoint before update on weekly_report_outbox
      for each row execute function fail_compile_checkpoint()`.execute(db);
      try {
        await outbox.drain();
        expect(compilationSpy).toHaveBeenCalledTimes(1);
        expect(
          await db
            .selectFrom('knowledgePageCompileSchedules')
            .selectAll()
            .execute(),
        ).toEqual([]);
        expect(
          await db
            .selectFrom('weeklyReportOutbox')
            .selectAll()
            .where('effect', '=', 'compile')
            .where('deliveredAt', 'is', null)
            .execute(),
        ).toHaveLength(1);
      } finally {
        await sql`drop trigger fail_compile_checkpoint on weekly_report_outbox`.execute(
          db,
        );
        await sql`drop function fail_compile_checkpoint()`.execute(db);
      }
      await outbox.drain();
      const schedules = await db
        .selectFrom('knowledgePageCompileSchedules')
        .selectAll()
        .execute();
      expect(schedules).toHaveLength(1);
      expect(schedules[0]).toMatchObject({
        sourcePageId: result.pageId,
        changeCount: 1,
      });
      expect(compilationSpy).toHaveBeenCalledTimes(2);
      expect(
        await db
          .selectFrom('weeklyReportOutbox')
          .selectAll()
          .where('deliveredAt', 'is', null)
          .execute(),
      ).toEqual([]);
      expect((await counts()).reports).toBe(1);
    });

    it('dispatches durable effects only after commit and schedules compilation once for the report', async () => {
      const { saveToken } = await prepare();
      const result = await first.weekly.save(ctx, {
        saveToken,
        content: document(),
      });
      noExternalEffects();
      expect(
        await db
          .selectFrom('knowledgePageCompileSchedules')
          .selectAll()
          .execute(),
      ).toEqual([]);
      await outbox.drain();
      expect(emitted).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      expect(queues.search.add).toHaveBeenCalledTimes(2);
      expect(queues.knowledge.add).toHaveBeenCalledTimes(2);
      expect(queues.general.add).toHaveBeenCalledTimes(2);
      expect(audit.logWithContext).toHaveBeenCalledTimes(2);
      const pageIds = [result.parentPageId, result.pageId].sort();
      expect(
        queues.search.add.mock.calls.map((call) => call[1].pageIds[0]).sort(),
      ).toEqual(pageIds);
      expect(
        queues.search.add.mock.calls.every(
          (call) => call[0] === QueueJob.PAGE_CREATED,
        ),
      ).toBe(true);
      expect(
        queues.knowledge.add.mock.calls.every(
          (call) => call[0] === QueueJob.KNOWLEDGE_REINDEX_ACCESS,
        ),
      ).toBe(true);
      expect(
        queues.general.add.mock.calls.every(
          (call) => call[0] === QueueJob.ADD_PAGE_WATCHERS,
        ),
      ).toBe(true);
      expect(compilationSpy).toHaveBeenCalledTimes(1);
      expect(compilationSpy.mock.calls[0][0]).toMatchObject({
        sourcePageIds: [result.pageId],
        trigger: 'page_created',
      });
      expect(compilationSpy.mock.calls[0][1]).toBeDefined();
      const schedules = await db
        .selectFrom('knowledgePageCompileSchedules')
        .selectAll()
        .execute();
      expect(schedules).toHaveLength(1);
      expect(schedules[0]).toMatchObject({
        sourcePageId: result.pageId,
        changeCount: 1,
      });
      expect(
        await db
          .selectFrom('weeklyReportOutbox')
          .selectAll()
          .where('deliveredAt', 'is', null)
          .execute(),
      ).toEqual([]);
      expect(
        audit.logWithContext.mock.calls
          .map((call) => call[0].resourceId)
          .sort(),
      ).toEqual(pageIds);
      await outbox.drain();
      await first.weekly.save(ctx, { saveToken, content: document('Retry') });
      await outbox.drain();
      expect(compilationSpy).toHaveBeenCalledTimes(1);
      expect(queues.search.add).toHaveBeenCalledTimes(2);
      expect(queues.knowledge.add).toHaveBeenCalledTimes(2);
      expect(queues.general.add).toHaveBeenCalledTimes(2);
      expect(audit.logWithContext).toHaveBeenCalledTimes(2);
      expect(
        (
          await db
            .selectFrom('knowledgePageCompileSchedules')
            .selectAll()
            .executeTakeFirstOrThrow()
        ).changeCount,
      ).toBe(1);
    });
  },
);

async function fixture(db: Kysely<any>) {
  await sql`create table spaces (
    id uuid primary key, workspace_id uuid not null, personal_owner_id uuid,
    name text not null, deleted_at timestamptz
  )`.execute(db);
  await sql`create table pages (
    id uuid primary key default gen_random_uuid(),
    slug_id text, title text, icon text, cover_photo text, position text,
    parent_page_id uuid, creator_id uuid, last_updated_by_id uuid,
    source_creator_name text, source_last_updated_by_name text,
    space_id uuid not null, workspace_id uuid not null,
    is_locked boolean not null default false, created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(), deleted_at timestamptz,
    contributor_ids uuid[] not null default '{}', content jsonb, text_content text, ydoc bytea
  )`.execute(db);
  await sql`create table knowledge_page_compile_schedules (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid not null, space_id uuid not null, source_page_id uuid not null,
    trigger text not null, change_count integer not null default 1,
    first_changed_at timestamptz not null, last_changed_at timestamptz not null,
    eligible_at timestamptz not null, created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(), unique(workspace_id, source_page_id)
  )`.execute(db);
  await sql`create function fail_report_insert() returns trigger language plpgsql as $$
    begin
      if NEW.title = 'FAIL_AFTER_PARENT' then
        if not exists(select 1 from pages where id = NEW.parent_page_id and title = '周报') then
          raise exception 'test did not reach post-parent insertion';
        end if;
        raise exception 'injected report insert failure after parent creation';
      end if;
      return NEW;
    end
  $$`.execute(db);
  await sql`create trigger fail_report_insert before insert on pages
    for each row execute function fail_report_insert()`.execute(db);
}
