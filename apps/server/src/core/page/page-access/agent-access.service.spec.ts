import { ForbiddenException } from '@nestjs/common';
import { AgentAccessService } from './agent-access.service';
import type { AgentAccessContext } from '../../../common/auth/agent-access-context';

const user = { id: 'human-1' } as any;
const context = {
  apiKeyId: 'key-1',
  credentialVersion: 1,
  agentUser: { id: 'agent-1' },
  workspace: { id: 'ws-1' },
  spaceIds: ['sp-1'],
} as unknown as AgentAccessContext;

const page = {
  id: 'page-1',
  spaceId: 'sp-1',
  workspaceId: 'ws-1',
  deletedAt: null,
} as any;

function subject(overrides: Record<string, any> = {}) {
  const apiKeyRepo = {
    findSpaceIdsByApiKeyId: jest.fn().mockResolvedValue(['sp-1']),
    ...overrides.apiKeyRepo,
  };
  const pagePermissionRepo = {
    canUserEditPage: jest.fn().mockResolvedValue({
      hasAnyRestriction: false,
      canAccess: true,
      canEdit: true,
    }),
    ...overrides.pagePermissionRepo,
  };
  const spaceAbility = {
    createForUser: jest.fn().mockResolvedValue({
      can: jest.fn().mockReturnValue(true),
    }),
    ...overrides.spaceAbility,
  };
  const service = new AgentAccessService(
    apiKeyRepo as any,
    pagePermissionRepo as any,
    spaceAbility as any,
  );
  return { service, apiKeyRepo, pagePermissionRepo, spaceAbility };
}

describe('AgentAccessService', () => {
  it('keeps the human own edit right on an unrestricted page', async () => {
    const { service, pagePermissionRepo } = subject();

    await expect(
      service.assertPageReadable(context, page, user),
    ).resolves.toEqual({ canEdit: true, hasRestriction: false });
    expect(pagePermissionRepo.canUserEditPage).toHaveBeenCalledWith(
      'human-1',
      'page-1',
    );
  });

  it('reports no edit right when the human is not a member of the bound space', async () => {
    const { service } = subject({
      spaceAbility: {
        createForUser: jest
          .fn()
          .mockRejectedValue(new Error('Space permissions not found')),
      },
    });

    await expect(
      service.assertPageReadable(context, page, user),
    ).resolves.toEqual({ canEdit: false, hasRestriction: false });
  });

  it('reports no edit right when the human is only a reader', async () => {
    const { service } = subject({
      spaceAbility: {
        createForUser: jest.fn().mockResolvedValue({
          can: jest.fn().mockReturnValue(false),
        }),
      },
    });

    await expect(
      service.assertPageReadable(context, page, user),
    ).resolves.toEqual({ canEdit: false, hasRestriction: false });
  });

  it('uses the scope resolved at authentication instead of re-querying', async () => {
    const { service, apiKeyRepo } = subject();

    await expect(
      service.getBoundSpaceIds({ ...context, spaceIds: ['sp-9'] }),
    ).resolves.toEqual(['sp-9']);
    expect(apiKeyRepo.findSpaceIdsByApiKeyId).not.toHaveBeenCalled();
  });

  it('rejects a space outside the key scope', async () => {
    const { service } = subject();

    await expect(
      service.assertPageReadable({ ...context, spaceIds: [] }, page, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('falls back to the repo when the context carries no scope', async () => {
    const { service, apiKeyRepo } = subject();

    await expect(
      service.getBoundSpaceIds({
        ...context,
        spaceIds: undefined as never,
      }),
    ).resolves.toEqual(['sp-1']);
    expect(apiKeyRepo.findSpaceIdsByApiKeyId).toHaveBeenCalledWith('key-1');
  });

  it('allows a restricted page the human has its own grant for', async () => {
    const { service } = subject({
      pagePermissionRepo: {
        canUserEditPage: jest.fn().mockResolvedValue({
          hasAnyRestriction: true,
          canAccess: true,
          canEdit: true,
        }),
      },
    });

    await expect(
      service.assertPageReadable(context, page, user),
    ).resolves.toEqual({ canEdit: true, hasRestriction: true });
  });

  it('honours the page-level grant on a restricted page, not the space role', async () => {
    const { service, spaceAbility } = subject({
      pagePermissionRepo: {
        canUserEditPage: jest.fn().mockResolvedValue({
          hasAnyRestriction: true,
          canAccess: true,
          canEdit: false,
        }),
      },
    });

    await expect(
      service.assertPageReadable(context, page, user),
    ).resolves.toEqual({ canEdit: false, hasRestriction: true });
    expect(spaceAbility.createForUser).not.toHaveBeenCalled();
  });

  it('rejects a restricted page the human cannot access, even in a bound space', async () => {
    const { service } = subject({
      pagePermissionRepo: {
        canUserEditPage: jest.fn().mockResolvedValue({
          hasAnyRestriction: true,
          canAccess: false,
          canEdit: false,
        }),
      },
    });

    await expect(
      service.assertPageReadable(context, page, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a page from another workspace and a deleted page', async () => {
    const { service, apiKeyRepo } = subject();

    await expect(
      service.assertPageReadable(
        context,
        { ...page, workspaceId: 'ws-other' },
        user,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.assertPageReadable(
        context,
        { ...page, deletedAt: new Date() },
        user,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(apiKeyRepo.findSpaceIdsByApiKeyId).not.toHaveBeenCalled();
  });
});
