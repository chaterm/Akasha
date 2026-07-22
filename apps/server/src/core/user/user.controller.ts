import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UserService } from './user.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@akasha/db/types/entity.types';
import { WorkspaceRepo } from '@akasha/db/repos/workspace/workspace.repo';
import { SpaceRepo } from '@akasha/db/repos/space/space.repo';
import { getApiKeyAccess } from '../../common/auth/api-key-access';
import { UserRole } from '../../common/helpers/types/permission';

@UseGuards(JwtAuthGuard)
@Controller('users')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly spaceRepo: SpaceRepo,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('me')
  async getUserInfo(
    @AuthUser() authUser: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const memberCount = await this.workspaceRepo.getActiveUserCount(
      workspace.id,
    );

    const { licenseKey, ...rest } = workspace;

    const workspaceInfo = {
      ...rest,
      memberCount,
    };

    const personalSpace = await this.spaceRepo.findPersonalSpaceForUser({
      userId: authUser.id,
      workspaceId: workspace.id,
    });
    const apiKeyAccess = getApiKeyAccess(authUser);

    return {
      user: authUser,
      workspace: workspaceInfo,
      personalSpaceId: personalSpace?.id ?? null,
      ...(apiKeyAccess
        ? {
            apiAccess: {
              personalSpaceId: apiKeyAccess.personalSpaceId,
              policy:
                authUser.role === UserRole.MEMBER
                  ? 'ordinary-user'
                  : 'privileged-user',
            },
          }
        : {}),
    };
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async updateUser(
    @Body() updateUserDto: UpdateUserDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.userService.update(updateUserDto, user.id, workspace);
  }
}
