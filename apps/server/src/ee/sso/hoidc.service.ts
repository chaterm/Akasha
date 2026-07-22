import { Injectable, UnauthorizedException } from '@nestjs/common';
import { User } from '@akasha/db/types/entity.types';
import { SessionService } from '../../core/session/session.service';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import { request } from 'undici';
import { SpaceService } from '../../core/space/services/space.service';
import { WorkspaceService } from '../../core/workspace/services/workspace.service';
import { GroupUserRepo } from '@akasha/db/repos/group/group-user.repo';
import { executeTx } from '@akasha/db/utils';

export interface HoidcProviderConfig {
  ssoApi: string;
  platformId: string;
  workspaceId: string;
  allowSignup: boolean;
}

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

  buildLoginUrl(opts: {
    loginPage: string;
    platformId: string;
    callbackUrl: string;
  }): string {
    const { loginPage, platformId, callbackUrl } = opts;
    return `${loginPage}?platform_id=${platformId}&redirect=${encodeURIComponent(callbackUrl)}`;
  }

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

  async verifyToken(
    config: HoidcProviderConfig,
    token: string,
  ): Promise<{ email: string; name: string | null; avatar: string | null }> {
    const url = `${config.ssoApi}/auth/verify-access-token?token=${encodeURIComponent(token)}`;
    const body = { platform_id: config.platformId };

    const { statusCode, body: responseBody } = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Token': token,
      },
      body: JSON.stringify(body),
    });

    if (statusCode < 200 || statusCode >= 300) {
      await responseBody.text();
      throw new UnauthorizedException(
        `HOIDC verify-access-token failed: HTTP ${statusCode}`,
      );
    }

    const json = (await responseBody.json()) as any;
    return this.parseUserInfo(json);
  }

  async loginUser(opts: {
    config: HoidcProviderConfig;
    info: { email: string; name: string | null; avatar: string | null };
  }): Promise<string> {
    const user = await this.provisionSsoUser({
      ...opts,
      updateProfile: true,
    });

    return this.sessionService.createSessionAndToken(user);
  }

  async provisionSsoUser(opts: {
    config: HoidcProviderConfig;
    info: { email: string; name: string | null; avatar: string | null };
    updateProfile?: boolean;
  }): Promise<User> {
    const { config, info, updateProfile = false } = opts;
    const { workspaceId } = config;
    let user: User = await this.userRepo.findByEmail(info.email, workspaceId);

    if (!user) {
      if (!config.allowSignup) {
        throw new UnauthorizedException(
          'User not found and signup is not allowed for this SSO provider',
        );
      }

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
        await this.groupUserRepo.addUserToDefaultGroup(
          newUser.id,
          workspaceId,
          trx,
        );
        await this.spaceService.ensurePersonalSpace(newUser, workspaceId, trx);

        return newUser;
      });

      return user;
    }

    if (updateProfile) {
      const profileUpdate: { name?: string; avatarUrl?: string | null } = {};
      if (info.name !== null && info.name !== user.name) {
        profileUpdate.name = info.name;
      }
      if (info.avatar !== null && info.avatar !== user.avatarUrl) {
        profileUpdate.avatarUrl = info.avatar;
      }

      if (Object.keys(profileUpdate).length > 0) {
        await this.userRepo.updateUser(profileUpdate, user.id, workspaceId);
        user = await this.userRepo.findByEmail(info.email, workspaceId);
      }
    }

    await this.groupUserRepo.addUserToDefaultGroup(user.id, workspaceId);
    await this.spaceService.ensurePersonalSpace(user, workspaceId);
    return user;
  }
}
