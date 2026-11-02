jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class CollaborationGateway {},
}));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpService } from './mcp.service';
import { withApiKeyAccess } from '../../common/auth/api-key-access';
import { ApiKeyType } from '../../common/auth/api-key-type';
import { z } from 'zod/v4';
import { WEEKLY_REPORT_DRAFT_TEXT } from '../weekly-report/weekly-report-draft';
import {
  prepareWeeklyReportSchema,
  saveWeeklyReportSchema,
} from './weekly-report.schemas';

const uuid = '0b6f8a3e-5c1d-4e2a-9f47-1a2b3c4d5e01';
const user = {
  id: 'user-1',
  workspaceId: 'ws-1',
  name: 'Writer',
  timezone: 'Asia/Shanghai',
} as any;
const workspace = { id: 'ws-1' } as any;
const personalUser = () =>
  withApiKeyAccess(user, {
    apiKeyId: 'never-output-key',
    keyType: ApiKeyType.PERSONAL,
    personalSpaceId: null,
  });
const decode = (result: any) => JSON.parse(result.content[0].text);

function subject() {
  const service = Object.create(McpService.prototype) as any;
  const templateService = {
    listForMcp: jest.fn().mockResolvedValue({ items: [] }),
    getForSpace: jest.fn().mockResolvedValue({ id: uuid }),
  };
  const weeklyReportService = {
    prepare: jest.fn().mockResolvedValue({ saveToken: 'signed' }),
    save: jest.fn().mockResolvedValue({ status: 'created' }),
  };
  const spaceRepo = {
    findPersonalSpaceForUser: jest
      .fn()
      .mockResolvedValue({ id: 'actual-space' }),
  };
  Object.assign(service, {
    templateService,
    weeklyReportService,
    spaceRepo,
    toolRegistry: { registerAll: jest.fn() },
  });
  return { service, templateService, weeklyReportService, spaceRepo };
}

function registered(service: any, ctx: any) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const spy = jest
    .spyOn(McpServer.prototype, 'registerTool')
    .mockImplementation(((name, _config, callback) => {
      handlers.set(name, callback);
      return {};
    }) as any);
  const server = service.createServer(ctx);
  spy.mockRestore();
  return { handlers, server };
}

describe('Weekly report MCP integration', () => {
  it('keeps the token in a short create call and sends the long body using only its returned page ID', async () => {
    const { service, weeklyReportService } = subject();
    const ctx = { user: personalUser(), workspace };
    const draft = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: WEEKLY_REPORT_DRAFT_TEXT }],
        },
      ],
    };
    const page = {
      id: uuid,
      workspaceId: workspace.id,
      deletedAt: null,
      content: draft,
    };
    const update = jest.fn().mockResolvedValue(page);
    Object.assign(service, {
      pageRepo: { findById: jest.fn().mockResolvedValue(page) },
      pageAccessService: {
        validateCanEdit: jest.fn().mockResolvedValue({ hasRestriction: false }),
      },
      pageService: { update },
    });
    weeklyReportService.save.mockResolvedValue({
      status: 'created',
      pageId: uuid,
      contentPending: true,
    } as any);
    const { handlers, server } = registered(service, ctx);
    try {
      const initial = {
        saveToken: 'test-token-'.repeat(80),
        title: 'Weekly report',
        content: draft,
      };
      expect(Buffer.byteLength(JSON.stringify(initial))).toBeLessThan(2048);
      const created = decode(
        await handlers.get('save_weekly_report')!(initial),
      );
      const body = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'x'.repeat(8192) }],
          },
        ],
      };
      const write = {
        pageId: created.pageId,
        operation: 'replace',
        format: 'json',
        content: body,
      };
      await handlers.get('update_page')!(write);
      expect(write).not.toHaveProperty('saveToken');
      expect(update).toHaveBeenCalledWith(
        page,
        { ...write, title: undefined, icon: undefined },
        ctx.user,
      );
      expect(weeklyReportService.save).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
  it.each([
    ['SSO', user, undefined],
    [
      'Agent',
      withApiKeyAccess(user, {
        apiKeyId: 'agent',
        keyType: ApiKeyType.AGENT,
        personalSpaceId: null,
      }),
      { delegatedUserId: 'user-1' },
    ],
    [
      'legacy untyped key',
      withApiKeyAccess(user, { apiKeyId: 'old', personalSpaceId: 'cached' }),
      undefined,
    ],
  ])(
    'registers all four tools but rejects %s before domain access',
    async (_name, currentUser, agentAccess) => {
      const { service, templateService, weeklyReportService, spaceRepo } =
        subject();
      const { handlers, server } = registered(service, {
        user: currentUser,
        workspace,
        agentAccess,
      });
      for (const name of [
        'list_templates',
        'get_template',
        'prepare_weekly_report',
        'save_weekly_report',
      ]) {
        expect(handlers.has(name)).toBe(true);
        const result = await handlers.get(name)!({});
        expect(result.isError).toBe(true);
        expect(decode(result).code).toBe('IDENTITY_UNSUPPORTED');
      }
      for (const dependency of [
        templateService,
        weeklyReportService,
        spaceRepo,
      ]) {
        for (const fn of Object.values(dependency))
          expect(fn).not.toHaveBeenCalled();
      }
      await server.close();
    },
  );

  it('passes authenticated context and arguments through registered tools', async () => {
    const { service, templateService, weeklyReportService } = subject();
    const ctx = { user: personalUser(), workspace };
    const { handlers, server } = registered(service, ctx);
    await handlers.get('list_templates')!({ query: 'weekly', spaceId: uuid });
    expect(templateService.listForMcp).toHaveBeenCalledWith(
      ctx.user,
      workspace,
      expect.objectContaining({
        scope: 'available',
        spaceId: uuid,
        limit: 20,
        query: 'weekly',
      }),
    );
    await handlers.get('get_template')!({ templateId: uuid, spaceId: uuid });
    expect(templateService.getForSpace).toHaveBeenCalledWith(
      uuid,
      uuid,
      ctx.user,
      workspace,
    );
    const prepare = {
      period: 'custom',
      periodStart: '2026-10-26',
      periodEnd: '2026-11-01',
    };
    await handlers.get('prepare_weekly_report')!(prepare);
    expect(weeklyReportService.prepare).toHaveBeenCalledWith(ctx, prepare);
    const save = { saveToken: 'signed', content: { type: 'doc' } };
    await handlers.get('save_weekly_report')!(save);
    expect(weeklyReportService.save).toHaveBeenCalledWith(ctx, save);
    await server.close();
  });

  it('rejects malformed cursors before repository listing and accepts real cursor shape', async () => {
    const { service, templateService } = subject();
    const ctx = { user: personalUser(), workspace };
    await expect(
      service.listTemplates(ctx, { cursor: 'invalid' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(templateService.listForMcp).not.toHaveBeenCalled();
    const cursor = Buffer.from(
      new URLSearchParams({ title: 'Weekly', id: uuid }).toString(),
    ).toString('base64url');
    await service.listTemplates(ctx, { cursor });
    expect(templateService.listForMcp).toHaveBeenCalled();
  });

  it('queries personal space directly despite empty cached personalSpaceId and never exposes key context', async () => {
    const { service, spaceRepo } = subject();
    const result = await service.getCurrentUser({
      user: personalUser(),
      workspace,
    });
    expect(spaceRepo.findPersonalSpaceForUser).toHaveBeenCalledWith({
      userId: user.id,
      workspaceId: workspace.id,
    });
    expect(result).toMatchObject({
      credentialType: 'personal_key',
      timezone: 'Asia/Shanghai',
      personalSpaceId: 'actual-space',
    });
    expect(JSON.stringify(result)).not.toContain('never-output-key');
    spaceRepo.findPersonalSpaceForUser.mockResolvedValue(undefined);
    expect(
      (await service.getCurrentUser({ user: personalUser(), workspace }))
        .personalSpaceId,
    ).toBeNull();
  });

  it.each([
    [user, 'other'],
    [
      withApiKeyAccess(user, {
        apiKeyId: 'agent',
        keyType: ApiKeyType.AGENT,
        personalSpaceId: null,
      }),
      'agent_key',
    ],
  ])(
    'retains generic identity lookup for unsupported weekly-report credentials',
    async (currentUser, credentialType) => {
      const { service, spaceRepo } = subject();
      const { handlers, server } = registered(service, {
        user: currentUser,
        workspace,
      });
      const result = await handlers.get('get_current_user')!();
      expect(decode(result)).toMatchObject({
        credentialType,
        personalSpaceId: null,
      });
      expect(result.isError).toBeUndefined();
      expect(spaceRepo.findPersonalSpaceForUser).not.toHaveBeenCalled();
      await server.close();
    },
  );

  it.each([
    new ForbiddenException({
      code: 'PARENT_LOCKED',
      message: 'Parent locked',
      details: { parentPageId: uuid },
    }),
    Object.assign(new Error('Parent locked'), {
      code: 'FUTURE_DOMAIN_CODE',
      details: { parentPageId: uuid },
    }),
  ])('preserves structured business codes and details', async (error) => {
    const { service } = subject();
    const result = await service.runTool(async () => {
      throw error;
    });
    expect(result.isError).toBe(true);
    expect(decode(result)).toMatchObject({
      code: (error as any).code ?? (error as any).response.code,
      error: 'Parent locked',
      details: { parentPageId: uuid },
    });
  });

  it('uses the default period and requires a JSON object document at the MCP boundary', () => {
    expect(
      z
        .object(prepareWeeklyReportSchema)
        .parse({ templateId: null, parentPageId: null }),
    ).toMatchObject({ templateId: null, parentPageId: null });
    expect(z.object(prepareWeeklyReportSchema).parse({}).period).toBe(
      'this_week',
    );
    expect(z.object(prepareWeeklyReportSchema).parse({}).timezone).toBe(
      'Asia/Shanghai',
    );
    expect(
      z.object(prepareWeeklyReportSchema).safeParse({ period: 'other' })
        .success,
    ).toBe(false);
    for (const content of ['markdown', null, []]) {
      expect(
        z
          .object(saveWeeklyReportSchema)
          .safeParse({ saveToken: 'signed', content }).success,
      ).toBe(false);
    }
    expect(
      z.object(saveWeeklyReportSchema).safeParse({
        saveToken: 'signed',
        content: { type: 'doc', content: [] },
      }).success,
    ).toBe(true);
  });
});
