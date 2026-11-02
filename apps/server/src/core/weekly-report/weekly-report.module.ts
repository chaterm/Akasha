import { Module } from '@nestjs/common';
import { PageModule } from '../page/page.module';
import { TemplateModule } from '../template/template.module';
import { WeeklyReportService } from './weekly-report.service';
import { WeeklyReportOutboxService } from './weekly-report-outbox.service';

@Module({
  imports: [PageModule, TemplateModule],
  providers: [WeeklyReportService, WeeklyReportOutboxService],
  exports: [WeeklyReportService],
})
export class WeeklyReportModule {}
