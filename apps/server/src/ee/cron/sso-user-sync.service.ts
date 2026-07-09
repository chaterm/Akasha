import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import { request } from 'undici';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { HoidcService, HoidcProviderConfig } from '../sso/hoidc.service';

type SsoUserListItem = {
  email?: string;
  name?: string | null;
  avatar?: string | null;
};

export type SsoUserSyncResult = {
  fetched: number;
  synced: number;
  skipped: number;
  failed: number;
};

@Injectable()
export class SsoUserSyncService {
  private readonly logger = new Logger(SsoUserSyncService.name);

  constructor(
    private readonly environmentService: EnvironmentService,
    private readonly hoidcService: HoidcService,
  ) {}

  @Cron('0 0 2 * * *', { name: 'sso-user-sync' })
  async handleScheduledSync(): Promise<void> {
    const result = await this.syncAllUsers();
    this.logger.log(
      `SSO user sync completed: fetched=${result.fetched}, synced=${result.synced}, skipped=${result.skipped}, failed=${result.failed}`,
    );
  }

  async syncAllUsers(): Promise<SsoUserSyncResult> {
    const config = this.getSyncConfig();
    if (!config) {
      this.logger.warn('SSO user sync skipped: personnel list config missing');
      return { fetched: 0, synced: 0, skipped: 0, failed: 0 };
    }

    const users = await this.fetchAllUsers(config);
    const result: SsoUserSyncResult = {
      fetched: users.length,
      synced: 0,
      skipped: 0,
      failed: 0,
    };

    for (const user of users) {
      const email = user.email?.trim();
      if (!email) {
        result.skipped += 1;
        continue;
      }

      try {
        await this.hoidcService.provisionSsoUser({
          config: {
            ssoApi: config.ssoApi,
            platformId: config.platformId,
            workspaceId: config.workspaceId,
            allowSignup: config.allowSignup,
          },
          info: {
            email,
            name: user.name ?? null,
            avatar: user.avatar ?? null,
          },
          updateProfile: true,
        });
        result.synced += 1;
      } catch (err) {
        result.failed += 1;
        this.logger.error(
          `Failed to sync SSO user ${email}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return result;
  }

  private getSyncConfig():
    | (HoidcProviderConfig & {
        secret: string;
      })
    | null {
    const ssoApi = this.environmentService.getSsoUserListApiUrl().trim();
    const platformId = this.environmentService
      .getSsoUserListPlatformId()
      .trim();
    const secret = this.environmentService.getSsoUserListSecret().trim();
    const workspaceId = this.environmentService.getHoidcWorkspaceId().trim();

    if (!ssoApi || !platformId || !secret || !workspaceId) {
      return null;
    }

    return {
      ssoApi: ssoApi.replace(/\/+$/, ''),
      platformId,
      secret,
      workspaceId,
      allowSignup: this.environmentService.isHoidcAllowSignup(),
    };
  }

  private async fetchAllUsers(
    config: HoidcProviderConfig & { secret: string },
  ): Promise<SsoUserListItem[]> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHash('md5')
      .update(`${timestamp}_${config.secret}`)
      .digest('hex');
    const params = new URLSearchParams({
      signature,
      timestamp,
      platform_id: config.platformId,
    });

    const { statusCode, body } = await request(
      `${config.ssoApi}/open-api/user/get-all?${params.toString()}`,
      {
        method: 'POST',
        body: '',
      },
    );

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`SSO get-all failed: HTTP ${statusCode}`);
    }

    const json = (await body.json()) as {
      code?: number;
      msg?: string;
      data?: unknown;
    };
    if (json.code !== 0 || !Array.isArray(json.data)) {
      throw new Error(
        `SSO get-all failed: ${json.msg ?? `code=${json.code}`}`,
      );
    }

    return json.data as SsoUserListItem[];
  }
}
