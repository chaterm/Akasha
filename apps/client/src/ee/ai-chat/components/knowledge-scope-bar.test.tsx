import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import KnowledgeScopeBar from "./knowledge-scope-bar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/use-user-role", () => ({
  default: () => ({ isAdmin: false }),
}));

vi.mock("@/features/space/components/space-filter-menu", () => ({
  SpaceFilterMenu: ({
    children,
    onChange,
  }: {
    children: ReactNode;
    onChange: (spaceId: string | null) => void;
  }) => (
    <>
      {children}
      <button type="button" onClick={() => onChange(null)}>
        choose all
      </button>
      <button type="button" onClick={() => onChange("space-1")}>
        choose AIM
      </button>
    </>
  ),
}));

describe("KnowledgeScopeBar", () => {
  beforeAll(() => {
    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    window.ResizeObserver = ResizeObserverMock;

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

  it("offers either all spaces or one concrete space", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <MantineProvider>
        <MemoryRouter>
          <KnowledgeScopeBar
            options={[{ value: "space-1", label: "AIM" }]}
            selectedSpaceId={null}
            onChange={onChange}
            showManagementLinks
          />
        </MemoryRouter>
      </MantineProvider>,
    );

    expect(screen.getByText("Space: All spaces")).toBeTruthy();
    const scopeButton = screen.getByRole("button", {
      name: "Knowledge spaces",
    });
    expect(scopeButton.parentElement?.firstElementChild).toBe(scopeButton);
    expect(screen.queryByText("Knowledge scope")).toBeNull();
    fireEvent.click(screen.getByText("choose AIM"));
    expect(onChange).toHaveBeenCalledWith("space-1");

    rerender(
      <MantineProvider>
        <MemoryRouter>
          <KnowledgeScopeBar
            options={[{ value: "space-1", label: "AIM" }]}
            selectedSpaceId="space-1"
            onChange={onChange}
          />
        </MemoryRouter>
      </MantineProvider>,
    );

    expect(screen.getByText("Space: AIM")).toBeTruthy();
    fireEvent.click(screen.getByText("choose all"));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
