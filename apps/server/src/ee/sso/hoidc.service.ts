import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { User } from '@docmost/db/types/entity.types';
import { SessionService } from '../../core/session/session.service';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { request } from 'undici';
import { SpaceService } from '../../core/space/services/space.service';
import { WorkspaceService } from '../../core/workspace/services/workspace.service';
import { GroupUserRepo } from '@docmost/db/repos/group/group-user.repo';
import { executeTx } from '@docmost/db/utils';

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
    const { config, info } = opts;
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

        return newUser;
      });

      await this.spaceService.ensurePersonalSpace(user, workspaceId);
      await this.groupUserRepo.addUserToDefaultGroup(user.id, workspaceId);

      return this.sessionService.createSessionAndToken(user);
    }

    await this.spaceService.ensurePersonalSpace(user, workspaceId);
    return this.sessionService.createSessionAndToken(user);
  }
}
