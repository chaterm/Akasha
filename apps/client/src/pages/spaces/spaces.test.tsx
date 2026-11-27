import { MantineProvider } from "@mantine/core";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter } from "react-router-dom";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import Spaces from "./spaces";

const mocks = vi.hoisted(() => ({
  isAdmin: false,
  getFavorites: vi.fn(),
  getSpaces: vi.fn((params) => ({
    data: {
      items: [
        {
          id: "space-1",
          slug: "notes",
          name: params?.cursor ? "More notes" : "Reading notes",
          description: "Notes and excerpts",
          personalOwnerId: "user-1",
          isDefaultPersonal: false,
          memberCount: 1,
        },
      ],
      meta: { total: 31, hasNextPage: !params?.cursor, nextCursor: "next" },
    },
  })),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/use-user-role.tsx", () => ({
  default: () => ({ isAdmin: mocks.isAdmin }),
}));
vi.mock("@/features/space/queries/space-query.ts", () => ({
  useGetSpacesQuery: mocks.getSpaces,
  prefetchSpace: vi.fn(),
}));
vi.mock("@/features/space/queries/space-query", () => ({
  useGetSpacesQuery: mocks.getSpaces,
  prefetchSpace: vi.fn(),
}));
vi.mock("@/features/space/components/create-space-modal", () => ({
  default: () => null,
}));
vi.mock("@/features/space/components/settings-modal", () => ({
  default: () => null,
}));
vi.mock("@/features/favorite/components/star-button", () => ({
  default: () => <button aria-label="Favorite" />,
}));
vi.mock("@/features/space/queries/space-watcher-query", () => ({
  useWatchedSpaceIds: () => new Set(),
  useWatchSpaceMutation: () => ({ mutate: vi.fn() }),
  useUnwatchSpaceMutation: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/features/favorite/queries/favorite-query", () => ({
  useFavoritesQuery: mocks.getFavorites,
}));

function renderSpaces(url = "/spaces") {
  return render(
    <MantineProvider env="test">
      <HelmetProvider>
        <MemoryRouter initialEntries={[url]}>
          <Spaces />
        </MemoryRouter>
      </HelmetProvider>
    </MantineProvider>,
  );
}

beforeAll(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  localStorage.removeItem("spaces-view");
  mocks.isAdmin = false;
  mocks.getSpaces.mockClear();
  mocks.getFavorites.mockReset().mockReturnValue({});
});

it("keeps search and the current page when switching layouts", async () => {
  renderSpaces("/spaces?type=created-personal");
  expect(
    screen.getByRole("tab", { name: "My spaces", selected: true }),
  ).toBeTruthy();
  expect(screen.getByRole("table")).toBeTruthy();
  expect(screen.getByText("Private space")).toBeTruthy();
  expect(screen.queryByText("Notes and excerpts")).toBeNull();
  const search = screen.getByRole("textbox", { name: "Search spaces" });
  fireEvent.change(search, { target: { value: "notes" } });
  await waitFor(() =>
    expect(mocks.getSpaces).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "created-personal", query: "notes" }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(screen.getByRole("link", { name: "More notes" })).toBeTruthy();

  fireEvent.click(screen.getByLabelText("Card view"));
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.getByText("Notes and excerpts")).toBeTruthy();
  expect(screen.getByRole("link", { name: "More notes" })).toBeTruthy();
  expect(mocks.getSpaces).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "created-personal",
      query: "notes",
      cursor: "next",
    }),
  );
  expect(localStorage.getItem("spaces-view")).toBe('"cards"');
});

it("keeps favorite spaces above the category tabs", () => {
  mocks.getFavorites.mockReturnValue({
    data: {
      pages: [
        {
          items: [
            {
              space: { id: "favorite-1", slug: "reference", name: "Reference" },
            },
          ],
        },
      ],
    },
  });
  renderSpaces("/spaces?type=favorites");

  const favorites = screen.getByRole("region", { name: "Favorite spaces" });
  const categories = screen.getByRole("tablist", { name: "Space category" });
  expect(
    within(favorites).getByRole("link", { name: "Reference" }),
  ).toBeTruthy();
  expect(
    favorites.compareDocumentPosition(categories) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Favorites" })).toBeNull();
  expect(
    screen.getByRole("tab", { name: "All spaces", selected: true }),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole("tab", { name: "My spaces" }));
  expect(screen.getByRole("region", { name: "Favorite spaces" })).toBe(
    favorites,
  );
});

it.each([true, false])(
  "filters by space type only in All spaces (isAdmin: %s)",
  (isAdmin) => {
    mocks.isAdmin = isAdmin;
    renderSpaces("/spaces?type=personal");
    expect(
      screen.getByRole("tab", { name: "All spaces", selected: true }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("tab", { name: "Manage personal spaces" }),
    ).toBeNull();
    expect(mocks.getSpaces).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: undefined, sortByType: true }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    const typeFilter = screen.getByRole("textbox", {
      name: "Filter by space type",
    });
    fireEvent.click(typeFilter);
    fireEvent.click(
      screen.getByRole("option", { name: "Default personal space" }),
    );
    expect(mocks.getSpaces).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "personal",
        personalKind: "default",
        cursor: undefined,
      }),
    );

    fireEvent.click(screen.getByRole("tab", { name: "My spaces" }));
    expect(
      screen.queryByRole("textbox", { name: "Filter by space type" }),
    ).toBeNull();
    expect(mocks.getSpaces).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "created-personal",
        personalKind: undefined,
        sortByType: undefined,
      }),
    );

    fireEvent.click(screen.getByRole("tab", { name: "All spaces" }));
    const restoredTypeFilter = screen.getByRole("textbox", {
      name: "Filter by space type",
    });
    fireEvent.click(restoredTypeFilter);
    fireEvent.click(screen.getByRole("option", { name: "Private space" }));
    expect(mocks.getSpaces).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "personal", personalKind: "created" }),
    );

    fireEvent.click(restoredTypeFilter);
    fireEvent.click(screen.getByRole("option", { name: "Public space" }));
    expect(mocks.getSpaces).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "public", personalKind: undefined }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(mocks.getSpaces).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: undefined, personalKind: undefined }),
    );
  },
);
