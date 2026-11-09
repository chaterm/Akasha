import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import { AnalyticsUsageQueryDto } from '../../../core/analytics/dto/analytics.dto';
import { AnalyticsRange, ANALYTICS_TIMEZONE } from './analytics-event.repo';

const n = (value: unknown) => Number(value ?? 0);
const iso = (value: unknown) =>
  value ? new Date(value as string).toISOString() : null;

@Injectable()
export class AnalyticsUsageRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  // Every query starts from the same workspace, time, attribution and filters.
  // Join metadata IDs as text: old events can contain missing/invalid IDs.
  private base(range: AnalyticsRange, query: AnalyticsUsageQueryDto) {
    const keyType = sql`coalesce(e.metadata->>'keyType', k.key_type,
      CASE WHEN u.user_type = 'agent' THEN 'agent' ELSE 'unknown' END)`;
    const userId = sql`coalesce(e.metadata->>'delegatedUserId',
      CASE WHEN u.user_type <> 'agent' THEN e.user_id::text END)`;
    const groupId =
      query.groupBy === 'key'
        ? sql`key_id`
        : query.groupBy === 'agent'
          ? sql`actor_id`
          : sql`attributed_user_id`;
    const groupName =
      query.groupBy === 'key'
        ? sql`key_name`
        : query.groupBy === 'agent'
          ? sql`actor_name`
          : sql`attributed_user_name`;
    const groupEmail =
      query.groupBy === 'key'
        ? sql`NULL::text`
        : query.groupBy === 'agent'
          ? sql`actor_email`
          : sql`attributed_user_email`;
    // Escape LIKE metacharacters so pasted IDs and tool names match literally.
    const search = `%${(query.search ?? '').trim().replace(/[\\%_]/g, '\\$&')}%`;
    return sql`
      WITH attributed AS (
        SELECT e.id, e.created_at, e.route AS op,
          e.user_id::text AS actor_id, u.name AS actor_name, u.email AS actor_email,
          ${userId} AS attributed_user_id,
          coalesce(d.name, CASE WHEN u.user_type <> 'agent' THEN u.name END) AS attributed_user_name,
          coalesce(d.email, CASE WHEN u.user_type <> 'agent' THEN u.email END) AS attributed_user_email,
          e.metadata->>'apiKeyId' AS key_id, k.name AS key_name,
          k.deleted_at AS key_deleted_at, k.expires_at AS key_expires_at,
          c.name AS creator_name, c.email AS creator_email,
          ${keyType} AS key_type, e.metadata->>'channel' AS channel,
          coalesce(e.metadata->>'outcome', 'called') AS outcome,
          (u.user_type = 'agent' OR ${keyType} = 'agent') AS is_agent
        FROM analytics_events e
        LEFT JOIN users u ON u.id = e.user_id AND u.workspace_id = e.workspace_id
        LEFT JOIN api_keys k ON k.id::text = e.metadata->>'apiKeyId' AND k.workspace_id = e.workspace_id
        LEFT JOIN users d ON d.id::text = e.metadata->>'delegatedUserId' AND d.workspace_id = e.workspace_id
        LEFT JOIN users c ON c.id = k.creator_id AND c.workspace_id = e.workspace_id
        WHERE e.workspace_id = ${range.workspaceId} AND e.event = 'agent_op'
          AND e.created_at >= ${range.from} AND e.created_at < ${range.to}
      ), grouped AS (
        SELECT *, coalesce(${groupId}, '__none__') AS group_id,
          ${groupName} AS group_name, ${groupEmail} AS group_email
        FROM attributed
        ${query.groupBy === 'agent' ? sql`WHERE is_agent` : sql``}
      ), filtered AS (
        SELECT * FROM grouped WHERE true
          ${
            query.search?.trim()
              ? sql`AND concat_ws(' ', actor_id, actor_name, actor_email,
            attributed_user_id, attributed_user_name, attributed_user_email,
            key_id, key_name, creator_name, creator_email) ILIKE ${search}`
              : sql``
          }
          ${query.keyType ? sql`AND key_type = ${query.keyType}` : sql``}
          ${query.channel ? sql`AND channel = ${query.channel}` : sql``}
          ${query.outcome ? sql`AND outcome = ${query.outcome}` : sql``}
          ${query.op ? sql`AND op = ${query.op}` : sql``}
          ${query.entityId ? sql`AND group_id = ${query.entityId}` : sql``}
      )
    `;
  }

  async overview(range: AnalyticsRange, query: AnalyticsUsageQueryDto) {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute((db) => this.readOverview(db, range, query));
  }

  private async readOverview(
    db: KyselyDB,
    range: AnalyticsRange,
    query: AnalyticsUsageQueryDto,
  ) {
    const base = this.base(range, query);
    const order = {
      ops: sql`ops`,
      failedOps: sql`failed_ops`,
      lastOpAt: sql`last_op_at`,
    }[query.sort];
    const direction = query.direction === 'asc' ? sql`ASC` : sql`DESC`;
    const hourly = range.to.getTime() - range.from.getTime() <= 86400000;
    const bucket = hourly ? 'hour' : 'day';
    const [summary, items, daily, byOp] = await Promise.all([
      sql<Record<string, unknown>>`${base}
        SELECT count(*) AS ops,
          count(*) FILTER (WHERE channel = 'api') AS api,
          count(*) FILTER (WHERE channel = 'mcp') AS mcp,
          count(*) FILTER (WHERE outcome = 'error') AS failed_ops,
          count(*) FILTER (WHERE outcome = 'called') AS unknown_ops,
          count(DISTINCT actor_id) FILTER (WHERE is_agent) AS active_agents,
          count(DISTINCT attributed_user_id) AS active_users,
          count(DISTINCT key_id) AS active_keys,
          count(DISTINCT group_id) AS total
        FROM filtered`.execute(db),
      sql<Record<string, unknown>>`${base}
        SELECT group_id AS id, group_name AS name, group_email AS email,
          string_agg(DISTINCT key_type, ', ' ORDER BY key_type) AS key_types,
          string_agg(DISTINCT coalesce(actor_name, actor_email, actor_id), ', ') AS actors,
          string_agg(DISTINCT coalesce(creator_name, creator_email), ', ') AS creators,
          CASE WHEN bool_or(key_deleted_at IS NOT NULL) THEN 'revoked'
            WHEN bool_or(key_expires_at <= now()) THEN 'expired' ELSE 'active' END AS status,
          count(*) AS ops,
          count(*) FILTER (WHERE channel = 'api') AS api,
          count(*) FILTER (WHERE channel = 'mcp') AS mcp,
          count(*) FILTER (WHERE outcome = 'error') AS failed_ops,
          count(*) FILTER (WHERE outcome = 'called') AS unknown_ops,
          count(DISTINCT key_id) AS key_count, max(created_at) AS last_op_at
        FROM filtered GROUP BY group_id, group_name, group_email
        ORDER BY ${order} ${direction}, group_id
        LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`.execute(
        db,
      ),
      sql<Record<string, unknown>>`${base}, buckets AS (
          SELECT generate_series(
            ${range.from}::timestamptz AT TIME ZONE ${ANALYTICS_TIMEZONE},
            (${range.to}::timestamptz AT TIME ZONE ${ANALYTICS_TIMEZONE}) - interval '1 second',
            ${hourly ? '1 hour' : '1 day'}::interval) AS bucket
        ), counts AS (
          SELECT date_trunc(${bucket}, created_at AT TIME ZONE ${ANALYTICS_TIMEZONE}) AS bucket,
            count(*) FILTER (WHERE channel = 'api') AS api,
            count(*) FILTER (WHERE channel = 'mcp') AS mcp
          FROM filtered GROUP BY 1
        )
        SELECT to_char(b.bucket, ${hourly ? 'YYYY-MM-DD HH24:00' : 'YYYY-MM-DD'}) AS date,
          coalesce(c.api, 0) AS api, coalesce(c.mcp, 0) AS mcp
        FROM buckets b LEFT JOIN counts c USING (bucket) ORDER BY b.bucket`.execute(
        db,
      ),
      sql<Record<string, unknown>>`${base}
        SELECT op, count(*) AS count FROM filtered GROUP BY op ORDER BY count DESC, op`.execute(
        db,
      ),
    ]);
    const s = summary.rows[0];
    return {
      updatedAt: new Date().toISOString(),
      summary: {
        ops: n(s.ops),
        api: n(s.api),
        mcp: n(s.mcp),
        failedOps: n(s.failedOps),
        unknownOps: n(s.unknownOps),
        activeAgents: n(s.activeAgents),
        activeUsers: n(s.activeUsers),
        activeKeys: n(s.activeKeys),
      },
      total: n(s.total),
      page: query.page,
      limit: query.limit,
      items: items.rows.map((r) => ({
        id: String(r.id),
        name: r.name as string | null,
        email: r.email as string | null,
        keyTypes: String(r.keyTypes).split(', '),
        actors: r.actors as string | null,
        creators: r.creators as string | null,
        status: String(r.status),
        ops: n(r.ops),
        api: n(r.api),
        mcp: n(r.mcp),
        failedOps: n(r.failedOps),
        unknownOps: n(r.unknownOps),
        keyCount: n(r.keyCount),
        lastOpAt: iso(r.lastOpAt),
      })),
      daily: daily.rows.map((r) => ({
        date: String(r.date),
        api: n(r.api),
        mcp: n(r.mcp),
      })),
      byOp: byOp.rows.map((r) => ({ op: String(r.op), count: n(r.count) })),
    };
  }

  async events(range: AnalyticsRange, query: AnalyticsUsageQueryDto) {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute((db) => this.readEvents(db, range, query));
  }

  private async readEvents(
    db: KyselyDB,
    range: AnalyticsRange,
    query: AnalyticsUsageQueryDto,
  ) {
    const base = this.base(range, query);
    const [count, events] = await Promise.all([
      sql<
        Record<string, unknown>
      >`${base} SELECT count(*) AS total FROM filtered`.execute(db),
      sql<Record<string, unknown>>`${base}
        SELECT id, created_at, op, actor_id, actor_name, actor_email,
          attributed_user_id, attributed_user_name, attributed_user_email,
          key_id, key_name, key_type, channel, outcome
        FROM filtered ORDER BY created_at DESC, id DESC
        LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`.execute(
        db,
      ),
    ]);
    return {
      total: n(count.rows[0].total),
      page: query.page,
      limit: query.limit,
      items: events.rows.map((r) => ({
        id: String(r.id),
        createdAt: iso(r.createdAt),
        op: String(r.op),
        actorId: r.actorId,
        actorName: r.actorName,
        actorEmail: r.actorEmail,
        userId: r.attributedUserId,
        userName: r.attributedUserName,
        userEmail: r.attributedUserEmail,
        keyId: r.keyId,
        keyName: r.keyName,
        keyType: r.keyType,
        channel: r.channel,
        outcome: r.outcome,
      })),
    };
  }
}
