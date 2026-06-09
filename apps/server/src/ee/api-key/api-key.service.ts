import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeyRepo } from '@docmost/db/repos/api-key/api-key.repo';
import { TokenService } from '../../core/auth/services/token.service';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { JwtApiKeyPayload } from '../../core/auth/dto/jwt-payload';
import { UserRole } from '../../common/helpers/types/permission';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';

@Injectable()
export class ApiKeyService {
  constructor(
    private apiKeyRepo: ApiKeyRepo,
    private tokenService: TokenService,
    private userRepo: UserRepo,
    private workspaceRepo: WorkspaceRepo,
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

    // restrictApiToAdmins is stored in workspace.settings.api.restrictToAdmins
    const workspaceSettings = (workspace.settings ?? {}) as Record<string, any>;
    const restrictToAdmins = workspaceSettings?.api?.restrictToAdmins ?? false;

    if (restrictToAdmins) {
      const user = await this.userRepo.findById(creatorId, workspaceId);
      if (
        !user ||
        (user.role !== UserRole.OWNER && user.role !== UserRole.ADMIN)
      ) {
        throw new ForbiddenException('API key creation is restricted to admins');
      }
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

    const user = await this.userRepo.findById(creatorId, workspaceId);

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
    const isAdmin =
      user?.role === UserRole.OWNER || user?.role === UserRole.ADMIN;
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
    const isAdmin =
      user?.role === UserRole.OWNER || user?.role === UserRole.ADMIN;
    if (key.creatorId !== userId && !isAdmin) {
      throw new ForbiddenException();
    }

    await this.apiKeyRepo.softDelete(apiKeyId, workspaceId);
  }

  async validateApiKey(payload: JwtApiKeyPayload) {
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

    this.apiKeyRepo.updateLastUsed(key.id).catch(() => {});

    return { user, workspace };
  }
}
