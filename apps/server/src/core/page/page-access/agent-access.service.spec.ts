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
  const pageAccessService = {
    validateCanViewWithPermissions: jest
      .fn()
      .mockResolvedValue({ canEdit: true, hasRestriction: false }),
    validateCanEdit: jest.fn().mockResolvedValue({ hasRestriction: false }),
    ...overrides.pageAccessService,
  };
  const service = new AgentAccessService(
    apiKeyRepo as any,
    pageAccessService as any,
  );
  return { service, apiKeyRepo, pageAccessService };
}

describe('AgentAccessService', () => {
  it('narrows to the key scope, then defers to the caller own permission', async () => {
    const { service, pageAccessService } = subject();

    await expect(
      service.assertPageReadable(context, page, user),
    ).resolves.toEqual({ canEdit: true, hasRestriction: false });
    expect(
      pageAccessService.validateCanViewWithPermissions,
    ).toHaveBeenCalledWith(page, user);
  });

  it('rejects a space outside the key scope before checking the caller', async () => {
    const { service, pageAccessService } = subject();

    await expect(
      service.assertPageReadable({ ...context, spaceIds: [] }, page, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      pageAccessService.validateCanViewWithPermissions,
    ).not.toHaveBeenCalled();
  });

  it('propagates the rejection when the caller cannot view a bound page', async () => {
    const { service } = subject({
      pageAccessService: {
        validateCanViewWithPermissions: jest
          .fn()
          .mockRejectedValue(new ForbiddenException()),
      },
    });

    await expect(
      service.assertPageReadable(context, page, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('writes a bound page through the caller own edit permission', async () => {
    const { service, pageAccessService } = subject();

    await expect(
      service.assertPageWritable(context, page, user),
    ).resolves.toEqual({ hasRestriction: false });
    expect(pageAccessService.validateCanEdit).toHaveBeenCalledWith(page, user);
  });

  it('rejects a write to a space outside the key scope', async () => {
    const { service, pageAccessService } = subject();

    await expect(
      service.assertPageWritable({ ...context, spaceIds: [] }, page, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(pageAccessService.validateCanEdit).not.toHaveBeenCalled();
  });

  it('propagates the rejection when the caller cannot edit a bound page', async () => {
    const { service } = subject({
      pageAccessService: {
        validateCanEdit: jest.fn().mockRejectedValue(new ForbiddenException()),
      },
    });

    await expect(
      service.assertPageWritable(context, page, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('checks the parent page is writable when creating below it', async () => {
    const { service, pageAccessService } = subject();

    await expect(
      service.assertCanCreate(context, 'sp-1', user, page),
    ).resolves.toBeUndefined();
    expect(pageAccessService.validateCanEdit).toHaveBeenCalledWith(page, user);
  });

  it('rejects creating in a space outside the key scope', async () => {
    const { service } = subject();

    await expect(
      service.assertCanCreate(context, 'sp-other', user),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a parent page from a different space', async () => {
    const { service } = subject();

    await expect(
      service.assertCanCreate(context, 'sp-1', user, {
        ...page,
        spaceId: 'sp-2',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('keeps the caller own edit right on a bound page', async () => {
    const { service } = subject({
      pageAccessService: {
        validateCanViewWithPermissions: jest
          .fn()
          .mockResolvedValue({ canEdit: true, hasRestriction: true }),
      },
    });

    await expect(
      service.assertPageReadable(context, page, user),
    ).resolves.toEqual({ canEdit: true, hasRestriction: true });
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

  it('uses the scope resolved at authentication instead of re-querying', async () => {
    const { service, apiKeyRepo } = subject();

    await expect(
      service.getBoundSpaceIds({ ...context, spaceIds: ['sp-9'] }),
    ).resolves.toEqual(['sp-9']);
    expect(apiKeyRepo.findSpaceIdsByApiKeyId).not.toHaveBeenCalled();
  });

  it('falls back to the repo when the context carries no scope', async () => {
    const { service, apiKeyRepo } = subject();

    await expect(
      service.getBoundSpaceIds({ ...context, spaceIds: undefined as never }),
    ).resolves.toEqual(['sp-1']);
    expect(apiKeyRepo.findSpaceIdsByApiKeyId).toHaveBeenCalledWith('key-1');
  });
});
