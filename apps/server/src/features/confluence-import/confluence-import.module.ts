import { Module } from '@nestjs/common';
import { ConfluenceImportService } from './confluence-import.service';
import { ImportModule } from '../../integrations/import/import.module';
import { PageModule } from '../../core/page/page.module';

@Module({
  imports: [ImportModule, PageModule],
  providers: [ConfluenceImportService],
  exports: [ConfluenceImportService],
})
export class ConfluenceImportModule {}
