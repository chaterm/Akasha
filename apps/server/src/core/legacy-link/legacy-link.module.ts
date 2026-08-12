import { Module } from '@nestjs/common';
import { LegacyLinkController } from './legacy-link.controller';
import { LegacyLinkService } from './legacy-link.service';

@Module({
  controllers: [LegacyLinkController],
  providers: [LegacyLinkService],
  exports: [LegacyLinkService],
})
export class LegacyLinkModule {}
