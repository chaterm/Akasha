import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { AuthProvider, User } from '@docmost/db/types/entity.types';
import { SessionService } from '../../core/session/session.service';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { request } from 'undici';
import { SpaceService } from '../../core/space/services/space.service';
import { WorkspaceService } from '../../core/workspace/services/workspace.service';
import { GroupUserRepo } from '@docmost/db/repos/group/group-user.repo';
import { executeTx } from '@docmost/db/utils';

@Injectable()
export class HoidcService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly userRepo: UserRepo,
    private readonly sessionService: SessionService,
    private readonly spaceService: SpaceService,
    private readonly workspaceService: WorkspaceService,
    private readonly groupUserRepo: GroupUserRepo,
  ) {}

  /**
   * 纯逻辑 helper（可单元测试，无 DB/网络依赖）
   * 构建 SSO 登录页跳转 URL
   */
  buildLoginUrl(opts: {
    loginPage: string;
    platformId: string;
    callbackUrl: string;
  }): string {
    const { loginPage, platformId, callbackUrl } = opts;
    return `${loginPage}?platform_id=${platformId}&redirect=${encodeURIComponent(callbackUrl)}`;
  }

  /**
   * 纯逻辑 helper（可单元测试，无 DB/网络依赖）
   * 从 SSO verify-access-token 响应中解析用户信息
   */
  parseUserInfo(resp: any): {
    email: string;
    name: string | null;
    avatar: string | null;
  } {
    const email = resp?.data?.email;
    if (!email) {
      throw new UnauthorizedException('SSO response missing email');
    }
    const name: string | null = resp?.data?.name ?? null;
    const avatar: string | null = resp?.data?.avatar ?? null;
    return { email, name, avatar };
  }

  /**
   * 从 DB 查询 HOIDC provider
   */
  async getProvider(providerId: string): Promise<AuthProvider> {
    const provider = await this.db
      .selectFrom('authProviders')
      .selectAll()
      .where('id', '=', providerId)
      .where('type', '=', 'hoidc')
      .where('isEnabled', '=', true)
      .executeTakeFirst();

    if (!provider) {
      throw new BadRequestException(
        `HOIDC provider not found or disabled: ${providerId}`,
      );
    }
    return provider;
  }

  /**
   * 用 token 向 SSO API 换取用户信息
   */
  async verifyToken(
    provider: AuthProvider,
    token: string,
  ): Promise<{ email: string; name: string | null; avatar: string | null }> {
    const url = `${provider.oidcIssuer}/auth/verify-access-token?token=${encodeURIComponent(token)}`;
    const body = { platform_id: provider.oidcClientId };

    const { statusCode, body: responseBody } = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Token': token,
      },
      body: JSON.stringify(body),
    });

    if (statusCode < 200 || statusCode >= 300) {
      await responseBody.text(); // 消费掉 body 避免 leak
      throw new UnauthorizedException(
        `HOIDC verify-access-token failed: HTTP ${statusCode}`,
      );
    }

    const json = (await responseBody.json()) as any;
    return this.parseUserInfo(json);
  }

  /**
   * 按 email + workspaceId 查/建用户，创建会话，返回 authToken
   */
  async loginUser(opts: {
    provider: AuthProvider;
    info: { email: string; name: string | null; avatar: string | null };
    workspaceId: string;
  }): Promise<string> {
    const { provider, info, workspaceId } = opts;

    let user: User = await this.userRepo.findByEmail(info.email, workspaceId);

    if (!user) {
      if (!provider.allowSignup) {
        throw new UnauthorizedException(
          'User not found and signup is not allowed for this SSO provider',
        );
      }

      // 直接插入，不走 insertUser（避免 hashPassword(undefined) 问题）
      user = await executeTx(this.db, async (trx) => {
        const newUser = await trx
          .insertInto('users')
          .values({
            email: info.email.toLowerCase(),
            name: info.name ?? info.email.split('@')[0].toLowerCase(),
            avatarUrl: info.avatar ?? null,
            workspaceId,
            role: 'member',
            emailVerifiedAt: new Date(),
            lastLoginAt: new Date(),
            locale: 'zh-CN',
          })
          .returning([
            'id',
            'email',
            'name',
            'emailVerifiedAt',
            'avatarUrl',
            'role',
            'workspaceId',
            'locale',
            'timezone',
            'settings',
            'lastLoginAt',
            'lastActiveAt',
            'deactivatedAt',
            'createdAt',
            'updatedAt',
            'deletedAt',
            'hasGeneratedPassword',
            'invitedById',
            'password',
            'scimExternalId',
          ])
          .executeTakeFirst();

        await this.workspaceService.addUserToWorkspace(
          newUser.id,
          workspaceId,
          undefined,
          trx,
        );

        return newUser;
      });

      // 加入 Everyone 组（在 ensurePersonalSpace 之前加入会导致 getUserSpaceIds 误判）
      // 所以先创建个人空间，再加入组
      await this.spaceService.ensurePersonalSpace(user, workspaceId);
      await this.groupUserRepo.addUserToDefaultGroup(user.id, workspaceId);

      return this.sessionService.createSessionAndToken(user);
    }

    await this.spaceService.ensurePersonalSpace(user, workspaceId);
    return this.sessionService.createSessionAndToken(user);
  }
}
