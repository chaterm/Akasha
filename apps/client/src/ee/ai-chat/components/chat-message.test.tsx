import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";
import ChatMessage from "./chat-message";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key.replace("{{count}}", String(values?.count ?? "{{count}}")),
  }),
}));

vi.mock("@docmost/editor-ext", () => ({
  markdownToHtml: (value: string) => `<p>${value}</p>`,
}));

vi.mock("@/components/common/copy.tsx", () => ({
  default: () => null,
}));

describe("ChatMessage knowledge evidence", () => {
  beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it("shows only verifiable answer sources and keeps retrieval counts in diagnostics", () => {
    render(
      <MantineProvider>
        <MemoryRouter>
          <ChatMessage
            message={{
              id: "message-1",
              chatId: "chat-1",
              role: "assistant",
              content: "Grounded answer",
              toolCalls: null,
              metadata: {
                answerMode: "knowledge",
                citations: [
                  {
                    sourcePageId: "page-1",
                    title: "Used page",
                    url: "/p/used",
                  },
                ],
                citationEvidence: [
                  {
                    sourcePageId: "page-1",
                    title: "Used page",
                    url: "/p/used",
                    excerpts: [
                      {
                        text: "This excerpt directly supports the answer.",
                        sourceRange: { startOffset: 10, endOffset: 51 },
                        quoteHash: "sha256:verified",
                      },
                    ],
                  },
                ],
                retrievedSources: [
                  {
                    sourcePageId: "page-1",
                    title: "Used page",
                    url: "/p/used",
                  },
                  {
                    sourcePageId: "page-2",
                    title: "Retrieved page",
                    url: "/p/retrieved",
                  },
                ],
                retrievalDiagnostics: {
                  mode: "lexical_fallback",
                  queryEmbeddingAvailable: false,
                  candidateSourceCount: 2,
                  policyCandidateSourceCount: 2,
                  fallbackCandidateSourceCount: 0,
                  finalAuthorizedSourceCount: 2,
                  accessPolicyFallbackUsed: false,
                  candidateChunkCount: 2,
                  rankedCandidateCount: 2,
                  authorizedChunkCount: 2,
                  filteredChunkCount: 0,
                },
              },
              createdAt: "2026-07-24T00:00:00.000Z",
            }}
          />
        </MemoryRouter>
      </MantineProvider>,
    );

    expect(screen.getByText("Answer sources")).toBeTruthy();
    expect(screen.getByText("1 verifiable source")).toBeTruthy();
    const answerSourcesSummary = screen
      .getByText("Answer sources")
      .closest("summary");
    const answerSourcesDetails = answerSourcesSummary?.closest("details");
    expect(answerSourcesDetails?.open).toBe(false);

    fireEvent.click(answerSourcesSummary!);

    expect(answerSourcesDetails?.open).toBe(true);
    expect(screen.getByText("Used page")).toBeTruthy();
    expect(
      screen.getByText("This excerpt directly supports the answer."),
    ).toBeTruthy();
    expect(screen.queryByText("Retrieved page")).toBeNull();
    expect(screen.getByText("Retrieval details")).toBeTruthy();
    expect(screen.getByText("Candidate sources")).toBeTruthy();
    expect(screen.getByText("Knowledge chunks used")).toBeTruthy();
    expect(screen.getByText("Verifiable citations")).toBeTruthy();
    expect(screen.getByText("Keyword retrieval fallback")).toBeTruthy();
    expect(
      screen.getByText(
        "Semantic retrieval was unavailable; keyword retrieval was used.",
      ),
    ).toBeTruthy();
  });

  it("clearly marks deterministic no-match answers", () => {
    render(
      <MantineProvider>
        <MemoryRouter>
          <ChatMessage
            message={{
              id: "message-2",
              chatId: "chat-1",
              role: "assistant",
              content: "No evidence",
              toolCalls: null,
              metadata: { answerMode: "no_match" },
              createdAt: "2026-07-24T00:00:00.000Z",
            }}
          />
        </MemoryRouter>
      </MantineProvider>,
    );

    expect(screen.getByText("No matching knowledge found")).toBeTruthy();
  });
});
