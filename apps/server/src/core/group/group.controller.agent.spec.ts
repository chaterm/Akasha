import { ForbiddenException } from '@nestjs/common';
import { GroupController } from './group.controller';
import { UserRole } from '../../common/helpers/types/permission';

const workspace = { id: 'ws-1' } as any;
const user = { id: 'agent-user-1', role: UserRole.MEMBER } as any;
const agentAccess = { apiKeyId: 'key-1', spaceIds: ['sp-1'] } as any;

const subject = (granted: boolean) => {
  const groupUserService = {
    getGroupUsers: jest.fn().mockResolvedValue({ items: [], meta: {} }),
  };
  const groupUserRepo = {
    hasGrantInSpaces: jest.fn().mockResolvedValue(granted),
  };
  const agentAccessService = {
    getBoundSpaceIds: jest.fn().mockResolvedValue(['sp-1']),
  };
  const controller = new GroupController(
    {} as any,
    groupUserService as any,
    { createForUser: () => ({ cannot: () => false }) } as any,
    agentAccessService as any,
    groupUserRepo as any,
  );
  return { controller, groupUserService, groupUserRepo, agentAccessService };
};

describe('GroupController.getGroupMembers agent scope', () => {
  it('allows a group that holds a grant in a bound space', async () => {
    const { controller, groupUserService, groupUserRepo } = subject(true);

    await controller.getGroupMembers(
      { groupId: 'group-1' } as any,
      { limit: 20 } as any,
      user,
      workspace,
      agentAccess,
    );

    expect(groupUserRepo.hasGrantInSpaces).toHaveBeenCalledWith('group-1', [
      'sp-1',
    ]);
    expect(groupUserService.getGroupUsers).toHaveBeenCalledWith(
      'group-1',
      'ws-1',
      { limit: 20 },
    );
  });

  it('refuses a group with no grant in any bound space', async () => {
    const { controller, groupUserService } = subject(false);

    await expect(
      controller.getGroupMembers(
        { groupId: 'group-1' } as any,
        { limit: 20 } as any,
        user,
        workspace,
        agentAccess,
      ),
    ).rejects.toThrow(
      'Group has no grant in any space bound to the Agent API key',
    );
    expect(groupUserService.getGroupUsers).not.toHaveBeenCalled();
  });

  it('skips the grant check without an agent key', async () => {
    const { controller, groupUserService, groupUserRepo } = subject(false);

    await controller.getGroupMembers(
      { groupId: 'group-1' } as any,
      { limit: 20 } as any,
      { id: 'u1', role: UserRole.ADMIN } as any,
      workspace,
    );

    expect(groupUserRepo.hasGrantInSpaces).not.toHaveBeenCalled();
    expect(groupUserService.getGroupUsers).toHaveBeenCalled();
  });

  it('fails closed when the agent services are unavailable', async () => {
    const groupUserService = { getGroupUsers: jest.fn() };
    const controller = new GroupController(
      {} as any,
      groupUserService as any,
      { createForUser: () => ({ cannot: () => false }) } as any,
    );

    await expect(
      controller.getGroupMembers(
        { groupId: 'group-1' } as any,
        { limit: 20 } as any,
        user,
        workspace,
        agentAccess,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(groupUserService.getGroupUsers).not.toHaveBeenCalled();
  });
});
