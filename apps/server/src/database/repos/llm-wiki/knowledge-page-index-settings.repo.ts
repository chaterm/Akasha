import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import {
  DEFAULT_KNOWLEDGE_INDEX_MODE,
  KnowledgeIndexMode,
} from '../../types/knowledge-index-mode.types';

@Injectable()
export class KnowledgePageIndexSettingsRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findMode(input: {
    workspaceId: string;
    sourcePageId: string;
  }): Promise<KnowledgeIndexMode> {
    const row = await this.db
      .selectFrom('knowledgePageIndexSettings')
      .select('indexMode')
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', '=', input.sourcePageId)
      .executeTakeFirst();
    return (
      (row?.indexMode as KnowledgeIndexMode | undefined) ??
      DEFAULT_KNOWLEDGE_INDEX_MODE
    );
  }
}
