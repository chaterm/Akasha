import { HoidcService } from './hoidc.service';
import { UnauthorizedException } from '@nestjs/common';

describe('HoidcService pure helpers', () => {
  // 构造 service 时 6 个依赖全传 null（只测纯逻辑方法，不需要 DB/网络）
  const svc = new HoidcService(null as any, null as any, null as any, null as any, null as any, null as any);

  describe('buildLoginUrl', () => {
    it('builds login url correctly', () => {
      const result = svc.buildLoginUrl({
        loginPage: 'https://sso.example.com',
        platformId: 'my-platform',
        callbackUrl: 'https://app.example.com/api/sso/hoidc/abc/callback',
      });

      expect(result).toBe(
        'https://sso.example.com?platform_id=my-platform&redirect=' +
          encodeURIComponent(
            'https://app.example.com/api/sso/hoidc/abc/callback',
          ),
      );
    });

    it('encodes callback url with query params', () => {
      const callbackUrl =
        'https://app.example.com/api/sso/hoidc/abc/callback?redirect=%2Fdashboard';
      const result = svc.buildLoginUrl({
        loginPage: 'https://sso.example.com',
        platformId: 'pid123',
        callbackUrl,
      });

      expect(result).toContain('platform_id=pid123');
      expect(result).toContain(
        'redirect=' + encodeURIComponent(callbackUrl),
      );
    });
  });

  describe('parseUserInfo', () => {
    it('parses userinfo from response', () => {
      const resp = {
        data: {
          email: 'user@example.com',
          name: 'Test User',
          avatar: 'https://cdn.example.com/avatar.png',
        },
      };

      const result = svc.parseUserInfo(resp);

      expect(result.email).toBe('user@example.com');
      expect(result.name).toBe('Test User');
      expect(result.avatar).toBe('https://cdn.example.com/avatar.png');
    });

    it('returns null for missing name and avatar', () => {
      const resp = {
        data: {
          email: 'user@example.com',
        },
      };

      const result = svc.parseUserInfo(resp);

      expect(result.email).toBe('user@example.com');
      expect(result.name).toBeNull();
      expect(result.avatar).toBeNull();
    });

    it('throws UnauthorizedException when email is missing', () => {
      const resp = {
        data: {
          name: 'No Email User',
        },
      };

      expect(() => svc.parseUserInfo(resp)).toThrow(UnauthorizedException);
      expect(() => svc.parseUserInfo(resp)).toThrow('SSO response missing email');
    });

    it('throws UnauthorizedException when data is null', () => {
      expect(() => svc.parseUserInfo(null)).toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when resp is empty object', () => {
      expect(() => svc.parseUserInfo({})).toThrow(UnauthorizedException);
    });
  });
});
