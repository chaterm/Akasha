import { Module } from '@nestjs/common';
import { HoidcController } from './hoidc.controller';
import { HoidcService } from './hoidc.service';
import { UserModule } from '../../core/user/user.module';
import { SpaceModule } from '../../core/space/space.module';
import { WorkspaceModule } from '../../core/workspace/workspace.module';
import { GroupModule } from '../../core/group/group.module';
import { SsoArchAuthGuard } from './guards/sso-arch-auth.guard';
import { SsoGroupController } from './sso-group.controller';
import { SsoGroupService } from './sso-group.service';
import { SsoUserLifecycleController } from './sso-user-lifecycle.controller';
import { SsoUserLifecycleService } from './sso-user-lifecycle.service';

@Module({
  imports: [UserModule, SpaceModule, WorkspaceModule, GroupModule],
  controllers: [
    HoidcController,
    SsoGroupController,
    SsoUserLifecycleController,
  ],
  providers: [
    HoidcService,
    SsoArchAuthGuard,
    SsoGroupService,
    SsoUserLifecycleService,
  ],
  exports: [HoidcService],
})
export class SsoModule {}
