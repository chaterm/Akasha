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

@Injectable()
export class PageAccessService {
  constructor(
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly spaceRepo: SpaceRepo,
  ) {}

  async validateCanView(page: Page, user: User): Promise<void> {
    if (user.role === UserRole.OWNER) {
      return;
    }

    const ability = await this.spaceAbility.createForUser(user, page.spaceId);

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

  async validateCanViewWithPermissions(
    page: Page,
    user: User,
  ): Promise<{ canEdit: boolean; hasRestriction: boolean }> {
    if (user.role === UserRole.OWNER) {
      return { canEdit: true, hasRestriction: false };
    }

    const ability = await this.spaceAbility.createForUser(user, page.spaceId);

    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    const { hasAnyRestriction, canAccess, canEdit } =
      await this.pagePermissionRepo.canUserEditPage(user.id, page.id);

    if (hasAnyRestriction && !canAccess) {
      throw new ForbiddenException();
    }

    return {
      canEdit: hasAnyRestriction
        ? canEdit
        : ability.can(SpaceCaslAction.Edit, SpaceCaslSubject.Page),
      hasRestriction: hasAnyRestriction,
    };
  }

  async validateCanReadSourceWithPermissions(
    page: Page,
    user: User,
  ): Promise<{ canEdit: boolean; hasRestriction: boolean }> {
    return this.validateCanViewWithPermissions(page, user);
  }

  async validateCanReadCitationSourceWithPermissions(
    page: Page,
    user: User,
  ): Promise<{ canEdit: boolean; hasRestriction: boolean }> {
    return this.validateCanViewWithPermissions(page, user);
  }

  async validateCanEdit(
    page: Page,
    user: User,
  ): Promise<{ hasRestriction: boolean }> {
    if (user.role === UserRole.OWNER) {
      return { hasRestriction: false };
    }

    const ability = await this.spaceAbility.createForUser(user, page.spaceId);

    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    const { hasAnyRestriction, canEdit } =
      await this.pagePermissionRepo.canUserEditPage(user.id, page.id);

    if (hasAnyRestriction) {
      if (!canEdit) {
        throw new ForbiddenException();
      }
    } else {
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
