import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Provider } from "jotai";

vi.mock("@/main", () => ({
  queryClient: {
    getQueryData() {},
    setQueryData() {},
    invalidateQueries() {},
    fetchQuery() {},
    prefetchQuery() {},
  },
}));

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const readyDiff = (fromHistoryId: string, toHistoryId: string) => ({
  status: "ready" as const,
  fromHistoryId,
  toHistoryId,
  algorithmVersion: "v",
  schemaVersion: "v",
  changes: [
    {
      fromA: 1,
      toA: 1,
      fromB: 1,
      toB: 4,
      deletedText: "",
      addedSpecialNode: null,
      deletedSpecialNode: null,
    },
  ],
  addedCount: 1,
  deletedCount: 0,
});

describe("HistoryEditor", () => {
  it("keeps highlights when switching between versions with cached diffs", async () => {
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
    (globalThis as any).WebGL2RenderingContext = class {};
    (globalThis as any).WebGLRenderingContext = class {};
    const { HistoryEditor } = await import("./history-editor");

    const props = (id: string, prevId: string, text: string) => ({
      title: "T",
      content: doc(text),
      prevHistoryId: prevId,
      persistedDiff: readyDiff(prevId, id) as any,
      isDiffLoading: false,
      isPreviousLoading: false,
      isPreviousError: false,
    });

    const tree = (p: ReturnType<typeof props>) => (
      <Provider>
        <MantineProvider>
          <HistoryEditor {...p} />
        </MantineProvider>
      </Provider>
    );

    const { container, rerender } = render(tree(props("v3", "v2", "abc one")));
    await waitFor(() =>
      expect(container.querySelector(".history-diff-added")).toBeTruthy(),
    );

    rerender(tree(props("v2", "v1", "xyz two")));
    await waitFor(() => {
      const added = container.querySelector(".history-diff-added");
      expect(added?.textContent).toBe("xyz");
    });

    rerender(
      tree({
        ...props("v2", "v1", "xyz two"),
        title: "Weekly report",
        previousTitle: "Daily report",
      } as any),
    );
    await waitFor(() => {
      const heading = container.querySelector("h1");
      expect(
        heading?.querySelector(".history-diff-deleted")?.textContent,
      ).toBe("Daily");
      expect(heading?.querySelector(".history-diff-added")?.textContent).toBe(
        "Weekly",
      );
      expect(
        heading
          ?.querySelector(".history-diff-deleted")
          ?.getAttribute("data-diff-index"),
      ).toBe("1");
      const bodyAdded = container.querySelector(
        ".ProseMirror .history-diff-added",
      );
      expect(bodyAdded?.getAttribute("data-diff-index")).toBe("3");
    });
  }, 240000);
});
