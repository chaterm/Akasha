import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import Security from "./security";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  };
});

vi.mock("react-helmet-async", () => ({
  Helmet: () => null,
}));

vi.mock("@/lib/config.ts", () => ({
  getAppName: () => "Akasha",
  isCloud: () => false,
}));

vi.mock("@/hooks/use-user-role.tsx", () => ({
  default: () => ({ isAdmin: true }),
}));

vi.mock("jotai", async () => {
  const actual = await vi.importActual<typeof import("jotai")>("jotai");
  return {
    ...actual,
    useAtom: () => [{ isScimEnabled: false }],
  };
});

vi.mock("@/ee/hooks/use-feature", () => ({
  useHasFeature: () => false,
}));

vi.mock("@/hooks/use-cursor-paginate", () => ({
  useCursorPaginate: () => ({
    cursor: undefined,
    goNext: vi.fn(),
    goPrev: vi.fn(),
  }),
}));

vi.mock("@/ee/scim/queries/scim-token-query", () => ({
  useGetScimTokensQuery: () => ({ data: undefined, isLoading: false }),
}));

vi.mock("@/ee/security/components/enforce-mfa.tsx", () => ({
  default: () => <div data-testid="enforce-mfa" />,
}));

vi.mock("@/ee/security/components/disable-public-sharing.tsx", () => ({
  default: () => <div data-testid="disable-public-sharing" />,
}));

vi.mock("@/ee/security/components/trash-retention.tsx", () => ({
  default: () => <div data-testid="trash-retention" />,
}));

vi.mock("@/ee/security/components/enforce-sso.tsx", () => ({
  default: () => <div data-testid="enforce-sso" />,
}));

vi.mock("@/ee/security/components/sso-provider-list.tsx", () => ({
  default: () => <div data-testid="sso-provider-list" />,
}));

describe("Security", () => {
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

  it("does not show the workspace public sharing control", () => {
    render(
      <MantineProvider>
        <Security />
      </MantineProvider>,
    );

    expect(screen.queryByTestId("disable-public-sharing")).toBeNull();
    expect(screen.getByTestId("enforce-mfa")).toBeTruthy();
  });
});
