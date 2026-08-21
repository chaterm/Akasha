import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { SsoArchAuthGuard } from './guards/sso-arch-auth.guard';
import { DeleteUserDto } from './dto/sso-arch.dto';
import { SsoUserLifecycleService } from './sso-user-lifecycle.service';

@UseGuards(SsoArchAuthGuard)
@Controller('sso/users')
export class SsoUserLifecycleController {
  constructor(
    private readonly ssoUserLifecycleService: SsoUserLifecycleService,
  ) {}

  @Post('delete')
  DeleteUser(@Body() dto: DeleteUserDto) {
    return this.ssoUserLifecycleService.DeleteUser(dto);
  }
}
