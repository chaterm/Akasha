import { lastValueFrom, of, throwError } from 'rxjs';
import { withApiKeyAccess } from '../../common/auth/api-key-access';
import { ApiKeyType } from '../../common/auth/api-key-type';
import { AgentOpInterceptor } from './agent-op.interceptor';
import {
  buildMcpAgentOps,
  categorizeAgentOp,
  extractMcpToolCalls,
  groupAgentOpsByCategory,
} from './agent-op-category';

describe('AgentOpInterceptor', () => {
  const agentAccess = {
    apiKeyId: 'key-1',
    credentialVersion: 1,
    agentUser: { id: 'agent-1' },
    workspace: { id: 'ws-1' },
    delegatedUser: { id: 'human-1' },
  };

  function setup(request: any, capability?: string) {
    const repo = { insertAgentOp: jest.fn().mockResolvedValue(undefined) };
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(capability),
    };
    const interceptor = new AgentOpInterceptor(reflector as any, repo as any);
    const context = {
      getType: () => 'http',
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => request }),
    } as any;
    return { interceptor, repo, context };
  }

  it('records a successful agent call with its capability', async () => {
    const { interceptor, repo, context } = setup({ agentAccess }, 'page.read');

    await lastValueFrom(
      interceptor.intercept(context, { handle: () => of(1) }),
    );

    expect(repo.insertAgentOp).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      agentUserId: 'agent-1',
      op: 'page.read',
      channel: 'api',
      apiKeyId: 'key-1',
      delegatedUserId: 'human-1',
      outcome: 'ok',
    });
  });

  it('records failures without swallowing the error', async () => {
    const { interceptor, repo, context } = setup(
      { agentAccess },
      'page.create',
    );
    const failing = { handle: () => throwError(() => new Error('boom')) };

    await expect(
      lastValueFrom(interceptor.intercept(context, failing)),
    ).rejects.toThrow('boom');
    expect(repo.insertAgentOp).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'page.create', outcome: 'error' }),
    );
  });

  it('records personal API-key REST calls with their route and user', async () => {
    const user = withApiKeyAccess({ id: 'human-1' } as any, {
      apiKeyId: 'personal-1',
      personalSpaceId: null,
      keyType: ApiKeyType.PERSONAL,
    });
    const { interceptor, repo, context } = setup({
      user: { user, workspace: { id: 'ws-1' } },
      method: 'POST',
      routeOptions: { url: '/api/pages/info' },
    });
    await lastValueFrom(
      interceptor.intercept(context, { handle: () => of(1) }),
    );
    expect(repo.insertAgentOp).toHaveBeenCalledWith(
      expect.objectContaining({
        agentUserId: 'human-1',
        apiKeyId: 'personal-1',
        keyType: 'personal',
        channel: 'api',
        op: 'POST /api/pages/info',
        outcome: 'ok',
      }),
    );
  });

  it('does not record ordinary browser sessions', async () => {
    const { interceptor, repo, context } = setup({
      user: { user: { id: 'human-1' }, workspace: { id: 'ws-1' } },
    });
    await lastValueFrom(
      interceptor.intercept(context, { handle: () => of(1) }),
    );
    expect(repo.insertAgentOp).not.toHaveBeenCalled();
  });

  it('ignores requests without an agent API key', async () => {
    const { interceptor, repo, context } = setup({}, 'page.read');

    await lastValueFrom(
      interceptor.intercept(context, { handle: () => of(1) }),
    );

    expect(repo.insertAgentOp).not.toHaveBeenCalled();
  });
});

describe('extractMcpToolCalls', () => {
  it('returns tool names from single and batched tools/call messages', () => {
    expect(
      extractMcpToolCalls({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'query_knowledge' },
      }),
    ).toEqual(['query_knowledge']);
    expect(
      extractMcpToolCalls([
        { method: 'tools/list' },
        { method: 'tools/call', params: { name: 'search_pages' } },
        { method: 'tools/call', params: {} },
      ]),
    ).toEqual(['search_pages']);
    expect(extractMcpToolCalls(undefined)).toEqual([]);
  });
});

describe('buildMcpAgentOps', () => {
  const call = { method: 'tools/call', params: { name: 'update_page' } };
  const human = { user: { id: 'human-1' }, workspace: { id: 'ws-1' } };

  it('records personal-key calls under the human user', () => {
    expect(buildMcpAgentOps(human, call, 'key-p')).toEqual([
      {
        workspaceId: 'ws-1',
        agentUserId: 'human-1',
        op: 'mcp:update_page',
        channel: 'mcp',
        apiKeyId: 'key-p',
        keyType: 'personal',
        delegatedUserId: null,
        outcome: 'called',
      },
    ]);
  });

  it('records agent-key calls under the agent account', () => {
    const agent = {
      user: { id: 'agent-1' },
      workspace: { id: 'ws-1' },
      agentAccess: {
        apiKeyId: 'key-a',
        agentUser: { id: 'agent-1' },
        delegatedUser: { id: 'human-1' },
      },
    };
    expect(buildMcpAgentOps(agent, [call, call], null)).toEqual([
      expect.objectContaining({
        agentUserId: 'agent-1',
        apiKeyId: 'key-a',
        keyType: 'agent',
        delegatedUserId: 'human-1',
      }),
      expect.objectContaining({ keyType: 'agent' }),
    ]);
  });

  it('records SSO-token calls without a key', () => {
    expect(buildMcpAgentOps(human, call, null)).toEqual([
      expect.objectContaining({ apiKeyId: null, keyType: 'sso' }),
    ]);
  });

  it('records nothing for non tool calls', () => {
    expect(buildMcpAgentOps(human, { method: 'tools/list' }, 'key-p')).toEqual(
      [],
    );
  });
});

describe('categorizeAgentOp', () => {
  it('classifies REST capabilities and MCP tools', () => {
    expect(categorizeAgentOp('knowledge.query')).toBe('query');
    expect(categorizeAgentOp('page.content.update')).toBe('write');
    expect(categorizeAgentOp('mcp:query_knowledge')).toBe('query');
    expect(categorizeAgentOp('mcp:search_attachments')).toBe('search');
    expect(categorizeAgentOp('mcp:list_spaces')).toBe('read');
    expect(categorizeAgentOp('mcp:move_page_to_space')).toBe('write');
    expect(categorizeAgentOp('mcp:delete_page')).toBe('delete');
    expect(categorizeAgentOp('mcp:brand_new_tool')).toBe('other');
    expect(categorizeAgentOp('other')).toBe('other');
  });

  it('sums counts per category with zero-filled categories', () => {
    expect(
      groupAgentOpsByCategory([
        { op: 'page.read', count: 3 },
        { op: 'mcp:get_page', count: 2 },
        { op: 'mcp:delete_page', count: 1 },
      ]),
    ).toEqual([
      { category: 'query', count: 0 },
      { category: 'search', count: 0 },
      { category: 'read', count: 5 },
      { category: 'write', count: 0 },
      { category: 'delete', count: 1 },
      { category: 'other', count: 0 },
    ]);
  });
});
