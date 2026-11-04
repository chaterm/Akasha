import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';

export const ANALYTICS_EVENT = {
  PAGE_VIEW: 'page_view',
  SPACE_DELETED: 'space_deleted',
  AGENT_OP: 'agent_op',
} as const;

// Days are bucketed in this timezone so charts line up with the team's day.
export const ANALYTICS_TIMEZONE = 'Asia/Shanghai';

export interface AnalyticsRange {
  workspaceId: string;
  from: Date; // inclusive, start of first local day
  to: Date; // exclusive, start of the day after the last local day
  spaceId?: string;
}

export interface DailyRow {
  date: string;
  pv: number;
  uv: number;
  newPages: number;
  pageEdits: number;
  // Distinct active users in the 7 / 30 local days ending on `date`.
  wau: number;
  mau: number;
  newUsers?: number;
  newSpaces?: number;
  aiQuestions?: number;
  userCount?: number;
  spaceCount?: number;
}

const toInt = (value: unknown): number => Number(value ?? 0);

@Injectable()
export class AnalyticsEventRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async insertPageView(input: {
    workspaceId: string;
    userId: string;
    route: string;
    spaceId?: string | null;
    pageId?: string | null;
  }): Promise<void> {
    await this.db
      .insertInto('analyticsEvents')
      .values({
        workspaceId: input.workspaceId,
        userId: input.userId,
        event: ANALYTICS_EVENT.PAGE_VIEW,
        route: input.route,
        spaceId: input.spaceId ?? null,
        pageId: input.pageId ?? null,
      })
      .execute();
  }

  async insertSpaceDeleted(input: {
    workspaceId: string;
    userId?: string | null;
    spaceId: string;
    spaceCreatedAt: Date;
    name: string | null;
  }): Promise<void> {
    await this.db
      .insertInto('analyticsEvents')
      .values({
        workspaceId: input.workspaceId,
        userId: input.userId ?? null,
        event: ANALYTICS_EVENT.SPACE_DELETED,
        spaceId: input.spaceId,
        metadata: {
          spaceCreatedAt: input.spaceCreatedAt.toISOString(),
          name: input.name,
        },
      })
      .execute();
  }

  /**
   * One call made with an agent API key. `op` is the endpoint capability
   * (e.g. 'page.read') or 'mcp:<tool>' for MCP tool calls.
   */
  async insertAgentOp(input: {
    workspaceId: string;
    agentUserId: string;
    op: string;
    channel: 'api' | 'mcp';
    /** Null for SSO-token MCP calls. */
    apiKeyId: string | null;
    /** Credential behind the call; absent on rows written before it existed. */
    keyType?: 'agent' | 'personal' | 'sso';
    delegatedUserId?: string | null;
    outcome: 'ok' | 'error' | 'called';
  }): Promise<void> {
    await this.db
      .insertInto('analyticsEvents')
      .values({
        workspaceId: input.workspaceId,
        userId: input.agentUserId,
        event: ANALYTICS_EVENT.AGENT_OP,
        route: input.op.slice(0, 64),
        metadata: {
          channel: input.channel,
          apiKeyId: input.apiKeyId,
          keyType: input.keyType ?? 'agent',
          delegatedUserId: input.delegatedUserId ?? null,
          outcome: input.outcome,
        },
      })
      .execute();
  }

  /** Expires high-volume events; space_deleted is kept for history. */
  async deleteExpiredEventsBefore(cutoff: Date): Promise<number> {
    const result = await this.db
      .deleteFrom('analyticsEvents')
      .where('event', 'in', [
        ANALYTICS_EVENT.PAGE_VIEW,
        ANALYTICS_EVENT.AGENT_OP,
      ])
      .where('createdAt', '<', cutoff)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  async findTrackingSince(workspaceId: string): Promise<Date | null> {
    const row = await this.db
      .selectFrom('analyticsEvents')
      .select((eb) => eb.fn.min('createdAt').as('first'))
      .where('workspaceId', '=', workspaceId)
      .where('event', '=', ANALYTICS_EVENT.PAGE_VIEW)
      .executeTakeFirst();
    return row?.first ? new Date(row.first as any) : null;
  }

  /**
   * Headline numbers for the range. Workspace-only metrics are omitted when
   * scoped to a space because they have no reliable space attribution.
   */
  async summarize(range: AnalyticsRange) {
    const { workspaceId, from, to, spaceId } = range;
    const spaceFilter = spaceId ? sql`AND space_id = ${spaceId}` : sql``;

    const base = await sql<Record<string, unknown>>`
      SELECT
        (SELECT count(*) FROM analytics_events
          WHERE workspace_id = ${workspaceId} AND event = 'page_view'
            AND created_at >= ${from} AND created_at < ${to} ${spaceFilter}) AS pv,
        (SELECT count(DISTINCT user_id) FROM analytics_events
          WHERE workspace_id = ${workspaceId} AND event = 'page_view'
            AND created_at >= ${from} AND created_at < ${to} ${spaceFilter}) AS uv,
        (SELECT count(*) FROM pages
          WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL ${spaceFilter}) AS total_pages,
        (SELECT count(*) FROM pages
          WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL
            AND created_at >= ${from} AND created_at < ${to} ${spaceFilter}) AS new_pages,
        (SELECT count(*) FROM page_history
          WHERE workspace_id = ${workspaceId}
            AND created_at >= ${from} AND created_at < ${to} ${spaceFilter}) AS page_edits,
        (SELECT count(*) FROM comments
          WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL
            AND created_at >= ${from} AND created_at < ${to} ${spaceFilter}) AS comments
    `.execute(this.db);

    const row = base.rows[0] ?? {};
    const summary: Record<string, number> = {
      pv: toInt(row.pv),
      uv: toInt(row.uv),
      totalPages: toInt(row.totalPages),
      newPages: toInt(row.newPages),
      pageEdits: toInt(row.pageEdits),
      comments: toInt(row.comments),
    };
    if (spaceId) return summary;

    const ws = await sql<Record<string, unknown>>`
      SELECT
        (SELECT count(*) FROM users
          WHERE workspace_id = ${workspaceId} AND user_type <> 'agent'
            AND deleted_at IS NULL AND deactivated_at IS NULL) AS total_users,
        (SELECT count(*) FROM users
          WHERE workspace_id = ${workspaceId} AND user_type <> 'agent'
            AND deleted_at IS NULL
            AND created_at >= ${from} AND created_at < ${to}) AS new_users,
        (SELECT count(*) FROM spaces
          WHERE workspace_id = ${workspaceId} AND personal_owner_id IS NULL) AS total_spaces,
        (SELECT count(*) FROM spaces
          WHERE workspace_id = ${workspaceId} AND personal_owner_id IS NULL
            AND created_at >= ${from} AND created_at < ${to}) AS new_spaces,
        (SELECT count(*) FROM ai_chat_messages
          WHERE workspace_id = ${workspaceId} AND role = 'user' AND deleted_at IS NULL
            AND created_at >= ${from} AND created_at < ${to}) AS ai_questions,
        (SELECT count(DISTINCT user_id) FROM ai_chat_messages
          WHERE workspace_id = ${workspaceId} AND role = 'user' AND deleted_at IS NULL
            AND created_at >= ${from} AND created_at < ${to}) AS ai_askers
    `.execute(this.db);

    const w = ws.rows[0] ?? {};
    return {
      ...summary,
      totalUsers: toInt(w.totalUsers),
      newUsers: toInt(w.newUsers),
      totalSpaces: toInt(w.totalSpaces),
      newSpaces: toInt(w.newSpaces),
      aiQuestions: toInt(w.aiQuestions),
      aiAskers: toInt(w.aiAskers),
    };
  }

  /**
   * One row per local day in [from, to), zero-filled. Stock counts (users,
   * public spaces) are reconstructed per day; deleted spaces are added back
   * from space_deleted events so the curve does not drop retroactively.
   * Personal spaces cannot be deleted, so every space_deleted is public.
   */
  async dailySeries(range: AnalyticsRange): Promise<DailyRow[]> {
    const { workspaceId, from, to, spaceId } = range;
    const tz = ANALYTICS_TIMEZONE;
    const spaceFilter = spaceId ? sql`AND space_id = ${spaceId}` : sql``;
    const day = (col: string) =>
      sql`(${sql.raw(col)} AT TIME ZONE ${tz})::date`;

    const result = await sql<Record<string, unknown>>`
      WITH days AS (
        SELECT d::date AS day,
               ((d::date + 1)::timestamp AT TIME ZONE ${tz}) AS day_end
        FROM generate_series(
          (${from}::timestamptz AT TIME ZONE ${tz})::date,
          (${to}::timestamptz AT TIME ZONE ${tz})::date - 1,
          interval '1 day'
        ) AS d
      ),
      pv AS (
        SELECT ${day('created_at')} AS day, count(*) AS pv, count(DISTINCT user_id) AS uv
        FROM analytics_events
        WHERE workspace_id = ${workspaceId} AND event = 'page_view'
          AND created_at >= ${from} AND created_at < ${to} ${spaceFilter}
        GROUP BY 1
      ),
      -- One row per (user, active day), reaching back 29 days before the range
      -- so the first rows of the rolling windows are complete.
      active AS (
        SELECT DISTINCT user_id, ${day('created_at')} AS day
        FROM analytics_events
        WHERE workspace_id = ${workspaceId} AND event = 'page_view'
          AND user_id IS NOT NULL
          AND created_at >= ${from}::timestamptz - interval '29 days'
          AND created_at < ${to} ${spaceFilter}
      ),
      rolling AS (
        SELECT days.day,
               count(DISTINCT a.user_id) FILTER (WHERE a.day > days.day - 7) AS wau,
               count(DISTINCT a.user_id) AS mau
        FROM days
        LEFT JOIN active a ON a.day > days.day - 30 AND a.day <= days.day
        GROUP BY days.day
      ),
      np AS (
        SELECT ${day('created_at')} AS day, count(*) AS n FROM pages
        WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL
          AND created_at >= ${from} AND created_at < ${to} ${spaceFilter}
        GROUP BY 1
      ),
      pe AS (
        SELECT ${day('created_at')} AS day, count(*) AS n FROM page_history
        WHERE workspace_id = ${workspaceId}
          AND created_at >= ${from} AND created_at < ${to} ${spaceFilter}
        GROUP BY 1
      )
      SELECT to_char(days.day, 'YYYY-MM-DD') AS date,
             coalesce(pv.pv, 0) AS pv,
             coalesce(pv.uv, 0) AS uv,
             coalesce(np.n, 0) AS new_pages,
             coalesce(pe.n, 0) AS page_edits,
             rolling.wau,
             rolling.mau
      FROM days
      JOIN rolling ON rolling.day = days.day
      LEFT JOIN pv ON pv.day = days.day
      LEFT JOIN np ON np.day = days.day
      LEFT JOIN pe ON pe.day = days.day
      ORDER BY days.day
    `.execute(this.db);

    const rows: DailyRow[] = result.rows.map((r) => ({
      date: String(r.date),
      pv: toInt(r.pv),
      uv: toInt(r.uv),
      newPages: toInt(r.newPages),
      pageEdits: toInt(r.pageEdits),
      wau: toInt(r.wau),
      mau: toInt(r.mau),
    }));
    if (spaceId) return rows;

    const wsResult = await sql<Record<string, unknown>>`
      WITH days AS (
        SELECT d::date AS day,
               ((d::date + 1)::timestamp AT TIME ZONE ${tz}) AS day_end
        FROM generate_series(
          (${from}::timestamptz AT TIME ZONE ${tz})::date,
          (${to}::timestamptz AT TIME ZONE ${tz})::date - 1,
          interval '1 day'
        ) AS d
      ),
      nu AS (
        SELECT ${day('created_at')} AS day, count(*) AS n FROM users
        WHERE workspace_id = ${workspaceId} AND user_type <> 'agent'
          AND deleted_at IS NULL
          AND created_at >= ${from} AND created_at < ${to}
        GROUP BY 1
      ),
      ns AS (
        SELECT ${day('created_at')} AS day, count(*) AS n FROM spaces
        WHERE workspace_id = ${workspaceId} AND personal_owner_id IS NULL
          AND created_at >= ${from} AND created_at < ${to}
        GROUP BY 1
      ),
      aq AS (
        SELECT ${day('created_at')} AS day, count(*) AS n FROM ai_chat_messages
        WHERE workspace_id = ${workspaceId} AND role = 'user' AND deleted_at IS NULL
          AND created_at >= ${from} AND created_at < ${to}
        GROUP BY 1
      )
      SELECT
        coalesce(nu.n, 0) AS new_users,
        coalesce(ns.n, 0) AS new_spaces,
        coalesce(aq.n, 0) AS ai_questions,
        (SELECT count(*) FROM users u
          WHERE u.workspace_id = ${workspaceId} AND u.user_type <> 'agent'
            AND u.created_at < days.day_end
            AND (u.deleted_at IS NULL OR u.deleted_at >= days.day_end)
            AND (u.deactivated_at IS NULL OR u.deactivated_at >= days.day_end)
        ) AS user_count,
        (SELECT count(*) FROM spaces s
          WHERE s.workspace_id = ${workspaceId} AND s.personal_owner_id IS NULL
            AND s.created_at < days.day_end)
        + (SELECT count(*) FROM analytics_events e
          WHERE e.workspace_id = ${workspaceId} AND e.event = 'space_deleted'
            AND (e.metadata->>'spaceCreatedAt')::timestamptz < days.day_end
            AND e.created_at >= days.day_end
        ) AS space_count
      FROM days
      LEFT JOIN nu ON nu.day = days.day
      LEFT JOIN ns ON ns.day = days.day
      LEFT JOIN aq ON aq.day = days.day
      ORDER BY days.day
    `.execute(this.db);

    return rows.map((row, i) => {
      const w = wsResult.rows[i] ?? {};
      return {
        ...row,
        newUsers: toInt(w.newUsers),
        newSpaces: toInt(w.newSpaces),
        aiQuestions: toInt(w.aiQuestions),
        userCount: toInt(w.userCount),
        spaceCount: toInt(w.spaceCount),
      };
    });
  }

  async topSpaces(range: AnalyticsRange, limit = 10) {
    const { workspaceId, from, to } = range;
    const result = await sql<Record<string, unknown>>`
      SELECT s.id AS space_id, s.name, s.slug, s.logo,
             count(*) AS pv, count(DISTINCT e.user_id) AS uv
      FROM analytics_events e
      JOIN spaces s ON s.id = e.space_id
      WHERE e.workspace_id = ${workspaceId} AND e.event = 'page_view'
        AND e.created_at >= ${from} AND e.created_at < ${to}
      GROUP BY s.id
      ORDER BY pv DESC, s.id
      LIMIT ${limit}
    `.execute(this.db);
    return result.rows.map((r) => ({
      spaceId: String(r.spaceId),
      name: (r.name as string) ?? null,
      slug: String(r.slug),
      logo: (r.logo as string) ?? null,
      pv: toInt(r.pv),
      uv: toInt(r.uv),
    }));
  }

  async topPages(range: AnalyticsRange, limit = 10) {
    const { workspaceId, from, to, spaceId } = range;
    const spaceFilter = spaceId ? sql`AND e.space_id = ${spaceId}` : sql``;
    const result = await sql<Record<string, unknown>>`
      SELECT p.id AS page_id, p.title, p.icon, p.slug_id,
             s.id AS space_id, s.name AS space_name, s.slug AS space_slug,
             count(*) AS pv, count(DISTINCT e.user_id) AS uv
      FROM analytics_events e
      JOIN pages p ON p.id = e.page_id AND p.deleted_at IS NULL
      JOIN spaces s ON s.id = p.space_id
      WHERE e.workspace_id = ${workspaceId} AND e.event = 'page_view'
        AND e.created_at >= ${from} AND e.created_at < ${to} ${spaceFilter}
      GROUP BY p.id, s.id
      ORDER BY pv DESC, p.id
      LIMIT ${limit}
    `.execute(this.db);
    return result.rows.map((r) => ({
      pageId: String(r.pageId),
      title: (r.title as string) ?? null,
      icon: (r.icon as string) ?? null,
      slugId: String(r.slugId),
      spaceId: String(r.spaceId),
      spaceName: (r.spaceName as string) ?? null,
      spaceSlug: String(r.spaceSlug),
      pv: toInt(r.pv),
      uv: toInt(r.uv),
    }));
  }

  /** Most active users by page views, with page edits alongside. */
  async topUsers(range: AnalyticsRange, limit = 10) {
    const { workspaceId, from, to, spaceId } = range;
    const viewSpace = spaceId ? sql`AND space_id = ${spaceId}` : sql``;
    const result = await sql<Record<string, unknown>>`
      WITH v AS (
        SELECT user_id, count(*) AS pv FROM analytics_events
        WHERE workspace_id = ${workspaceId} AND event = 'page_view'
          AND user_id IS NOT NULL
          AND created_at >= ${from} AND created_at < ${to} ${viewSpace}
        GROUP BY user_id
      ),
      ed AS (
        SELECT last_updated_by_id AS user_id, count(*) AS edits FROM page_history
        WHERE workspace_id = ${workspaceId} AND last_updated_by_id IS NOT NULL
          AND created_at >= ${from} AND created_at < ${to} ${viewSpace}
        GROUP BY last_updated_by_id
      )
      SELECT u.id AS user_id, u.name, u.email, u.avatar_url,
             coalesce(v.pv, 0) AS pv, coalesce(ed.edits, 0) AS edits
      FROM (SELECT user_id FROM v UNION SELECT user_id FROM ed) ids
      JOIN users u ON u.id = ids.user_id
      LEFT JOIN v ON v.user_id = ids.user_id
      LEFT JOIN ed ON ed.user_id = ids.user_id
      ORDER BY pv DESC, edits DESC, u.id
      LIMIT ${limit}
    `.execute(this.db);
    return result.rows.map((r) => ({
      userId: String(r.userId),
      name: (r.name as string) ?? null,
      email: String(r.email),
      avatarUrl: (r.avatarUrl as string) ?? null,
      pv: toInt(r.pv),
      edits: toInt(r.edits),
    }));
  }

  /**
   * Agent (API key) usage. Agent counts come from users; operation counts
   * come from agent_op events and so start when tracking was deployed.
   */
  async agentSummary(range: AnalyticsRange) {
    const { workspaceId, from, to } = range;
    const tz = ANALYTICS_TIMEZONE;

    const totals = await sql<Record<string, unknown>>`
      SELECT
        (SELECT count(*) FROM users
          WHERE workspace_id = ${workspaceId} AND user_type = 'agent'
            AND deleted_at IS NULL AND deactivated_at IS NULL) AS total_agents,
        (SELECT count(*) FROM users
          WHERE workspace_id = ${workspaceId} AND user_type = 'agent'
            AND deleted_at IS NULL
            AND created_at >= ${from} AND created_at < ${to}) AS new_agents,
        -- MCP calls made with personal keys are recorded under the human user,
        -- so only agent accounts count as active agents.
        (SELECT count(DISTINCT e.user_id) FROM analytics_events e
          JOIN users u ON u.id = e.user_id AND u.user_type = 'agent'
          WHERE e.workspace_id = ${workspaceId} AND e.event = 'agent_op'
            AND e.created_at >= ${from} AND e.created_at < ${to}) AS active_agents,
        (SELECT count(*) FROM analytics_events
          WHERE workspace_id = ${workspaceId} AND event = 'agent_op'
            AND created_at >= ${from} AND created_at < ${to}) AS ops,
        (SELECT count(*) FROM analytics_events
          WHERE workspace_id = ${workspaceId} AND event = 'agent_op'
            AND metadata->>'outcome' = 'error'
            AND created_at >= ${from} AND created_at < ${to}) AS failed_ops,
        (SELECT min(created_at) FROM analytics_events
          WHERE workspace_id = ${workspaceId} AND event = 'agent_op') AS tracking_since
    `.execute(this.db);

    const daily = await sql<Record<string, unknown>>`
      WITH days AS (
        SELECT d::date AS day
        FROM generate_series(
          (${from}::timestamptz AT TIME ZONE ${tz})::date,
          (${to}::timestamptz AT TIME ZONE ${tz})::date - 1,
          interval '1 day'
        ) AS d
      ),
      ops AS (
        SELECT (created_at AT TIME ZONE ${tz})::date AS day,
               count(*) FILTER (WHERE metadata->>'channel' = 'api') AS api,
               count(*) FILTER (WHERE metadata->>'channel' = 'mcp') AS mcp
        FROM analytics_events
        WHERE workspace_id = ${workspaceId} AND event = 'agent_op'
          AND created_at >= ${from} AND created_at < ${to}
        GROUP BY 1
      )
      SELECT to_char(days.day, 'YYYY-MM-DD') AS date,
             coalesce(ops.api, 0) AS api, coalesce(ops.mcp, 0) AS mcp
      FROM days LEFT JOIN ops ON ops.day = days.day
      ORDER BY days.day
    `.execute(this.db);

    const byOp = await sql<Record<string, unknown>>`
      SELECT route AS op, count(*) AS n FROM analytics_events
      WHERE workspace_id = ${workspaceId} AND event = 'agent_op'
        AND created_at >= ${from} AND created_at < ${to}
      GROUP BY route ORDER BY n DESC
    `.execute(this.db);

    // Every live agent is listed, so idle agents show up with zero ops.
    const topAgents = await sql<Record<string, unknown>>`
      WITH o AS (
        SELECT user_id, count(*) AS ops, max(created_at) AS last_op_at
        FROM analytics_events
        WHERE workspace_id = ${workspaceId} AND event = 'agent_op'
          AND created_at >= ${from} AND created_at < ${to}
        GROUP BY user_id
      )
      SELECT u.id AS user_id, u.name, u.created_at,
             coalesce(o.ops, 0) AS ops, o.last_op_at,
             (SELECT max(k.last_used_at) FROM api_keys k
               WHERE k.agent_user_id = u.id AND k.deleted_at IS NULL) AS key_last_used_at
      FROM users u
      LEFT JOIN o ON o.user_id = u.id
      WHERE u.workspace_id = ${workspaceId} AND u.user_type = 'agent'
        AND u.deleted_at IS NULL
      ORDER BY ops DESC, u.created_at DESC
      LIMIT 20
    `.execute(this.db);

    const t = totals.rows[0] ?? {};
    const iso = (v: unknown) => (v ? new Date(v as any).toISOString() : null);
    return {
      totalAgents: toInt(t.totalAgents),
      newAgents: toInt(t.newAgents),
      activeAgents: toInt(t.activeAgents),
      ops: toInt(t.ops),
      failedOps: toInt(t.failedOps),
      trackingSince: iso(t.trackingSince),
      daily: daily.rows.map((r) => ({
        date: String(r.date),
        api: toInt(r.api),
        mcp: toInt(r.mcp),
      })),
      byOp: byOp.rows.map((r) => ({ op: String(r.op), count: toInt(r.n) })),
      topAgents: topAgents.rows.map((r) => ({
        userId: String(r.userId),
        name: (r.name as string) ?? null,
        createdAt: iso(r.createdAt),
        ops: toInt(r.ops),
        lastOpAt: iso(r.lastOpAt),
        keyLastUsedAt: iso(r.keyLastUsedAt),
      })),
    };
  }

  async routeBreakdown(range: AnalyticsRange) {
    const { workspaceId, from, to } = range;
    const result = await sql<Record<string, unknown>>`
      SELECT route, count(*) AS pv FROM analytics_events
      WHERE workspace_id = ${workspaceId} AND event = 'page_view'
        AND created_at >= ${from} AND created_at < ${to}
      GROUP BY route
      ORDER BY pv DESC
    `.execute(this.db);
    return result.rows.map((r) => ({
      route: String(r.route ?? 'other'),
      pv: toInt(r.pv),
    }));
  }
}
