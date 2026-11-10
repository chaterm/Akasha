import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Optional,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SpaceService } from './services/space.service';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { SpaceIdDto } from './dto/space-id.dto';
import { SpaceMemberService } from './services/space-member.service';
import { Space, User, Workspace } from '@akasha/db/types/entity.types';
import { AddSpaceMembersDto } from './dto/add-space-members.dto';
import { RemoveSpaceMemberDto } from './dto/remove-space-member.dto';
import { UpdateSpaceMemberRoleDto } from './dto/update-space-member-role.dto';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../casl/interfaces/space-ability.type';
import { UpdateSpaceDto } from './dto/update-space.dto';
import { findHighestUserSpaceRole } from '@akasha/db/repos/space/utils';
import { SpaceMemberRepo } from '@akasha/db/repos/space/space-member.repo';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../casl/interfaces/workspace-ability.type';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import { CreateSpaceDto } from './dto/create-space.dto';
import { SpaceRepo } from '@akasha/db/repos/space/space.repo';
import { emptyCursorPaginationResult } from '@akasha/db/pagination/cursor-pagination';
import {
  isWorkspaceAdmin,
  SpaceRole,
} from '../../common/helpers/types/permission';
import { SpacePaginationOptions } from './dto/space-pagination-options.dto';
import { PaginationOptions } from '@akasha/db/pagination/pagination-options';
import { AgentCallable } from '../../common/decorators/agent-callable.decorator';
import { AgentCapability } from '../../common/auth/agent-capability';
import { AgentAccess } from '../../common/decorators/agent-access.decorator';
import type { AgentAccessContext } from '../../common/auth/agent-access-context';
import { AgentAccessService } from '../page/page-access/agent-access.service';

@UseGuards(JwtAuthGuard)
@Controller('spaces')
export class SpaceController {
  constructor(
    private readonly spaceService: SpaceService,
    private readonly spaceMemberService: SpaceMemberService,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly spaceRepo: SpaceRepo,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    @Optional() private readonly agentAccessService?: AgentAccessService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('/')
  @AgentCallable(AgentCapability.SPACE_READ)
  async getWorkspaceSpaces(
    @Body()
    pagination: SpacePaginationOptions,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @AgentAccess() agentAccess?: AgentAccessContext,
  ) {
    const useAdminView = isWorkspaceAdmin(user.role);

    // Filter by effective access: workspace administrators manage every space,
    // regardless of direct or group membership.
    if (
      useAdminView &&
      pagination.role &&
      pagination.role !== SpaceRole.ADMIN
    ) {
      return emptyCursorPaginationResult<Space>(pagination.limit, 0);
    }

    let allowedSpaceIds: string[] | undefined;
    if (agentAccess) {
      if (!this.agentAccessService) {
        throw new ForbiddenException('Agent space authorization unavailable');
      }
      allowedSpaceIds =
        await this.agentAccessService.getBoundSpaceIds(agentAccess);
    }
    const result = useAdminView
      ? await this.spaceService.getWorkspaceSpaces(
          workspace.id,
          pagination,
          allowedSpaceIds,
        )
      : await this.spaceMemberService.getUserSpaces(
          user.id,
          pagination,
          allowedSpaceIds,
        );

    if (result.items.length > 0) {
      if (useAdminView) {
        result.items = result.items.map((space) => ({
          ...space,
          membership: { userId: user.id, role: SpaceRole.ADMIN },
        }));
      } else {
        const spaceIds = result.items.map((s) => s.id);
        const roles = await this.spaceMemberRepo.getUserRolesForSpaces(
          user.id,
          spaceIds,
        );

        const roleMap = new Map<string, string[]>();
        for (const row of roles) {
          const existing = roleMap.get(row.spaceId) || [];
          existing.push(row.role);
          roleMap.set(row.spaceId, existing);
        }

        result.items = result.items.map((space) => {
          const spaceRoles = roleMap.get(space.id);
          const role = spaceRoles
            ? findHighestUserSpaceRole(
                spaceRoles.map((r) => ({ userId: user.id, role: r })),
              )
            : undefined;

          return {
            ...space,
            membership: { userId: user.id, role },
          };
        });
      }
    }

    return result;
  }

  @HttpCode(HttpStatus.OK)
  @Post('info')
  @AgentCallable(AgentCapability.SPACE_READ)
  async getSpaceInfo(
    @Body() spaceIdDto: SpaceIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @AgentAccess() agentAccess?: AgentAccessContext,
  ) {
    if (agentAccess) {
      if (!this.agentAccessService) {
        throw new ForbiddenException('Agent space authorization unavailable');
      }
      await this.agentAccessService.assertSpaceBound(
        agentAccess,
        spaceIdDto.spaceId,
      );
    }
    const space = await this.spaceService.getSpaceInfo(
      spaceIdDto.spaceId,
      workspace.id,
    );

    if (!space) {
      throw new NotFoundException('Space not found');
    }

    const ability = await this.spaceAbility.createForUser(user, space.id);
    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Settings)) {
      throw new ForbiddenException();
    }

    const userSpaceRole = isWorkspaceAdmin(user.role)
      ? SpaceRole.ADMIN
      : findHighestUserSpaceRole(
          (await this.spaceMemberRepo.getUserSpaceRoles(user.id, space.id)) ??
            [],
        );

    const membership = {
      userId: user.id,
      role: userSpaceRole,
      permissions: ability.rules,
    };

    return { ...space, membership };
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  createSpace(
    @Body() createSpaceDto: CreateSpaceDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Space)
    ) {
      throw new ForbiddenException();
    }
    return this.spaceService.createSpace(user, workspace.id, createSpaceDto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async updateSpace(
    @Body() updateSpaceDto: UpdateSpaceDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    // The knowledge publish mode is a workspace-admin setting (like the
    // knowledge diagnostics page), independent of the user's space role.
    const { spaceId, knowledgeIndexMode, ...otherFields } = updateSpaceDto;
    const updatesKnowledge = knowledgeIndexMode !== undefined;
    if (updatesKnowledge && !isWorkspaceAdmin(user.role)) {
      throw new ForbiddenException();
    }
    const updatesOtherFields = Object.values(otherFields).some(
      (value) => value !== undefined,
    );
    if (updatesOtherFields || !updatesKnowledge) {
      const ability = await this.spaceAbility.createForUser(user, spaceId);
      if (ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Settings)) {
        throw new ForbiddenException();
      }
    }
    return this.spaceService.updateSpace(updateSpaceDto, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async deleteSpace(
    @Body() spaceIdDto: SpaceIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = await this.spaceAbility.createForUser(
      user,
      spaceIdDto.spaceId,
    );
    if (ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Settings)) {
      throw new ForbiddenException();
    }
    return this.spaceService.deleteSpace(
      spaceIdDto.spaceId,
      workspace.id,
      user.id,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('members')
  async getSpaceMembers(
    @Body() spaceIdDto: SpaceIdDto,
    @Body()
    pagination: PaginationOptions,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = await this.spaceAbility.createForUser(
      user,
      spaceIdDto.spaceId,
    );

    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Member)) {
      throw new ForbiddenException();
    }

    return this.spaceMemberService.getSpaceMembers(
      spaceIdDto.spaceId,
      workspace.id,
      pagination,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('members/add')
  async addSpaceMember(
    @Body() dto: AddSpaceMembersDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    if (
      (!dto.userIds || dto.userIds.length === 0) &&
      (!dto.groupIds || dto.groupIds.length === 0)
    ) {
      throw new BadRequestException('userIds or groupIds is required');
    }

    const ability = await this.spaceAbility.createForUser(user, dto.spaceId);
    if (ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Member)) {
      throw new ForbiddenException();
    }

    return this.spaceMemberService.addMembersToSpaceBatch(
      dto,
      user,
      workspace.id,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('members/remove')
  async removeSpaceMember(
    @Body() dto: RemoveSpaceMemberDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.validateIds(dto);

    const ability = await this.spaceAbility.createForUser(user, dto.spaceId);
    if (ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Member)) {
      throw new ForbiddenException();
    }

    return this.spaceMemberService.removeMemberFromSpace(dto, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('members/change-role')
  async updateSpaceMemberRole(
    @Body() dto: UpdateSpaceMemberRoleDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.validateIds(dto);

    const ability = await this.spaceAbility.createForUser(user, dto.spaceId);
    if (ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Member)) {
      throw new ForbiddenException();
    }

    return this.spaceMemberService.updateSpaceMemberRole(dto, workspace.id);
  }

  validateIds(dto: RemoveSpaceMemberDto | UpdateSpaceMemberRoleDto) {
    if (!dto.userId && !dto.groupId) {
      throw new BadRequestException('userId or groupId is required');
    }
    if (dto.userId && dto.groupId) {
      throw new BadRequestException(
        'please provide either a userId or groupId and both',
      );
    }
  }
}
