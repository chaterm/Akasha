import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SpaceSidebar } from "./space-sidebar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("jotai", async () => {
  const actual = await vi.importActual<typeof import("jotai")>("jotai");
  return {
    ...actual,
    useAtom: () => [false, vi.fn()],
  };
});

vi.mock("@mantine/hooks", async () => {
  const actual = await vi.importActual<typeof import("@mantine/hooks")>(
    "@mantine/hooks",
  );
  return {
    ...actual,
    useDisclosure: () => [false, { open: vi.fn(), close: vi.fn() }],
  };
});

vi.mock("@/features/space/queries/space-query.ts", () => ({
  useGetSpaceBySlugQuery: () => ({
    data: {
      id: "space-1",
      name: "AIM",
      slug: "aim",
      logo: null,
      membership: { permissions: [] },
    },
  }),
}));

vi.mock("@/features/space/permissions/use-space-ability.ts", () => ({
  useSpaceAbility: () => ({
    can: () => true,
    cannot: () => false,
  }),
}));

vi.mock("@/features/page/tree/hooks/use-tree-mutation.ts", () => ({
  useTreeMutation: () => ({
    handleCreate: vi.fn(),
  }),
}));

vi.mock("@/components/layouts/global/hooks/hooks/use-toggle-sidebar.ts", () => ({
  useToggleSidebar: () => vi.fn(),
}));

vi.mock("@/features/search/constants", () => ({
  searchSpotlight: { open: vi.fn() },
}));

vi.mock("@/features/page/tree/components/space-tree.tsx", () => ({
  default: () => <div data-testid="space-tree" />,
}));

vi.mock("./switch-space", () => ({
  SwitchSpace: () => <div>AIM</div>,
}));

vi.mock("@/features/space/components/settings-modal.tsx", () => ({
  default: () => null,
}));

vi.mock("@/features/page/components/page-import-modal.tsx", () => ({
  default: () => null,
}));

vi.mock("@/components/common/export-modal", () => ({
  default: () => null,
}));

vi.mock("@/ee/template/components/template-picker-modal", () => ({
  default: () => null,
}));

vi.mock("@/features/space/queries/space-watcher-query.ts", () => ({
  useSpaceWatchStatusQuery: () => ({ data: { watching: false } }),
  useWatchSpaceMutation: () => ({ mutate: vi.fn() }),
  useUnwatchSpaceMutation: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/features/favorite/queries/favorite-query", () => ({
  useFavoriteIds: () => new Set(),
  useAddFavoriteMutation: () => ({ mutate: vi.fn() }),
  useRemoveFavoriteMutation: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/ee/hooks/use-feature", () => ({
  useHasFeature: () => true,
}));

vi.mock("@/ee/hooks/use-upgrade-label", () => ({
  useUpgradeLabel: () => "",
}));

describe("SpaceSidebar", () => {
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

  it("does not show the relationship graph entry in the space navigation", () => {
    render(
      <MantineProvider>
        <MemoryRouter initialEntries={["/s/aim"]}>
          <Routes>
            <Route path="/s/:spaceSlug" element={<SpaceSidebar />} />
          </Routes>
        </MemoryRouter>
      </MantineProvider>,
    );

    expect(screen.getByRole("link", { name: "Overview" })).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "Relationship graph" }),
    ).toBeNull();
  });
});
