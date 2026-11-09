export type AnalyticsRangeKey =
  | "today"
  | "yesterday"
  | "7d"
  | "30d"
  | "90d"
  | "custom";

export interface IAnalyticsCards {
  pv: number;
  uv: number;
  totalPages: number;
  newPages: number;
  pageEdits: number;
  comments: number;
  avgDau: number;
  wau: number;
  mau: number;
  stickiness: number; // average daily DAU / MAU, 0-1
  // Workspace scope only.
  totalUsers?: number;
  newUsers?: number;
  totalSpaces?: number;
  newSpaces?: number;
  aiQuestions?: number;
  aiAskers?: number;
}

export interface IAnalyticsDailyRow {
  date: string;
  pv: number;
  uv: number;
  newPages: number;
  pageEdits: number;
  wau: number;
  mau: number;
  newUsers?: number;
  newSpaces?: number;
  aiQuestions?: number;
  userCount?: number;
  spaceCount?: number;
}

export interface IAnalyticsTopSpace {
  spaceId: string;
  name: string | null;
  slug: string;
  logo: string | null;
  pv: number;
  uv: number;
}

export interface IAnalyticsTopPage {
  pageId: string;
  title: string | null;
  icon: string | null;
  slugId: string;
  spaceId: string;
  spaceName: string | null;
  spaceSlug: string;
  pv: number;
  uv: number;
}

export interface IAnalyticsTopUser {
  userId: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
  pv: number;
  edits: number;
}

export type AgentOpCategory =
  | "query"
  | "search"
  | "read"
  | "write"
  | "delete"
  | "other";

export interface IAnalyticsAgents {
  totalAgents: number;
  newAgents: number;
  activeAgents: number;
  ops: number;
  failedOps: number; // REST calls only; MCP outcomes are not observable
  trackingSince: string | null;
  daily: { date: string; api: number; mcp: number }[];
  byCategory: { category: AgentOpCategory; count: number }[];
  byOp: { op: string; count: number }[];
  topAgents: {
    userId: string;
    name: string | null;
    createdAt: string | null;
    ops: number;
    lastOpAt: string | null;
    keyLastUsedAt: string | null;
  }[];
}

export interface IAnalyticsOverview {
  range: { key: AnalyticsRangeKey; from: string; to: string };
  scope: "workspace" | "space";
  trackingSince: string | null;
  cards: IAnalyticsCards;
  series: { daily: IAnalyticsDailyRow[] };
  rankings: {
    topPages: IAnalyticsTopPage[];
    topUsers: IAnalyticsTopUser[];
    topSpaces?: IAnalyticsTopSpace[];
    routeBreakdown?: { route: string; pv: number }[];
  };
  agents?: IAnalyticsAgents; // workspace scope only
}

export interface ITrackPageView {
  route: string;
  spaceSlug?: string;
  pageSlugId?: string;
}

export interface AnalyticsDateFilter {
  range: AnalyticsRangeKey;
  from?: string;
  to?: string;
}

export type UsageGroup = "agent" | "user" | "key";
export interface AnalyticsUsageFilter extends AnalyticsDateFilter {
  groupBy: UsageGroup;
  search?: string;
  keyType?: string;
  channel?: string;
  outcome?: string;
  op?: string;
  entityId?: string;
  sort?: "ops" | "failedOps" | "lastOpAt";
  direction?: "asc" | "desc";
  page?: number;
  limit?: number;
}

export interface AnalyticsUsageRow {
  id: string;
  name: string | null;
  email: string | null;
  keyTypes: string[];
  actors: string | null;
  creators: string | null;
  status: string;
  ops: number;
  api: number;
  mcp: number;
  failedOps: number;
  unknownOps: number;
  keyCount: number;
  lastOpAt: string | null;
}

export interface AnalyticsUsageOverview {
  updatedAt: string;
  summary: {
    ops: number;
    api: number;
    mcp: number;
    failedOps: number;
    unknownOps: number;
    activeAgents: number;
    activeUsers: number;
    activeKeys: number;
  };
  total: number;
  page: number;
  limit: number;
  items: AnalyticsUsageRow[];
  daily: { date: string; api: number; mcp: number }[];
  byOp: { op: string; count: number }[];
}

export interface AnalyticsUsageEvent {
  id: string;
  createdAt: string;
  op: string;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  keyId: string | null;
  keyName: string | null;
  keyType: string;
  channel: string;
  outcome: string;
}

export interface AnalyticsUsageEvents {
  total: number;
  page: number;
  limit: number;
  items: AnalyticsUsageEvent[];
}
