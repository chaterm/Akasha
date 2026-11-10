import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import {
  isKnowledgeIndexMode,
  KnowledgeIndexMode,
  KnowledgeSpaceIndexMode,
  readSpaceKnowledgeIndexMode,
  resolveEffectiveKnowledgeIndexMode,
} from '../../types/knowledge-index-mode.types';

export interface ResolvedKnowledgeIndexMode {
  /** Stored page setting; ignored while the Space mode is locked. */
  pageIndexMode: KnowledgeIndexMode | null;
  spaceIndexMode: KnowledgeSpaceIndexMode;
  effectiveIndexMode: KnowledgeIndexMode;
}

@Injectable()
export class KnowledgePageIndexSettingsRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  /** Saves the page override; null clears it so the page follows the Space. */
  async setMode(input: {
    workspaceId: string;
    sourcePageId: string;
    indexMode: KnowledgeIndexMode | null;
    updatedBy: string | null;
  }): Promise<void> {
    if (input.indexMode === null) {
      await this.db
        .deleteFrom('knowledgePageIndexSettings')
        .where('workspaceId', '=', input.workspaceId)
        .where('sourcePageId', '=', input.sourcePageId)
        .execute();
      return;
    }
    const indexMode = input.indexMode;
    const now = new Date();
    await this.db
      .insertInto('knowledgePageIndexSettings')
      .values({
        workspaceId: input.workspaceId,
        sourcePageId: input.sourcePageId,
        indexMode,
        updatedBy: input.updatedBy,
        updatedAt: now,
      })
      .onConflict((oc) =>
        oc.columns(['workspaceId', 'sourcePageId']).doUpdateSet({
          indexMode,
          updatedBy: input.updatedBy,
          updatedAt: now,
        }),
      )
      .execute();
  }

  async resolveMode(input: {
    workspaceId: string;
    spaceId: string;
    sourcePageId: string;
  }): Promise<ResolvedKnowledgeIndexMode> {
    const row = await this.db
      .selectFrom('spaces as space')
      .leftJoin('knowledgePageIndexSettings as setting', (join) =>
        join
          .on('setting.workspaceId', '=', input.workspaceId)
          .on('setting.sourcePageId', '=', input.sourcePageId),
      )
      .select(['space.settings', 'setting.indexMode'])
      .where('space.id', '=', input.spaceId)
      .where('space.workspaceId', '=', input.workspaceId)
      .executeTakeFirst();
    const pageIndexMode = isKnowledgeIndexMode(row?.indexMode)
      ? row.indexMode
      : null;
    const spaceIndexMode = readSpaceKnowledgeIndexMode(row?.settings);
    return {
      pageIndexMode,
      spaceIndexMode,
      effectiveIndexMode: resolveEffectiveKnowledgeIndexMode({
        pageIndexMode,
        spaceIndexMode,
      }),
    };
  }
}
