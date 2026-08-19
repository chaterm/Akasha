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
import { ApiKeyType } from '../../common/auth/api-key-type';
import { JwtType } from '../../core/auth/dto/jwt-payload';
import { isUserDisabled } from '../../common/helpers';

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
      keyType: ApiKeyType.PERSONAL,
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

  async createPublicApiKey(opts: {
    name: string;
    spaceIds: string[];
    expiresAt?: string;
    creatorId: string;
    workspaceId: string;
  }) {
    const { name, creatorId, workspaceId } = opts;
    const user = await this.requireWorkspaceAdmin(creatorId, workspaceId);
    const spaceIds = [...new Set(opts.spaceIds)];
    const bindableSpaceIds = await this.apiKeyRepo.findBindableSpaceIds(
      workspaceId,
      spaceIds,
    );
    if (bindableSpaceIds.length !== spaceIds.length) {
      throw new BadRequestException(
        'Public API keys can only bind active shared Spaces in this workspace',
      );
    }

    const expiresDate = opts.expiresAt ? new Date(opts.expiresAt) : null;
    if (expiresDate && expiresDate <= new Date()) {
      throw new BadRequestException('Expiration date must be in the future');
    }

    const apiKey = await this.apiKeyRepo.createWithSpaces(
      {
        name,
        creatorId,
        workspaceId,
        keyType: ApiKeyType.PUBLIC_RETRIEVAL,
        expiresAt: expiresDate,
      },
      spaceIds,
    );
    const expiresIn = expiresDate
      ? Math.floor((expiresDate.getTime() - Date.now()) / 1000)
      : undefined;
    const token = await this.tokenService.generatePublicApiToken({
      apiKeyId: apiKey.id,
      workspaceId,
      expiresIn,
    });

    return {
      ...apiKey,
      token,
      spaces: spaceIds.map((id) => ({ id })),
      creator: { id: user.id, name: user.name, email: user.email },
    };
  }

  async getPublicApiKeys(workspaceId: string, pagination: PaginationOptions) {
    return this.apiKeyRepo.findPublicKeys(workspaceId, pagination);
  }

  async getBindablePublicKeySpaces(userId: string, workspaceId: string) {
    await this.requireWorkspaceAdmin(userId, workspaceId);
    return this.apiKeyRepo.findBindableSpaces(workspaceId);
  }

  async updatePublicApiKey(opts: {
    apiKeyId: string;
    name: string;
    spaceIds: string[];
    userId: string;
    workspaceId: string;
  }) {
    await this.requireWorkspaceAdmin(opts.userId, opts.workspaceId);
    const key = await this.apiKeyRepo.findById(opts.apiKeyId, opts.workspaceId);
    if (!key || key.keyType !== ApiKeyType.PUBLIC_RETRIEVAL) {
      throw new NotFoundException('Public API key not found');
    }
    const spaceIds = [...new Set(opts.spaceIds)];
    const bindableSpaceIds = await this.apiKeyRepo.findBindableSpaceIds(
      opts.workspaceId,
      spaceIds,
    );
    if (bindableSpaceIds.length !== spaceIds.length) {
      throw new BadRequestException(
        'Public API keys can only bind active shared Spaces in this workspace',
      );
    }

    return this.apiKeyRepo.updatePublicKey(
      opts.apiKeyId,
      opts.workspaceId,
      opts.name,
      spaceIds,
    );
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

    // Treat pre-migration rows without a key type as personal during rolling
    // deployments. The migration backfills all persisted rows to this value.
    if (key.keyType && key.keyType !== ApiKeyType.PERSONAL) {
      throw new UnauthorizedException('A personal API key is required');
    }

    if (key.expiresAt && key.expiresAt <= new Date()) {
      throw new UnauthorizedException('API key has expired');
    }

    const workspace = await this.workspaceRepo.findById(payload.workspaceId);
    if (!workspace) throw new UnauthorizedException();

    const user = await this.userRepo.findById(payload.sub, payload.workspaceId);
    if (!user || isUserDisabled(user)) throw new UnauthorizedException();

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

  async validatePublicApiKey(token: string, workspaceId: string) {
    let payload: {
      apiKeyId: string;
      workspaceId: string;
      type: string;
    };
    try {
      payload = await this.tokenService.verifyJwt(
        token,
        JwtType.PUBLIC_API_KEY,
      );
    } catch {
      throw new UnauthorizedException('Invalid Public API key');
    }
    if (payload.workspaceId !== workspaceId) {
      throw new UnauthorizedException('API key workspace does not match');
    }

    const key = await this.apiKeyRepo.findById(payload.apiKeyId, workspaceId);
    if (!key || key.keyType !== ApiKeyType.PUBLIC_RETRIEVAL) {
      throw new UnauthorizedException('Public API key not found or revoked');
    }
    if (key.expiresAt && key.expiresAt <= new Date()) {
      throw new UnauthorizedException('Public API key has expired');
    }

    const spaceIds = await this.apiKeyRepo.findSpaceIdsByApiKeyId(key.id);
    this.apiKeyRepo
      .updateLastUsed(key.id)
      .catch((err) =>
        this.logger.warn(
          `Failed to update lastUsedAt for API key ${key.id}: ${err?.message}`,
        ),
      );
    return { apiKeyId: key.id, workspaceId, spaceIds };
  }

  private async requireWorkspaceAdmin(userId: string, workspaceId: string) {
    const user = await this.userRepo.findById(userId, workspaceId);
    if (
      !user ||
      (user.role !== UserRole.OWNER && user.role !== UserRole.ADMIN)
    ) {
      throw new ForbiddenException('Workspace administrator access required');
    }
    return user;
  }
}
