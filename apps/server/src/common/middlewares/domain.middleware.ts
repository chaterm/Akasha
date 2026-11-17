import { Injectable, NestMiddleware, NotFoundException } from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import { PinoLogger } from 'nestjs-pino';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { WorkspaceRepo } from '@akasha/db/repos/workspace/workspace.repo';

@Injectable()
export class DomainMiddleware implements NestMiddleware {
  constructor(
    private workspaceRepo: WorkspaceRepo,
    private environmentService: EnvironmentService,
    private pinoLogger: PinoLogger,
  ) {}

  private assignWorkspaceId(workspaceId: string | null) {
    try {
      this.pinoLogger.assign({ workspaceId: workspaceId ?? '' });
    } catch {
      // ignored on purpose
    }
  }
  async use(
    req: FastifyRequest['raw'],
    res: FastifyReply['raw'],
    next: () => void,
  ) {
    if (this.environmentService.isSelfHosted()) {
      const workspace = await this.workspaceRepo.findFirst();
      if (!workspace) {
        (req as any).workspaceId = null;
        this.assignWorkspaceId(null);
        return next();
      }

      (req as any).workspaceId = workspace.id;
      (req as any).workspace = workspace;
      this.assignWorkspaceId(workspace.id);
    } else if (this.environmentService.isCloud()) {
      const header = req.headers.host;
      const subdomain = header.split('.')[0];

      const workspace = await this.workspaceRepo.findByHostname(subdomain);

      if (!workspace) {
        (req as any).workspaceId = null;
        this.assignWorkspaceId(null);
        return next();
      }

      (req as any).workspaceId = workspace.id;
      (req as any).workspace = workspace;
      this.assignWorkspaceId(workspace.id);
    }

    next();
  }
}
