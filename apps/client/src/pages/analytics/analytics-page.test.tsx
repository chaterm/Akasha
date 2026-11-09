import { MantineProvider } from "@mantine/core";
import { HelmetProvider } from "react-helmet-async";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import AnalyticsPage from "./analytics-page";
import { useAnalyticsOverviewQuery } from "@/features/analytics/queries/analytics-query";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("jotai", () => ({
  useAtomValue: () => ({ user: { role: "owner" } }),
  atom: vi.fn(),
}));
vi.mock("@/features/user/atoms/current-user-atom", () => ({
  currentUserAtom: {},
}));
vi.mock("@/hooks/use-user-role", () => ({
  default: () => ({ isAdmin: true }),
}));
vi.mock("@/features/analytics/queries/analytics-query", () => ({
  useAnalyticsOverviewQuery: vi.fn().mockReturnValue({}),
}));
vi.mock("@/features/space/components/sidebar/space-select", () => ({
  SpaceSelect: () => <div>Space filter</div>,
}));
vi.mock("@/features/analytics/components/trend-charts", () => ({
  TrendCharts: () => null,
}));
vi.mock("@/features/analytics/components/rankings", () => ({
  Rankings: () => null,
}));
vi.mock("@/features/analytics/components/usage-panel", () => ({
  UsagePanel: ({ enabled, dates }: any) => (
    <div>
      {enabled ? `Usage ${dates.range} ${dates.from || ""}` : "Usage disabled"}
    </div>
  ),
}));

beforeAll(() => {
  window.matchMedia = vi
    .fn()
    .mockReturnValue({
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
});
afterEach(cleanup);

describe("analytics navigation", () => {
  it("defaults to overview and preserves the shared date range when moving between tabs", () => {
    render(
      <MantineProvider>
        <HelmetProvider>
          <AnalyticsPage />
        </HelmetProvider>
      </MantineProvider>,
    );
    expect(
      screen
        .getByRole("tab", { name: "Overview" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(useAnalyticsOverviewQuery).toHaveBeenLastCalledWith(
      { range: "30d" },
      undefined,
      true,
    );
    fireEvent.click(screen.getByRole("textbox", { name: "Time range" }));
    fireEvent.click(screen.getByRole("option", { name: "Today" }));
    fireEvent.click(screen.getByRole("tab", { name: "Call statistics" }));
    expect(screen.getByText("Usage today")).toBeTruthy();
    expect(screen.queryByText("Space filter")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(
      (screen.getByRole("textbox", { name: "Time range" }) as HTMLInputElement)
        .value,
    ).toBe("Today");
  });

  it("blocks queries for invalid custom date ranges", () => {
    render(
      <MantineProvider>
        <HelmetProvider>
          <AnalyticsPage />
        </HelmetProvider>
      </MantineProvider>,
    );
    fireEvent.click(screen.getByRole("textbox", { name: "Time range" }));
    fireEvent.click(screen.getByRole("option", { name: "Custom range" }));
    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "2026-11-10" },
    });
    fireEvent.change(screen.getByLabelText("End date"), {
      target: { value: "2026-11-01" },
    });
    expect(
      screen.getByText("Select an ordered date range of at most 400 days"),
    ).toBeTruthy();
    expect(useAnalyticsOverviewQuery).toHaveBeenLastCalledWith(
      expect.anything(),
      undefined,
      false,
    );
  });
});
