export const AGENT_OP_CATEGORIES = [
  'query',
  'search',
  'read',
  'write',
  'delete',
  'other',
] as const;

export type AgentOpCategory = (typeof AGENT_OP_CATEGORIES)[number];

const API_CATEGORIES: Record<string, AgentOpCategory> = {
  'knowledge.query': 'query',
  'space.read': 'read',
  'page.read': 'read',
  'page.tree.read': 'read',
  'page.create': 'write',
  'page.content.update': 'write',
};

const MCP_EXACT: Record<string, AgentOpCategory> = {
  query_knowledge: 'query',
  get_citation_page: 'query',
};

// MCP tools follow verb_noun naming; the verb decides the category.
const MCP_VERBS: [string, AgentOpCategory][] = [
  ['search_', 'search'],
  ['get_', 'read'],
  ['list_', 'read'],
  ['download_', 'read'],
  ['delete_', 'delete'],
  ['create_', 'write'],
  ['update_', 'write'],
  ['move_', 'write'],
  ['copy_', 'write'],
  ['duplicate_', 'write'],
  ['restore_', 'write'],
  ['upload_', 'write'],
];

/** Classifies an agent_op `route` ('page.read' or 'mcp:<tool>'). */
export function categorizeAgentOp(op: string): AgentOpCategory {
  if (!op.startsWith('mcp:')) return API_CATEGORIES[op] ?? 'other';

  const tool = op.slice(4);
  if (MCP_EXACT[tool]) return MCP_EXACT[tool];
  const match = MCP_VERBS.find(([prefix]) => tool.startsWith(prefix));
  return match ? match[1] : 'other';
}

/** Sums op counts per category, keeping every category (zero-filled). */
export function groupAgentOpsByCategory(
  byOp: { op: string; count: number }[],
): { category: AgentOpCategory; count: number }[] {
  const totals = new Map<AgentOpCategory, number>(
    AGENT_OP_CATEGORIES.map((c) => [c, 0]),
  );
  for (const { op, count } of byOp) {
    const category = categorizeAgentOp(op);
    totals.set(category, totals.get(category)! + count);
  }
  return AGENT_OP_CATEGORIES.map((category) => ({
    category,
    count: totals.get(category)!,
  }));
}

export type AgentOpKeyType = 'agent' | 'personal' | 'sso';

/** Minimal shape of an authenticated MCP request (see McpAuthContext). */
type McpCaller = {
  user: { id: string };
  workspace: { id: string };
  agentAccess?: {
    apiKeyId: string;
    agentUser: { id: string };
    delegatedUser?: { id: string };
  };
};

/**
 * One agent_op row per `tools/call`, whatever the credential: agent keys,
 * personal keys and SSO tokens all count as the MCP channel.
 */
export function buildMcpAgentOps(
  caller: McpCaller,
  body: unknown,
  apiKeyId: string | null,
) {
  const { agentAccess } = caller;
  const keyType: AgentOpKeyType = agentAccess
    ? 'agent'
    : apiKeyId
      ? 'personal'
      : 'sso';
  return extractMcpToolCalls(body).map((tool) => ({
    workspaceId: caller.workspace.id,
    agentUserId: agentAccess?.agentUser.id ?? caller.user.id,
    op: `mcp:${tool}`,
    channel: 'mcp' as const,
    apiKeyId: agentAccess?.apiKeyId ?? apiKeyId,
    keyType,
    delegatedUserId: agentAccess?.delegatedUser?.id ?? null,
    outcome: 'called' as const,
  }));
}

/** Tool names from `tools/call` messages in a single or batched JSON-RPC body. */
export function extractMcpToolCalls(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages
    .filter(
      (m: any) =>
        m?.method === 'tools/call' && typeof m?.params?.name === 'string',
    )
    .map((m: any) => m.params.name as string);
}
