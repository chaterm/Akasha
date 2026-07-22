import { ForbiddenException } from '@nestjs/common';
import { withApiKeyAccess } from '../../../common/auth/api-key-access';
import { UserRole } from '../../../common/helpers/types/permission';
import { PageAccessService } from './page-access.service';

describe('PageAccessService API key policy', () => {
  const page = { id: 'page-1', spaceId: 'shared-1' } as any;
  const apiUser = withApiKeyAccess(
    { id: 'user-1', role: UserRole.MEMBER } as any,
    { apiKeyId: 'key-1', personalSpaceId: 'personal-1' },
  );

  const createService = () => {
    const pagePermissionRepo = {
      canUserEditPage: jest.fn().mockResolvedValue({
        hasAnyRestriction: true,
        canAccess: true,
        canEdit: true,
      }),
    };
    const spaceAbility = {
      createForUser: jest.fn().mockResolvedValue({
        can: jest.fn().mockReturnValue(true),
        cannot: jest.fn().mockReturnValue(false),
      }),
    };
    const spaceRepo = { findById: jest.fn() };
    return {
      service: new PageAccessService(
        pagePermissionRepo as any,
        spaceAbility as any,
        spaceRepo as any,
      ),
      pagePermissionRepo,
      spaceAbility,
    };
  };

  it('rejects editing a shared-space page even with page-level writer access', async () => {
    const { service, pagePermissionRepo } = createService();

    await expect(service.validateCanEdit(page, apiUser)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(pagePermissionRepo.canUserEditPage).not.toHaveBeenCalled();
  });

  it('reports shared-space pages as non-editable while preserving read access', async () => {
    const { service } = createService();

    await expect(
      service.validateCanViewWithPermissions(page, apiUser),
    ).resolves.toEqual({ canEdit: false, hasRestriction: true });
  });

  it('rejects reading shared-space source content with an API key', async () => {
    const { service, spaceAbility, pagePermissionRepo } = createService();

    await expect(
      service.validateCanReadSourceWithPermissions(page, apiUser),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(spaceAbility.createForUser).not.toHaveBeenCalled();
    expect(pagePermissionRepo.canUserEditPage).not.toHaveBeenCalled();
  });

  it('allows reading source content from the API key personal space', async () => {
    const { service } = createService();
    const personalPage = { ...page, spaceId: 'personal-1' };

    await expect(
      service.validateCanReadSourceWithPermissions(personalPage, apiUser),
    ).resolves.toEqual({ canEdit: true, hasRestriction: true });
  });
});
