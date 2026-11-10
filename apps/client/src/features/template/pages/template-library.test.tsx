import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PageTemplate } from "../api/template.types";
import TemplateLibrary from "./template-library";

const mocks = vi.hoisted(() => ({
  templates: [] as PageTemplate[],
  writeText: vi.fn(),
  execCommand: vi.fn(),
  remove: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      key.replace(/{{(\w+)}}/g, (_, name) => values?.[name] ?? name),
  }),
}));
vi.mock("react-helmet-async", () => ({ Helmet: () => null }));
vi.mock("@/lib/config.ts", () => ({ getAppName: () => "Test" }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock("../api/template-hooks", () => ({
  useTemplateList: () => ({ data: mocks.templates, isLoading: false }),
  useTemplate: (id: string | null) => ({
    data: mocks.templates.find((tpl) => tpl.id === id),
  }),
  useRemoveTemplate: () => ({ mutate: mocks.remove }),
}));
vi.mock("../lib/use-space-names", () => ({
  useSpaceDirectory: () => ({
    spaces: [],
    availabilityLabel: () => "All spaces",
  }),
}));
vi.mock("../components/template-preview", () => ({
  TemplatePreview: () => <div>Preview body</div>,
}));
vi.mock("../components/template-creator", () => ({
  TemplateCreator: () => null,
}));

const ID = "0b6f8a3e-5c1d-4e2a-9f47-1a2b3c4d5e01";
function setup(options: Partial<PageTemplate> = {}) {
  mocks.templates = [
    {
      id: ID,
      title: "Weekly report",
      description: null,
      icon: null,
      allSpaces: true,
      spaceIds: [],
      otherSpaceCount: 0,
      workspaceId: "workspace",
      creatorId: null,
      lastUpdatedById: null,
      canManage: false,
      createdAt: "2026-10-30",
      updatedAt: "2026-10-30",
      ...options,
    },
  ];
  render(
    <MantineProvider env="test">
      <ModalsProvider>
        <MemoryRouter>
          <TemplateLibrary />
        </MemoryRouter>
      </ModalsProvider>
    </MantineProvider>,
  );
}

async function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Template actions" }));
  return screen.findByRole("menuitem", { name: "Copy template ID" });
}

describe("template ID actions in the library", () => {
  beforeAll(() => {
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any;
    Element.prototype.scrollIntoView = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: mocks.writeText },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: mocks.execCommand,
    });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writeText.mockReset().mockResolvedValue(undefined);
    mocks.execCommand.mockReset().mockReturnValue(false);
  });
  afterEach(cleanup);

  it.each([false, true])(
    "copies a visible read-only template (builtin=%s) without edit/delete",
    async (builtin) => {
      setup({ builtin });
      expect(screen.queryByText(ID)).toBeNull();
      fireEvent.click(await openMenu());
      await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(ID));
      await waitFor(() =>
        expect(notifications.show).toHaveBeenCalledWith({
          message: "Template ID copied",
        }),
      );
      expect(mocks.execCommand).not.toHaveBeenCalled();
      expect(mocks.navigate).not.toHaveBeenCalled();
      await openMenu();
      expect(screen.queryByRole("menuitem", { name: "Edit" })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
      expect(mocks.remove).not.toHaveBeenCalled();
    },
  );

  it("retains edit/delete for managers alongside copy", async () => {
    setup({ canManage: true });
    await openMenu();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(mocks.navigate).toHaveBeenCalledWith(`/templates/${ID}`);
  });

  it("copies from a read-only preview without offering edit", async () => {
    setup();
    fireEvent.click(
      screen.getByRole("button", { name: "Preview template Weekly report" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy template ID" }),
    );
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(ID));
    expect(screen.queryByRole("button", { name: "Edit template" })).toBeNull();
    expect(screen.queryByText(ID)).toBeNull();
  });

  it("waits for clipboard confirmation before reporting success", async () => {
    let resolve!: () => void;
    mocks.writeText.mockReturnValue(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    setup();
    fireEvent.click(await openMenu());
    expect(notifications.show).not.toHaveBeenCalled();
    resolve();
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith({
        message: "Template ID copied",
      }),
    );
  });

  it("uses the legacy clipboard fallback only when it confirms success", async () => {
    mocks.writeText.mockRejectedValue(new Error("Denied"));
    mocks.execCommand.mockReturnValue(true);
    setup();
    fireEvent.click(await openMenu());
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith({
        message: "Template ID copied",
      }),
    );
    expect(mocks.execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("uses the fallback when the clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    mocks.execCommand.mockReturnValue(true);
    try {
      setup();
      fireEvent.click(await openMenu());
      await waitFor(() =>
        expect(notifications.show).toHaveBeenCalledWith({
          message: "Template ID copied",
        }),
      );
      expect(mocks.writeText).not.toHaveBeenCalled();
      expect(mocks.execCommand).toHaveBeenCalledWith("copy");
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: mocks.writeText },
      });
    }
  });

  it("keeps the manual-copy fallback accessible over a read-only preview", async () => {
    mocks.writeText.mockRejectedValue(new Error("Denied"));
    setup();
    fireEvent.click(
      screen.getByRole("button", { name: "Preview template Weekly report" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy template ID" }),
    );
    const input = (await screen.findByRole("textbox", {
      name: "Template ID",
    })) as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe(ID);
    expect(input.selectionEnd).toBe(ID.length);
    expect(notifications.show).not.toHaveBeenCalled();
  });

  it.each([false, "throw"])(
    "shows a selectable ID after clipboard failure (%s), without success",
    async (result) => {
      mocks.writeText.mockRejectedValue(new Error("Denied"));
      mocks.execCommand.mockImplementation(() => {
        if (result === "throw") throw new Error("Unavailable");
        return false;
      });
      setup();
      fireEvent.click(await openMenu());
      const input = (await screen.findByRole("textbox", {
        name: "Template ID",
      })) as HTMLInputElement;
      expect(input.value).toBe(ID);
      expect(input.readOnly).toBe(true);
      expect(await screen.findByRole("alert")).toBeTruthy();
      fireEvent.click(input);
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe(ID.length);
      expect(notifications.show).not.toHaveBeenCalled();
      expect(document.querySelector("textarea")).toBeNull();
    },
  );
});
