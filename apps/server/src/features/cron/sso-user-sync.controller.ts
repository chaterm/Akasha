import {
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { User } from '@akasha/db/types/entity.types';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UserRole } from '../../common/helpers/types/permission';
import { SsoUserSyncResult, SsoUserSyncService } from './sso-user-sync.service';

@UseGuards(JwtAuthGuard)
@Controller('sso/users')
export class SsoUserSyncController {
  constructor(private readonly ssoUserSyncService: SsoUserSyncService) {}

  @HttpCode(HttpStatus.OK)
  @Post('sync')
  async sync(@AuthUser() user: User): Promise<SsoUserSyncResult> {
    if (user.role !== UserRole.OWNER) {
      throw new ForbiddenException('SSO user sync is restricted to owners');
    }

    return this.ssoUserSyncService.syncAllUsers();
  }
}
