import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import {
  isCompileWindowOpen,
  KnowledgeCompileWindowConfig,
  nextCompileWindowStartAt,
  parseCompileWindowConfig,
} from '../../types/knowledge-compile-window.types';

export interface KnowledgeCompileWindowDecision {
  deferred: boolean;
  deferredUntil: Date | null;
}

@Injectable()
export class KnowledgeCompileWindowRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async getConfig(workspaceId: string): Promise<KnowledgeCompileWindowConfig> {
    const row = await this.db
      .selectFrom('workspaces')
      .select(sql<unknown>`settings->'ai'->'compileWindow'`.as('compileWindow'))
      .where('id', '=', workspaceId)
      .executeTakeFirst();
    return parseCompileWindowConfig(row?.compileWindow);
  }

  async saveConfig(
    workspaceId: string,
    config: KnowledgeCompileWindowConfig,
  ): Promise<void> {
    await this.db
      .updateTable('workspaces')
      .set({
        settings: sql`COALESCE(settings, '{}'::jsonb)
                || jsonb_build_object('ai', COALESCE(settings->'ai', '{}'::jsonb)
                || jsonb_build_object('compileWindow', jsonb_build_object(
                  'enabled', ${config.enabled}::boolean,
                  'startTime', ${config.startTime}::text,
                  'endTime', ${config.endTime}::text
                )))`,
        updatedAt: new Date(),
      })
      .where('id', '=', workspaceId)
      .execute();
  }

  async decide(
    workspaceId: string,
    now = new Date(),
  ): Promise<KnowledgeCompileWindowDecision> {
    const config = await this.getConfig(workspaceId);
    if (isCompileWindowOpen(config, now)) {
      return { deferred: false, deferredUntil: null };
    }
    return {
      deferred: true,
      deferredUntil: nextCompileWindowStartAt(config, now),
    };
  }

  async isEnabled(workspaceId: string): Promise<boolean> {
    return (await this.getConfig(workspaceId)).enabled;
  }

  async findGatedWorkspaceIds(now = new Date()): Promise<string[]> {
    const rows = await this.db
      .selectFrom('workspaces')
      .select([
        'id',
        sql<unknown>`settings->'ai'->'compileWindow'`.as('compileWindow'),
      ])
      .where(sql<boolean>`settings->'ai'->'compileWindow'->>'enabled' = 'true'`)
      .where('deletedAt', 'is', null)
      .execute();
    return rows
      .filter(
        (row) =>
          !isCompileWindowOpen(
            parseCompileWindowConfig(row.compileWindow),
            now,
          ),
      )
      .map((row) => row.id);
  }
}
