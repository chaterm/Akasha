import { ForbiddenException } from '@nestjs/common';

export type McpErrorCode =
  | 'MCP_DISABLED'
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'TOOL_FAILED';

export class McpDisabledException extends ForbiddenException {
  readonly code = 'MCP_DISABLED' as const;

  constructor() {
    super('MCP is disabled for this workspace');
  }
}
