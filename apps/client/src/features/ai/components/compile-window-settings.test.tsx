import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import CompileWindowSettings from "./compile-window-settings";

const mocks = vi.hoisted(() => ({
  getCompileWindowSettings: vi.fn(),
  updateCompileWindowSettings: vi.fn(),
  showNotification: vi.fn(),
}));

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: Record<string, string>) =>
        options?.timezone ? `${key} [${options.timezone}]` : key,
    }),
  };
});

vi.mock("@/features/workspace/services/workspace-service.ts", () => ({
  getCompileWindowSettings: mocks.getCompileWindowSettings,
  updateCompileWindowSettings: mocks.updateCompileWindowSettings,
}));

vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.showNotification },
}));

const persisted = {
  enabled: true,
  startTime: "23:00",
  endTime: "07:00",
  serverTimezone: "Asia/Shanghai",
};

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <CompileWindowSettings />
      </MantineProvider>
    </QueryClientProvider>,
  );
  const hidden = (name: string) =>
    view.container.querySelector<HTMLInputElement>(
      `input[type="hidden"][name="${name}"]`,
    );
  return { queryClient, hidden };
}

describe("CompileWindowSettings", () => {
  beforeAll(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = vi.fn();
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hides the time range while the switch is off", async () => {
    mocks.getCompileWindowSettings.mockResolvedValue({
      ...persisted,
      enabled: false,
    });
    const { hidden } = renderSettings();

    await waitFor(() =>
      expect(mocks.getCompileWindowSettings).toHaveBeenCalled(),
    );
    expect(hidden("startTime")).toBeNull();
  });

  it("shows the server timezone instead of a timezone picker", async () => {
    mocks.getCompileWindowSettings.mockResolvedValue(persisted);
    renderSettings();

    expect(
      await screen.findByText(/server timezone.*\[Asia\/Shanghai\]/),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Timezone")).toBeNull();
  });

  it("picks the end minute from the dropdown and saves without a timezone", async () => {
    mocks.getCompileWindowSettings.mockResolvedValue(persisted);
    mocks.updateCompileWindowSettings.mockImplementation(async (value) => ({
      ...value,
      serverTimezone: "Asia/Shanghai",
    }));
    const { hidden } = renderSettings();

    await waitFor(() => expect(hidden("endTime")?.value).toBe("07:00"));
    const minuteInputs = screen.getAllByLabelText("Minutes");
    fireEvent.focus(minuteInputs[1]);
    const option = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-value="30"]');
      expect(found).toBeTruthy();
      return found!;
    });
    fireEvent.click(option);
    await waitFor(() => expect(hidden("endTime")?.value).toBe("07:30"));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.updateCompileWindowSettings).toHaveBeenCalledWith({
        enabled: true,
        startTime: "23:00",
        endTime: "07:30",
      }),
    );
  });
});
