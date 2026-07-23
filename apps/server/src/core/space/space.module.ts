import { Module } from '@nestjs/common';
import { SpaceService } from './services/space.service';
import { SpaceController } from './space.controller';
import { SpaceMemberService } from './services/space-member.service';
import { SpaceAuthorizationService } from './services/space-authorization.service';

@Module({
  imports: [],
  controllers: [SpaceController],
  providers: [SpaceService, SpaceMemberService, SpaceAuthorizationService],
  exports: [SpaceService, SpaceMemberService, SpaceAuthorizationService],
})
export class SpaceModule {}
