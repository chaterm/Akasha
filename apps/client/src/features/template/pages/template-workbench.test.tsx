import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import {
  createMemoryRouter,
  Link,
  Route,
  RouterProvider,
  Routes,
} from "react-router-dom";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import TemplateWorkbench from "./template-workbench";
import { PageTemplate } from "../api/template.types";
import { notifications } from "@mantine/notifications";

const mocks = vi.hoisted(() => ({
  t: (key: string) => key,
  create: vi.fn(),
  template: undefined as PageTemplate | undefined,
  writeText: vi.fn(),
  editor: {
    isDestroyed: false,
    isEditable: true,
    setEditable: vi.fn(),
    getJSON: () => ({ type: "doc", content: [{ type: "paragraph" }] }),
  },
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock("react-helmet-async", () => ({ Helmet: () => null }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("@/lib/config.ts", () => ({ getAppName: () => "Test" }));
vi.mock("@/features/editor/extensions/extensions", () => ({
  templateExtensions: [],
}));
vi.mock("@tiptap/react", () => ({
  useEditor: ({ editable }: { editable: boolean }) => {
    mocks.editor.isEditable = editable;
    return mocks.editor;
  },
  EditorContent: () => <div data-testid="body" />,
}));
vi.mock("@/components/ui/emoji-picker", () => ({
  default: ({ readOnly }: { readOnly: boolean }) => (
    <button disabled={readOnly}>Emoji</button>
  ),
}));
vi.mock("@/features/editor/components/bubble-menu/bubble-menu", () => ({
  EditorBubbleMenu: () => null,
}));
vi.mock("@/features/editor/components/link/link-menu", () => ({
  EditorLinkMenu: () => null,
}));
vi.mock("@/features/editor/components/table/table-menu.tsx", () => ({
  default: () => null,
}));
vi.mock("@/features/editor/components/callout/callout-menu.tsx", () => ({
  default: () => null,
}));
vi.mock(
  "@/features/editor/components/transclusion/transclusion-lookup-context",
  () => ({
    TransclusionLookupProvider: ({ children }: any) => children,
  }),
);
vi.mock("../components/template-creator", () => ({
  TemplateCreator: () => null,
}));
vi.mock("../components/template-availability-picker", () => ({
  TemplateAvailabilityPicker: ({ disabled }: { disabled: boolean }) => (
    <button disabled={disabled}>Availability</button>
  ),
}));
vi.mock("../api/template-hooks", () => ({
  useTemplate: () => ({
    data: mocks.template,
    isLoading: false,
    isError: false,
  }),
  useSaveTemplate: () => ({ mutateAsync: vi.fn() }),
  useRemoveTemplate: () => ({ mutate: vi.fn() }),
  useCreateTemplate: () => {
    const [isPending, setPending] = useState(false);
    return {
      isPending,
      mutateAsync: async (draft: unknown) => {
        setPending(true);
        try {
          return await mocks.create(draft);
        } finally {
          setPending(false);
        }
      },
    };
  },
}));

function setup(path = "/templates/new") {
  // 与入口一致：数据路由包裹现有的后代 Routes。
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <>
            <Link to="/home">Sidebar home</Link>
            <Routes>
              <Route
                path="/templates/:templateId"
                element={<TemplateWorkbench />}
              />
              <Route
                path="/templates/saved"
                element={<div>Created template</div>}
              />
              <Route path="*" element={<div>Library</div>} />
            </Routes>
          </>
        ),
      },
    ],
    { initialEntries: ["/templates", path], initialIndex: 1 },
  );
  render(
    <MantineProvider env="test">
      <ModalsProvider>
        <RouterProvider router={router} />
      </ModalsProvider>
    </MantineProvider>,
  );
  return router;
}

const nameInput = () =>
  screen.getByRole("textbox", { name: "Template name" }) as HTMLInputElement;
const edit = () =>
  fireEvent.change(nameInput(), { target: { value: "My template" } });

describe("template workbench", () => {
  beforeAll(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: mocks.writeText },
    });
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
  });
  beforeEach(() => {
    mocks.template = undefined;
    mocks.writeText.mockReset().mockResolvedValue(undefined);
    vi.mocked(notifications.show).mockClear();
    mocks.create.mockReset();
    mocks.editor.setEditable.mockClear();
  });
  afterEach(cleanup);

  it("does not offer copy for a new draft, including while creation is pending", async () => {
    let resolve!: (value: { id: string }) => void;
    mocks.create.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    setup();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    expect(screen.queryByText("Copy template ID")).toBeNull();
    edit();
    fireEvent.click(screen.getByRole("button", { name: "Create template" }));
    expect(screen.queryByText("Copy template ID")).toBeNull();
    expect(mocks.writeText).not.toHaveBeenCalled();
    await act(async () => resolve({ id: "saved" }));
  });

  it("copies the saved ID from More actions even after a local rename", async () => {
    const id = "1c9753ac-5990-4b55-b00e-8a688b24d2a0";
    mocks.template = {
      id,
      title: "Saved report",
      description: null,
      icon: null,
      allSpaces: true,
      spaceIds: [],
      otherSpaceCount: 0,
      workspaceId: "workspace",
      creatorId: null,
      lastUpdatedById: null,
      canManage: true,
      createdAt: "2026-10-30",
      updatedAt: "2026-10-30",
    };
    setup(`/templates/${id}`);
    edit();
    expect(screen.queryByText(id)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy template ID" }),
    );
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(id));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith({
        message: "Template ID copied",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(
      await screen.findByRole("menuitem", { name: "Delete template" }),
    ).toBeTruthy();
    expect(screen.queryByText("Discard this template?")).toBeNull();
  });

  it("continues to deny workbench editing to a read-only template", () => {
    mocks.template = { id: "readonly", canManage: false } as PageTemplate;
    setup("/templates/readonly");
    expect(
      screen.getByText("You don't have permission to edit this template"),
    ).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Template name" })).toBeNull();
    expect(screen.queryByText("Copy template ID")).toBeNull();
  });

  it("browser back keeps the draft on cancel and leaves on discard", async () => {
    const router = setup();
    edit();
    await act(() => router.navigate(-1));
    expect(await screen.findByText("Discard this template?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() =>
      expect(screen.queryByText("Discard this template?")).toBeNull(),
    );
    expect(router.state.location.pathname).toBe("/templates/new");
    expect(nameInput().value).toBe("My template");
    await act(() => router.navigate(-1));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/templates"),
    );
  });

  it("sidebar navigation can be dismissed, retried, and confirmed", async () => {
    const router = setup();
    edit();
    fireEvent.click(screen.getByRole("link", { name: "Sidebar home" }));
    expect(await screen.findByText("Discard this template?")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByText("Discard this template?")).toBeNull(),
    );
    expect(nameInput().value).toBe("My template");
    fireEvent.click(screen.getByRole("link", { name: "Sidebar home" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/home"));
  });

  it("an untouched draft leaves without prompting", async () => {
    const router = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/templates"),
    );
    expect(screen.queryByText("Discard this template?")).toBeNull();
  });

  it("locks edits and navigation while creating and opens the saved template without a prompt", async () => {
    let resolve!: (value: { id: string }) => void;
    mocks.create.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const router = setup();
    edit();
    fireEvent.click(screen.getByRole("button", { name: "Create template" }));
    expect(nameInput().disabled).toBe(true);
    expect(
      (
        screen.getByRole("textbox", {
          name: "Description",
        }) as HTMLTextAreaElement
      ).disabled,
    ).toBe(true);
    for (const name of ["Emoji", "Availability", "Cancel"]) {
      expect(
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    expect(mocks.editor.setEditable).toHaveBeenCalledWith(false, false);
    expect(mocks.editor.isEditable).toBe(false);
    fireEvent.click(screen.getByRole("link", { name: "Sidebar home" }));
    await waitFor(() =>
      expect(router.state.blockers.values().next().value?.state).toBe(
        "unblocked",
      ),
    );
    expect(router.state.location.pathname).toBe("/templates/new");
    await act(async () => resolve({ id: "saved" }));
    expect(await screen.findByText("Created template")).toBeTruthy();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "My template" }),
    );
    expect(screen.queryByText("Discard this template?")).toBeNull();
  });

  it("a failed creation restores editing and keeps draft protection", async () => {
    let reject!: (error: Error) => void;
    mocks.create.mockReturnValue(
      new Promise((_done, fail) => {
        reject = fail;
      }),
    );
    setup();
    edit();
    fireEvent.click(screen.getByRole("button", { name: "Create template" }));
    await act(async () => reject(new Error("Failed")));
    expect(nameInput().disabled).toBe(false);
    expect(nameInput().value).toBe("My template");
    expect(mocks.editor.setEditable).toHaveBeenLastCalledWith(true, false);
    expect(mocks.editor.isEditable).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Discard this template?")).toBeTruthy();
  });
});
