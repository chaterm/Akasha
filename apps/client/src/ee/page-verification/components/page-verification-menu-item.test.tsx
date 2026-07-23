import { MantineProvider, Menu } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeAll, vi } from "vitest";
import {
  PageVerificationBadge,
  PageVerificationMenuItem,
} from "./page-verification-modal";

const featureAccess = vi.hoisted(() => ({ enabled: false }));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/ee/hooks/use-feature", () => ({
  useHasFeature: () => featureAccess.enabled,
}));

vi.mock("@/ee/hooks/use-upgrade-label", () => ({
  useUpgradeLabel: () => "Available with a paid license",
}));

vi.mock("@/ee/page-verification/queries/page-verification-query", () => ({
  usePageVerificationInfoQuery: () => ({ data: undefined }),
}));

vi.mock("@/features/page/queries/page-query", () => ({
  usePageQuery: () => ({ data: { id: "page-1" } }),
}));

vi.mock("@/i18n.ts", () => ({
  default: { language: "en" },
}));

describe("PageVerificationMenuItem", () => {
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

  it("hides the add verification entry when verification is unavailable", () => {
    render(
      <MantineProvider>
        <Menu opened>
          <Menu.Target>
            <button type="button">Page menu</button>
          </Menu.Target>
          <Menu.Dropdown>
            <PageVerificationMenuItem pageId="page-1" onClick={vi.fn()} />
          </Menu.Dropdown>
        </Menu>
      </MantineProvider>,
    );

    expect(screen.queryByText("Add verification")).toBeNull();
  });

  it("hides the verification badge when verification is unavailable", () => {
    render(
      <MantineProvider>
        <MemoryRouter initialEntries={["/s/aim/p/example-page-1"]}>
          <Routes>
            <Route
              path="/s/:spaceSlug/p/:pageSlug"
              element={<PageVerificationBadge />}
            />
          </Routes>
        </MemoryRouter>
      </MantineProvider>,
    );

    expect(screen.queryByLabelText(/Add verification/)).toBeNull();
  });
});
