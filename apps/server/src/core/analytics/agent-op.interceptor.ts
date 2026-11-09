import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { AnalyticsEventRepo } from '@akasha/db/repos/analytics/analytics-event.repo';
import { getAgentAccessContext } from '../../common/auth/agent-access-context';
import { AGENT_CAPABILITY } from '../../common/decorators/agent-callable.decorator';
import { getApiKeyAccess } from '../../common/auth/api-key-access';

/**
 * Records one operation per REST call authenticated with an API key.
 * MCP tool calls are recorded separately by McpController. Recording never affects the
 * response.
 */
@Injectable()
export class AgentOpInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AgentOpInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly analyticsEventRepo: AnalyticsEventRepo,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest();
    const agentAccess = getAgentAccessContext(request);
    const principal = request.user;
    const access = principal?.user
      ? getApiKeyAccess(principal.user)
      : undefined;
    const personal = !agentAccess && access?.apiKeyId && principal?.workspace;
    if (!agentAccess && !personal) return next.handle();

    const capability = this.reflector.getAllAndOverride<string>(
      AGENT_CAPABILITY,
      [context.getHandler(), context.getClass()],
    );
    const op =
      capability ??
      `${request.method ?? 'HTTP'} ${request.routeOptions?.url ?? 'other'}`;

    const record = (outcome: 'ok' | 'error') => {
      this.analyticsEventRepo
        .insertAgentOp({
          workspaceId: agentAccess?.workspace.id ?? principal.workspace.id,
          agentUserId: agentAccess?.agentUser.id ?? principal.user.id,
          op,
          channel: 'api',
          apiKeyId: agentAccess?.apiKeyId ?? access.apiKeyId,
          ...(personal ? { keyType: 'personal' as const } : {}),
          delegatedUserId: agentAccess?.delegatedUser?.id,
          outcome,
        })
        .catch((error) =>
          this.logger.warn(`Failed to record agent_op event: ${error}`),
        );
    };

    return next.handle().pipe(
      tap({
        next: () => record('ok'),
        error: () => record('error'),
      }),
    );
  }
}
