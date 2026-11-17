import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { User, Workspace } from '@akasha/db/types/entity.types';
import type { AgentAccessContext } from '../../common/auth/agent-access-context';

export type McpToolContext = {
  user: User;
  workspace: Workspace;
  agentAccess?: AgentAccessContext;
  weeklyReportDefaults?: { templateId?: string; parentPageId?: string };
};

export type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export type McpToolRunner = (
  fn: () => Promise<unknown>,
) => Promise<McpToolResult>;

export type McpToolExtension = {
  register: (
    server: McpServer,
    context: McpToolContext,
    runTool: McpToolRunner,
  ) => void;
};

@Injectable()
export class McpToolRegistry {
  private readonly extensions: McpToolExtension[] = [];

  register(extension: McpToolExtension): void {
    if (!this.extensions.includes(extension)) {
      this.extensions.push(extension);
    }
  }

  registerAll(
    server: McpServer,
    context: McpToolContext,
    runTool: McpToolRunner,
  ): void {
    for (const extension of this.extensions) {
      extension.register(server, context, runTool);
    }
  }
}
