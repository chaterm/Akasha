import { afterEach, describe, expect, it, vi } from "vitest";

const i18nMock = vi.hoisted(() => ({
  isInitialized: true,
  t: (key: string, params?: Record<string, unknown>) =>
    `t(${key})${params ? JSON.stringify(params) : ""}`,
}));

vi.mock("i18next", () => ({ default: i18nMock }));

import { ApiError, apiErrorFromResponse } from "./api-error";
import { getErrorMessage } from "./get-error-message";

const axiosError = (status: number, data: unknown) => ({
  isAxiosError: true,
  response: { status, data },
});

describe("getErrorMessage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("translates a known error code with its params", () => {
    expect(
      getErrorMessage(
        axiosError(400, {
          code: "FILE_TOO_LARGE",
          message: "File too large. Exceeds the 10MB limit",
          params: { limit: "10MB" },
        }),
        "Failed to upload file",
      ),
    ).toBe('t(File exceeds the {{limit}} limit){"limit":"10MB"}');
  });

  it("uses the caller fallback and hides the raw message when no code matches", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      getErrorMessage(
        axiosError(400, { message: "spaceId is required" }),
        "Failed to create space",
      ),
    ).toBe("t(Failed to create space)");
    expect(warn).toHaveBeenCalled();
  });

  it("appends the raw message only when detail is requested", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      getErrorMessage(
        axiosError(500, { message: "Internal server error" }),
        "Failed to load",
        { withDetail: true },
      ),
    ).toBe(
      't({{summary}}: {{detail}}){"summary":"t(Failed to load)","detail":"Internal server error"}',
    );
  });

  it("prefers a status message over the fallback for permission errors", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      getErrorMessage(axiosError(403, { message: "Forbidden" }), "Failed"),
    ).toBe("t(You don't have permission to do this)");
  });

  it("reports network failures without a response", () => {
    expect(
      getErrorMessage({ isAxiosError: true, message: "Network Error" }, "Failed"),
    ).toBe("t(Network error. Check your connection and try again.)");
  });

  it("interpolates the untranslated key before i18next is initialized", () => {
    i18nMock.isInitialized = false;
    try {
      expect(
        getErrorMessage(
          axiosError(400, {
            code: "AI_INPUT_TOO_LONG",
            message: "too long",
            params: { max: 8000 },
          }),
          "Failed",
        ),
      ).toBe("Input exceeds the 8000 character limit");
    } finally {
      i18nMock.isInitialized = true;
    }
  });

  it("reads fetch responses into an ApiError", async () => {
    const error = await apiErrorFromResponse(
      new Response(
        JSON.stringify({ code: "KNOWLEDGE_RUN_IN_PROGRESS", message: "busy" }),
        { status: 409 },
      ),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
    expect(getErrorMessage(error, "Failed")).toBe(
      "t(A compilation run is still in progress for these pages. Try again after it finishes.)",
    );
  });
});
