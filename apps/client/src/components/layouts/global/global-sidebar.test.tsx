import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import GlobalSidebar from "./global-sidebar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useAtom: () => [false],
}));

vi.mock("@/components/layouts/global/hooks/hooks/use-toggle-sidebar", () => ({
  useToggleSidebar: () => vi.fn(),
}));

vi.mock("@/features/favorite/queries/favorite-query", () => ({
  useFavoritesQuery: () => ({ data: { pages: [] }, isPending: false }),
}));

vi.mock(
  "@/features/workspace/components/members/components/workspace-invite-form",
  () => ({ WorkspaceInviteForm: () => null }),
);

vi.mock("@/components/ui/custom-avatar", () => ({
  CustomAvatar: () => null,
}));

vi.mock("@/ee/hooks/use-feature", () => ({
  useHasFeature: () => false,
}));

vi.mock("@/ee/hooks/use-upgrade-label", () => ({
  useUpgradeLabel: () => "Available with a paid license",
}));

vi.mock("@/hooks/use-user-role", () => ({
  default: () => ({ isOwner: false }),
}));

describe("GlobalSidebar", () => {
  beforeAll(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
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

  it("hides the templates navigation item when templates are unavailable", () => {
    render(
      <MantineProvider>
        <MemoryRouter initialEntries={["/home"]}>
          <GlobalSidebar />
        </MemoryRouter>
      </MantineProvider>,
    );

    expect(screen.getByRole("link", { name: "Home" })).toBeTruthy();
    expect(screen.queryByText("Templates")).toBeNull();
  });
});
