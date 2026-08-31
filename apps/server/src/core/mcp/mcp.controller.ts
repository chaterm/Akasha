import {
  All,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Req,
  Res,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { McpAuthService } from './mcp-auth.service';
import { McpService } from './mcp.service';
import { McpDisabledException } from './mcp.errors';

@Controller('mcp')
export class McpController {
  constructor(
    private readonly mcpAuthService: McpAuthService,
    private readonly mcpService: McpService,
  ) {}

  @All()
  @SkipTransform()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Body() body: unknown,
  ) {
    if (req.method !== 'POST') {
      return reply.status(405).send({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed.',
        },
        id: null,
      });
    }

    let ctx;
    try {
      ctx = await this.mcpAuthService.authenticate(req);
      this.mcpService.assertEnabled(ctx.workspace);
    } catch (error: any) {
      const status = error?.getStatus?.() ?? HttpStatus.UNAUTHORIZED;
      const code =
        error instanceof McpDisabledException
          ? 'MCP_DISABLED'
          : status === HttpStatus.UNAUTHORIZED
            ? 'AUTH_REQUIRED'
            : 'FORBIDDEN';
      return reply.status(status).send({
        error: { code, message: error?.message ?? 'MCP request rejected' },
      });
    }

    reply.hijack();
    await this.mcpService.handleRequest(ctx, req.raw, reply.raw, body);
  }
}
