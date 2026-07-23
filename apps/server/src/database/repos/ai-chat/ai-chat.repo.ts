import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { executeWithCursorPagination } from '@akasha/db/pagination/cursor-pagination';
import { PaginationOptions } from '@akasha/db/pagination/pagination-options';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import {
  AiChat,
  AiChatMessage,
  InsertableAiChatMessage,
} from '@akasha/db/types/entity.types';

@Injectable()
export class AiChatRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async createChat(input: {
    workspaceId: string;
    creatorId: string;
    title?: string | null;
  }): Promise<AiChat> {
    return this.db
      .insertInto('aiChats')
      .values({
        workspaceId: input.workspaceId,
        creatorId: input.creatorId,
        title: input.title ?? null,
      })
      .returningAll()
      .executeTakeFirst();
  }

  async findChatByIdForUser(input: {
    workspaceId: string;
    userId: string;
    chatId: string;
  }): Promise<AiChat | undefined> {
    return this.db
      .selectFrom('aiChats')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('creatorId', '=', input.userId)
      .where('id', '=', input.chatId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  async listChats(input: {
    workspaceId: string;
    userId: string;
    pagination: PaginationOptions;
  }) {
    const query = this.db
      .selectFrom('aiChats')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('creatorId', '=', input.userId)
      .where('deletedAt', 'is', null)
      .orderBy('updatedAt', 'desc')
      .orderBy('id', 'desc');

    return executeWithCursorPagination(query, {
      perPage: input.pagination.limit ?? 30,
      cursor: input.pagination.cursor,
      beforeCursor: input.pagination.beforeCursor,
      fields: [
        { expression: 'updatedAt', direction: 'desc' },
        { expression: 'id', direction: 'desc' },
      ],
      parseCursor: (cursor) => ({
        updatedAt: new Date(cursor.updatedAt),
        id: cursor.id,
      }),
    });
  }

  async searchChats(input: {
    workspaceId: string;
    userId: string;
    query: string;
    limit?: number;
  }): Promise<AiChat[]> {
    return this.db
      .selectFrom('aiChats')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('creatorId', '=', input.userId)
      .where('deletedAt', 'is', null)
      .where((eb) =>
        eb(
          sql`f_unaccent(title)`,
          'ilike',
          sql`f_unaccent(${'%' + input.query + '%'})`,
        ),
      )
      .orderBy('updatedAt', 'desc')
      .limit(input.limit ?? 20)
      .execute();
  }

  async updateChatTitle(input: {
    workspaceId: string;
    userId: string;
    chatId: string;
    title: string;
  }): Promise<void> {
    await this.db
      .updateTable('aiChats')
      .set({ title: input.title, updatedAt: new Date() })
      .where('workspaceId', '=', input.workspaceId)
      .where('creatorId', '=', input.userId)
      .where('id', '=', input.chatId)
      .where('deletedAt', 'is', null)
      .execute();
  }

  async softDeleteChat(input: {
    workspaceId: string;
    userId: string;
    chatId: string;
  }): Promise<void> {
    await this.db
      .updateTable('aiChats')
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where('workspaceId', '=', input.workspaceId)
      .where('creatorId', '=', input.userId)
      .where('id', '=', input.chatId)
      .execute();
  }

  async addMessage(input: InsertableAiChatMessage): Promise<AiChatMessage> {
    const message = await this.db
      .insertInto('aiChatMessages')
      .values(input)
      .returningAll()
      .executeTakeFirst();

    await this.db
      .updateTable('aiChats')
      .set({ updatedAt: new Date() })
      .where('id', '=', input.chatId)
      .where('workspaceId', '=', input.workspaceId)
      .execute();

    return stripTsv(message as AiChatMessage & { tsv?: string });
  }

  async findMessages(input: {
    workspaceId: string;
    chatId: string;
    limit?: number;
  }): Promise<AiChatMessage[]> {
    const rows = await this.db
      .selectFrom('aiChatMessages')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('chatId', '=', input.chatId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .limit(input.limit ?? 100)
      .execute();

    return rows.map(stripTsv);
  }
}

function stripTsv(row: AiChatMessage & { tsv?: string }): AiChatMessage {
  const { tsv: _tsv, ...message } = row;
  return message;
}
