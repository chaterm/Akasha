import type {
  NegotiationTurn,
  ReviewApplication,
  ReviewApplicationDiff,
  ReviewJob,
  ReviewJobResult,
  ResolvedReview,
  ReviewDocMeta,
  ReviewItem,
  ReviewSnapshot,
} from "../types/review.types";

const REVIEW_JOB_POLL_INTERVAL_MS = 2000;
const REVIEW_JOB_POLL_TIMEOUT_MS = 5 * 60 * 1000;

export async function loadReviewSnapshot(params: {
  spaceId: string;
}): Promise<ReviewSnapshot | null> {
  const response = await fetch("/api/llm-wiki/review/load", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return normalizeReviewSnapshot(unwrapApiData(await response.json()));
}

export async function discoverReview(params: {
  spaceId: string;
  limit?: number;
  onJob?: (job: ReviewJob) => void;
}): Promise<ReviewSnapshot> {
  const response = await fetch("/api/llm-wiki/review/discover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ spaceId: params.spaceId, limit: params.limit }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const payload = unwrapApiData(await response.json());
  const jobResult = normalizeReviewJobResult(payload);
  if (jobResult) {
    params.onJob?.(jobResult.job);
    const completed = await pollReviewJob({
      spaceId: params.spaceId,
      jobId: jobResult.job.jobId,
    });
    assertReviewJobSucceeded(completed);
    const snapshot = normalizeReviewSnapshot(completed.result);
    if (!snapshot) {
      throw new Error("Review discover job completed without a snapshot");
    }
    return snapshot;
  }

  const snapshot = normalizeReviewSnapshot(payload);
  if (!snapshot) {
    throw new Error("Review discover returned an empty snapshot");
  }
  return snapshot;
}

export async function negotiateReview(params: {
  spaceId: string;
  item: ReviewItem;
  feedback: string;
  priorTurns?: NegotiationTurn[];
  onJob?: (job: ReviewJob) => void;
}): Promise<ResolvedReview> {
  const response = await fetch("/api/llm-wiki/review/negotiate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      spaceId: params.spaceId,
      item: params.item,
      feedback: params.feedback,
      priorTurns: params.priorTurns,
    }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const payload = unwrapApiData(await response.json());
  const jobResult = normalizeReviewJobResult(payload);
  if (jobResult) {
    params.onJob?.(jobResult.job);
    const completed = await pollReviewJob({
      spaceId: params.spaceId,
      jobId: jobResult.job.jobId,
    });
    assertReviewJobSucceeded(completed);
    if (!isRecord(completed.result)) {
      throw new Error("Review negotiation job completed without a draft");
    }
    return normalizeResolvedReview(
      completed.result as unknown as ResolvedReview,
    );
  }

  return normalizeResolvedReview(payload as ResolvedReview);
}

export async function getReviewJob(params: {
  spaceId: string;
  jobId: string;
}): Promise<ReviewJobResult> {
  const response = await fetch(
    `/api/llm-wiki/review/jobs/${encodeURIComponent(params.jobId)}?spaceId=${encodeURIComponent(params.spaceId)}`,
    {
      method: "GET",
      credentials: "include",
    },
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const result = normalizeReviewJobResult(unwrapApiData(await response.json()));
  if (!result) {
    throw new Error("Invalid review job response");
  }
  return result;
}

export async function pollReviewJob(params: {
  spaceId: string;
  jobId: string;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<ReviewJobResult> {
  const timeoutMs = params.timeoutMs ?? REVIEW_JOB_POLL_TIMEOUT_MS;
  const intervalMs = params.intervalMs ?? REVIEW_JOB_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const result = await getReviewJob(params);
    if (result.job.status === "done" || result.job.status === "failed") {
      return result;
    }
    if (Date.now() >= deadline) {
      throw new Error("Review job is still running. Please check back later.");
    }
    await delay(intervalMs);
  }
}

export async function planReviewApplication(params: {
  spaceId: string;
  itemId: string;
}): Promise<ReviewApplication> {
  const response = await fetch(`/api/llm-wiki/review/${params.itemId}/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ spaceId: params.spaceId }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return unwrapApiData(await response.json()) as ReviewApplication;
}

export async function applyReviewApplication(params: {
  applicationId: string;
}): Promise<ReviewApplication> {
  const response = await fetch(
    `/api/llm-wiki/review/applications/${params.applicationId}/apply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({}),
    },
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return unwrapApiData(await response.json()) as ReviewApplication;
}

export async function revertReviewApplication(params: {
  applicationId: string;
}): Promise<ReviewApplication> {
  const response = await fetch(
    `/api/llm-wiki/review/applications/${params.applicationId}/revert`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({}),
    },
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return unwrapApiData(await response.json()) as ReviewApplication;
}

export async function getReviewApplicationDiff(params: {
  applicationId: string;
}): Promise<ReviewApplicationDiff> {
  const response = await fetch(
    `/api/llm-wiki/review/applications/${params.applicationId}/diff`,
    {
      method: "GET",
      credentials: "include",
    },
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return unwrapApiData(await response.json()) as ReviewApplicationDiff;
}

function normalizeReviewSnapshot(value: unknown): ReviewSnapshot | null {
  if (value === null) return null;
  const record = isRecord(value) ? value : {};
  const items = Array.isArray(record.items) ? record.items : [];
  const docs = Array.isArray(record.docs) ? record.docs : [];
  const resolvedReviews = Array.isArray(record.resolvedReviews)
    ? record.resolvedReviews
    : [];
  const jobs = Array.isArray(record.jobs) ? record.jobs : [];
  const applications = Array.isArray(record.applications)
    ? record.applications
    : [];
  return {
    version: "2",
    items: items.filter(isRecord) as unknown as ReviewItem[],
    docs: docs
      .filter(isRecord)
      .map(
        (doc): ReviewDocMeta => ({
          id: typeof doc.id === "string" ? doc.id : "",
          title: typeof doc.title === "string" ? doc.title : "",
          sourcePageId:
            typeof doc.sourcePageId === "string" ? doc.sourcePageId : undefined,
        }),
      )
      .filter((doc) => Boolean(doc.id)),
    resolvedReviews: resolvedReviews
      .filter(isRecord)
      .map((resolved) =>
        normalizeResolvedReview(resolved as unknown as ResolvedReview),
      ),
    jobs: jobs.filter(isRecord).map(normalizeReviewJob),
    applications: applications.filter(
      isRecord,
    ) as unknown as ReviewApplication[],
    discoveredAt:
      typeof record.discoveredAt === "string" ? record.discoveredAt : "",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
  };
}

function normalizeReviewJobResult(value: unknown): ReviewJobResult | null {
  if (!isRecord(value) || !isRecord(value.job)) {
    return null;
  }
  return {
    job: normalizeReviewJob(value.job),
    result: value.result ?? null,
  };
}

function normalizeReviewJob(value: Record<string, unknown>): ReviewJob {
  const status =
    value.status === "running" ||
    value.status === "done" ||
    value.status === "failed"
      ? value.status
      : "pending";
  const kind = value.kind === "negotiate" ? "negotiate" : "discover";
  return {
    jobId: typeof value.jobId === "string" ? value.jobId : "",
    kind,
    itemId: typeof value.itemId === "string" ? value.itemId : null,
    status,
    error: typeof value.error === "string" ? value.error : null,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
    finishedAt: typeof value.finishedAt === "string" ? value.finishedAt : null,
  };
}

function assertReviewJobSucceeded(result: ReviewJobResult): void {
  if (result.job.status === "failed") {
    throw new Error(result.job.error || "Review job failed");
  }
}

function normalizeResolvedReview(resolved: ResolvedReview): ResolvedReview {
  const turns = Array.isArray(resolved.turns)
    ? resolved.turns
    : resolved.draft
      ? [
          {
            feedback: resolved.feedback,
            draft: resolved.draft,
            deepSearched: resolved.deepSearched,
            searchResults: resolved.searchResults ?? [],
          },
        ]
      : [];
  const latestTurn = turns[turns.length - 1];
  if (!latestTurn) {
    return { ...resolved, turns };
  }
  return {
    ...resolved,
    turns,
    feedback: latestTurn.feedback,
    deepSearched: latestTurn.deepSearched,
    searchResults: latestTurn.searchResults,
    draft: latestTurn.draft,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapApiData(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return "data" in value ? value.data : value;
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `HTTP error ${response.status}`;
  try {
    const body = await response.json();
    if (body?.message) {
      return Array.isArray(body.message)
        ? body.message.join(", ")
        : body.message;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}
