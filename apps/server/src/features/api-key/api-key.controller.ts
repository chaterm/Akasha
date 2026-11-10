import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User, Workspace } from '@akasha/db/types/entity.types';
import { PaginationOptions } from '@akasha/db/pagination/pagination-options';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../core/casl/interfaces/workspace-ability.type';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { UpdateApiKeyDto } from './dto/update-api-key.dto';
import { RevokeApiKeyDto } from './dto/revoke-api-key.dto';
import { CreatePublicApiKeyDto } from './dto/create-public-api-key.dto';
import { UpdatePublicApiKeyDto } from './dto/update-public-api-key.dto';
import { AgentApiKeyIdDto } from './dto/agent-api-key-id.dto';
import { UserRole } from '../../common/helpers/types/permission';
import { UpdateAgentSpacesDto } from './dto/update-agent-spaces.dto';

@UseGuards(JwtAuthGuard)
@Controller('api-keys')
export class ApiKeyController {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('/')
  async listApiKeys(
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.apiKeyService.getUserApiKeys(user.id, workspace.id, pagination);
  }

  @HttpCode(HttpStatus.OK)
  @Post('workspace')
  async listWorkspaceApiKeys(
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }
    return this.apiKeyService.getWorkspaceApiKeys(workspace.id, pagination);
  }

  @HttpCode(HttpStatus.OK)
  @Post('public')
  async listPublicApiKeys(
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertWorkspaceOwner(user);
    return this.apiKeyService.getPublicApiKeys(workspace.id, pagination);
  }

  @HttpCode(HttpStatus.OK)
  @Post('agent/spaces')
  async listAgentSpaces(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.apiKeyService.getAgentBindableSpaces(user.id, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('agent/spaces/update')
  async updateAgentSpaces(
    @Body() dto: UpdateAgentSpacesDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertWorkspaceOwner(user);
    return this.apiKeyService.updateAgentSpaces({
      apiKeyId: dto.apiKeyId,
      spaceIds: dto.spaceIds,
      userId: user.id,
      workspaceId: workspace.id,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async createApiKey(
    @Body() dto: CreateApiKeyDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.apiKeyService.createApiKey({
      name: dto.name,
      expiresAt: dto.expiresAt,
      creatorId: user.id,
      workspaceId: workspace.id,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('public/create')
  async createPublicApiKey(
    @Body() dto: CreatePublicApiKeyDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertWorkspaceOwner(user);
    return this.apiKeyService.createPublicApiKey({
      name: dto.name,
      creatorId: user.id,
      workspaceId: workspace.id,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('public/update')
  async updatePublicApiKey(
    @Body() dto: UpdatePublicApiKeyDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertWorkspaceOwner(user);
    return this.apiKeyService.updatePublicApiKey({
      apiKeyId: dto.apiKeyId,
      name: dto.name,
      userId: user.id,
      workspaceId: workspace.id,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('public/rotate')
  async rotatePublicApiKey(
    @Body() dto: AgentApiKeyIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertWorkspaceOwner(user);
    return this.apiKeyService.rotatePublicApiKey({
      apiKeyId: dto.apiKeyId,
      userId: user.id,
      workspaceId: workspace.id,
    });
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('public/delete')
  async deletePublicApiKey(
    @Body() dto: AgentApiKeyIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<void> {
    this.assertWorkspaceOwner(user);
    await this.apiKeyService.deletePublicApiKey({
      apiKeyId: dto.apiKeyId,
      userId: user.id,
      workspaceId: workspace.id,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async updateApiKey(
    @Body() dto: UpdateApiKeyDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.apiKeyService.updateApiKey({
      apiKeyId: dto.apiKeyId,
      name: dto.name,
      userId: user.id,
      workspaceId: workspace.id,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('revoke')
  async revokeApiKey(
    @Body() dto: RevokeApiKeyDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<void> {
    await this.apiKeyService.revokeApiKey({
      apiKeyId: dto.apiKeyId,
      userId: user.id,
      workspaceId: workspace.id,
    });
  }

  private assertCanManageApiKeys(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.API)) {
      throw new ForbiddenException();
    }
  }

  private assertWorkspaceOwner(user: User) {
    if (user.role !== UserRole.OWNER) {
      throw new ForbiddenException();
    }
  }
}
