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

@Injectable()
export class ApiKeyRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findById(
    id: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<ApiKey> {
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
  ): Promise<CursorPaginationResult<ApiKey & { creator: { id: string; name: string; email: string; avatarUrl: string } | null }>> {
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

  async findWorkspaceKeys(
    workspaceId: string,
    pagination: PaginationOptions,
    trx?: KyselyTransaction,
  ): Promise<CursorPaginationResult<ApiKey & { creator: { id: string; name: string; email: string; avatarUrl: string } | null }>> {
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
