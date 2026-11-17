import { Extension, onAuthenticatePayload } from '@hocuspocus/server';
import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenService } from '../../core/auth/services/token.service';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@akasha/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@akasha/db/repos/page/page-permission.repo';
import { findHighestUserSpaceRole } from '@akasha/db/repos/space/utils';
import {
  isWorkspaceAdmin,
  SpaceRole,
  UserRole,
} from '../../common/helpers/types/permission';
import { isUserDisabled } from '../../common/helpers';
import { getPageId } from '../collaboration.util';
import { JwtCollabPayload, JwtType } from '../../core/auth/dto/jwt-payload';

@Injectable()
export class AuthenticationExtension implements Extension {
  private readonly logger = new Logger(AuthenticationExtension.name);

  constructor(
    private tokenService: TokenService,
    private userRepo: UserRepo,
    private pageRepo: PageRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
  ) {}

  async onAuthenticate(data: onAuthenticatePayload) {
    const { documentName, token, requestParameters } = data;
    const pageId = getPageId(documentName);

    if (requestParameters.get('readOnly') === 'true') {
      data.connectionConfig.readOnly = true;
    }

    let jwtPayload: JwtCollabPayload;

    try {
      jwtPayload = await this.tokenService.verifyJwt(token, JwtType.COLLAB);
    } catch (error) {
      throw new UnauthorizedException('Invalid collab token');
    }

    const userId = jwtPayload.sub;
    const workspaceId = jwtPayload.workspaceId;

    const user = await this.userRepo.findById(userId, workspaceId);

    if (!user) {
      throw new UnauthorizedException();
    }

    if (isUserDisabled(user)) {
      throw new UnauthorizedException();
    }

    const page = await this.pageRepo.findById(pageId);
    if (!page || page.workspaceId !== workspaceId) {
      throw new NotFoundException('Page not found');
    }

    if (user.role === UserRole.OWNER) {
      if (page.deletedAt) {
        data.connectionConfig.readOnly = true;
      }
      return { user };
    }

    const userSpaceRole = isWorkspaceAdmin(user.role)
      ? SpaceRole.ADMIN
      : findHighestUserSpaceRole(
          await this.spaceMemberRepo.getUserSpaceRoles(user.id, page.spaceId),
        );

    if (!userSpaceRole) {
      this.logger.warn(
        { userId: user.id, pageId },
        'Collab access denied: no space role',
      );
      throw new UnauthorizedException();
    }

    const { hasAnyRestriction, canAccess, canEdit } =
      await this.pagePermissionRepo.canUserEditPage(user.id, page.id);

    if (hasAnyRestriction) {
      if (!canAccess) {
        this.logger.warn(
          { userId: user.id, pageId },
          'Collab access denied: page restriction',
        );
        throw new UnauthorizedException();
      }

      if (!canEdit) {
        data.connectionConfig.readOnly = true;
      }
    } else if (userSpaceRole === SpaceRole.READER) {
      data.connectionConfig.readOnly = true;
    }

    if (page.deletedAt) {
      data.connectionConfig.readOnly = true;
    }

    return {
      user,
    };
  }
}
