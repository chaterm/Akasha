jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class {},
}));

import { McpController } from './mcp.controller';
import { withApiKeyAccess } from '../../common/auth/api-key-access';
import { ApiKeyType } from '../../common/auth/api-key-type';

function analyticsRepo() {
  return { insertAgentOp: jest.fn().mockResolvedValue(undefined) };
}

describe('MCP connection preference forwarding', () => {
  it('attaches preference headers after authentication without treating them as identity', async () => {
    const authenticated = {
      user: { id: 'authenticated-user' },
      workspace: { id: 'workspace' },
    };
    const auth = { authenticate: jest.fn().mockResolvedValue(authenticated) };
    const service = {
      assertEnabled: jest.fn(),
      handleRequest: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new McpController(
      auth as any,
      service as any,
      analyticsRepo() as any,
    );
    const request = {
      method: 'POST',
      raw: {},
      headers: {
        authorization: 'Bearer synthetic-key',
        'x-akasha-weekly-template-id': '9694050d-4ebc-59d6-8560-d88d7d0ecf45',
        'x-akasha-weekly-parent-page-id':
          'dcaec16f-7579-5ebb-b38d-21f8f3b7c1ce',
      },
    };
    const reply = { hijack: jest.fn(), raw: {} };
    const body = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'prepare_weekly_report', arguments: {} },
      id: 1,
    };
    await controller.handle(request as any, reply as any, body);
    expect(auth.authenticate).toHaveBeenCalledWith(request);
    expect(service.handleRequest).toHaveBeenCalledWith(
      {
        ...authenticated,
        weeklyReportDefaults: {
          templateId: request.headers['x-akasha-weekly-template-id'],
          parentPageId: request.headers['x-akasha-weekly-parent-page-id'],
        },
      },
      request.raw,
      reply.raw,
      body,
    );
    expect(authenticated).not.toHaveProperty('weeklyReportDefaults');
  });

  it('leaves malformed preference validation to prepare, so ordinary tool calls stay available', async () => {
    const auth = {
      authenticate: jest.fn().mockResolvedValue({ user: {}, workspace: {} }),
    };
    const service = {
      assertEnabled: jest.fn(),
      handleRequest: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new McpController(
      auth as any,
      service as any,
      analyticsRepo() as any,
    );
    await controller.handle(
      {
        method: 'POST',
        raw: {},
        headers: { 'x-akasha-weekly-template-id': 'bad' },
      } as any,
      { hijack: jest.fn(), raw: {} } as any,
      { method: 'tools/list' },
    );
    expect(service.handleRequest).toHaveBeenCalledTimes(1);
  });
});

describe('MCP agent_op recording', () => {
  const body = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: 'update_page', arguments: {} },
    id: 1,
  };
  const request = { method: 'POST', raw: {}, headers: {} };

  function setup(authenticated: unknown, repo = analyticsRepo()) {
    const auth = { authenticate: jest.fn().mockResolvedValue(authenticated) };
    const service = {
      assertEnabled: jest.fn(),
      handleRequest: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new McpController(
      auth as any,
      service as any,
      repo as any,
    );
    return { controller, service, repo };
  }

  it('records personal-key tool calls under the key owner and still forwards', async () => {
    const user = withApiKeyAccess({ id: 'human-1' } as any, {
      apiKeyId: 'key-p',
      personalSpaceId: null,
      keyType: ApiKeyType.PERSONAL,
    });
    const { controller, service, repo } = setup({
      user,
      workspace: { id: 'ws-1' },
    });

    await controller.handle(
      request as any,
      { hijack: jest.fn(), raw: {} } as any,
      body,
    );

    expect(repo.insertAgentOp).toHaveBeenCalledTimes(1);
    expect(repo.insertAgentOp).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      agentUserId: 'human-1',
      op: 'mcp:update_page',
      channel: 'mcp',
      apiKeyId: 'key-p',
      keyType: 'personal',
      delegatedUserId: null,
      outcome: 'called',
    });
    expect(service.handleRequest).toHaveBeenCalledTimes(1);
  });

  it('records SSO tool calls without a key', async () => {
    const { controller, repo } = setup({
      user: { id: 'human-1' },
      workspace: { id: 'ws-1' },
    });

    await controller.handle(
      request as any,
      { hijack: jest.fn(), raw: {} } as any,
      body,
    );

    expect(repo.insertAgentOp).toHaveBeenCalledWith(
      expect.objectContaining({
        agentUserId: 'human-1',
        apiKeyId: null,
        keyType: 'sso',
      }),
    );
  });

  it('does not block the request when recording fails', async () => {
    const repo = {
      insertAgentOp: jest.fn().mockRejectedValue(new Error('db down')),
    };
    const { controller, service } = setup(
      { user: { id: 'human-1' }, workspace: { id: 'ws-1' } },
      repo,
    );

    await controller.handle(
      request as any,
      { hijack: jest.fn(), raw: {} } as any,
      body,
    );

    expect(repo.insertAgentOp).toHaveBeenCalledTimes(1);
    expect(service.handleRequest).toHaveBeenCalledTimes(1);
  });
});
