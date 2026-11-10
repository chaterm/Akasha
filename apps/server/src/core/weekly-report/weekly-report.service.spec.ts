jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class {},
}));

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import type { JSONContent } from '@tiptap/core';
import { withApiKeyAccess } from '../../common/auth/api-key-access';
import { ApiKeyType } from '../../common/auth/api-key-type';
import type {
  KyselyDB,
  KyselyTransaction,
} from '../../database/types/kysely.types';
import type { McpToolContext } from '../mcp/mcp-tool-registry';
import { BUILTIN_WEEKLY_REPORT_ID } from '../template/builtin-templates';
import { normalizeWeeklyReportContent } from './weekly-report-content';
import { WeeklyReportService } from './weekly-report.service';
import { WEEKLY_REPORT_DRAFT_TEXT } from './weekly-report-draft';
import type {
  PrepareWeeklyReportInput,
  WeeklyReportClaims,
} from './weekly-report.types';

type Table =
  | 'pages'
  | 'weeklyReportRecords'
  | 'weeklyReportSaveReceipts'
  | 'weeklyReportOutbox';
type Row = Record<string, unknown>;
type Filter = { field: string; operator: string; value: unknown };

/** Fluent query fake applies predicates and stages writes until commit. Advisory
 * locks are stubbed below: actual PostgreSQL locking belongs to integration tests. */
class Query {
  readonly filters: Filter[] = [];
  private incoming: Row[] = [];
  constructor(
    private readonly db: TestDb,
    private readonly table: Table,
    private readonly insert = false,
  ) {}
  select(_fields: string | string[]) {
    return this;
  }
  selectAll() {
    return this;
  }
  returningAll() {
    return this;
  }
  where(field: string, operator: string, value: unknown) {
    this.filters.push({ field, operator, value });
    return this;
  }
  values(rows: Row | Row[]) {
    this.incoming = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  private run(): Row[] {
    if (this.insert) {
      const rows = this.incoming.map((row) => ({ ...row }));
      this.db.rows[this.table].push(...rows);
      this.db.writes.push({
        table: this.table,
        rows,
        inTransaction: this.db.inTransaction,
      });
      return rows;
    }
    return this.db.rows[this.table].filter((row) =>
      this.filters.every(({ field, operator, value }) => {
        if (operator !== '=' && operator !== 'is')
          throw new Error(`Unexpected predicate: ${operator}`);
        return row[field] === value;
      }),
    );
  }
  async execute() {
    return this.run();
  }
  async executeTakeFirst() {
    return this.run()[0];
  }
  async executeTakeFirstOrThrow() {
    const row = this.run()[0];
    if (!row) throw new Error('No row');
    return row;
  }
}
class TestDb {
  rows: Record<Table, Row[]> = {
    pages: [],
    weeklyReportRecords: [],
    weeklyReportSaveReceipts: [],
    weeklyReportOutbox: [],
  };
  writes: { table: Table; rows: Row[]; inTransaction: boolean }[] = [];
  transactions: TestDb[] = [];
  constructor(readonly inTransaction = false) {}
  selectFrom(table: Table) {
    return new Query(this, table);
  }
  insertInto(table: Table) {
    return new Query(this, table, true);
  }
  transaction = jest.fn(() => ({
    execute: async <T>(callback: (trx: TestDb) => Promise<T>) => {
      const trx = new TestDb(true);
      trx.rows = structuredClone(this.rows);
      this.transactions.push(trx);
      const result = await callback(trx);
      this.rows = trx.rows;
      this.writes.push(...trx.writes);
      return result;
    },
  }));
}

const IDS = {
  user: '84324b40-28ff-5be1-9c2a-94905189ee97',
  workspace: 'c724cd23-6b0c-59b9-95b3-75a73c02e422',
  personal: 'da48184d-a340-5691-bc05-7104b39e2b1d',
  shared: 'e45bb85b-68d4-50e4-901a-11fcc0538a8b',
  custom_template: '9694050d-4ebc-59d6-8560-d88d7d0ecf45',
  missing_custom: '3899b508-0acd-57bf-a260-7e7b0a7a1bfb',
  custom: 'a033c03e-2062-54f8-ad35-da24b5ebb6e4',
  deleted_template: '36bebc73-72cf-5c24-bd9b-7548e8a951aa',
  chosen: 'dcaec16f-7579-5ebb-b38d-21f8f3b7c1ce',
  directory: '226c2b9b-1f78-5f06-8785-d29767db4272',
  moved_space: '9a360f63-96aa-54a7-a460-c120672989d2',
  moved_parent: '5bf85b3f-15c4-5fba-9659-bff43aaf3eca',
  another: '1d72f3ac-a77e-5eb5-acc3-86cf7e8f0f06',
} as const;
const SECRET = 'test-only-weekly-report-secret';
const PERIOD: PrepareWeeklyReportInput = {
  period: 'custom',
  periodStart: '2026-10-26',
  periodEnd: '2026-11-01',
};
const BODY: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Completed the API integration' }],
    },
  ],
};
const page = (id: string, extra: Row = {}): Row => ({
  id,
  workspaceId: IDS.workspace,
  spaceId: IDS.personal,
  parentPageId: null,
  slugId: `slug-${id}`,
  title: id,
  deletedAt: null,
  isLocked: false,
  ...extra,
});
function context(
  keyType: ApiKeyType | 'sso' | 'legacy' = ApiKeyType.PERSONAL,
): McpToolContext {
  const user = {
    id: IDS.user,
    name: 'Member',
    timezone: 'Asia/Shanghai',
  } as McpToolContext['user'];
  return {
    user:
      keyType === 'sso'
        ? user
        : withApiKeyAccess(user, {
            apiKeyId: 'key',
            personalSpaceId: null,
            ...(keyType === 'legacy' ? {} : { keyType }),
          }),
    workspace: {
      id: IDS.workspace,
      name: 'Team',
    } as McpToolContext['workspace'],
  };
}

function fixture() {
  const db = new TestDb();
  const ctx = context();
  const space = {
    id: IDS.personal,
    name: 'My space',
    workspaceId: IDS.workspace,
    deletedAt: null,
    type: 'personal',
    personalOwnerId: IDS.user,
  };
  const spaceRepo = {
    findPersonalSpaceForUser: jest.fn().mockResolvedValue(space),
    findById: jest
      .fn()
      .mockImplementation(async (id: string) => ({ ...space, id })),
  };
  const pageRepo = {
    findById: jest.fn(async (id: string, options?: { trx?: TestDb }) =>
      (options?.trx ?? db).rows.pages.find(
        (row) => row.id === id || row.slugId === id,
      ),
    ),
  };
  const pageAccess = {
    validateCanView: jest.fn().mockResolvedValue(undefined),
    validateCanEdit: jest.fn().mockResolvedValue(undefined),
  };
  const spaceAbility = {
    createForUser: jest.fn().mockResolvedValue({ cannot: () => false }),
  };
  const templates = {
    getForSpace: jest.fn().mockImplementation(async (id: string) => ({
      id,
      content: BODY,
      templateFingerprint: 'fingerprint-at-prepare',
      icon: '📅',
    })),
  };
  const pageService = {
    create: jest.fn(
      async (
        _user: string,
        _workspace: string,
        draft: Row,
        options: { trx: TestDb; deferCreatedEffects: boolean },
      ) => {
        const created = page(randomUUID(), draft);
        options.trx.rows.pages.push(created);
        return created;
      },
    ),
  };
  const service = new WeeklyReportService(
    db as unknown as KyselyDB,
    spaceRepo as any,
    pageRepo as any,
    pageService as any,
    pageAccess as any,
    spaceAbility as any,
    templates as any,
    { getAppSecret: () => SECRET } as any,
  );
  const locks = jest
    .spyOn(
      service as unknown as {
        lock(trx: KyselyTransaction, key: string): Promise<void>;
      },
      'lock',
    )
    .mockResolvedValue(undefined);
  return {
    service,
    db,
    ctx,
    space,
    spaceRepo,
    pageRepo,
    pageService,
    pageAccess,
    spaceAbility,
    templates,
    locks,
  };
}
type Fixture = ReturnType<typeof fixture>;
async function prepared(f: Fixture, input: PrepareWeeklyReportInput = {}) {
  const result = await f.service.prepare(f.ctx, { ...PERIOD, ...input });
  if (!('saveToken' in result)) throw new Error('Expected preparation');
  return result;
}
function sign(claims: WeeklyReportClaims, options: jwt.SignOptions = {}) {
  return jwt.sign(claims, SECRET, {
    algorithm: 'HS256',
    issuer: 'Akasha',
    audience: 'weekly-report-save',
    expiresIn: 1800,
    ...options,
  });
}
function errorCode(code: string) {
  return expect.objectContaining({
    response: expect.objectContaining({ code }),
  });
}

describe('WeeklyReportService identity and preparation', () => {
  it('uses Shanghai without asking, even with a missing or different profile timezone', async () => {
    const f = fixture();
    for (const timezone of [null, 'America/Los_Angeles', 'invalid']) {
      f.ctx.user.timezone = timezone;
      const result = await prepared(f);
      expect(result.timezone).toBe('Asia/Shanghai');
      expect(jwt.verify(result.saveToken, SECRET)).toMatchObject({
        timezone: 'Asia/Shanghai',
      });
    }
    expect((await prepared(f, { timezone: 'America/New_York' })).timezone).toBe(
      'America/New_York',
    );
  });
  it.each(['MJ3eqsj1Ac', '-MJ3eqsj1Ac'])(
    'resolves configured short parent %s to its canonical UUID before signing',
    async (value) => {
      const f = fixture();
      f.ctx.weeklyReportDefaults = { parentPageId: value };
      f.db.rows.pages.push(
        page(IDS.chosen, { slugId: 'MJ3eqsj1Ac', title: 'Weekly archive' }),
      );
      const result = await prepared(f);
      expect(result.target.parentPageId).toBe(IDS.chosen);
      expect(jwt.verify(result.saveToken, SECRET)).toMatchObject({
        parentPageId: IDS.chosen,
      });
      expect(f.pageAccess.validateCanView).toHaveBeenCalled();
      expect(f.pageAccess.validateCanEdit).toHaveBeenCalled();
    },
  );
  it('rejects a short parent identifier in another workspace', async () => {
    const f = fixture();
    f.ctx.weeklyReportDefaults = { parentPageId: 'MJ3eqsj1Ac' };
    f.db.rows.pages.push(
      page(IDS.chosen, { slugId: 'MJ3eqsj1Ac', workspaceId: IDS.another }),
    );
    await expect(prepared(f)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.templates.getForSpace).not.toHaveBeenCalled();
  });
  it('uses connection defaults on repeated preparations without requiring message-level IDs', async () => {
    const f = fixture();
    f.ctx.weeklyReportDefaults = {
      templateId: IDS.custom_template,
      parentPageId: IDS.chosen,
    };
    f.db.rows.pages.push(
      page(IDS.chosen, { spaceId: IDS.shared, title: 'Team weekly reports' }),
    );
    for (let i = 0; i < 2; i++) {
      const result = await prepared(f);
      expect(result.target).toMatchObject({
        spaceId: IDS.shared,
        parentPageId: IDS.chosen,
      });
      expect(result.template.id).toBe(IDS.custom_template);
      expect(jwt.verify(result.saveToken, SECRET)).toMatchObject({
        templateId: IDS.custom_template,
        parentPageId: IDS.chosen,
      });
    }
    expect(f.spaceRepo.findPersonalSpaceForUser).not.toHaveBeenCalled();
    expect(f.pageService.create).not.toHaveBeenCalled();
  });

  it('allows a temporary override and explicit null to bypass connection defaults', async () => {
    const f = fixture();
    f.ctx.weeklyReportDefaults = {
      templateId: IDS.custom_template,
      parentPageId: IDS.chosen,
    };
    f.db.rows.pages.push(page(IDS.another, { title: 'One-off reports' }));
    const explicit = await prepared(f, {
      templateId: BUILTIN_WEEKLY_REPORT_ID,
      parentPageId: IDS.another,
    });
    expect(explicit.target.parentPageId).toBe(IDS.another);
    expect(explicit.template.id).toBe(BUILTIN_WEEKLY_REPORT_ID);
    const system = await prepared(f, { templateId: null, parentPageId: null });
    expect(system.target).toMatchObject({
      spaceId: IDS.personal,
      parentPageId: null,
    });
    expect(system.template.id).toBe(BUILTIN_WEEKLY_REPORT_ID);
    expect(f.ctx.weeklyReportDefaults).toEqual({
      templateId: IDS.custom_template,
      parentPageId: IDS.chosen,
    });
  });

  it('validates configured targets and never silently falls back from a missing parent', async () => {
    const f = fixture();
    f.ctx.weeklyReportDefaults = { parentPageId: IDS.chosen };
    await expect(prepared(f)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.spaceRepo.findPersonalSpaceForUser).not.toHaveBeenCalled();
    expect(f.pageService.create).not.toHaveBeenCalled();
  });

  it('keeps the prepared target bound to its token if connection defaults change before save', async () => {
    const f = fixture();
    f.ctx.weeklyReportDefaults = {
      templateId: IDS.custom_template,
      parentPageId: IDS.chosen,
    };
    f.db.rows.pages.push(page(IDS.chosen, { title: 'Pinned parent' }));
    const ready = await prepared(f);
    f.ctx.weeklyReportDefaults = {
      templateId: IDS.missing_custom,
      parentPageId: IDS.another,
    };
    await expect(
      f.service.save(f.ctx, { saveToken: ready.saveToken, content: BODY }),
    ).resolves.toMatchObject({
      templateId: IDS.custom_template,
      parentPageId: IDS.chosen,
      status: 'created',
    });
  });

  it.each(['sso', 'legacy', ApiKeyType.AGENT] as const)(
    'rejects %s before querying space or template',
    async (key) => {
      const f = fixture();
      await expect(f.service.prepare(context(key), PERIOD)).rejects.toEqual(
        errorCode('IDENTITY_UNSUPPORTED'),
      );
      await expect(
        f.service.save(context(key), { saveToken: 'invalid', content: BODY }),
      ).rejects.toEqual(errorCode('IDENTITY_UNSUPPORTED'));
      expect(f.spaceRepo.findPersonalSpaceForUser).not.toHaveBeenCalled();
      expect(f.templates.getForSpace).not.toHaveBeenCalled();
      expect(f.db.transaction).not.toHaveBeenCalled();
    },
  );
  it('also rejects an Agent delegation context even if a personal-key marker is present', async () => {
    const f = fixture();
    f.ctx.agentAccess = {} as McpToolContext['agentAccess'];
    await expect(prepared(f)).rejects.toEqual(
      errorCode('IDENTITY_UNSUPPORTED'),
    );
  });
  it('queries the real personal space with a null access-context cache and selects the semantic builtin', async () => {
    const f = fixture();
    const result = await prepared(f);
    expect(f.spaceRepo.findPersonalSpaceForUser).toHaveBeenCalledWith({
      userId: IDS.user,
      workspaceId: IDS.workspace,
      trx: undefined,
    });
    expect(f.templates.getForSpace).toHaveBeenCalledWith(
      BUILTIN_WEEKLY_REPORT_ID,
      IDS.personal,
      f.ctx.user,
      f.ctx.workspace,
    );
    expect(result.target).toMatchObject({
      parentPageId: null,
      willCreateParent: true,
      parentTitle: '周报',
    });
    expect(result.title).toBe('2026-10-26 至 2026-11-01 周报');
    expect(jwt.verify(result.saveToken, SECRET)).toMatchObject({
      userId: IDS.user,
      workspaceId: IDS.workspace,
      spaceId: IDS.personal,
      templateId: BUILTIN_WEEKLY_REPORT_ID,
    });
    expect(f.pageService.create).not.toHaveBeenCalled();
    expect(f.db.rows.weeklyReportOutbox).toEqual([]);
  });
  it('rejects absent and deleted personal spaces before preparing or creating content', async () => {
    const f = fixture();
    f.spaceRepo.findPersonalSpaceForUser.mockResolvedValueOnce(undefined);
    await expect(prepared(f)).rejects.toEqual(
      errorCode('PERSONAL_SPACE_UNAVAILABLE'),
    );
    f.spaceRepo.findPersonalSpaceForUser.mockResolvedValueOnce({
      ...f.space,
      deletedAt: new Date(),
    });
    await expect(prepared(f)).rejects.toEqual(
      errorCode('PERSONAL_SPACE_UNAVAILABLE'),
    );
    expect(f.templates.getForSpace).not.toHaveBeenCalled();
    expect(f.pageService.create).not.toHaveBeenCalled();
  });
  it.each(['workspaceId', 'personalOwnerId'] as const)(
    'rejects a stale default personal space with a different %s',
    async (field) => {
      const f = fixture();
      f.spaceRepo.findPersonalSpaceForUser.mockResolvedValue({
        ...f.space,
        [field]: randomUUID(),
      });
      await expect(prepared(f)).rejects.toEqual(
        errorCode('PERSONAL_SPACE_UNAVAILABLE'),
      );
      expect(f.pageService.create).not.toHaveBeenCalled();
    },
  );
  it('requires edit permission on an explicit parent and create permission on an empty personal space', async () => {
    const f = fixture();
    f.db.rows.pages.push(page('cae13a68-701a-4a0b-b80f-ec6d0473be00'));
    f.pageAccess.validateCanEdit.mockRejectedValue(new ForbiddenException());
    await expect(
      prepared(f, { parentPageId: 'cae13a68-701a-4a0b-b80f-ec6d0473be00' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    f.spaceAbility.createForUser.mockResolvedValue({ cannot: () => true });
    await expect(prepared(f)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.templates.getForSpace).not.toHaveBeenCalled();
  });
  it('uses an explicit parent to select its space and the requested template without a directory wrapper', async () => {
    const f = fixture();
    f.db.rows.pages.push(
      page(IDS.chosen, { spaceId: IDS.shared, title: 'Project reports' }),
    );
    const result = await prepared(f, {
      parentPageId: IDS.chosen,
      templateId: IDS.custom_template,
    });
    expect(result.target).toMatchObject({
      spaceId: IDS.shared,
      parentPageId: IDS.chosen,
      willCreateParent: false,
    });
    expect(f.spaceRepo.findPersonalSpaceForUser).not.toHaveBeenCalled();
    expect(f.templates.getForSpace).toHaveBeenCalledWith(
      IDS.custom_template,
      IDS.shared,
      f.ctx.user,
      f.ctx.workspace,
    );
  });
  it.each(['missing', 'deleted', 'foreign'] as const)(
    'rejects an explicit %s parent without fallback',
    async (kind) => {
      const f = fixture();
      if (kind !== 'missing')
        f.db.rows.pages.push(
          page(
            IDS.chosen,
            kind === 'deleted'
              ? { deletedAt: new Date() }
              : { workspaceId: 'other' },
          ),
        );
      await expect(
        prepared(f, { parentPageId: IDS.chosen }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(f.spaceRepo.findPersonalSpaceForUser).not.toHaveBeenCalled();
    },
  );
  it('only resolves exact undeleted root directory names, ignoring similarly named and nested pages', async () => {
    const f = fixture();
    f.db.rows.pages.push(
      page('wrong-title', { title: '周报 2' }),
      page('nested', { title: '周报', parentPageId: IDS.another }),
      page('deleted', { title: '周报', deletedAt: new Date() }),
      page(IDS.directory, { title: '周报' }),
    );
    expect((await prepared(f)).target.parentPageId).toBe(IDS.directory);
  });
  it('reports ambiguous visible directories and never silently picks one', async () => {
    const f = fixture();
    f.db.rows.pages.push(
      page('a', { title: '周报' }),
      page('b', { title: '周报' }),
    );
    await expect(prepared(f)).rejects.toEqual(
      expect.objectContaining({
        response: expect.objectContaining({
          code: 'TARGET_AMBIGUOUS',
          details: {
            candidates: [
              { pageId: 'a', title: '周报', url: '/p/slug-a' },
              { pageId: 'b', title: '周报', url: '/p/slug-b' },
            ],
          },
        }),
      }),
    );
    expect(f.pageService.create).not.toHaveBeenCalled();
  });
  it('does not create a second default directory when the existing directory is inaccessible', async () => {
    const f = fixture();
    f.db.rows.pages.push(page(IDS.directory, { title: '周报' }));
    f.pageAccess.validateCanView.mockRejectedValue(new ForbiddenException());
    await expect(prepared(f)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.pageService.create).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    'rejects locked parents, including default directories (explicit=%s)',
    async (explicit) => {
      const f = fixture();
      f.db.rows.pages.push(
        page(IDS.directory, { title: '周报', isLocked: true }),
      );
      await expect(
        prepared(f, explicit ? { parentPageId: IDS.directory } : {}),
      ).rejects.toEqual(errorCode('PARENT_LOCKED'));
      expect(f.templates.getForSpace).not.toHaveBeenCalled();
    },
  );
  it('does not fall back from a rejected custom template to the builtin', async () => {
    const f = fixture();
    f.templates.getForSpace.mockRejectedValue(
      new NotFoundException('Template not found'),
    );
    await expect(
      prepared(f, { templateId: IDS.missing_custom }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.templates.getForSpace).toHaveBeenCalledTimes(1);
  });
});

describe('WeeklyReportService signed saves and replay', () => {
  it('creates and reuses an unfilled report without compiling placeholder text', async () => {
    const f = fixture();
    const ready = await prepared(f);
    const draft = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: WEEKLY_REPORT_DRAFT_TEXT }],
        },
      ],
    };
    const result = await f.service.save(f.ctx, {
      saveToken: ready.saveToken,
      content: draft,
    });
    expect(result).toMatchObject({ contentPending: true, status: 'created' });
    expect(
      f.db.rows.weeklyReportOutbox.filter((row) => row.effect === 'compile'),
    ).toEqual([]);
    await expect(
      f.service.save(f.ctx, { saveToken: ready.saveToken, content: draft }),
    ).resolves.toMatchObject({
      contentPending: true,
      pageId: result.pageId,
      status: 'replayed',
    });
    await expect(f.service.prepare(f.ctx, PERIOD)).resolves.toMatchObject({
      contentPending: true,
      pageId: result.pageId,
      status: 'existing',
    });
    // Simulate the separate collaboration content write; a completed report no longer resumes.
    f.db.rows.pages.find((row) => row.id === result.pageId)!.content = BODY;
    await expect(f.service.prepare(f.ctx, PERIOD)).resolves.toMatchObject({
      contentPending: false,
      pageId: result.pageId,
    });
    expect(f.db.rows.weeklyReportRecords).toHaveLength(1);
    expect(f.pageService.create).toHaveBeenCalledTimes(2);
  });
  it.each(['weekly_report_business_key', 'weekly_report_save_receipts_pkey'])(
    'recovers %s uniqueness races outside the failed transaction',
    async (constraint) => {
      const f = fixture();
      const a = await prepared(f);
      const b = await prepared(f);
      const first = await f.service.save(f.ctx, {
        saveToken: a.saveToken,
        content: BODY,
      });
      f.db.transaction.mockClear();
      f.db.transaction.mockImplementationOnce(
        () =>
          ({
            execute: async () => {
              throw { code: '23505', constraint_name: constraint };
            },
          }) as any,
      );
      await expect(
        f.service.save(f.ctx, { saveToken: b.saveToken, content: BODY }),
      ).resolves.toMatchObject({ status: 'existing', pageId: first.pageId });
      expect(f.db.transaction).toHaveBeenCalledTimes(2);
      expect(f.db.rows.weeklyReportRecords).toHaveLength(1);
      expect(f.db.rows.weeklyReportSaveReceipts).toHaveLength(2);
      expect(f.pageService.create).toHaveBeenCalledTimes(2);
    },
  );
  it('does not retry an unrelated PostgreSQL uniqueness violation', async () => {
    const f = fixture();
    const a = await prepared(f);
    const error = { code: '23505', constraint_name: 'unrelated_constraint' };
    f.db.transaction.mockImplementationOnce(
      () =>
        ({
          execute: async () => {
            throw error;
          },
        }) as any,
    );
    await expect(
      f.service.save(f.ctx, { saveToken: a.saveToken, content: BODY }),
    ).rejects.toBe(error);
    expect(f.db.transaction).toHaveBeenCalledTimes(1);
    expect(f.pageService.create).not.toHaveBeenCalled();
  });

  it.each([
    'signature',
    'expired',
    'cross-user',
    'cross-workspace',
    'purpose',
    'algorithm',
    'audience',
  ] as const)(
    'rejects %s token problems before opening a transaction',
    async (problem) => {
      const f = fixture();
      const preparation = await prepared(f);
      const claims = jwt.verify(
        preparation.saveToken,
        SECRET,
      ) as WeeklyReportClaims & jwt.JwtPayload;
      delete claims.iat;
      delete claims.exp;
      delete claims.iss;
      delete claims.aud;
      let token: string;
      switch (problem) {
        case 'signature':
          token = jwt.sign(claims, 'wrong-secret');
          break;
        case 'expired':
          token = sign(claims, { expiresIn: -1 });
          break;
        case 'cross-user':
          token = sign({ ...claims, userId: IDS.another });
          break;
        case 'cross-workspace':
          token = sign({ ...claims, workspaceId: IDS.another });
          break;
        case 'purpose':
          token = sign({
            ...claims,
            type: 'another-purpose',
          } as unknown as WeeklyReportClaims);
          break;
        case 'algorithm':
          token = sign(claims, { algorithm: 'HS384' });
          break;
        case 'audience':
          token = sign(claims, { audience: 'another-consumer' });
          break;
      }
      await expect(
        f.service.save(f.ctx, { saveToken: token, content: BODY }),
      ).rejects.toEqual(
        errorCode(
          problem === 'expired' ? 'SAVE_TOKEN_EXPIRED' : 'INVALID_SAVE_TOKEN',
        ),
      );
      expect(f.db.transaction).not.toHaveBeenCalled();
      expect(f.pageService.create).not.toHaveBeenCalled();
    },
  );
  it('creates the empty parent and normalized report atomically, staging distinct outbox effects without dispatching', async () => {
    const f = fixture();
    const preparation = await prepared(f);
    const result = await f.service.save(f.ctx, {
      saveToken: preparation.saveToken,
      content: BODY,
    });
    expect(result).toMatchObject({
      status: 'created',
      parentCreated: true,
      replayed: false,
      locationChanged: false,
    });
    expect(f.pageService.create).toHaveBeenCalledTimes(2);
    const [parentCall, reportCall] = f.pageService.create.mock.calls;
    expect(parentCall[2]).toMatchObject({ title: '周报', icon: '📅' });
    expect(reportCall[2]).toMatchObject({
      parentPageId: result.parentPageId,
      title: preparation.title,
      content: normalizeWeeklyReportContent(BODY),
    });
    expect(parentCall[3]).toEqual({
      trx: f.db.transactions[0],
      deferCreatedEffects: true,
    });
    expect(reportCall[3]).toEqual(parentCall[3]);
    expect(
      f.db.rows.weeklyReportOutbox
        .filter((row) => row.pageId === result.parentPageId)
        .map((row) => row.effect),
    ).toEqual(['search', 'access', 'watchers', 'audit']);
    expect(
      f.db.rows.weeklyReportOutbox
        .filter((row) => row.pageId === result.pageId)
        .map((row) => row.effect),
    ).toEqual(['search', 'access', 'watchers', 'audit', 'compile']);
    expect(f.db.writes.every((write) => write.inTransaction)).toBe(true);
    expect(f.db.rows.weeklyReportSaveReceipts).toHaveLength(1);
  });
  it('creates only a report under an explicit parent', async () => {
    const f = fixture();
    f.db.rows.pages.push(page(IDS.chosen, { spaceId: IDS.shared }));
    const preparation = await prepared(f, { parentPageId: IDS.chosen });
    const result = await f.service.save(f.ctx, {
      saveToken: preparation.saveToken,
      content: BODY,
    });
    expect(result).toMatchObject({
      parentCreated: false,
      parentPageId: IDS.chosen,
      spaceId: IDS.shared,
    });
    expect(f.pageService.create).toHaveBeenCalledTimes(1);
    expect(f.db.rows.weeklyReportOutbox).toHaveLength(5);
    expect(f.pageRepo.findById).toHaveBeenCalledWith(IDS.chosen, {
      trx: f.db.transactions[0],
      withLock: true,
    });
  });
  it('replays the same token with changed invalid body and title without rechecking current template or writing', async () => {
    const f = fixture();
    const preparation = await prepared(f);
    const first = await f.service.save(f.ctx, {
      saveToken: preparation.saveToken,
      content: BODY,
    });
    const effects = structuredClone(f.db.rows.weeklyReportOutbox);
    f.templates.getForSpace
      .mockClear()
      .mockRejectedValue(new ForbiddenException());
    f.pageAccess.validateCanEdit
      .mockClear()
      .mockRejectedValue(new ForbiddenException());
    const replay = await f.service.save(f.ctx, {
      saveToken: preparation.saveToken,
      content: { type: 'unknown' },
      title: 'x'.repeat(201),
    });
    expect(replay).toEqual({ ...first, status: 'replayed', replayed: true });
    expect(f.templates.getForSpace).not.toHaveBeenCalled();
    expect(f.pageAccess.validateCanEdit).not.toHaveBeenCalled();
    expect(f.pageService.create).toHaveBeenCalledTimes(2);
    expect(f.db.rows.weeklyReportOutbox).toEqual(effects);
  });
  it('rejects schema loss before creating even the directory, then permits correcting the same token', async () => {
    const f = fixture();
    const preparation = await prepared(f);
    await expect(
      f.service.save(f.ctx, {
        saveToken: preparation.saveToken,
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', attrs: { unknown: 'lost' } }],
        },
      }),
    ).rejects.toEqual(errorCode('INVALID_CONTENT'));
    expect(f.pageService.create).not.toHaveBeenCalled();
    expect(f.db.rows.pages).toEqual([]);
    expect(f.db.rows.weeklyReportSaveReceipts).toEqual([]);
    expect(f.db.rows.weeklyReportOutbox).toEqual([]);
    await expect(
      f.service.save(f.ctx, {
        saveToken: preparation.saveToken,
        content: BODY,
      }),
    ).resolves.toMatchObject({ status: 'created' });
  });
  it('allows ordinary template edits after preparation while retaining the original fingerprint and generated body', async () => {
    const f = fixture();
    const preparation = await prepared(f, { templateId: IDS.custom });
    f.templates.getForSpace.mockResolvedValue({
      id: IDS.custom,
      templateFingerprint: 'edited-fingerprint',
      content: { type: 'doc', content: [] },
      icon: '📝',
    });
    await expect(
      f.service.save(f.ctx, {
        saveToken: preparation.saveToken,
        content: BODY,
      }),
    ).resolves.toMatchObject({ status: 'created' });
    expect(f.db.rows.weeklyReportRecords[0]).toMatchObject({
      templateId: IDS.custom,
      templateFingerprint: 'fingerprint-at-prepare',
    });
    expect(f.pageService.create.mock.calls[1][2].content).toEqual(
      normalizeWeeklyReportContent(BODY),
    );
  });
  it('rolls back a staged parent and outbox rows if report creation fails, allowing retry with the same token', async () => {
    const f = fixture();
    const preparation = await prepared(f);
    const originalCreate = f.pageService.create.getMockImplementation()!;
    f.pageService.create
      .mockImplementationOnce(originalCreate)
      .mockRejectedValueOnce(new Error('Report insert failed'));
    await expect(
      f.service.save(f.ctx, {
        saveToken: preparation.saveToken,
        content: BODY,
      }),
    ).rejects.toThrow('Report insert failed');
    expect(f.db.rows.pages).toEqual([]);
    expect(f.db.rows.weeklyReportRecords).toEqual([]);
    expect(f.db.rows.weeklyReportSaveReceipts).toEqual([]);
    expect(f.db.rows.weeklyReportOutbox).toEqual([]);
    expect(f.db.transactions[0].rows.pages).toHaveLength(1);
    expect(f.db.transactions[0].rows.weeklyReportOutbox).toHaveLength(4);
    await expect(
      f.service.save(f.ctx, {
        saveToken: preparation.saveToken,
        content: BODY,
      }),
    ).resolves.toMatchObject({ status: 'created', parentCreated: true });
    expect(f.db.rows.pages).toHaveLength(2);
  });
  it('rejects a parent moved to another space after preparation without redirecting the save', async () => {
    const f = fixture();
    const parentId = randomUUID();
    f.db.rows.pages.push(page(parentId));
    const preparation = await prepared(f, { parentPageId: parentId });
    f.db.rows.pages[0].spaceId = randomUUID();
    await expect(
      f.service.save(f.ctx, {
        saveToken: preparation.saveToken,
        content: BODY,
      }),
    ).rejects.toEqual(errorCode('INVALID_SAVE_TOKEN'));
    expect(f.pageService.create).not.toHaveBeenCalled();
  });
  it('rejects an oversized title before any page creation', async () => {
    const f = fixture();
    const preparation = await prepared(f);
    await expect(
      f.service.save(f.ctx, {
        saveToken: preparation.saveToken,
        content: BODY,
        title: 'x'.repeat(201),
      }),
    ).rejects.toEqual(errorCode('INVALID_ARGUMENT'));
    expect(f.pageService.create).not.toHaveBeenCalled();
    expect(f.db.rows.weeklyReportSaveReceipts).toEqual([]);
  });
  it('rechecks template access and parent locking on first save', async () => {
    const f = fixture();
    f.db.rows.pages.push(page(IDS.chosen));
    const preparation = await prepared(f, { parentPageId: IDS.chosen });
    f.db.rows.pages[0].isLocked = true;
    await expect(
      f.service.save(f.ctx, {
        saveToken: preparation.saveToken,
        content: BODY,
      }),
    ).rejects.toEqual(errorCode('PARENT_LOCKED'));
    f.db.rows.pages[0].isLocked = false;
    f.templates.getForSpace.mockRejectedValue(new ForbiddenException());
    await expect(
      f.service.save(f.ctx, {
        saveToken: preparation.saveToken,
        content: BODY,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.pageService.create).not.toHaveBeenCalled();
  });
  it('returns an existing business result read-only for a fresh token despite locked parent or changed template', async () => {
    const f = fixture();
    f.db.rows.pages.push(page(IDS.directory, { title: '周报' }));
    const tokenA = await prepared(f);
    const tokenB = await prepared(f);
    const first = await f.service.save(f.ctx, {
      saveToken: tokenA.saveToken,
      content: BODY,
    });
    f.db.rows.pages.find((row) => row.id === IDS.directory)!.isLocked = true;
    f.pageAccess.validateCanEdit
      .mockClear()
      .mockRejectedValue(new ForbiddenException());
    f.templates.getForSpace
      .mockClear()
      .mockRejectedValue(new NotFoundException());
    const result = await f.service.save(f.ctx, {
      saveToken: tokenB.saveToken,
      content: { type: 'invalid' },
    });
    expect(result).toMatchObject({ pageId: first.pageId, status: 'existing' });
    await expect(
      f.service.prepare(f.ctx, { ...PERIOD, templateId: IDS.deleted_template }),
    ).resolves.toMatchObject({ pageId: first.pageId, status: 'existing' });
    expect(f.pageAccess.validateCanEdit).not.toHaveBeenCalled();
    expect(f.templates.getForSpace).not.toHaveBeenCalled();
    expect(f.db.rows.weeklyReportSaveReceipts).toHaveLength(2);
    expect(f.db.rows.weeklyReportOutbox).toHaveLength(5);
    expect(f.pageService.create).toHaveBeenCalledTimes(1);
  });
  it('returns the actual location when a saved page has moved, without replacing it', async () => {
    const f = fixture();
    const preparation = await prepared(f);
    const first = await f.service.save(f.ctx, {
      saveToken: preparation.saveToken,
      content: BODY,
    });
    Object.assign(f.db.rows.pages.find((row) => row.id === first.pageId)!, {
      spaceId: IDS.moved_space,
      parentPageId: IDS.moved_parent,
      slugId: 'current-slug',
    });
    await expect(
      f.service.save(f.ctx, {
        saveToken: preparation.saveToken,
        content: BODY,
      }),
    ).resolves.toMatchObject({
      pageId: first.pageId,
      spaceId: IDS.moved_space,
      parentPageId: IDS.moved_parent,
      url: '/p/current-slug',
      locationChanged: true,
      status: 'replayed',
    });
    expect(f.pageService.create).toHaveBeenCalledTimes(2);
  });
  it.each(['deleted', 'missing', 'invisible'] as const)(
    'does not recreate an unavailable %s saved page',
    async (condition) => {
      const f = fixture();
      const preparation = await prepared(f);
      const first = await f.service.save(f.ctx, {
        saveToken: preparation.saveToken,
        content: BODY,
      });
      if (condition === 'deleted')
        f.db.rows.pages.find((row) => row.id === first.pageId)!.deletedAt =
          new Date();
      if (condition === 'missing')
        f.db.rows.pages = f.db.rows.pages.filter(
          (row) => row.id !== first.pageId,
        );
      if (condition === 'invisible')
        f.pageAccess.validateCanView.mockRejectedValue(
          new ForbiddenException(),
        );
      await expect(
        f.service.save(f.ctx, {
          saveToken: preparation.saveToken,
          content: BODY,
        }),
      ).rejects.toEqual(errorCode('RESULT_UNAVAILABLE'));
      expect(f.pageService.create).toHaveBeenCalledTimes(2);
      expect(f.db.rows.weeklyReportRecords).toHaveLength(1);
    },
  );
});
