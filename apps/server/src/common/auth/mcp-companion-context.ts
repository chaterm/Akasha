import { JwtType } from '../../core/auth/dto/jwt-payload';

export type McpCompanionContext = {
  type: JwtType.MCP_UPLOAD | JwtType.MCP_DOWNLOAD;
  userId: string;
  workspaceId: string;
  pageId?: string;
  attachmentId?: string;
};

type RequestWithMcpCompanion = {
  mcpCompanion?: McpCompanionContext;
};

export function getMcpCompanionContext(
  request: RequestWithMcpCompanion,
): McpCompanionContext | undefined {
  return request.mcpCompanion;
}

export function setMcpCompanionContext(
  request: RequestWithMcpCompanion,
  context: McpCompanionContext,
): void {
  request.mcpCompanion = context;
}
