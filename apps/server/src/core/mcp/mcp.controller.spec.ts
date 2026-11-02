jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class {},
}));

import { McpController } from './mcp.controller';

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
      {} as any,
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
      {} as any,
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
