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

function readSkillVersion(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const value = headers['x-akasha-skill-version'];
  if (value === undefined) return undefined;
  const raw = (Array.isArray(value) ? value[0] : value).trim();
  return raw || undefined;
}

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
      skillVersion: readSkillVersion(req.headers),
    };
    this.recordAgentToolCalls(ctx, body);

    reply.hijack();
    await this.mcpService.handleRequest(ctx, req.raw, reply.raw, body);
  }

  private recordAgentToolCalls(
    ctx: Awaited<ReturnType<McpAuthService['authenticate']>>,
    body: unknown,
  ): void {
    const apiKeyId = getApiKeyAccess(ctx.user)?.apiKeyId ?? null;
    for (const op of buildMcpAgentOps(ctx, body, apiKeyId)) {
      this.analyticsEventRepo
        .insertAgentOp(op)
        .catch((error) =>
          this.logger.warn({ err: error }, 'Failed to record agent_op event'),
        );
    }
  }
}
