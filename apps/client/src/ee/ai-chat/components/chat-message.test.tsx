import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
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
  default: ({ label }: { label: string }) => <button>{label}</button>,
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

  it("keeps the copy action inside the assistant answer content", () => {
    render(
      <MantineProvider>
        <MemoryRouter>
          <ChatMessage
            message={{
              id: "message-copy",
              chatId: "chat-1",
              role: "assistant",
              content: "Answer to copy",
              toolCalls: null,
              metadata: null,
              createdAt: "2026-07-27T00:00:00.000Z",
            }}
          />
        </MemoryRouter>
      </MantineProvider>,
    );

    const answerContent =
      screen.getByText("Answer to copy").parentElement?.parentElement;
    const copyAction = screen.getByRole("button", {
      name: "Copy assistant response",
    });

    expect(answerContent?.contains(copyAction)).toBe(true);
  });

  it("edits a user question inline and regenerates from it", () => {
    const onEdit = vi.fn();
    render(
      <MantineProvider>
        <MemoryRouter>
          <ChatMessage
            message={{
              id: "message-user-1",
              chatId: "chat-1",
              role: "user",
              content: "Original question",
              toolCalls: null,
              metadata: null,
              createdAt: "2026-07-30T00:00:00.000Z",
            }}
            onEdit={onEdit}
          />
        </MemoryRouter>
      </MantineProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));

    expect(
      screen
        .getByRole("article", { name: "You said:" })
        .getAttribute("data-editing"),
    ).toBe("true");
    const editor = screen.getByRole("textbox", { name: "Edit message" });
    expect((editor as HTMLTextAreaElement).value).toBe("Original question");
    fireEvent.change(editor, { target: { value: "Edited question" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Save and regenerate" }),
    );

    expect(onEdit).toHaveBeenCalledWith("message-user-1", "Edited question");
    expect(screen.queryByRole("textbox", { name: "Edit message" })).toBeNull();
  });

  it("regenerates when the user saves an unchanged question", () => {
    const onEdit = vi.fn();
    render(
      <MantineProvider>
        <MemoryRouter>
          <ChatMessage
            message={{
              id: "message-user-unchanged",
              chatId: "chat-1",
              role: "user",
              content: "Original question",
              toolCalls: null,
              metadata: null,
              createdAt: "2026-07-30T00:00:00.000Z",
            }}
            onEdit={onEdit}
          />
        </MemoryRouter>
      </MantineProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Save and regenerate" }),
    );

    expect(onEdit).toHaveBeenCalledWith(
      "message-user-unchanged",
      "Original question",
    );
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
    const sourceLink = screen.getByRole("link", { name: "Used page" });
    expect(sourceLink.getAttribute("href")).toBe("/p/used");
    expect(sourceLink.getAttribute("target")).toBe("_blank");
    expect(sourceLink.getAttribute("rel")).toBe("noopener noreferrer");
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

  it("does not show an empty evidence card for no-match answers", () => {
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

    expect(screen.getByText("No evidence")).toBeTruthy();
    expect(screen.queryByText("No matching knowledge found")).toBeNull();
  });

  it("uses only the inline disclaimer for a general-knowledge answer", () => {
    render(
      <MantineProvider>
        <MemoryRouter>
          <ChatMessage
            message={{
              id: "message-general",
              chatId: "chat-1",
              role: "assistant",
              content:
                "> 以下回答基于通用模型知识，未引用企业知识库。\n\nGeneral answer",
              toolCalls: null,
              metadata: {
                answerMode: "general",
              },
              createdAt: "2026-07-30T00:00:00.000Z",
            }}
          />
        </MemoryRouter>
      </MantineProvider>,
    );

    expect(screen.getByText(/以下回答基于通用模型知识/)).toBeTruthy();
    expect(screen.queryByText("General knowledge answer")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Answer with general knowledge" }),
    ).toBeNull();
  });

  it("shows contextual understanding as an observable progress stage", () => {
    render(
      <MantineProvider>
        <MemoryRouter>
          <ChatMessage
            message={{
              id: "message-streaming",
              chatId: "chat-1",
              role: "assistant",
              content: null,
              toolCalls: null,
              metadata: null,
              createdAt: "2026-07-29T00:00:00.000Z",
            }}
            isStreaming
            streamingContent=""
            progressStage="understanding"
          />
        </MemoryRouter>
      </MantineProvider>,
    );

    expect(screen.getByText("Understanding the conversation...")).toBeTruthy();
  });

  it("renders live knowledge work as an expanded thinking timeline", () => {
    render(
      <MantineProvider>
        <MemoryRouter>
          <ChatMessage
            message={{
              id: "message-streaming-thinking",
              chatId: "chat-1",
              role: "assistant",
              content: null,
              toolCalls: null,
              metadata: null,
              createdAt: "2026-07-29T00:00:00.000Z",
            }}
            isStreaming
            streamingContent=""
            thinkingSteps={[
              {
                step: "understanding",
                status: "completed",
                durationMs: 320,
                stats: {
                  historyMessageCount: 2,
                  queryRewritten: true,
                },
              },
              {
                step: "searching",
                status: "started",
                startedAt: Date.now(),
              },
            ]}
          />
        </MemoryRouter>
      </MantineProvider>,
    );

    const summary = screen
      .getByText("Searching the knowledge base...")
      .closest("summary");
    expect(summary?.closest("details")?.open).toBe(true);
    expect(
      screen.getByText("Understand and analyze the question"),
    ).toBeTruthy();
    expect(screen.getByText("Find relevant knowledge")).toBeTruthy();
    expect(
      screen.getByText("Used 2 recent messages to clarify the question"),
    ).toBeTruthy();
  });

  it("keeps a completed thinking timeline folded in persisted messages", () => {
    render(
      <MantineProvider>
        <MemoryRouter>
          <ChatMessage
            message={{
              id: "message-completed-thinking",
              chatId: "chat-1",
              role: "assistant",
              content: "Grounded answer",
              toolCalls: null,
              metadata: {
                thinkingTrace: [
                  {
                    step: "searching",
                    status: "completed",
                    durationMs: 900,
                    stats: { matchedChunkCount: 20, sourceCount: 4 },
                  },
                  {
                    step: "analyzing",
                    status: "completed",
                    durationMs: 80,
                    stats: { includedItemCount: 2, sourceCount: 2 },
                    outcome: "knowledge",
                  },
                ],
              },
              createdAt: "2026-07-29T00:00:00.000Z",
            }}
          />
        </MemoryRouter>
      </MantineProvider>,
    );

    const summary = screen.getByText("Search completed").closest("summary");
    const details = summary?.closest("details");
    expect(details?.open).toBe(false);
    expect(screen.getByText("Results are only visible to you")).toBeTruthy();
    fireEvent.click(summary!);
    expect(details?.open).toBe(true);
    expect(screen.getByText("Found 20 relevant knowledge chunks")).toBeTruthy();
    expect(
      screen.getByText("Selected 2 knowledge items for the answer"),
    ).toBeTruthy();
  });

  it("keeps a contextual retrieval query folded inside answer evidence", () => {
    render(
      <MantineProvider>
        <MemoryRouter>
          <ChatMessage
            message={{
              id: "message-rewritten-query",
              chatId: "chat-1",
              role: "assistant",
              content: "Grounded answer",
              toolCalls: null,
              metadata: {
                answerMode: "knowledge",
                retrievalQuery: "Codex 的套餐价格是多少？",
              },
              createdAt: "2026-07-29T00:00:00.000Z",
            }}
          />
        </MemoryRouter>
      </MantineProvider>,
    );

    const evidenceSummary = screen
      .getByText("No verifiable citation was generated")
      .closest("summary");
    fireEvent.click(evidenceSummary!);

    const querySummary = screen
      .getByText("Contextual retrieval query")
      .closest("summary");
    const queryDetails = querySummary?.closest("details");
    expect(queryDetails?.open).toBe(false);
    expect(screen.getByText("Codex 的套餐价格是多少？")).toBeTruthy();
  });

  it("keeps internal answer links in the app and preserves their location", () => {
    function LocationProbe() {
      const location = useLocation();
      return (
        <output data-testid="location">
          {location.pathname + location.search + location.hash}
        </output>
      );
    }

    render(
      <MantineProvider>
        <MemoryRouter initialEntries={["/ai"]}>
          <ChatMessage
            message={{
              id: "message-link",
              chatId: "chat-1",
              role: "assistant",
              content:
                '<a href="https://fabricated.example/s/aim/p/roadmap?view=compact#rollout">Roadmap</a>',
              toolCalls: null,
              metadata: null,
              createdAt: "2026-07-27T00:00:00.000Z",
            }}
          />
          <LocationProbe />
        </MemoryRouter>
      </MantineProvider>,
    );

    const link = screen.getByRole("link", { name: "Roadmap" });
    expect(link.getAttribute("href")).toBe(
      "/s/aim/p/roadmap?view=compact#rollout",
    );
    expect(link.getAttribute("target")).toBeNull();

    fireEvent.click(link);

    expect(screen.getByTestId("location").textContent).toBe(
      "/s/aim/p/roadmap?view=compact#rollout",
    );
  });

  it("does not render non-page metadata as a trusted source link", () => {
    render(
      <MantineProvider>
        <MemoryRouter>
          <ChatMessage
            message={{
              id: "message-untrusted-link",
              chatId: "chat-1",
              role: "assistant",
              content: "Answer",
              toolCalls: null,
              metadata: {
                answerMode: "knowledge",
                citations: [
                  {
                    sourcePageId: "page-1",
                    title: "Unexpected external source",
                    url: "https://example.com/reference?next=/p/forged",
                  },
                ],
              },
              createdAt: "2026-07-27T00:00:00.000Z",
            }}
          />
        </MemoryRouter>
      </MantineProvider>,
    );

    expect(screen.queryByText("Unexpected external source")).toBeNull();
    expect(
      screen.getByText("No verifiable citation was generated"),
    ).toBeTruthy();
  });
});
