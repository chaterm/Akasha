import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { executeWithCursorPagination } from '@akasha/db/pagination/cursor-pagination';
import { PaginationOptions } from '@akasha/db/pagination/pagination-options';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import { executeTx } from '@akasha/db/utils';
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

    if (input.role === 'user') {
      await this.db
        .updateTable('aiChats')
        .set({ updatedAt: new Date() })
        .where('id', '=', input.chatId)
        .where('workspaceId', '=', input.workspaceId)
        .execute();
    }

    return stripTsv(message as AiChatMessage & { tsv?: string });
  }

  async editUserMessageAndSoftDeleteTail(input: {
    workspaceId: string;
    userId: string;
    chatId: string;
    messageId: string;
    content: string;
  }): Promise<{
    message: AiChatMessage;
    previousMessages: AiChatMessage[];
  } | null> {
    return executeTx(this.db, async (trx) => {
      const chat = await trx
        .selectFrom('aiChats')
        .select('id')
        .where('workspaceId', '=', input.workspaceId)
        .where('creatorId', '=', input.userId)
        .where('id', '=', input.chatId)
        .where('deletedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!chat) return null;

      const target = await trx
        .selectFrom('aiChatMessages')
        .select('id')
        .where('workspaceId', '=', input.workspaceId)
        .where('chatId', '=', input.chatId)
        .where('id', '=', input.messageId)
        .where('userId', '=', input.userId)
        .where('role', '=', 'user')
        .where('deletedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!target) return null;

      const now = new Date();
      const edited = await trx
        .updateTable('aiChatMessages')
        .set({ content: input.content, updatedAt: now })
        .where('workspaceId', '=', input.workspaceId)
        .where('chatId', '=', input.chatId)
        .where('id', '=', input.messageId)
        .where('userId', '=', input.userId)
        .where('role', '=', 'user')
        .where('deletedAt', 'is', null)
        .returningAll()
        .executeTakeFirst();
      if (!edited) return null;

      await trx
        .updateTable('aiChatMessages')
        .set({ deletedAt: now, updatedAt: now })
        .where('workspaceId', '=', input.workspaceId)
        .where('chatId', '=', input.chatId)
        .where('deletedAt', 'is', null)
        .where(messageIsAfter(input))
        .execute();

      const previousRows = await trx
        .selectFrom('aiChatMessages')
        .selectAll()
        .where('workspaceId', '=', input.workspaceId)
        .where('chatId', '=', input.chatId)
        .where('deletedAt', 'is', null)
        .where(messageIsBefore(input))
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .limit(20)
        .execute();

      const earlierUserMessage = await trx
        .selectFrom('aiChatMessages')
        .select('id')
        .where('workspaceId', '=', input.workspaceId)
        .where('chatId', '=', input.chatId)
        .where('role', '=', 'user')
        .where('deletedAt', 'is', null)
        .where(messageIsBefore(input))
        .limit(1)
        .executeTakeFirst();

      await trx
        .updateTable('aiChats')
        .set({
          updatedAt: now,
          ...(!earlierUserMessage ? { title: buildTitle(input.content) } : {}),
        })
        .where('workspaceId', '=', input.workspaceId)
        .where('creatorId', '=', input.userId)
        .where('id', '=', input.chatId)
        .where('deletedAt', 'is', null)
        .execute();

      return {
        message: stripTsv(edited),
        previousMessages: previousRows.reverse().map(stripTsv),
      };
    });
  }

  async addAssistantMessageIfCurrent(input: {
    workspaceId: string;
    userId: string;
    chatId: string;
    anchorMessageId: string;
    anchorUpdatedAt: Date;
    content: string;
    metadata: InsertableAiChatMessage['metadata'];
  }): Promise<AiChatMessage | null> {
    return executeTx(this.db, async (trx) => {
      const chat = await trx
        .selectFrom('aiChats')
        .select('id')
        .where('workspaceId', '=', input.workspaceId)
        .where('creatorId', '=', input.userId)
        .where('id', '=', input.chatId)
        .where('deletedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!chat) return null;

      const anchor = await trx
        .selectFrom('aiChatMessages')
        .select('id')
        .where('workspaceId', '=', input.workspaceId)
        .where('chatId', '=', input.chatId)
        .where('id', '=', input.anchorMessageId)
        .where('userId', '=', input.userId)
        .where('role', '=', 'user')
        .where('updatedAt', '=', input.anchorUpdatedAt)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      if (!anchor) return null;

      const message = await trx
        .insertInto('aiChatMessages')
        .values({
          workspaceId: input.workspaceId,
          chatId: input.chatId,
          userId: null,
          role: 'assistant',
          content: input.content,
          toolCalls: null,
          metadata: input.metadata,
        })
        .returningAll()
        .executeTakeFirst();

      return stripTsv(message);
    });
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
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(input.limit ?? 100)
      .execute();

    return rows.reverse().map(stripTsv);
  }
}

function stripTsv(row: AiChatMessage & { tsv?: string }): AiChatMessage {
  const { tsv: _tsv, ...message } = row;
  return message;
}

function buildTitle(content: string): string {
  const title = content.replace(/\s+/g, ' ').trim();
  return title.length > 60
    ? `${title.slice(0, 57)}...`
    : title || 'New question';
}

type MessageBoundary = {
  workspaceId: string;
  chatId: string;
  messageId: string;
};

/**
 * Keep the timestamp comparison inside PostgreSQL. `timestamptz` can contain
 * microseconds, while JavaScript Date only retains milliseconds. Comparing a
 * timestamp loaded into JavaScript can therefore classify the boundary row as
 * being after itself and soft-delete the edited user message.
 */
function messageIsAfter(input: MessageBoundary) {
  return sql<boolean>`
    (created_at, id) > (
      SELECT boundary.created_at, boundary.id
      FROM ai_chat_messages AS boundary
      WHERE boundary.workspace_id = ${input.workspaceId}
        AND boundary.chat_id = ${input.chatId}
        AND boundary.id = ${input.messageId}
    )
  `;
}

function messageIsBefore(input: MessageBoundary) {
  return sql<boolean>`
    (created_at, id) < (
      SELECT boundary.created_at, boundary.id
      FROM ai_chat_messages AS boundary
      WHERE boundary.workspace_id = ${input.workspaceId}
        AND boundary.chat_id = ${input.chatId}
        AND boundary.id = ${input.messageId}
    )
  `;
}
