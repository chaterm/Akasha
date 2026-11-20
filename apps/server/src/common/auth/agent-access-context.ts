import type { User, Workspace } from '@akasha/db/types/entity.types';

export type AgentAccessContext = {
  apiKeyId: string;
  credentialVersion: number;
  agentUser: User;
  workspace: Workspace;
  spaceIds: string[];
};

type RequestWithAgentAccess = {
  agentAccess?: AgentAccessContext;
};

export function getAgentAccessContext(
  request: RequestWithAgentAccess,
): AgentAccessContext | undefined {
  return request.agentAccess;
}

export function setAgentAccessContext(
  request: RequestWithAgentAccess,
  context: AgentAccessContext,
): void {
  request.agentAccess = context;
}
