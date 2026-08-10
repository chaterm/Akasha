import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { dbOrTx } from '@akasha/db/utils';
import {
  AiModelConfig,
  InsertableAiModelConfig,
} from '@akasha/db/types/entity.types';

export type AiModelConfigFeature =
  | 'compiler'
  | 'answer'
  | 'image'
  | 'embedding';

@Injectable()
export class AiModelConfigRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findByFeature(
    feature: AiModelConfigFeature,
    trx?: KyselyTransaction,
  ): Promise<AiModelConfig | undefined> {
    const db = dbOrTx(this.db, trx);
    return db
      .selectFrom('aiModelConfigs')
      .selectAll()
      .where('feature', '=', feature)
      .executeTakeFirst();
  }

  async findAll(trx?: KyselyTransaction): Promise<AiModelConfig[]> {
    const db = dbOrTx(this.db, trx);
    return db.selectFrom('aiModelConfigs').selectAll().execute();
  }

  async upsert(
    feature: AiModelConfigFeature,
    data: Omit<InsertableAiModelConfig, 'feature'>,
    trx?: KyselyTransaction,
  ): Promise<AiModelConfig> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('aiModelConfigs')
      .values({ ...data, feature })
      .onConflict((oc) =>
        oc.column('feature').doUpdateSet({
          provider: data.provider,
          model: data.model,
          baseUrl: data.baseUrl ?? null,
          apiKeyEncrypted: data.apiKeyEncrypted ?? null,
          parameters: data.parameters ?? null,
          updatedAt: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
