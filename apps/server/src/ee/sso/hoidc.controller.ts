import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { HoidcService, HoidcProviderConfig } from './hoidc.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { WorkspaceRepo } from '@akasha/db/repos/workspace/workspace.repo';

@Controller('sso/hoidc')
export class HoidcController {
  constructor(
    private readonly hoidcService: HoidcService,
    private readonly environmentService: EnvironmentService,
    private readonly workspaceRepo: WorkspaceRepo,
  ) {}

  private async getProviderConfig(): Promise<HoidcProviderConfig> {
    const ssoApi = this.environmentService.getHoidcSsoApi();
    const platformId = this.environmentService.getHoidcPlatformId();

    if (!ssoApi || !platformId) {
      throw new BadRequestException(
        'HOIDC is not fully configured. Required: HOIDC_SSO_API, HOIDC_PLATFORM_ID',
      );
    }

    const workspace = await this.workspaceRepo.findFirst();
    if (!workspace) {
      throw new BadRequestException('Workspace is not initialized');
    }

    return {
      ssoApi,
      platformId,
      workspaceId: workspace.id,
      allowSignup: this.environmentService.isHoidcAllowSignup(),
    };
  }

  /**
   * GET /api/sso/hoidc/login
   * 302 跳转到 SSO 登录页
   */
  @Get('login')
  async login(
    @Query('redirect') redirect: string | undefined,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const config = await this.getProviderConfig();

    const loginPage = this.environmentService.getHoidcLoginPage();
    if (!loginPage) {
      throw new BadRequestException('HOIDC_LOGIN_PAGE is not configured');
    }

    const appUrl = this.environmentService.getAppUrl();
    let callbackUrl = `${appUrl}/api/sso/hoidc/callback`;
    if (redirect) {
      callbackUrl += `?redirect=${encodeURIComponent(redirect)}`;
    }

    const loginUrl = this.hoidcService.buildLoginUrl({
      loginPage,
      platformId: config.platformId,
      callbackUrl,
    });

    return res.redirect(loginUrl, 302);
  }

  /**
   * GET /api/sso/hoidc/callback?token=xxx
   * 接收 SSO 回调 token，换取用户信息，写 cookie，302 首页
   */
  @Get('callback')
  async callback(
    @Query('token') token: string,
    @Query('redirect') redirect: string | undefined,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const config = await this.getProviderConfig();

    const userInfo = await this.hoidcService.verifyToken(config, token);

    const authToken = await this.hoidcService.loginUser({
      config,
      info: userInfo,
    });

    res.setCookie('authToken', authToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: this.environmentService.getCookieExpiresIn(),
      secure: this.environmentService.isHttps(),
    });

    const redirectUrl = redirect || this.environmentService.getAppUrl();
    return res.redirect(redirectUrl, 302);
  }
}
