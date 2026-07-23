import { Module } from '@nestjs/common';
import { TelemetryService } from './telemetry.service';

@Module({
  providers: [TelemetryService],
})
export class TelemetryModule {}
