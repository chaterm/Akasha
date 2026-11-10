import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import SkillSettings from "./skill-settings";

const mocks = vi.hoisted(() => ({
  getSkillSettings: vi.fn(),
  updateSkillSettings: vi.fn(),
  showNotification: vi.fn(),
}));

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

vi.mock("@/features/workspace/services/workspace-service.ts", () => ({
  getSkillSettings: mocks.getSkillSettings,
  updateSkillSettings: mocks.updateSkillSettings,
}));

vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.showNotification },
}));

function renderSkillSettings(cachedSettings?: {
  latestVersion: string;
  upgradeUrl: string;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (cachedSettings) {
    queryClient.setQueryData(["skill-settings"], cachedSettings);
  }

  const result = render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <SkillSettings />
      </MantineProvider>
    </QueryClientProvider>,
  );

  return { ...result, queryClient };
}

describe("SkillSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSkillSettings.mockResolvedValue({
      latestVersion: "1.0.0",
      upgradeUrl: "https://example.com/old-skill",
    });
  });

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

  it("loads and saves the latest Akasha Skill release", async () => {
    const updatedSettings = {
      latestVersion: "1.1.0",
      upgradeUrl: "https://example.com/akasha-skill",
    };
    mocks.updateSkillSettings.mockResolvedValueOnce(updatedSettings);

    const { queryClient } = renderSkillSettings();

    const versionInput = screen.getByLabelText("Latest Skill version");
    const urlInput = screen.getByLabelText("Skill upgrade URL");
    await waitFor(() => {
      expect((versionInput as HTMLInputElement).value).toBe("1.0.0");
      expect((urlInput as HTMLInputElement).value).toBe(
        "https://example.com/old-skill",
      );
    });

    fireEvent.change(versionInput, { target: { value: "1.1.0" } });
    fireEvent.change(urlInput, {
      target: { value: "https://example.com/akasha-skill" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mocks.updateSkillSettings).toHaveBeenCalledWith(updatedSettings);
      expect(queryClient.getQueryData(["skill-settings"])).toEqual(
        updatedSettings,
      );
    });
  });

  it("rejects upgrade URLs outside HTTP and HTTPS", async () => {
    renderSkillSettings();

    await waitFor(() => {
      expect(
        (screen.getByLabelText("Latest Skill version") as HTMLInputElement)
          .value,
      ).toBe("1.0.0");
    });
    fireEvent.change(screen.getByLabelText("Latest Skill version"), {
      target: { value: "1.1.0" },
    });
    fireEvent.change(screen.getByLabelText("Skill upgrade URL"), {
      target: { value: "ftp://example.com/akasha-skill" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mocks.updateSkillSettings).not.toHaveBeenCalled();
    });
  });

  it("reads persisted Skill settings when the page opens", async () => {
    mocks.getSkillSettings.mockResolvedValueOnce({
      latestVersion: "2.0.0",
      upgradeUrl: "https://example.com/current-skill",
    });

    renderSkillSettings();

    await waitFor(() => {
      expect(mocks.getSkillSettings).toHaveBeenCalledTimes(1);
      expect(
        (screen.getByLabelText("Latest Skill version") as HTMLInputElement)
          .value,
      ).toBe("2.0.0");
      expect(
        (screen.getByLabelText("Skill upgrade URL") as HTMLInputElement).value,
      ).toBe("https://example.com/current-skill");
    });
  });

  it("keeps cached settings disabled until the fresh read completes", async () => {
    let resolveSettings: (settings: {
      latestVersion: string;
      upgradeUrl: string;
    }) => void;
    mocks.getSkillSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSettings = resolve;
      }),
    );

    renderSkillSettings({
      latestVersion: "1.0.0",
      upgradeUrl: "https://example.com/cached-skill",
    });

    const versionInput = screen.getByLabelText("Latest Skill version");
    expect((versionInput as HTMLInputElement).disabled).toBe(true);

    resolveSettings!({
      latestVersion: "2.0.0",
      upgradeUrl: "https://example.com/fresh-skill",
    });

    await waitFor(() => {
      expect((versionInput as HTMLInputElement).disabled).toBe(false);
      expect((versionInput as HTMLInputElement).value).toBe("2.0.0");
      expect(
        (screen.getByLabelText("Skill upgrade URL") as HTMLInputElement).value,
      ).toBe("https://example.com/fresh-skill");
    });
  });
});
