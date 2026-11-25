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
    if (!agentAccess) return next.handle();

    const op = this.reflector.getAllAndOverride<string>(AGENT_CAPABILITY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!op) {
      this.logger.warn(
        { route: request.routeOptions?.url },
        'Agent-scoped request reached an endpoint with no declared capability',
      );
      return next.handle();
    }

    const principal = request.user;
    const record = (outcome: 'ok' | 'error') => {
      this.analyticsEventRepo
        .insertAgentOp({
          workspaceId: agentAccess.workspace.id,
          agentUserId: agentAccess.agentUser.id,
          op,
          channel: 'api',
          apiKeyId: agentAccess.apiKeyId,
          delegatedUserId: principal?.user?.id ?? null,
          outcome,
        })
        .catch((error) =>
          this.logger.warn({ err: error }, 'Failed to record agent_op event'),
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
