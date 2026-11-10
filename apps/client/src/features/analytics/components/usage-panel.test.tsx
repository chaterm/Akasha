import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { UsagePanel } from "./usage-panel";
import {
  getAnalyticsUsage,
  getAnalyticsUsageEvents,
} from "../services/analytics-service";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@mantine/charts", () => ({ BarChart: () => <div /> }));
vi.mock("../services/analytics-service", () => ({
  getAnalyticsUsage: vi.fn(),
  getAnalyticsUsageEvents: vi.fn(),
}));

const row = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "Production key",
  keyTypes: ["agent"],
  actors: "Agent A",
  creators: "Alice",
  status: "active",
  ops: 25,
  api: 20,
  mcp: 5,
  failedOps: 1,
  unknownOps: 5,
  keyCount: 1,
  lastOpAt: "2026-11-09T10:00:00Z",
};
const dates = {
  range: "custom" as const,
  from: "2026-11-01",
  to: "2026-11-09",
};

beforeAll(() => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  vi.mocked(getAnalyticsUsage).mockResolvedValue({
    summary: {
      ops: 25,
      api: 20,
      mcp: 5,
      failedOps: 1,
      unknownOps: 5,
      activeAgents: 1,
      activeUsers: 1,
      activeKeys: 1,
    },
    updatedAt: "2026-11-09T10:00:00Z",
    total: 21,
    page: 1,
    limit: 20,
    items: [row],
    daily: [],
    byOp: [],
  } as never);
  vi.mocked(getAnalyticsUsageEvents).mockResolvedValue({
    total: 25,
    page: 1,
    limit: 20,
    items: [],
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <UsagePanel dates={dates} enabled />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe("usage exploration", () => {
  it("keeps time, search, sorting and pagination when opening and closing a detail drawer", async () => {
    setup();
    await screen.findByRole("button", { name: "Production key" });
    fireEvent.change(screen.getByLabelText("Search caller or key"), {
      target: { value: "Alice" },
    });
    await waitFor(() =>
      expect(getAnalyticsUsage).toHaveBeenLastCalledWith(
        expect.objectContaining({ ...dates, search: "Alice" }),
      ),
    );
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Sort by {{column}}" }))[0],
    );
    // Move to page two, then drill into a result.
    fireEvent.click(await screen.findByRole("button", { name: "2" }));
    await waitFor(() =>
      expect(getAnalyticsUsage).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2, search: "Alice" }),
      ),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Production key" }),
    );
    await waitFor(() =>
      expect(getAnalyticsUsageEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          ...dates,
          search: "Alice",
          entityId: row.id,
          page: 1,
        }),
      ),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Individual calls")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      (screen.getByLabelText("Search caller or key") as HTMLInputElement).value,
    ).toBe("Alice");
    expect(
      screen.getByRole("button", { name: "2" }).getAttribute("data-active"),
    ).toBe("true");
  });

  it("resets pagination when switching grouping and clears search filters", async () => {
    setup();
    await screen.findByRole("button", { name: "Production key" });
    fireEvent.click(await screen.findByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "By user" }));
    await waitFor(() =>
      expect(getAnalyticsUsage).toHaveBeenLastCalledWith(
        expect.objectContaining({ groupBy: "user", page: 1 }),
      ),
    );
    fireEvent.change(screen.getByLabelText("Search caller or key"), {
      target: { value: "missing" },
    });
    await waitFor(() =>
      expect(getAnalyticsUsage).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: "missing" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Search caller or key") as HTMLInputElement)
          .value,
      ).toBe(""),
    );
    await new Promise((resolve) => setTimeout(resolve, 350));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(getAnalyticsUsage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          groupBy: "user",
          search: undefined,
          page: 1,
        }),
      ),
    );
  });
});
