import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import SpaceSettingsModal from "./settings-modal";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/space/queries/space-query.ts", () => ({
  useSpaceQuery: () => ({
    data: {
      id: "space-1",
      name: "Engineering",
      slug: "engineering",
      settings: {},
      membership: { permissions: [] },
    },
    isLoading: false,
  }),
  useUpdateSpaceMutation: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@/features/space/permissions/use-space-ability.ts", () => ({
  useSpaceAbility: () => ({ can: () => true, cannot: () => false }),
}));

vi.mock("@/hooks/use-user-role.tsx", () => ({
  default: () => ({ isOwner: false }),
}));

vi.mock("@/features/space/components/space-members.tsx", () => ({
  default: () => null,
}));

vi.mock("@/features/space/components/add-space-members-modal.tsx", () => ({
  default: () => null,
}));

vi.mock("@/features/space/components/space-details.tsx", () => ({
  default: () => null,
}));

vi.mock("@/features/space/components/space-security-settings.tsx", () => ({
  default: () => null,
}));

describe("SpaceSettingsModal compilation review", () => {
  beforeAll(() => {
    global.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
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

  it("shows a default-off compilation review toggle to space settings managers", () => {
    render(
      <MantineProvider>
        <SpaceSettingsModal
          spaceId="engineering"
          opened
          onClose={vi.fn()}
        />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));

    const toggle = screen.getByRole("switch", {
      name: "Toggle compilation review",
    });
    expect((toggle as HTMLInputElement).checked).toBe(false);
  });
});
