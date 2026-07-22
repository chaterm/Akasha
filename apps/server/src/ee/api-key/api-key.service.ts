import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeyRepo } from '@akasha/db/repos/api-key/api-key.repo';
import { TokenService } from '../../core/auth/services/token.service';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
import { WorkspaceRepo } from '@akasha/db/repos/workspace/workspace.repo';
import { JwtApiKeyPayload } from '../../core/auth/dto/jwt-payload';
import { UserRole } from '../../common/helpers/types/permission';
import { PaginationOptions } from '@akasha/db/pagination/pagination-options';
import { SpaceRepo } from '@akasha/db/repos/space/space.repo';
import { withApiKeyAccess } from '../../common/auth/api-key-access';
import type { User, Workspace } from '@akasha/db/types/entity.types';

@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  constructor(
    private apiKeyRepo: ApiKeyRepo,
    private tokenService: TokenService,
    private userRepo: UserRepo,
    private workspaceRepo: WorkspaceRepo,
    private spaceRepo: SpaceRepo,
  ) {}

  async createApiKey(opts: {
    name: string;
    expiresAt?: string;
    creatorId: string;
    workspaceId: string;
  }) {
    const { name, expiresAt, creatorId, workspaceId } = opts;

    const workspace = await this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new NotFoundException('Workspace not found');

    // Always fetch user upfront — needed for token generation and permission check
    const user = await this.userRepo.findById(creatorId, workspaceId);
    if (!user) throw new ForbiddenException();

    // restrictApiToAdmins is stored in workspace.settings.api.restrictToAdmins
    const workspaceSettings = (workspace.settings ?? {}) as Record<string, any>;
    const restrictToAdmins = workspaceSettings?.api?.restrictToAdmins ?? false;

    if (
      restrictToAdmins &&
      user.role !== UserRole.OWNER &&
      user.role !== UserRole.ADMIN
    ) {
      throw new ForbiddenException('API key creation is restricted to admins');
    }

    const expiresDate = expiresAt ? new Date(expiresAt) : null;
    if (expiresDate && expiresDate <= new Date()) {
      throw new BadRequestException('Expiration date must be in the future');
    }

    const apiKey = await this.apiKeyRepo.create({
      name,
      creatorId,
      workspaceId,
      expiresAt: expiresDate,
    });

    let expiresIn: number | undefined;
    if (expiresDate) {
      expiresIn = Math.floor((expiresDate.getTime() - Date.now()) / 1000);
    }

    const token = await this.tokenService.generateApiToken({
      apiKeyId: apiKey.id,
      user,
      workspaceId,
      expiresIn,
    });

    return {
      ...apiKey,
      token,
      creator: { id: user.id, name: user.name, email: user.email },
    };
  }

  async getUserApiKeys(
    creatorId: string,
    workspaceId: string,
    pagination: PaginationOptions,
  ) {
    return this.apiKeyRepo.findUserKeys(creatorId, workspaceId, pagination);
  }

  async getWorkspaceApiKeys(
    workspaceId: string,
    pagination: PaginationOptions,
  ) {
    return this.apiKeyRepo.findWorkspaceKeys(workspaceId, pagination);
  }

  async updateApiKey(opts: {
    apiKeyId: string;
    name: string;
    userId: string;
    workspaceId: string;
  }) {
    const { apiKeyId, name, userId, workspaceId } = opts;
    const key = await this.apiKeyRepo.findById(apiKeyId, workspaceId);
    if (!key) throw new NotFoundException('API key not found');

    const user = await this.userRepo.findById(userId, workspaceId);
    if (!user) throw new ForbiddenException();
    const isAdmin =
      user.role === UserRole.OWNER || user.role === UserRole.ADMIN;
    if (key.creatorId !== userId && !isAdmin) {
      throw new ForbiddenException();
    }

    return this.apiKeyRepo.updateName(apiKeyId, workspaceId, name);
  }

  async revokeApiKey(opts: {
    apiKeyId: string;
    userId: string;
    workspaceId: string;
  }) {
    const { apiKeyId, userId, workspaceId } = opts;
    const key = await this.apiKeyRepo.findById(apiKeyId, workspaceId);
    if (!key) throw new NotFoundException('API key not found');

    const user = await this.userRepo.findById(userId, workspaceId);
    if (!user) throw new ForbiddenException();
    const isAdmin =
      user.role === UserRole.OWNER || user.role === UserRole.ADMIN;
    if (key.creatorId !== userId && !isAdmin) {
      throw new ForbiddenException();
    }

    await this.apiKeyRepo.softDelete(apiKeyId, workspaceId);
  }

  async validateApiKey(
    payload: JwtApiKeyPayload,
  ): Promise<{ user: User; workspace: Workspace }> {
    const key = await this.apiKeyRepo.findById(
      payload.apiKeyId,
      payload.workspaceId,
    );
    if (!key) throw new UnauthorizedException('API key not found or revoked');

    if (key.expiresAt && key.expiresAt <= new Date()) {
      throw new UnauthorizedException('API key has expired');
    }

    const workspace = await this.workspaceRepo.findById(payload.workspaceId);
    if (!workspace) throw new UnauthorizedException();

    const user = await this.userRepo.findById(payload.sub, payload.workspaceId);
    if (!user) throw new UnauthorizedException();

    const personalSpace = await this.spaceRepo.findPersonalSpaceForUser({
      userId: user.id,
      workspaceId: payload.workspaceId,
    });
    const authenticatedUser = withApiKeyAccess(user, {
      apiKeyId: key.id,
      personalSpaceId: personalSpace?.id ?? null,
    });

    this.apiKeyRepo
      .updateLastUsed(key.id)
      .catch((err) =>
        this.logger.warn(
          `Failed to update lastUsedAt for API key ${key.id}: ${err?.message}`,
        ),
      );

    return { user: authenticatedUser, workspace };
  }
}
