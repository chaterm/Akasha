import { ForbiddenException, Injectable } from '@nestjs/common';
import { Page, User } from '@akasha/db/types/entity.types';
import { PagePermissionRepo } from '@akasha/db/repos/page/page-permission.repo';
import SpaceAbilityFactory from '../../casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../casl/interfaces/space-ability.type';
import { SpaceRepo } from '@akasha/db/repos/space/space.repo';
import { UserRole } from '../../../common/helpers/types/permission';
import {
  getApiKeyAccess,
  isOrdinaryApiKeySpaceReadOnly,
} from '../../../common/auth/api-key-access';

@Injectable()
export class PageAccessService {
  constructor(
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly spaceRepo: SpaceRepo,
  ) {}

  /**
   * Validate user can view page, throws ForbiddenException if not.
   * If page has restrictions: page-level permission determines access.
   * If no restrictions: space-level permission determines access.
   */
  async validateCanView(page: Page, user: User): Promise<void> {
    // Workspace owner bypasses all page-level restrictions
    if (user.role === UserRole.OWNER) {
      return;
    }

    // TODO: cache by pageId and userId.
    const ability = await this.spaceAbility.createForUser(user, page.spaceId);

    // User must be at least a space member
    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    const canAccess = await this.pagePermissionRepo.canUserAccessPage(
      user.id,
      page.id,
    );
    if (!canAccess) {
      throw new ForbiddenException();
    }
  }

  /**
   * Validate user can view page AND return effective canEdit permission.
   * Combines access check + edit permission in a single query pass.
   */
  async validateCanViewWithPermissions(
    page: Page,
    user: User,
  ): Promise<{ canEdit: boolean; hasRestriction: boolean }> {
    // Workspace owner has full edit access, bypassing page-level restrictions
    if (user.role === UserRole.OWNER) {
      return { canEdit: true, hasRestriction: false };
    }

    const ability = await this.spaceAbility.createForUser(user, page.spaceId);

    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    const apiKeyReadOnly = isOrdinaryApiKeySpaceReadOnly(user, page.spaceId);

    const { hasAnyRestriction, canAccess, canEdit } =
      await this.pagePermissionRepo.canUserEditPage(user.id, page.id);

    if (hasAnyRestriction && !canAccess) {
      throw new ForbiddenException();
    }

    return {
      canEdit: apiKeyReadOnly
        ? false
        : hasAnyRestriction
          ? canEdit
          : ability.can(SpaceCaslAction.Edit, SpaceCaslSubject.Page),
      hasRestriction: hasAnyRestriction,
    };
  }

  /**
   * API keys may read raw Page source only from their personal space.
   * Session authentication keeps the existing Page viewing behavior.
   */
  async validateCanReadSourceWithPermissions(
    page: Page,
    user: User,
  ): Promise<{ canEdit: boolean; hasRestriction: boolean }> {
    const apiKeyAccess = getApiKeyAccess(user);
    if (apiKeyAccess && apiKeyAccess.personalSpaceId !== page.spaceId) {
      throw new ForbiddenException(
        'API key can read Page source only in its personal space',
      );
    }

    return this.validateCanViewWithPermissions(page, user);
  }

  /**
   * Validate user can edit page, throws ForbiddenException if not.
   * If page has restrictions: page-level writer permission determines access.
   * If no restrictions: space-level edit permission determines access.
   */
  async validateCanEdit(
    page: Page,
    user: User,
  ): Promise<{ hasRestriction: boolean }> {
    // Workspace owner bypasses all page-level restrictions
    if (user.role === UserRole.OWNER) {
      return { hasRestriction: false };
    }

    const ability = await this.spaceAbility.createForUser(user, page.spaceId);

    // User must be at least a space member
    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    if (isOrdinaryApiKeySpaceReadOnly(user, page.spaceId)) {
      throw new ForbiddenException(
        'API key has read-only access to this space',
      );
    }

    const { hasAnyRestriction, canEdit } =
      await this.pagePermissionRepo.canUserEditPage(user.id, page.id);

    if (hasAnyRestriction) {
      // Page has restrictions - use page-level permission
      if (!canEdit) {
        throw new ForbiddenException();
      }
    } else {
      // No restrictions - use space-level permission
      if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }
    }

    return { hasRestriction: hasAnyRestriction };
  }

  async validateCanComment(
    page: Page,
    user: User,
    workspaceId: string,
  ): Promise<void> {
    if (isOrdinaryApiKeySpaceReadOnly(user, page.spaceId)) {
      throw new ForbiddenException(
        'API key has read-only access to this space',
      );
    }

    // Workspace owner can always comment
    if (user.role === UserRole.OWNER) {
      return;
    }

    try {
      await this.validateCanEdit(page, user);
      return;
    } catch {
      // User cannot edit — check if reader commenting is enabled
    }

    await this.validateCanView(page, user);

    const space = await this.spaceRepo.findById(page.spaceId, workspaceId);
    const settings = space?.settings as Record<string, any> | null;
    if (!settings?.comments?.allowViewerComments) {
      throw new ForbiddenException();
    }
  }
}
