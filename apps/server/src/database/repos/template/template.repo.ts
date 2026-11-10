import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { dbOrTx } from '@akasha/db/utils';
import {
  InsertableTemplate,
  Template,
  UpdatableTemplate,
} from '@akasha/db/types/entity.types';
import { PaginationOptions } from '../../pagination/pagination-options';
import { executeWithCursorPagination } from '@akasha/db/pagination/cursor-pagination';
import { ExpressionBuilder, sql } from 'kysely';
import { DB } from '@akasha/db/types/db';
import { jsonObjectFrom } from 'kysely/helpers/postgres';

/** 模板行 + 指定空间列表（allSpaces 为 true 时通常为空）。 */
export type TemplateRow = Template & { spaceIds: string[] };

export type TemplateSpaceFilter =
  /** 用户可见的全部：所有空间模板 + 指定到其可访问空间的模板 */
  | { mode: 'accessible' }
  /** 仅"所有空间"模板 */
  | { mode: 'allSpaces' }
  /** 明确指定到该空间的模板（不含"所有空间"模板） */
  | { mode: 'assignedTo'; spaceId: string }
  /** 在该空间可用：所有空间模板 + 指定到该空间的模板 */
  | { mode: 'availableIn'; spaceId: string };

@Injectable()
export class TemplateRepo {
  private baseFields: Array<keyof Template> = [
    'id',
    'title',
    'description',
    'icon',
    'allSpaces',
    'workspaceId',
    'creatorId',
    'lastUpdatedById',
    'createdAt',
    'updatedAt',
  ];

  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findById(
    templateId: string,
    workspaceId: string,
    opts?: { includeContent?: boolean; trx?: KyselyTransaction },
  ): Promise<TemplateRow> {
    const db = dbOrTx(this.db, opts?.trx);

    const query = db
      .selectFrom('templates')
      .select(this.baseFields)
      .$if(opts?.includeContent ?? false, (qb) => qb.select('content'))
      .select((eb) => [this.withCreator(eb), this.withSpaceIds(eb)])
      .where('id', '=', templateId)
      .where('workspaceId', '=', workspaceId);

    return query.executeTakeFirst() as Promise<TemplateRow>;
  }

  async findTemplates(
    workspaceId: string,
    accessibleSpaceIds: string[],
    pagination: PaginationOptions,
    filter: TemplateSpaceFilter,
    opts?: { includeContent?: boolean; isAdmin?: boolean; userId?: string },
  ) {
    let query = this.db
      .selectFrom('templates')
      .select(this.baseFields)
      .$if(opts?.includeContent ?? false, (qb) => qb.select('content'))
      .select((eb) => [this.withCreator(eb), this.withSpaceIds(eb)])
      .where('workspaceId', '=', workspaceId);

    const assignedToAny = (spaceIds: string[]) =>
      sql<boolean>`exists (
        select 1 from template_spaces ts
        where ts.template_id = templates.id
          and ts.space_id = any(${spaceIds}::uuid[])
      )`;

    switch (filter.mode) {
      case 'allSpaces':
        query = query.where('allSpaces', '=', true);
        break;
      case 'assignedTo':
      case 'availableIn': {
        // 无权访问的空间一律返回空
        if (!accessibleSpaceIds.includes(filter.spaceId)) {
          query = query.where(sql<boolean>`false`);
          break;
        }
        const assigned = assignedToAny([filter.spaceId]);
        query =
          filter.mode === 'assignedTo'
            ? query.where(assigned)
            : query.where((eb) => eb.or([eb('allSpaces', '=', true), assigned]));
        break;
      }
      default:
        // 管理员可以看到所有模板
        if (opts?.isAdmin) {
          // 不添加额外过滤条件，查询所有模板
        } else {
          // 普通用户：自己有权限空间的模板 + 自己创建的模板
          query = query.where((eb) =>
            eb.or([
              eb('allSpaces', '=', true),
              ...(accessibleSpaceIds.length > 0
                ? [assignedToAny(accessibleSpaceIds)]
                : []),
              ...(opts?.userId ? [eb('creatorId', '=', opts.userId)] : []),
            ]),
          );
        }
    }

    if (pagination.query) {
      const searchTerm = `%${pagination.query}%`;
      query = query.where((eb) =>
        eb.or([
          eb(sql`f_unaccent(title)`, 'ilike', sql`f_unaccent(${searchTerm})`),
          eb(
            sql`f_unaccent(description)`,
            'ilike',
            sql`f_unaccent(${searchTerm})`,
          ),
        ]),
      );
    }

    return executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [
        { expression: 'title', direction: 'asc' },
        { expression: 'id', direction: 'asc' },
      ],
      parseCursor: (cursor) => ({
        title: cursor.title,
        id: cursor.id,
      }),
    });
  }

  async insertTemplate(
    insertableTemplate: InsertableTemplate,
    trx?: KyselyTransaction,
  ): Promise<{ id: string }> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('templates')
      .values(insertableTemplate)
      .returning('id')
      .executeTakeFirst();
  }

  async updateTemplate(
    updatableTemplate: UpdatableTemplate,
    templateId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .updateTable('templates')
      .set({ ...updatableTemplate, updatedAt: new Date() })
      .where('id', '=', templateId)
      .where('workspaceId', '=', workspaceId)
      .execute();
  }

  /** 整体替换模板的指定空间列表。 */
  async setTemplateSpaces(
    templateId: string,
    spaceIds: string[],
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .deleteFrom('templateSpaces')
      .where('templateId', '=', templateId)
      .execute();
    if (spaceIds.length > 0) {
      await db
        .insertInto('templateSpaces')
        .values([...new Set(spaceIds)].map((spaceId) => ({ templateId, spaceId })))
        .execute();
    }
  }

  async deleteTemplate(
    templateId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .deleteFrom('templates')
      .where('id', '=', templateId)
      .where('workspaceId', '=', workspaceId)
      .execute();
  }

  withCreator(eb: ExpressionBuilder<DB, 'templates'>) {
    return jsonObjectFrom(
      eb
        .selectFrom('users')
        .select(['users.id', 'users.name', 'users.avatarUrl'])
        .whereRef('users.id', '=', 'templates.creatorId'),
    ).as('creator');
  }

  withSpaceIds(_eb: ExpressionBuilder<DB, 'templates'>) {
    return sql<string[]>`coalesce((
      select array_agg(ts.space_id order by ts.created_at, ts.space_id)
      from template_spaces ts
      where ts.template_id = templates.id
    ), '{}'::uuid[])`.as('spaceIds');
  }
}
