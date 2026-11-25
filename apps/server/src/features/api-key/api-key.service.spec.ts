import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeyType } from '../../common/auth/api-key-type';
import { UserType } from '../../common/auth/user-type';
import { UserRole } from '../../common/helpers/types/permission';
import { ApiKeyService } from './api-key.service';

describe('ApiKeyService', () => {
  const makeService = (overrides: Record<string, any> = {}) => {
    const apiKeyRepo = {
      findById: jest.fn(),
      updateLastUsed: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((work) => work({})),
      findActiveAgentByName: jest.fn().mockResolvedValue(undefined),
      create: jest.fn(),
      findSpaceIdsByApiKeyId: jest.fn().mockResolvedValue([]),
      ...overrides.apiKeyRepo,
    };
    const tokenService = {
      verifyJwt: jest.fn(),
      generateApiToken: jest.fn(),
      ...overrides.tokenService,
    };
    const userRepo = {
      findById: jest.fn(),
      findWorkspaceOwner: jest.fn(),
      ...overrides.userRepo,
    };
    const workspaceRepo = {
      findById: jest.fn().mockResolvedValue({ id: 'workspace-1' }),
      ...overrides.workspaceRepo,
    };
    const spaceRepo = {
      findPersonalSpaceForUser: jest.fn(),
      ...overrides.spaceRepo,
    };
    const agentUserService = {
      create: jest.fn(),
      requireActive: jest.fn(),
      rename: jest.fn(),
      softDelete: jest.fn(),
      ...overrides.agentUserService,
    };
    const spaceMemberRepo = {
      removeAllDirectMembershipsForUser: jest.fn(),
      ...overrides.spaceMemberRepo,
    };
    return {
      apiKeyRepo,
      tokenService,
      userRepo,
      agentUserService,
      service: new ApiKeyService(
        apiKeyRepo as any,
        tokenService as any,
        userRepo as any,
        workspaceRepo as any,
        spaceRepo as any,
        agentUserService as any,
        spaceMemberRepo as any,
        { log: jest.fn() } as any,
      ),
    };
  };

  it('拒绝用个人密钥认证 HTTP 请求，个人密钥只能用于 MCP', async () => {
    const { service, apiKeyRepo, userRepo } = makeService({
      spaceRepo: {
        findPersonalSpaceForUser: jest
          .fn()
          .mockResolvedValue({ id: 'personal-1' }),
      },
    });
    apiKeyRepo.findById.mockResolvedValue({
      id: 'key-1',
      keyType: ApiKeyType.PERSONAL,
      expiresAt: null,
    });

    await expect(
      service.validateApiKey({
        sub: 'user-1',
        workspaceId: 'workspace-1',
        apiKeyId: 'key-1',
        type: 'api_key',
      }),
    ).rejects.toThrow('Personal API keys are only valid for the MCP endpoint');
    expect(userRepo.findById).not.toHaveBeenCalled();
  });

  const creatorSubject = () => {
    const made = makeService();
    made.userRepo.findById.mockResolvedValue({
      id: 'user-1',
      workspaceId: 'workspace-1',
      userType: UserType.NORMAL,
      role: UserRole.MEMBER,
      deletedAt: null,
      deactivatedAt: null,
    });
    made.apiKeyRepo.create.mockImplementation(async (data: any) => ({
      id: 'key-1',
      ...data,
    }));
    made.tokenService.generateApiToken.mockResolvedValue('token-1');
    return made;
  };

  it('创建个人密钥时满足 agent 字段的 CHECK 约束', async () => {
    const { service, apiKeyRepo, tokenService } = creatorSubject();

    const created = await service.createApiKey({
      name: 'k',
      expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      creatorId: 'user-1',
      workspaceId: 'workspace-1',
    });

    expect(created.token).toBe('token-1');
    expect(apiKeyRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        keyType: ApiKeyType.PERSONAL,
        agentUserId: null,
        credentialVersion: null,
      }),
    );
    expect(tokenService.generateApiToken).toHaveBeenCalledWith(
      expect.not.objectContaining({ credentialVersion: expect.anything() }),
    );
  });

  it('允许创建永不过期的个人密钥', async () => {
    const { service, apiKeyRepo, tokenService } = creatorSubject();

    await service.createApiKey({
      name: 'k',
      creatorId: 'user-1',
      workspaceId: 'workspace-1',
    });

    expect(apiKeyRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: null }),
    );
    expect(tokenService.generateApiToken).toHaveBeenCalledWith(
      expect.objectContaining({ expiresIn: undefined }),
    );
  });

  it('拒绝已经过去的过期时间', async () => {
    const { service } = creatorSubject();

    await expect(
      service.createApiKey({
        name: 'k',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        creatorId: 'user-1',
        workspaceId: 'workspace-1',
      }),
    ).rejects.toThrow('Expiration date must be in the future');
  });

  it('拒绝用智能体密钥作为 Bearer 凭证认证请求', async () => {
    const { service, apiKeyRepo } = makeService();
    apiKeyRepo.findById.mockResolvedValue({
      id: 'agent-key-1',
      keyType: ApiKeyType.AGENT,
      agentUserId: 'agent-user-1',
      credentialVersion: '2000',
    });

    await expect(
      service.validateApiKey({
        sub: 'agent-user-1',
        workspaceId: 'workspace-1',
        apiKeyId: 'agent-key-1',
        credentialVersion: 2000,
        type: 'api_key',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('以范围凭证解析智能体密钥并拒绝轮换前的旧值', async () => {
    const { service, apiKeyRepo, userRepo, tokenService } = makeService({
      apiKeyRepo: {
        findSpaceIdsByApiKeyId: jest.fn().mockResolvedValue(['space-1']),
      },
    });
    apiKeyRepo.findById.mockResolvedValue({
      id: 'agent-key-1',
      keyType: ApiKeyType.AGENT,
      agentUserId: 'agent-user-1',
      credentialVersion: '2000',
    });
    userRepo.findById.mockResolvedValue({
      id: 'agent-user-1',
      workspaceId: 'workspace-1',
      userType: UserType.AGENT,
      deletedAt: null,
      deactivatedAt: null,
    });

    tokenService.verifyJwt.mockResolvedValue({
      sub: 'agent-user-1',
      workspaceId: 'workspace-1',
      apiKeyId: 'agent-key-1',
      credentialVersion: 1000,
      type: 'api_key',
    });
    await expect(
      service.validateAgentApiKeyScope('token', 'workspace-1'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    tokenService.verifyJwt.mockResolvedValue({
      sub: 'agent-user-1',
      workspaceId: 'workspace-1',
      apiKeyId: 'agent-key-1',
      credentialVersion: 2000,
      type: 'api_key',
    });
    const scope = await service.validateAgentApiKeyScope(
      'token',
      'workspace-1',
    );
    expect(scope).toEqual({
      apiKeyId: 'agent-key-1',
      credentialVersion: 2000,
      agentUser: expect.objectContaining({ id: 'agent-user-1' }),
      workspace: { id: 'workspace-1' },
      spaceIds: ['space-1'],
    });
  });

  it('拒绝把个人密钥当作范围凭证', async () => {
    const { service, apiKeyRepo, tokenService } = makeService();
    tokenService.verifyJwt.mockResolvedValue({
      sub: 'user-1',
      workspaceId: 'workspace-1',
      apiKeyId: 'personal-key-1',
      type: 'api_key',
    });
    apiKeyRepo.findById.mockResolvedValue({
      id: 'personal-key-1',
      keyType: ApiKeyType.PERSONAL,
      agentUserId: null,
    });

    await expect(
      service.validateAgentApiKeyScope('token', 'workspace-1'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('由工作区所有者创建永久且初始无空间的智能体密钥', async () => {
    const { service, userRepo, agentUserService, apiKeyRepo, tokenService } =
      makeService();
    userRepo.findById.mockResolvedValue({
      id: 'owner-1',
      role: UserRole.OWNER,
      userType: UserType.NORMAL,
      deletedAt: null,
      deactivatedAt: null,
    });
    agentUserService.create.mockResolvedValue({
      id: 'agent-user-1',
      userType: UserType.AGENT,
    });
    apiKeyRepo.create.mockImplementation(async (value) => ({
      id: 'agent-key-1',
      ...value,
    }));
    tokenService.generateApiToken.mockResolvedValue('agent-token');

    const result = await service.createPublicApiKey({
      name: '检索智能体',
      creatorId: 'owner-1',
      workspaceId: 'workspace-1',
    });
    expect(result).toEqual(
      expect.objectContaining({
        id: 'agent-key-1',
        token: 'agent-token',
        spaces: [],
      }),
    );
    expect(apiKeyRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        keyType: ApiKeyType.AGENT,
        expiresAt: null,
        agentUserId: 'agent-user-1',
      }),
      expect.anything(),
    );
  });

  it('平台间接口自动解析工作区所有者并用 agent_id 作为邮箱标识', async () => {
    const { service, userRepo, agentUserService, apiKeyRepo, tokenService } =
      makeService();
    userRepo.findWorkspaceOwner.mockResolvedValue({
      id: 'owner-1',
      name: '所有者',
      email: 'owner@akasha.net',
    });
    agentUserService.create.mockResolvedValue({
      id: 'agent-user-1',
      userType: UserType.AGENT,
    });
    apiKeyRepo.create.mockImplementation(async (value) => ({
      id: 'agent-key-1',
      ...value,
    }));
    tokenService.generateApiToken.mockResolvedValue('agent-token');

    const result = await service.createAgentApiKeyForPlatform({
      agentId: 'ext-agent-42',
      name: '外部智能体',
      workspaceId: 'workspace-1',
    });

    expect(userRepo.findWorkspaceOwner).toHaveBeenCalledWith('workspace-1');
    expect(agentUserService.create).toHaveBeenCalledWith(
      '外部智能体',
      'workspace-1',
      expect.anything(),
      'ext-agent-42',
    );
    expect(result).toEqual(
      expect.objectContaining({
        id: 'agent-key-1',
        token: 'agent-token',
        spaces: [],
        creator: expect.objectContaining({ id: 'owner-1' }),
      }),
    );
  });

  it('平台间接口在找不到工作区所有者时抛出 NotFound', async () => {
    const { service, userRepo } = makeService();
    userRepo.findWorkspaceOwner.mockResolvedValue(undefined);

    await expect(
      service.createAgentApiKeyForPlatform({
        agentId: 'ext-agent-42',
        name: '外部智能体',
        workspaceId: 'workspace-1',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('owner 可按 apiKeyId 重绑 agent 空间(内部/设置页路径)', async () => {
    const { service, userRepo, apiKeyRepo } = makeService({
      apiKeyRepo: {
        findByIdForUpdate: jest.fn().mockResolvedValue({
          id: 'agent-key-1',
          keyType: ApiKeyType.AGENT,
          agentUserId: 'agent-user-1',
        }),
        findBindableSpaceIds: jest
          .fn()
          .mockResolvedValue(['space-1', 'space-2']),
        replaceAgentSpaceBindings: jest.fn().mockResolvedValue(undefined),
        findBoundSpaces: jest.fn().mockResolvedValue([
          { id: 'space-1', name: 'A' },
          { id: 'space-2', name: 'B' },
        ]),
      },
    });
    userRepo.findById.mockResolvedValue({
      id: 'owner-1',
      role: UserRole.OWNER,
      userType: UserType.NORMAL,
      deletedAt: null,
      deactivatedAt: null,
    });

    const result = await service.updateAgentSpaces({
      apiKeyId: 'agent-key-1',
      userId: 'owner-1',
      workspaceId: 'workspace-1',
      spaceIds: ['space-1', 'space-2'],
    });

    expect(apiKeyRepo.replaceAgentSpaceBindings).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeyId: 'agent-key-1',
        agentUserId: 'agent-user-1',
        spaceIds: ['space-1', 'space-2'],
      }),
      expect.anything(),
    );
    expect(result).toEqual({
      spaces: [
        { id: 'space-1', name: 'A' },
        { id: 'space-2', name: 'B' },
      ],
    });
  });

  it('个人空间可以绑定', async () => {
    const { service, userRepo, apiKeyRepo } = makeService({
      apiKeyRepo: {
        findByIdForUpdate: jest.fn().mockResolvedValue({
          id: 'agent-key-1',
          keyType: ApiKeyType.AGENT,
          agentUserId: 'agent-user-1',
        }),
        findBindableSpaceIds: jest.fn().mockResolvedValue(['personal-1']),
        replaceAgentSpaceBindings: jest.fn().mockResolvedValue(undefined),
        findBoundSpaces: jest
          .fn()
          .mockResolvedValue([{ id: 'personal-1', name: '吴静(wu@x.com)' }]),
      },
    });
    userRepo.findById.mockResolvedValue({
      id: 'owner-1',
      role: UserRole.OWNER,
      userType: UserType.NORMAL,
      deletedAt: null,
      deactivatedAt: null,
    });

    const result = await service.updateAgentSpaces({
      apiKeyId: 'agent-key-1',
      userId: 'owner-1',
      workspaceId: 'workspace-1',
      spaceIds: ['personal-1'],
    });

    expect(apiKeyRepo.replaceAgentSpaceBindings).toHaveBeenCalledWith(
      expect.objectContaining({ spaceIds: ['personal-1'] }),
      expect.anything(),
    );
    expect(result.spaces).toEqual([
      { id: 'personal-1', name: '吴静(wu@x.com)' },
    ]);
  });

  it('非 owner 调用 updateAgentSpaces 被拒', async () => {
    const { service, userRepo } = makeService();
    userRepo.findById.mockResolvedValue({
      id: 'member-1',
      role: UserRole.MEMBER,
      userType: UserType.NORMAL,
      deletedAt: null,
      deactivatedAt: null,
    });

    await expect(
      service.updateAgentSpaces({
        apiKeyId: 'agent-key-1',
        userId: 'member-1',
        workspaceId: 'workspace-1',
        spaceIds: ['space-1'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
