import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import SpaceSecuritySettings from "./space-security-settings";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  };
});

vi.mock("@/ee/security/components/space-public-sharing-toggle.tsx", () => ({
  default: () => <div data-testid="space-public-sharing-toggle" />,
}));

vi.mock("@/ee/security/components/space-viewer-comments-toggle.tsx", () => ({
  default: () => <div data-testid="space-viewer-comments-toggle" />,
}));

describe("SpaceSecuritySettings", () => {
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

  it("does not show the public sharing control", () => {
    render(
      <MantineProvider>
        <SpaceSecuritySettings space={{ id: "space-1" } as never} />
      </MantineProvider>,
    );

    expect(screen.queryByTestId("space-public-sharing-toggle")).toBeNull();
    expect(screen.getByTestId("space-viewer-comments-toggle")).toBeTruthy();
  });
});
