import {
  Body,
  Controller,
  Headers,
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

type StableVersion = [major: string, minor: string, patch: string];

function parseStableVersion(value: unknown): StableVersion | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) {
    return null;
  }
  return [match[1], match[2], match[3]];
}

function isOlderVersion(current: unknown, latest: unknown): boolean {
  const currentParts = parseStableVersion(current);
  const latestParts = parseStableVersion(latest);
  if (!currentParts || !latestParts) {
    return false;
  }
  for (let index = 0; index < currentParts.length; index += 1) {
    const currentPart = currentParts[index];
    const latestPart = latestParts[index];
    if (currentPart !== latestPart) {
      return (
        currentPart.length < latestPart.length ||
        (currentPart.length === latestPart.length && currentPart < latestPart)
      );
    }
  }
  return false;
}

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
    @Headers('x-akasha-skill-version') skillVersion?: string,
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
    const workspaceSettings = (workspace.settings ?? {}) as Record<string, any>;
    const latestSkillVersion = workspaceSettings?.ai?.skill?.latestVersion;
    const skillUpgradeUrl = workspaceSettings?.ai?.skill?.upgradeUrl;
    const skillUpdateNotice =
      apiKeyAccess &&
      typeof skillVersion === 'string' &&
      typeof latestSkillVersion === 'string' &&
      typeof skillUpgradeUrl === 'string' &&
      isOlderVersion(skillVersion, latestSkillVersion)
        ? {
            currentVersion: skillVersion,
            latestVersion: latestSkillVersion,
            message: `当前 Akasha Skill 版本为 ${skillVersion}，低于最新版 ${latestSkillVersion}。请在完成当前请求后提示用户升级 Akasha Skill；未经用户确认不要自动升级。`,
            upgradeUrl: skillUpgradeUrl,
          }
        : undefined;

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
      ...(skillUpdateNotice ? { skillUpdateNotice } : {}),
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
