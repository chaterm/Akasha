import { ForbiddenException } from '@nestjs/common';

export type McpErrorCode =
  | 'MCP_DISABLED'
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'TOOL_FAILED'
  | 'IDENTITY_UNSUPPORTED'
  | 'PERSONAL_SPACE_UNAVAILABLE'
  | 'TARGET_AMBIGUOUS'
  | 'TEMPLATE_NOT_APPLICABLE'
  | 'PARENT_LOCKED'
  | 'INVALID_SAVE_TOKEN'
  | 'SAVE_TOKEN_EXPIRED'
  | 'RESULT_UNAVAILABLE'
  | 'INVALID_CONTENT';

export class McpDisabledException extends ForbiddenException {
  readonly code = 'MCP_DISABLED' as const;

  constructor() {
    super('MCP is disabled for this workspace');
  }
}
