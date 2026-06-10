import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { HoidcService } from './hoidc.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';

@Controller('sso/hoidc')
export class HoidcController {
  constructor(
    private readonly hoidcService: HoidcService,
    private readonly environmentService: EnvironmentService,
  ) {}

  /**
   * GET /api/sso/hoidc/:providerId/login
   * 302 跳转到 SSO 登录页
   */
  @Get(':providerId/login')
  async login(
    @Param('providerId') providerId: string,
    @Query('redirect') redirect: string | undefined,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const provider = await this.hoidcService.getProvider(providerId);

    const loginPage = this.environmentService.getHoidcLoginPage();
    if (!loginPage) {
      throw new BadRequestException('HOIDC_LOGIN_PAGE is not configured');
    }

    const appUrl = this.environmentService.getAppUrl();
    let callbackUrl = `${appUrl}/api/sso/hoidc/${providerId}/callback`;
    if (redirect) {
      callbackUrl += `?redirect=${encodeURIComponent(redirect)}`;
    }

    const loginUrl = this.hoidcService.buildLoginUrl({
      loginPage,
      platformId: provider.oidcClientId,
      callbackUrl,
    });

    return res.redirect(loginUrl, 302);
  }

  /**
   * GET /api/sso/hoidc/:providerId/callback?token=xxx
   * 接收 SSO 回调 token，换取用户信息，写 cookie，302 首页
   */
  @Get(':providerId/callback')
  async callback(
    @Param('providerId') providerId: string,
    @Query('token') token: string,
    @Query('redirect') redirect: string | undefined,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const provider = await this.hoidcService.getProvider(providerId);

    const userInfo = await this.hoidcService.verifyToken(provider, token);

    const workspaceId =
      (req.raw as any)?.workspaceId ?? provider.workspaceId;

    const authToken = await this.hoidcService.loginUser({
      provider,
      info: userInfo,
      workspaceId,
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
