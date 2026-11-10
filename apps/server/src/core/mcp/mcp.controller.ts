import {
  All,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Req,
  Res,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { McpAuthService } from './mcp-auth.service';
import { McpService } from './mcp.service';
import { McpDisabledException } from './mcp.errors';
import { AnalyticsEventRepo } from '@akasha/db/repos/analytics/analytics-event.repo';
import { buildMcpAgentOps } from '../analytics/agent-op-category';
import { getApiKeyAccess } from '../../common/auth/api-key-access';
import { readWeeklyReportDefaults } from '../weekly-report/weekly-report-defaults';

@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(
    private readonly mcpAuthService: McpAuthService,
    private readonly mcpService: McpService,
    private readonly analyticsEventRepo: AnalyticsEventRepo,
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

    ctx = {
      ...ctx,
      weeklyReportDefaults: readWeeklyReportDefaults(req.headers),
    };
    this.recordAgentToolCalls(ctx, body);

    reply.hijack();
    await this.mcpService.handleRequest(ctx, req.raw, reply.raw, body);
  }

  // Every MCP tool call is recorded, whether it came from an agent key, a
  // personal key or an SSO token. Outcome is 'called': the response is
  // streamed by the MCP transport and tool errors live inside the JSON-RPC
  // result.
  private recordAgentToolCalls(
    ctx: Awaited<ReturnType<McpAuthService['authenticate']>>,
    body: unknown,
  ): void {
    const apiKeyId = getApiKeyAccess(ctx.user)?.apiKeyId ?? null;
    for (const op of buildMcpAgentOps(ctx, body, apiKeyId)) {
      this.analyticsEventRepo
        .insertAgentOp(op)
        .catch((error) =>
          this.logger.warn(`Failed to record agent_op event: ${error}`),
        );
    }
  }
}
