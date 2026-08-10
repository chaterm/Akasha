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

  it('allows editing a shared-space page when the API key owner has page-level writer access', async () => {
    const { service, pagePermissionRepo } = createService();

    await expect(service.validateCanEdit(page, apiUser)).resolves.toEqual({
      hasRestriction: true,
    });
    expect(pagePermissionRepo.canUserEditPage).toHaveBeenCalledWith(
      'user-1',
      'page-1',
    );
  });

  it('reports shared-space pages as editable when the API key owner has edit access', async () => {
    const { service } = createService();

    await expect(
      service.validateCanViewWithPermissions(page, apiUser),
    ).resolves.toEqual({ canEdit: true, hasRestriction: true });
  });

  it('uses the same permissions for citation source reads', async () => {
    const { service } = createService();

    await expect(
      service.validateCanReadCitationSourceWithPermissions(page, apiUser),
    ).resolves.toEqual({ canEdit: true, hasRestriction: true });
  });

  it('allows reading shared-space source content through ordinary Page visibility', async () => {
    const { service, spaceAbility, pagePermissionRepo } = createService();

    await expect(
      service.validateCanReadSourceWithPermissions(page, apiUser),
    ).resolves.toEqual({ canEdit: true, hasRestriction: true });

    expect(spaceAbility.createForUser).toHaveBeenCalledWith(apiUser, 'shared-1');
    expect(pagePermissionRepo.canUserEditPage).toHaveBeenCalledWith(
      'user-1',
      'page-1',
    );
  });

  it('allows reading source content from the API key personal space', async () => {
    const { service } = createService();
    const personalPage = { ...page, spaceId: 'personal-1' };

    await expect(
      service.validateCanReadSourceWithPermissions(personalPage, apiUser),
    ).resolves.toEqual({ canEdit: true, hasRestriction: true });
  });
});
