import { Module } from '@nestjs/common';
import { SsoModule } from './sso/sso.module';
import { ApiKeyModule } from './api-key/api-key.module';
import { DocumentImportModule } from './document-import/document-import.module';

@Module({
  imports: [SsoModule, ApiKeyModule, DocumentImportModule],
})
export class EeModule {}
