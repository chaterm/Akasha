import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import TopMenu from "./top-menu";

const currentUser = {
  user: {
    id: "user-1",
    name: "name001",
    email: "xxxx@xxxxx.net",
    avatarUrl: "",
  },
  workspace: {
    id: "workspace-1",
    name: "知识库",
    logo: "",
  },
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("jotai", async () => {
  const actual = await vi.importActual<typeof import("jotai")>("jotai");
  return {
    ...actual,
    useAtom: () => [currentUser],
  };
});

vi.mock("@/features/auth/hooks/use-auth.ts", () => ({
  default: () => ({ logout: vi.fn() }),
}));

vi.mock("@/hooks/use-user-role.tsx", () => ({
  default: () => ({ isAdmin: false, isOwner: false }),
}));

vi.mock("@/features/space/queries/space-query.ts", () => ({
  useGetSpacesQuery: () => ({
    data: {
      items: [
        {
          id: "space-1",
          name: "xxxxxxx(xxxxxx@xxxxx.net)",
          slug: "personal-space",
          creatorId: "user-1",
          membership: { userId: "user-1", role: "admin" },
        },
      ],
    },
  }),
}));

describe("TopMenu", () => {
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

  it("uses the current user's avatar in the menu trigger", () => {
    render(
      <MantineProvider>
        <MemoryRouter>
          <TopMenu />
        </MemoryRouter>
      </MantineProvider>,
    );

    expect(screen.getByTitle("姚旭红")).toBeTruthy();
    expect(screen.queryByTitle("知识库")).toBeNull();
  });

  it("shows a personal space shortcut for the current user", async () => {
    render(
      <MantineProvider>
        <MemoryRouter>
          <TopMenu />
        </MemoryRouter>
      </MantineProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /知识库/ }));

    const personalSpace = await screen.findByRole("menuitem", {
      name: "Personal space",
    });

    expect(personalSpace.getAttribute("href")).toBe("/s/personal-space");
  });
});
