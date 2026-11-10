import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import SpaceKnowledgeSettings from "./space-knowledge-settings";

const mutateAsync = vi.fn().mockResolvedValue({});

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  };
});

vi.mock("@/features/space/queries/space-query.ts", () => ({
  useUpdateSpaceMutation: () => ({ mutateAsync, isPending: false }),
}));

function renderSettings(space: Record<string, unknown>): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <SpaceKnowledgeSettings space={space as never} />
      </MantineProvider>
    </QueryClientProvider>,
  );
}

describe("SpaceKnowledgeSettings", () => {
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
    // SegmentedControl's floating indicator observes its size.
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
  });

  it("defaults to Default and saves the Space-wide publish mode", async () => {
    renderSettings({ id: "space-1", settings: {} });

    const defaultMode = screen.getByLabelText("Default");
    expect((defaultMode as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByLabelText("Original text indexing"));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        spaceId: "space-1",
        knowledgeIndexMode: "original",
      }),
    );
  });

  it("reflects the stored mode", () => {
    renderSettings({
      id: "space-1",
      settings: { knowledge: { indexMode: "original" } },
    });

    const original = screen.getByLabelText("Original text indexing");
    expect((original as HTMLInputElement).checked).toBe(true);
  });
});
