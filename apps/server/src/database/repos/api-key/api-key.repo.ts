import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { dbOrTx } from '@akasha/db/utils';
import {
  ApiKey,
  InsertableApiKey,
  UpdatableApiKey,
} from '@akasha/db/types/entity.types';
import { PaginationOptions } from '@akasha/db/pagination/pagination-options';
import {
  CursorPaginationResult,
  executeWithCursorPagination,
} from '@akasha/db/pagination/cursor-pagination';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { ApiKeyType } from '../../../common/auth/api-key-type';

@Injectable()
export class ApiKeyRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findById(
    id: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<ApiKey | undefined> {
    const db = dbOrTx(this.db, trx);
    return db
      .selectFrom('apiKeys')
      .selectAll()
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  async findUserKeys(
    creatorId: string,
    workspaceId: string,
    pagination: PaginationOptions,
    trx?: KyselyTransaction,
  ): Promise<
    CursorPaginationResult<
      ApiKey & {
        creator: {
          id: string;
          name: string;
          email: string;
          avatarUrl: string;
        } | null;
      }
    >
  > {
    const db = dbOrTx(this.db, trx);
    const query = db
      .selectFrom('apiKeys as ak')
      .selectAll('ak')
      .select((eb) =>
        jsonObjectFrom(
          eb
            .selectFrom('users')
            .select(['id', 'name', 'email', 'avatarUrl'])
            .whereRef('users.id', '=', 'ak.creatorId'),
        ).as('creator'),
      )
      .where('ak.creatorId', '=', creatorId)
      .where('ak.workspaceId', '=', workspaceId)
      .where('ak.keyType', '=', ApiKeyType.PERSONAL)
      .where('ak.deletedAt', 'is', null);

    const result = await executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [
        { expression: 'ak.createdAt', direction: 'desc', key: 'createdAt' },
        { expression: 'ak.id', direction: 'desc', key: 'id' },
      ],
      parseCursor: (cursor) => ({
        createdAt: new Date(cursor.createdAt),
        id: cursor.id,
      }),
    });

    return result;
  }

  async findWorkspaceKeys(
    workspaceId: string,
    pagination: PaginationOptions,
    trx?: KyselyTransaction,
  ): Promise<
    CursorPaginationResult<
      ApiKey & {
        creator: {
          id: string;
          name: string;
          email: string;
          avatarUrl: string;
        } | null;
      }
    >
  > {
    const db = dbOrTx(this.db, trx);
    const query = db
      .selectFrom('apiKeys as ak')
      .selectAll('ak')
      .select((eb) =>
        jsonObjectFrom(
          eb
            .selectFrom('users')
            .select(['id', 'name', 'email', 'avatarUrl'])
            .whereRef('users.id', '=', 'ak.creatorId'),
        ).as('creator'),
      )
      .where('ak.workspaceId', '=', workspaceId)
      .where('ak.keyType', '=', ApiKeyType.PERSONAL)
      .where('ak.deletedAt', 'is', null);

    return executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [
        { expression: 'ak.createdAt', direction: 'desc', key: 'createdAt' },
        { expression: 'ak.id', direction: 'desc', key: 'id' },
      ],
      parseCursor: (cursor) => ({
        createdAt: new Date(cursor.createdAt),
        id: cursor.id,
      }),
    });
  }

  async create(
    data: InsertableApiKey,
    trx?: KyselyTransaction,
  ): Promise<ApiKey> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('apiKeys')
      .values(data)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findBindableSpaceIds(
    workspaceId: string,
    spaceIds: string[],
    trx?: KyselyTransaction,
  ): Promise<string[]> {
    if (spaceIds.length === 0) return [];
    const db = dbOrTx(this.db, trx);
    const rows = await db
      .selectFrom('spaces')
      .select('id')
      .where('workspaceId', '=', workspaceId)
      .where('id', 'in', spaceIds)
      .where('deletedAt', 'is', null)
      .where('personalOwnerId', 'is', null)
      .execute();
    return rows.map((row) => row.id);
  }

  async findBindableSpaces(workspaceId: string) {
    return this.db
      .selectFrom('spaces')
      .select(['id', 'name'])
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .where('personalOwnerId', 'is', null)
      .orderBy('name', 'asc')
      .execute();
  }

  async createWithSpaces(
    data: InsertableApiKey,
    spaceIds: string[],
  ): Promise<ApiKey> {
    return this.db.transaction().execute(async (trx) => {
      const apiKey = await this.create(data, trx);
      await trx
        .insertInto('apiKeySpaces')
        .values(spaceIds.map((spaceId) => ({ apiKeyId: apiKey.id, spaceId })))
        .execute();
      return apiKey;
    });
  }

  async findSpaceIdsByApiKeyId(
    apiKeyId: string,
    trx?: KyselyTransaction,
  ): Promise<string[]> {
    const db = dbOrTx(this.db, trx);
    const rows = await db
      .selectFrom('apiKeySpaces')
      .select('spaceId')
      .where('apiKeyId', '=', apiKeyId)
      .execute();
    return rows.map((row) => row.spaceId);
  }

  async findPublicKeys(workspaceId: string, pagination: PaginationOptions) {
    const query = this.db
      .selectFrom('apiKeys as ak')
      .selectAll('ak')
      .select((eb) =>
        jsonObjectFrom(
          eb
            .selectFrom('users')
            .select(['id', 'name', 'email', 'avatarUrl'])
            .whereRef('users.id', '=', 'ak.creatorId'),
        ).as('creator'),
      )
      .where('ak.workspaceId', '=', workspaceId)
      .where('ak.keyType', '=', ApiKeyType.PUBLIC_RETRIEVAL)
      .where('ak.deletedAt', 'is', null);

    const result = await executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [
        { expression: 'ak.createdAt', direction: 'desc', key: 'createdAt' },
        { expression: 'ak.id', direction: 'desc', key: 'id' },
      ],
      parseCursor: (cursor) => ({
        createdAt: new Date(cursor.createdAt),
        id: cursor.id,
      }),
    });

    if (result.items.length === 0) return result;
    const keyIds = result.items.map((item) => item.id);
    const bindings = await this.db
      .selectFrom('apiKeySpaces as aks')
      .innerJoin('spaces as s', 's.id', 'aks.spaceId')
      .select(['aks.apiKeyId', 's.id', 's.name'])
      .where('aks.apiKeyId', 'in', keyIds)
      .orderBy('s.name', 'asc')
      .execute();

    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        spaces: bindings
          .filter((binding) => binding.apiKeyId === item.id)
          .map(({ id, name }) => ({ id, name })),
      })),
    };
  }

  async updatePublicKey(
    id: string,
    workspaceId: string,
    name: string,
    spaceIds: string[],
  ): Promise<ApiKey | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const apiKey = await trx
        .updateTable('apiKeys')
        .set({ name, updatedAt: new Date() })
        .where('id', '=', id)
        .where('workspaceId', '=', workspaceId)
        .where('keyType', '=', ApiKeyType.PUBLIC_RETRIEVAL)
        .where('deletedAt', 'is', null)
        .returningAll()
        .executeTakeFirst();

      if (!apiKey) return undefined;
      await trx.deleteFrom('apiKeySpaces').where('apiKeyId', '=', id).execute();
      await trx
        .insertInto('apiKeySpaces')
        .values(spaceIds.map((spaceId) => ({ apiKeyId: id, spaceId })))
        .execute();
      return apiKey;
    });
  }

  async updateName(
    id: string,
    workspaceId: string,
    name: string,
    trx?: KyselyTransaction,
  ): Promise<ApiKey> {
    const db = dbOrTx(this.db, trx);
    return db
      .updateTable('apiKeys')
      .set({ name, updatedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .returningAll()
      .executeTakeFirst();
  }

  async softDelete(
    id: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .updateTable('apiKeys')
      .set({ deletedAt: new Date() })
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  async updateLastUsed(id: string, trx?: KyselyTransaction): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .updateTable('apiKeys')
      .set({ lastUsedAt: new Date() })
      .where('id', '=', id)
      .execute();
  }
}
