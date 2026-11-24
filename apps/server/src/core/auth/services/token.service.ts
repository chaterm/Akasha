import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { StringValue } from 'ms';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  JwtApiKeyPayload,
  JwtAttachmentPayload,
  JwtCollabPayload,
  JwtExchangePayload,
  JwtMcpDownloadPayload,
  JwtMcpUploadPayload,
  JwtMfaTokenPayload,
  JwtPayload,
  JwtPdfExportDownloadPayload,
  JwtPdfRenderPayload,
  JwtType,
} from '../dto/jwt-payload';
import { User } from '@akasha/db/types/entity.types';
import { isUserDisabled } from '../../../common/helpers';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class TokenService {
  constructor(
    private jwtService: JwtService,
    private environmentService: EnvironmentService,
  ) {}

  async generateAccessToken(user: User, sessionId: string): Promise<string> {
    if (isUserDisabled(user)) {
      throw new ForbiddenException();
    }

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      workspaceId: user.workspaceId,
      type: JwtType.ACCESS,
      sessionId,
    };
    return this.jwtService.sign(payload);
  }

  async generateCollabToken(user: User, workspaceId: string): Promise<string> {
    if (isUserDisabled(user)) {
      throw new ForbiddenException();
    }

    const payload: JwtCollabPayload = {
      sub: user.id,
      workspaceId,
      type: JwtType.COLLAB,
    };
    const expiresIn = '24h';
    return this.jwtService.sign(payload, { expiresIn });
  }

  async generateExchangeToken(
    userId: string,
    workspaceId: string,
  ): Promise<string> {
    const payload: JwtExchangePayload = {
      sub: userId,
      workspaceId: workspaceId,
      type: JwtType.EXCHANGE,
    };
    return this.jwtService.sign(payload, { expiresIn: '10s' });
  }

  async generateAttachmentToken(opts: {
    attachmentId: string;
    pageId: string;
    workspaceId: string;
  }): Promise<string> {
    const { attachmentId, pageId, workspaceId } = opts;
    const payload: JwtAttachmentPayload = {
      attachmentId: attachmentId,
      pageId: pageId,
      workspaceId: workspaceId,
      type: JwtType.ATTACHMENT,
    };
    return this.jwtService.sign(payload, { expiresIn: '1h' });
  }

  async generateMfaToken(user: User, workspaceId: string): Promise<string> {
    if (isUserDisabled(user)) {
      throw new ForbiddenException();
    }

    const payload: JwtMfaTokenPayload = {
      sub: user.id,
      workspaceId,
      type: JwtType.MFA_TOKEN,
    };
    return this.jwtService.sign(payload, { expiresIn: '5m' });
  }

  async generateApiToken(opts: {
    apiKeyId: string;
    user: User;
    workspaceId: string;
    expiresIn?: StringValue | number;
    credentialVersion?: number;
  }): Promise<string> {
    const { apiKeyId, user, workspaceId, expiresIn, credentialVersion } = opts;
    if (isUserDisabled(user)) {
      throw new ForbiddenException();
    }

    const payload: JwtApiKeyPayload = {
      sub: user.id,
      apiKeyId: apiKeyId,
      workspaceId,
      type: JwtType.API_KEY,
      ...(credentialVersion === undefined ? {} : { credentialVersion }),
    };

    if (expiresIn === undefined) {
      return jwt.sign(payload, this.environmentService.getAppSecret(), {
        issuer: 'Akasha',
      });
    }
    return this.jwtService.sign(payload, { expiresIn });
  }

  async generateMcpUploadToken(opts: {
    userId: string;
    workspaceId: string;
    pageId: string;
    attachmentId?: string;
  }): Promise<string> {
    const payload: JwtMcpUploadPayload = {
      sub: opts.userId,
      workspaceId: opts.workspaceId,
      pageId: opts.pageId,
      ...(opts.attachmentId ? { attachmentId: opts.attachmentId } : {}),
      type: JwtType.MCP_UPLOAD,
    };
    return this.jwtService.sign(payload, { expiresIn: '10m' });
  }

  async generateMcpDownloadToken(opts: {
    userId: string;
    workspaceId: string;
    attachmentId: string;
  }): Promise<string> {
    const payload: JwtMcpDownloadPayload = {
      sub: opts.userId,
      workspaceId: opts.workspaceId,
      attachmentId: opts.attachmentId,
      type: JwtType.MCP_DOWNLOAD,
    };
    return this.jwtService.sign(payload, { expiresIn: '10m' });
  }

  async generatePdfRenderToken(
    pageId: string,
    workspaceId: string,
  ): Promise<string> {
    const payload: JwtPdfRenderPayload = {
      pageId,
      workspaceId,
      type: JwtType.PDF_RENDER,
    };
    return this.jwtService.sign(payload, { expiresIn: '60s' });
  }

  async generatePdfExportDownloadToken(
    fileTaskId: string,
    workspaceId: string,
  ): Promise<string> {
    const payload: JwtPdfExportDownloadPayload = {
      fileTaskId,
      workspaceId,
      type: JwtType.PDF_EXPORT_DOWNLOAD,
    };
    return this.jwtService.sign(payload, { expiresIn: '1h' });
  }

  decodeJwt(token: string): { type?: string } | null {
    try {
      return this.jwtService.decode(token) as { type?: string } | null;
    } catch {
      return null;
    }
  }

  async verifyJwt(token: string, tokenType: string) {
    const payload = await this.jwtService.verifyAsync(token, {
      secret: this.environmentService.getAppSecret(),
      issuer: 'Akasha',
    });

    if (payload.type !== tokenType) {
      throw new UnauthorizedException(
        'Invalid JWT token. Token type does not match.',
      );
    }

    return payload;
  }
}
