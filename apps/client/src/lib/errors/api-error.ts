export type ErrorParams = Record<string, string | number>;

export interface ApiErrorInfo {
  status?: number;
  code?: string;
  message?: string;
  params?: ErrorParams;
  network: boolean;
}

type ErrorBody = {
  code?: unknown;
  message?: unknown;
  params?: unknown;
};

export class ApiError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly params?: ErrorParams;

  constructor(info: Omit<ApiErrorInfo, "network">) {
    super(info.message ?? `HTTP error ${info.status ?? ""}`.trim());
    this.name = "ApiError";
    this.status = info.status;
    this.code = info.code;
    this.params = info.params;
  }
}

function fromBody(status: number | undefined, body: unknown): ApiErrorInfo {
  const data = (body ?? {}) as ErrorBody;
  const message = Array.isArray(data.message)
    ? data.message.join(", ")
    : typeof data.message === "string"
      ? data.message
      : undefined;
  return {
    status,
    code: typeof data.code === "string" ? data.code : undefined,
    message,
    params:
      data.params && typeof data.params === "object"
        ? (data.params as ErrorParams)
        : undefined,
    network: false,
  };
}

export function parseApiError(error: unknown): ApiErrorInfo {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      params: error.params,
      network: false,
    };
  }
  const axiosLike = error as {
    isAxiosError?: boolean;
    response?: { status?: number; data?: unknown };
    message?: string;
  };
  if (axiosLike?.response) {
    return fromBody(axiosLike.response.status, axiosLike.response.data);
  }
  if (axiosLike?.isAxiosError || error instanceof TypeError) {
    return { network: true, message: axiosLike?.message };
  }
  return {
    message: error instanceof Error ? error.message : undefined,
    network: false,
  };
}

export async function apiErrorFromResponse(
  response: Response,
): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const info = fromBody(response.status, body);
  return new ApiError(info);
}
