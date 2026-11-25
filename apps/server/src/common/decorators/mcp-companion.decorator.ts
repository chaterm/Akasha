import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { getMcpCompanionContext } from '../auth/mcp-companion-context';

export const McpCompanion = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    getMcpCompanionContext(context.switchToHttp().getRequest()),
);
