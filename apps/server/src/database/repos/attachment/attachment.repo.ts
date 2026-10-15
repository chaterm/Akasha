import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { ExpressionBuilder, sql } from 'kysely';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { DB } from '@akasha/db/types/db';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { dbOrTx } from '@akasha/db/utils';
import {
  Attachment,
  InsertableAttachment,
  UpdatableAttachment,
} from '@akasha/db/types/entity.types';
import { AttachmentType } from '../../../core/attachment/attachment.constants';
import { PaginationOptions } from '@akasha/db/pagination/pagination-options';
import { executeWithCursorPagination } from '@akasha/db/pagination/cursor-pagination';

@Injectable()
export class AttachmentRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  private baseFields: Array<keyof Attachment> = [
    'id',
    'fileName',
    'filePath',
    'fileSize',
    'fileExt',
    'mimeType',
    'type',
    'creatorId',
    'pageId',
    'spaceId',
    'aiChatId',
    'workspaceId',
    'createdAt',
    'updatedAt',
    'deletedAt',
  ];

  async findById(
    attachmentId: string,
    opts?: {
      trx?: KyselyTransaction;
    },
  ): Promise<Attachment> {
    const db = dbOrTx(this.db, opts?.trx);

    return db
      .selectFrom('attachments')
      .select(this.baseFields)
      .where('id', '=', attachmentId)
      .executeTakeFirst();
  }

  async findByIdWithContent(
    attachmentId: string,
    opts?: {
      trx?: KyselyTransaction;
    },
  ): Promise<Attachment> {
    const db = dbOrTx(this.db, opts?.trx);

    return db
      .selectFrom('attachments')
      .select([...this.baseFields, 'textContent'])
      .where('id', '=', attachmentId)
      .executeTakeFirst();
  }

  async insertAttachment(
    insertableAttachment: InsertableAttachment,
    trx?: KyselyTransaction,
  ): Promise<Attachment> {
    const db = dbOrTx(this.db, trx);

    return db
      .insertInto('attachments')
      .values(insertableAttachment)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  async findBySpaceId(
    spaceId: string,
    opts?: {
      trx?: KyselyTransaction;
    },
  ): Promise<Attachment[]> {
    const db = dbOrTx(this.db, opts?.trx);

    return db
      .selectFrom('attachments')
      .select(this.baseFields)
      .where('spaceId', '=', spaceId)
      .execute();
  }

  async findPageAttachments(pageId: string, pagination: PaginationOptions) {
    let query = this.db
      .selectFrom('attachments')
      .select(this.baseFields)
      .select((eb) => this.withCreator(eb))
      .where('pageId', '=', pageId)
      .where('type', '=', AttachmentType.File)
      .where('deletedAt', 'is', null);

    if (pagination.query) {
      query = query.where(
        sql`f_unaccent(file_name)`,
        'ilike',
        sql`f_unaccent(${'%' + pagination.query + '%'})`,
      );
    }

    return executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [{ expression: 'id', direction: 'desc' }],
      parseCursor: (cursor) => ({ id: cursor.id }),
    });
  }

  withCreator(eb: ExpressionBuilder<DB, 'attachments'>) {
    return jsonObjectFrom(
      eb
        .selectFrom('users')
        .select(['users.id', 'users.name', 'users.avatarUrl'])
        .whereRef('users.id', '=', 'attachments.creatorId'),
    ).as('creator');
  }

  async findByIds(
    ids: string[],
    opts?: {
      trx?: KyselyTransaction;
    },
  ): Promise<Attachment[]> {
    if (ids.length === 0) return [];
    const db = dbOrTx(this.db, opts?.trx);

    return db
      .selectFrom('attachments')
      .select(this.baseFields)
      .where('id', 'in', ids)
      .execute();
  }

  async findByPageIds(
    pageIds: string[],
    workspaceId: string,
    opts?: {
      trx?: KyselyTransaction;
    },
  ): Promise<Attachment[]> {
    if (pageIds.length === 0) return [];
    const db = dbOrTx(this.db, opts?.trx);

    return db
      .selectFrom('attachments')
      .select(this.baseFields)
      .where('pageId', 'in', pageIds)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .execute();
  }

  async findByAiChatId(
    aiChatId: string,
    opts?: {
      trx?: KyselyTransaction;
    },
  ): Promise<Attachment[]> {
    const db = dbOrTx(this.db, opts?.trx);

    return db
      .selectFrom('attachments')
      .select(this.baseFields)
      .where('aiChatId', '=', aiChatId)
      .execute();
  }

  updateAttachmentsByPageId(
    updatableAttachment: UpdatableAttachment,
    pageIds: string[],
    trx?: KyselyTransaction,
  ) {
    return dbOrTx(this.db, trx)
      .updateTable('attachments')
      .set(updatableAttachment)
      .where('pageId', 'in', pageIds)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  async updateAttachment(
    updatableAttachment: UpdatableAttachment,
    attachmentId: string,
  ): Promise<Attachment> {
    return await this.db
      .updateTable('attachments')
      .set(updatableAttachment)
      .where('id', '=', attachmentId)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  async claimAttachmentsForChat(
    attachmentIds: string[],
    aiChatId: string,
    creatorId: string,
    workspaceId: string,
  ): Promise<void> {
    if (attachmentIds.length === 0) return;

    await this.db
      .updateTable('attachments')
      .set({ aiChatId })
      .where('id', 'in', attachmentIds)
      .where('creatorId', '=', creatorId)
      .where('workspaceId', '=', workspaceId)
      .where('type', '=', AttachmentType.Chat)
      .where('aiChatId', 'is', null)
      .execute();
  }

  async deleteAttachmentById(attachmentId: string): Promise<Attachment> {
    return this.db
      .deleteFrom('attachments')
      .where('id', '=', attachmentId)
      .returning(this.baseFields)
      .executeTakeFirst();
  }

  async deleteAttachmentByFilePath(
    attachmentFilePath: string,
  ): Promise<Attachment> {
    return this.db
      .deleteFrom('attachments')
      .where('filePath', '=', attachmentFilePath)
      .returning(this.baseFields)
      .executeTakeFirst();
  }
}
