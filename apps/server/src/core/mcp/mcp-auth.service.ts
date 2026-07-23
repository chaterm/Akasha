import {
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeyRepo } from '@akasha/db/repos/api-key/api-key.repo';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
import { WorkspaceRepo } from '@akasha/db/repos/workspace/workspace.repo';
import { User, Workspace } from '@akasha/db/types/entity.types';
import { TokenService } from '../auth/services/token.service';
import { JwtApiKeyPayload, JwtType } from '../auth/dto/jwt-payload';
import {
  extractBearerTokenFromHeader,
  isUserDisabled,
} from '../../common/helpers';
import { FastifyRequest } from 'fastify';

export type McpAuthContext = {
  user: User;
  workspace: Workspace;
};

@Injectable()
export class McpAuthService {
  private readonly logger = new Logger(McpAuthService.name);

  constructor(
    private readonly apiKeyRepo: ApiKeyRepo,
    private readonly tokenService: TokenService,
    private readonly userRepo: UserRepo,
    private readonly workspaceRepo: WorkspaceRepo,
  ) {}

  async authenticate(request: FastifyRequest): Promise<McpAuthContext> {
    const token = extractBearerTokenFromHeader(request);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let payload: JwtApiKeyPayload;
    try {
      payload = await this.tokenService.verifyJwt(token, JwtType.API_KEY);
    } catch {
      throw new UnauthorizedException('Invalid API key');
    }

    const requestWorkspaceId = (request.raw as any)?.workspaceId;
    if (requestWorkspaceId && requestWorkspaceId !== payload.workspaceId) {
      throw new UnauthorizedException('Workspace does not match');
    }

    const key = await this.apiKeyRepo.findById(
      payload.apiKeyId,
      payload.workspaceId,
    );
    if (!key) {
      throw new UnauthorizedException('API key not found or revoked');
    }

    if (key.expiresAt && key.expiresAt <= new Date()) {
      throw new UnauthorizedException('API key has expired');
    }

    const workspace = await this.workspaceRepo.findById(payload.workspaceId);
    if (!workspace) {
      throw new UnauthorizedException('Workspace not found');
    }

    const user = await this.userRepo.findById(payload.sub, workspace.id);
    if (!user || isUserDisabled(user)) {
      throw new UnauthorizedException('User not found');
    }

    this.apiKeyRepo
      .updateLastUsed(key.id)
      .catch((err) =>
        this.logger.warn(
          `Failed to update lastUsedAt for API key ${key.id}: ${err?.message}`,
        ),
      );

    return { user, workspace };
  }
}
