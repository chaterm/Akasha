import type {
  ReviewApplication,
  ReviewApplicationDiff,
  ResolvedReview,
  ReviewDocMeta,
  ReviewItem,
  ReviewSnapshot,
} from "../types/review.types";

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
}): Promise<ReviewSnapshot> {
  const response = await fetch("/api/llm-wiki/review/discover", {
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

export async function negotiateReview(params: {
  spaceId: string;
  item: ReviewItem;
  feedback: string;
}): Promise<ResolvedReview> {
  const response = await fetch("/api/llm-wiki/review/negotiate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return unwrapApiData(await response.json()) as ResolvedReview;
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
    resolvedReviews: resolvedReviews.filter(
      isRecord,
    ) as unknown as ResolvedReview[],
    applications: applications.filter(
      isRecord,
    ) as unknown as ReviewApplication[],
    discoveredAt:
      typeof record.discoveredAt === "string" ? record.discoveredAt : "",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
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
