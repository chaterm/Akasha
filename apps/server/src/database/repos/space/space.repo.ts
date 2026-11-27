import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { dbOrTx } from '@akasha/db/utils';
import {
  InsertableSpace,
  Space,
  UpdatableSpace,
} from '@akasha/db/types/entity.types';
import { ExpressionBuilder, SelectQueryBuilder, sql } from 'kysely';
import { SpaceListOptions } from './types';
import {
  emptyCursorPaginationResult,
  executeWithCursorPagination,
} from '@akasha/db/pagination/cursor-pagination';
import { DB } from '@akasha/db/types/db';
import { DbInterface } from '@akasha/db/types/db.interface';
import { validate as isValidUUID } from 'uuid';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventName } from '../../../common/events/event.contants';

@Injectable()
export class SpaceRepo {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private eventEmitter: EventEmitter2,
  ) {}

  async findById(
    spaceId: string,
    workspaceId: string,
    opts?: { includeMemberCount?: boolean; trx?: KyselyTransaction },
  ): Promise<Space> {
    const db = dbOrTx(this.db, opts?.trx);

    let query = db
      .selectFrom('spaces')
      .selectAll('spaces')
      .$if(opts?.includeMemberCount, (qb) => qb.select(this.withMemberCount))
      .where('workspaceId', '=', workspaceId);

    if (isValidUUID(spaceId)) {
      query = query.where('id', '=', spaceId);
    } else {
      query = query.where(sql`LOWER(slug)`, '=', sql`LOWER(${spaceId})`);
    }
    return query.executeTakeFirst();
  }

  async findPersonalSpaceForUser(opts: {
    userId: string;
    workspaceId: string;
    trx?: KyselyTransaction;
  }): Promise<Space | undefined> {
    const db = dbOrTx(this.db, opts.trx);
    return db
      .selectFrom('spaces')
      .selectAll('spaces')
      .where('workspaceId', '=', opts.workspaceId)
      .where('personalOwnerId', '=', opts.userId)
      .where('isDefaultPersonal', '=', true)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  async findPersonalSpacesForUser(opts: {
    userId: string;
    workspaceId: string;
    trx?: KyselyTransaction;
  }): Promise<Space[]> {
    const db = dbOrTx(this.db, opts.trx);

    return db
      .selectFrom('spaces')
      .selectAll('spaces')
      .where('workspaceId', '=', opts.workspaceId)
      .where('personalOwnerId', '=', opts.userId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .execute();
  }

  async lockPersonalSpacesForUser(
    userId: string,
    workspaceId: string,
    trx: KyselyTransaction,
  ): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}), hashtext(${userId}))`.execute(
      trx,
    );
  }

  async insertPersonalSpace(
    insertableSpace: InsertableSpace,
    trx?: KyselyTransaction,
  ): Promise<Space | undefined> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('spaces')
      .values({ ...insertableSpace, isDefaultPersonal: true })
      .returningAll()
      .executeTakeFirst();
  }

  async findBySlug(
    slug: string,
    workspaceId: string,
    opts?: { includeMemberCount: boolean },
  ): Promise<Space> {
    return await this.db
      .selectFrom('spaces')
      .selectAll('spaces')
      .$if(opts?.includeMemberCount, (qb) => qb.select(this.withMemberCount))
      .where(sql`LOWER(slug)`, '=', sql`LOWER(${slug})`)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  async slugExists(
    slug: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<boolean> {
    const db = dbOrTx(this.db, trx);
    let { count } = await db
      .selectFrom('spaces')
      .select((eb) => eb.fn.count('id').as('count'))
      .where(sql`LOWER(slug)`, '=', sql`LOWER(${slug})`)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    count = count as number;
    return count != 0;
  }

  async updateSpace(
    updatableSpace: UpdatableSpace,
    spaceId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ) {
    const db = dbOrTx(this.db, trx);
    return db
      .updateTable('spaces')
      .set({ ...updatableSpace, updatedAt: new Date() })
      .where('id', '=', spaceId)
      .where('workspaceId', '=', workspaceId)
      .returningAll()
      .executeTakeFirst();
  }

  async updateSharingSettings(
    spaceId: string,
    workspaceId: string,
    prefKey: string,
    prefValue: string | boolean,
    trx?: KyselyTransaction,
  ) {
    const db = dbOrTx(this.db, trx);
    return db
      .updateTable('spaces')
      .set({
        settings: sql`COALESCE(settings, '{}'::jsonb)
          || jsonb_build_object('sharing', COALESCE(settings->'sharing', '{}'::jsonb)
          || jsonb_build_object('${sql.raw(prefKey)}', ${sql.lit(prefValue)}))`,
        updatedAt: new Date(),
      })
      .where('id', '=', spaceId)
      .where('workspaceId', '=', workspaceId)
      .returningAll()
      .executeTakeFirst();
  }

  async updateCommentSettings(
    spaceId: string,
    workspaceId: string,
    prefKey: string,
    prefValue: string | boolean,
    trx?: KyselyTransaction,
  ) {
    const db = dbOrTx(this.db, trx);
    return db
      .updateTable('spaces')
      .set({
        settings: sql`COALESCE(settings, '{}'::jsonb)
          || jsonb_build_object('comments', COALESCE(settings->'comments', '{}'::jsonb)
          || jsonb_build_object('${sql.raw(prefKey)}', ${sql.lit(prefValue)}))`,
        updatedAt: new Date(),
      })
      .where('id', '=', spaceId)
      .where('workspaceId', '=', workspaceId)
      .returningAll()
      .executeTakeFirst();
  }

  async updateKnowledgeSettings(
    spaceId: string,
    workspaceId: string,
    prefKey: string,
    prefValue: string | boolean,
    trx?: KyselyTransaction,
  ) {
    const db = dbOrTx(this.db, trx);
    return db
      .updateTable('spaces')
      .set({
        settings: sql`COALESCE(settings, '{}'::jsonb)
          || jsonb_build_object('knowledge', COALESCE(settings->'knowledge', '{}'::jsonb)
          || jsonb_build_object('${sql.raw(prefKey)}', ${sql.lit(prefValue)}))`,
        updatedAt: new Date(),
      })
      .where('id', '=', spaceId)
      .where('workspaceId', '=', workspaceId)
      .returningAll()
      .executeTakeFirst();
  }

  async insertSpace(
    insertableSpace: InsertableSpace,
    trx?: KyselyTransaction,
  ): Promise<Space> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('spaces')
      .values(insertableSpace)
      .returningAll()
      .executeTakeFirst();
  }

  async getSpacesInWorkspace(
    workspaceId: string,
    pagination: SpaceListOptions,
    allowedSpaceIds?: string[],
  ) {
    if (allowedSpaceIds?.length === 0) {
      return emptyCursorPaginationResult<Space>(pagination.limit, 0);
    }
    let query = this.db
      .selectFrom('spaces')
      .selectAll('spaces')
      .select((eb) => [this.withMemberCount(eb)])
      .where('workspaceId', '=', workspaceId);

    if (allowedSpaceIds) {
      query = query.where('id', 'in', allowedSpaceIds);
    }
    if (pagination.type === 'created-personal') {
      query = query
        .where('personalOwnerId', '=', pagination.ownerId)
        .where((eb) =>
          eb.or([
            eb('isDefaultPersonal', '=', true),
            eb('creatorId', '=', pagination.ownerId),
          ]),
        )
        .where('deletedAt', 'is', null);
    } else if (pagination.type === 'favorites') {
      query = query
        .where('deletedAt', 'is', null)
        .where((eb) => this.isFavoritedBy(eb, pagination.favoriteUserId));
    } else if (pagination.type) {
      query = query.where(
        'personalOwnerId',
        pagination.type === 'personal' ? 'is not' : 'is',
        null,
      );
    }

    if (pagination.type === 'personal') {
      if (pagination.personalKind) {
        query = query
          .where(
            'isDefaultPersonal',
            '=',
            pagination.personalKind === 'default',
          )
          .where('deletedAt', 'is', null);
      }
      const ownerQuery = pagination.ownerQuery?.trim();
      if (ownerQuery) {
        const pattern = sql`f_unaccent(${'%' + ownerQuery + '%'})`;
        query = query.where((eb) =>
          eb.exists(
            eb
              .selectFrom('users as owner')
              .select('owner.id')
              .whereRef('owner.id', '=', 'spaces.personalOwnerId')
              .whereRef('owner.workspaceId', '=', 'spaces.workspaceId')
              .where((owner) =>
                owner.or([
                  owner(sql`f_unaccent(owner.name)`, 'ilike', pattern),
                  owner(sql`f_unaccent(owner.email)`, 'ilike', pattern),
                ]),
              ),
          ),
        );
      }
    }

    if (pagination.query) {
      query = query.where((eb) =>
        eb(
          sql`f_unaccent(name)`,
          'ilike',
          sql`f_unaccent(${'%' + pagination.query + '%'})`,
        ).or(
          sql`f_unaccent(description)`,
          'ilike',
          sql`f_unaccent(${'%' + pagination.query + '%'})`,
        ),
      );
    }

    return this.paginateSpaces(query, pagination);
  }

  async paginateSpaces(
    query: SelectQueryBuilder<
      DbInterface,
      'spaces',
      Space & { memberCount: number | string | bigint }
    >,
    pagination: SpaceListOptions,
  ) {
    const count = await query
      .clearSelect()
      .select((eb) => eb.fn.countAll().as('total'))
      .executeTakeFirstOrThrow();
    const page = {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
    };
    const fields = [
      { expression: 'name', key: 'name', direction: 'asc' },
      { expression: 'id', key: 'id', direction: 'asc' },
    ] as const;

    if (pagination.sortByType) {
      const spaceTypeOrder = sql<number>`case
        when ${sql.ref('personalOwnerId')} is null then 0
        when ${sql.ref('isDefaultPersonal')} then 1
        else 2
      end`;
      const result = await executeWithCursorPagination(
        query.select(spaceTypeOrder.as('spaceTypeOrder')),
        {
          ...page,
          fields: [
            {
              expression: spaceTypeOrder,
              key: 'spaceTypeOrder',
              direction: 'asc',
            },
            ...fields,
          ],
          parseCursor: ({ spaceTypeOrder, name, id }) => ({
            spaceTypeOrder: Number(spaceTypeOrder),
            name,
            id,
          }),
        },
      );
      return {
        items: result.items.map(
          ({ spaceTypeOrder: _spaceTypeOrder, ...space }) => space,
        ),
        meta: { ...result.meta, total: Number(count.total) },
      };
    }

    const result = await executeWithCursorPagination(query, {
      ...page,
      fields: [
        ...(pagination.type === 'created-personal'
          ? [
              {
                expression: 'isDefaultPersonal',
                key: 'isDefaultPersonal',
                direction: 'desc',
              } as const,
            ]
          : []),
        ...fields,
      ],
      parseCursor: (cursor) => ({
        isDefaultPersonal: cursor.isDefaultPersonal === 'true',
        name: cursor.name,
        id: cursor.id,
      }),
    });
    return { ...result, meta: { ...result.meta, total: Number(count.total) } };
  }

  withMemberCount(eb: ExpressionBuilder<DB, 'spaces'>) {
    const subquery = eb
      .selectFrom('spaceMembers')
      .select('spaceMembers.userId')
      .where('spaceMembers.userId', 'is not', null)
      .whereRef('spaceMembers.spaceId', '=', 'spaces.id')
      .union(
        eb
          .selectFrom('spaceMembers')
          .where('spaceMembers.groupId', 'is not', null)
          .leftJoin('groups', 'groups.id', 'spaceMembers.groupId')
          .leftJoin('groupUsers', 'groupUsers.groupId', 'groups.id')
          .select('groupUsers.userId')
          .whereRef('spaceMembers.spaceId', '=', 'spaces.id'),
      )
      .as('userId');

    return eb
      .selectFrom(subquery)
      .select((eb) => eb.fn.count('userId').as('count'))
      .as('memberCount');
  }

  isFavoritedBy(eb: ExpressionBuilder<DB, 'spaces'>, userId?: string) {
    if (!userId) return eb.val(false);
    return eb.exists(
      eb
        .selectFrom('favorites')
        .select('favorites.id')
        .where('favorites.userId', '=', userId)
        .where('favorites.type', '=', 'space')
        .whereRef('favorites.spaceId', '=', 'spaces.id')
        .whereRef('favorites.workspaceId', '=', 'spaces.workspaceId'),
    );
  }

  async deleteSpace(spaceId: string, workspaceId: string): Promise<void> {
    await this.db
      .deleteFrom('spaces')
      .where('id', '=', spaceId)
      .where('workspaceId', '=', workspaceId)
      .execute();

    this.eventEmitter.emit(EventName.SPACE_DELETED, {
      spaceId,
    });
  }
}
