import { MantineProvider } from "@mantine/core";
import { render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import SsoLogin from "./sso-login";
import { SSO_PROVIDER } from "@/ee/security/contants";

const workspaceData = {
  id: "workspace-1",
  enforceSso: false,
  authProviders: [
    {
      id: "provider-1",
      type: SSO_PROVIDER.HOIDC,
      name: "HOIDC",
    },
  ],
};

let currentUser: unknown = null;

vi.mock("@/features/workspace/queries/workspace-query.ts", () => ({
  useWorkspacePublicDataQuery: () => ({
    data: workspaceData,
    isLoading: false,
  }),
}));

vi.mock("@/features/user/hooks/use-current-user.ts", () => ({
  default: () => ({ data: currentUser }),
}));

vi.mock("@/ee/security/sso.utils.ts", () => ({
  buildSsoLoginUrl: vi.fn(({ redirect }) =>
    redirect
      ? `http://localhost:3000/api/sso/hoidc/login?redirect=${encodeURIComponent(redirect)}`
      : "http://localhost:3000/api/sso/hoidc/login",
  ),
}));

function renderSsoLogin(path: string) {
  window.history.pushState({}, "", path);
  render(
    <MantineProvider>
      <SsoLogin />
    </MantineProvider>,
  );
}

describe("SsoLogin", () => {
  let originalLocation: Location;
  let assignedHref = "";

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

  beforeEach(() => {
    currentUser = null;
    sessionStorage.clear();
    assignedHref = "";
    originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...originalLocation,
        get pathname() {
          return originalLocation.pathname;
        },
        get search() {
          return originalLocation.search;
        },
        get href() {
          return assignedHref || originalLocation.href;
        },
        set href(value: string) {
          assignedHref = value;
        },
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("auto redirects /login to HOIDC with /home as the post-login redirect", async () => {
    renderSsoLogin("/login");

    await waitFor(() => {
      expect(assignedHref).toBe(
        "http://localhost:3000/api/sso/hoidc/login?redirect=%2Fhome",
      );
    });
  });

  it("auto redirects /login?logout=1 to HOIDC after logout", async () => {
    sessionStorage.setItem("akasha:ssoAutoAttempt", String(Date.now()));
    renderSsoLogin("/login?logout=1");

    await waitFor(() => {
      expect(assignedHref).toBe(
        "http://localhost:3000/api/sso/hoidc/login?redirect=%2Fhome",
      );
    });
  });

  it("shows the login page when auto=akasha disables auto redirect", async () => {
    renderSsoLogin("/login?auto=akasha");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "HOIDC" })).toBeTruthy();
    });
    expect(assignedHref).toBe("");
  });

  it("also accepts quoted auto='akasha' to disable auto redirect", async () => {
    renderSsoLogin("/login?auto='akasha'");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "HOIDC" })).toBeTruthy();
    });
    expect(assignedHref).toBe("");
  });
});
