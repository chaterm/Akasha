import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SearchControl } from "./search-control";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("SearchControl", () => {
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

  it("renders a compact search trigger without the shortcut badge", () => {
    const onClick = vi.fn();

    render(
      <MantineProvider>
        <SearchControl
          {...({ compact: true } as Record<string, unknown>)}
          onClick={onClick}
        />
      </MantineProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Search" });
    expect(screen.queryByText(/\+ K/)).toBeNull();

    fireEvent.click(trigger);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
