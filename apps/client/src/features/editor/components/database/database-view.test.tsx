import { MantineProvider } from "@mantine/core";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildDatabaseJSON,
  Database,
  DatabaseCell,
  DatabaseRow,
  readDatabaseRows,
  setDatabaseCellValue,
  updateDatabaseView,
} from "@docmost/editor-ext";
import DatabaseView from "./database-view";
import { clampText } from "./database-ui";

// The viewer is Ann (u1); p1 is visible to her, p2 is not.
vi.mock("@/features/search/services/search-service", () => ({
  resolvePages: vi.fn(async (ids: string[]) =>
    ids.includes("p1")
      ? [{ id: "p1", title: "Spec", slugId: "abc", space: { slug: "eng" } }]
      : [],
  ),
  searchSuggestions: vi.fn(async () => ({ users: [], pages: [] })),
}));

vi.mock("@/features/user/atoms/current-user-atom", async () => {
  const { atom } = await import("jotai");
  return {
    userAtom: atom({ id: "u1", name: "Ann", avatarUrl: "" }),
    currentUserAtom: atom(null),
  };
});

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? "")),
    i18n: { language: "en-US" },
  }),
}));

const doc = {
  type: "doc",
  content: [
    buildDatabaseJSON({
      id: "db1",
      title: "Tasks",
      columns: [
        { id: "name", name: "Name", type: "text" },
        {
          id: "status",
          name: "Status",
          type: "select",
          options: [
            { id: "todo", name: "To do", color: "gray" },
            { id: "done", name: "Done", color: "green" },
          ],
        },
        { id: "due", name: "Due", type: "date" },
        {
          id: "owner",
          name: "Owner",
          type: "person",
          options: [
            { id: "u1", name: "Ann", color: "blue" },
            { id: "u2", name: "Bob", color: "blue" },
            // Assigned once, then removed from every row.
            { id: "u3", name: "Cid", color: "blue" },
          ],
        },
        {
          id: "doc",
          name: "Doc",
          type: "page",
          // Stored as ids only; titles come from the permission-checked lookup below.
          options: [
            { id: "p1", name: "", color: "blue" },
            { id: "p2", name: "", color: "blue" },
          ],
        },
      ],
      views: [
        { id: "t", name: "Grid", type: "table" },
        { id: "k", name: "Board", type: "kanban", groupBy: "status" },
        { id: "c", name: "Cal", type: "calendar", dateColumnId: "due" },
        { id: "l", name: "Plan", type: "timeline", dateColumnId: "due" },
        { id: "m", name: "Me", type: "mine" },
      ],
      rows: [
        {
          id: "r1",
          values: {
            name: "Write spec",
            status: "todo",
            owner: ["u1"],
            doc: ["p1"],
          },
        },
        {
          id: "r2",
          values: {
            name: "Ship it",
            status: "done",
            owner: ["u1"],
            doc: ["p2"],
            due: "2026-11-03",
          },
        },
        {
          id: "r3",
          values: { name: "Not mine", status: "todo", owner: ["u2"] },
        },
      ],
    }),
  ],
};

let editor: Editor | null = null;

function Harness() {
  const instance = useEditor({
    extensions: [
      StarterKit,
      Database.configure({ view: DatabaseView }),
      DatabaseRow,
      DatabaseCell,
    ],
    content: doc,
    immediatelyRender: true,
  });
  editor = instance;
  return <EditorContent editor={instance} />;
}

function renderEditor() {
  localStorage.clear();
  render(
    <MantineProvider>
      <Harness />
    </MantineProvider>,
  );
}

const rows = () => readDatabaseRows(editor!.state.doc.child(0));

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
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
  Element.prototype.scrollIntoView = vi.fn();
});

describe("DatabaseView", () => {
  it("renders the table view with headers and rows", async () => {
    renderEditor();
    expect(await screen.findByText("Write spec")).toBeTruthy();
    expect(screen.getByText("Ship it")).toBeTruthy();
    expect(screen.getByText("Status")).toBeTruthy();
    expect(screen.getAllByText("To do").length).toBeGreaterThan(0);
  });

  it("edits a cell by typing, committing on Enter", async () => {
    renderEditor();
    const cell = (await screen.findByText("Write spec")).closest("td")!;
    fireEvent.mouseDown(cell, { button: 0 });
    const grid = cell.closest("[data-db-focus]")!;
    fireEvent.keyDown(grid, { key: "X" });
    const input = within(cell).getByDisplayValue("X");
    fireEvent.change(input, { target: { value: "Xylophone" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(rows()[0].values.name).toBe("Xylophone");
  });

  it("clears a selected cell with Backspace without touching the rest of the doc", async () => {
    renderEditor();
    const cell = (await screen.findByText("Ship it")).closest("td")!;
    fireEvent.mouseDown(cell, { button: 0 });
    fireEvent.keyDown(cell.closest("[data-db-focus]")!, { key: "Backspace" });
    expect(rows()[1].values.name).toBe("");
    expect(rows()).toHaveLength(3);
  });

  it("adds a row from the New row button", async () => {
    renderEditor();
    fireEvent.click(await screen.findByLabelText("New row"));
    expect(rows()).toHaveLength(4);
  });

  it("switches to the kanban and calendar views of the same rows", async () => {
    renderEditor();
    fireEvent.click(await screen.findByText("Board"));
    const lane = document.querySelector(
      '[data-lane-key="todo"]',
    ) as HTMLElement;
    expect(lane).toBeTruthy();
    expect(within(lane).getByText("Write spec")).toBeTruthy();
    expect(document.querySelector('[data-lane-key="done"]')).toBeTruthy();

    fireEvent.click(screen.getByText("Cal"));
    expect(
      document.querySelectorAll("[data-day]").length,
    ).toBeGreaterThanOrEqual(28);
    // Both rows have no date yet.
    expect(screen.getByText("No date (2)")).toBeTruthy();
  });

  it("creates and selects a new option from the tag picker", async () => {
    renderEditor();
    await screen.findByText("Write spec");
    const cell = document.querySelector(
      'tr[data-row-id="r1"] td[data-type="select"]',
    ) as HTMLElement;
    fireEvent.mouseDown(cell, { button: 0 });
    fireEvent.keyDown(cell.closest("[data-db-focus]")!, { key: "Enter" });
    // The row already has a value, so the input shows the chip instead of a placeholder.
    const hint = await screen.findByText("Select an option or create one");
    const input = hint.parentElement!.querySelector("input")!;
    expect(
      within(hint.parentElement!).getAllByText("To do").length,
    ).toBeGreaterThan(0);
    fireEvent.change(input, { target: { value: "Blocked" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    const column = editor!.state.doc
      .child(0)
      .attrs.columns.find((c: any) => c.id === "status");
    const created = column.options.find((o: any) => o.name === "Blocked");
    expect(created).toBeTruthy();
    expect(rows()[0].values.status).toBe(created.id);
  });

  it("edits a table cell on double-click, single click only selects", async () => {
    renderEditor();
    const cell = (await screen.findByText("Write spec")).closest("td")!;
    fireEvent.mouseDown(cell, { button: 0 });
    expect(within(cell).queryByDisplayValue("Write spec")).toBeNull();
    fireEvent.doubleClick(cell);
    const input = within(cell).getByDisplayValue("Write spec");
    fireEvent.change(input, { target: { value: "Write it" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(rows()[0].values.name).toBe("Write it");
  });

  it("edits a kanban card field only on double-click", async () => {
    renderEditor();
    fireEvent.click(await screen.findByText("Board"));
    const card = document.querySelector('[data-card-id="r1"]') as HTMLElement;
    const field = within(card).getByText("Write spec");
    fireEvent.click(field);
    expect(within(card).queryByDisplayValue("Write spec")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.doubleClick(field);
    expect(within(card).getByDisplayValue("Write spec")).toBeTruthy();
  });

  it("names a column after its type, following type changes", async () => {
    renderEditor();
    await screen.findByText("Write spec");
    fireEvent.click(screen.getByLabelText("Add column"));
    const added = () => editor!.state.doc.child(0).attrs.columns.at(-1);
    expect(added().name).toBe("Text");
    fireEvent.click(await screen.findByText("Type"));
    fireEvent.click(await screen.findByText("Number"));
    expect(added()).toMatchObject({ type: "number", name: "Number" });
  });

  it("moves the keyboard selection onto the header row and opens its menu", async () => {
    renderEditor();
    const cell = (await screen.findByText("Write spec")).closest("td")!;
    fireEvent.mouseDown(cell, { button: 0 });
    const grid = cell.closest("[data-db-focus]")!;
    fireEvent.keyDown(grid, { key: "ArrowUp" });
    const header = screen.getByText("Name").closest("th")!;
    expect(header.hasAttribute("data-selected")).toBe(true);
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(await screen.findByText("Hide in view")).toBeTruthy();
  });

  it("hides a column from the column menu", async () => {
    renderEditor();
    await screen.findByText("Write spec");
    fireEvent.doubleClick(screen.getByText("Due"));
    fireEvent.click(await screen.findByText("Hide in view"));
    const view = editor!.state.doc
      .child(0)
      .attrs.views.find((v: any) => v.id === "t");
    expect(view.columns.find((c: any) => c.id === "due").hidden).toBe(true);
    expect(screen.queryByText("Due")).toBeNull();
  });

  it("opens a row in the detail modal and steps to the next row", async () => {
    renderEditor();
    await screen.findByText("Write spec");
    fireEvent.click(screen.getAllByLabelText("Expand")[0]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Write spec")).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText("Next"));
    fireEvent.click(await within(dialog).findByText("Ship it"));
    const input = await within(dialog).findByDisplayValue("Ship it");
    fireEvent.change(input, { target: { value: "Ship it now" } });
    fireEvent.blur(input);
    expect(rows()[1].values.name).toBe("Ship it now");
  });

  it("moves a kanban card to another group from its menu", async () => {
    renderEditor();
    fireEvent.click(await screen.findByText("Board"));
    const card = document.querySelector(
      '[data-lane-key="todo"] [data-card-id="r1"]',
    ) as HTMLElement;
    fireEvent.click(within(card).getByLabelText("More"));
    const menu = await screen.findByText("Move to");
    const target = within(menu.parentElement as HTMLElement)
      .getAllByText("Done")
      .pop()!;
    fireEvent.click(target);
    expect(rows()[0].values.status).toBe("done");
    expect(
      document.querySelector('[data-lane-key="done"] [data-card-id="r1"]'),
    ).toBeTruthy();
  });

  it("numbers rows and groups the table by a select column", async () => {
    renderEditor();
    await screen.findByText("Write spec");
    expect(
      document.querySelector("tbody tr td:nth-child(2)")?.textContent,
    ).toBe("1");
    act(() => {
      editor!.commands.command(({ tr }) => {
        updateDatabaseView(tr, 0, "t", { groupBy: "status" });
        return true;
      });
    });
    const groups = [...document.querySelectorAll("tr[data-group-key]")].map(
      (row) => (row as HTMLElement).dataset.groupKey,
    );
    expect(groups).toEqual(["todo", "done"]);
    fireEvent.click(screen.getAllByLabelText("Collapse")[0]);
    expect(screen.queryByText("Write spec")).toBeNull();
    expect(screen.getByText("Ship it")).toBeTruthy();
  });

  it("lays a board out horizontally, one row of cards per group", async () => {
    renderEditor();
    fireEvent.click(await screen.findByText("Board"));
    act(() => {
      editor!.commands.command(({ tr }) => {
        updateDatabaseView(tr, 0, "k", { orientation: "horizontal" });
        return true;
      });
    });
    const board = document.querySelector("[data-orientation]") as HTMLElement;
    expect(board.dataset.orientation).toBe("horizontal");
    expect(
      board.querySelector('[data-lane-key="todo"] [data-card-id="r1"]'),
    ).toBeTruthy();
  });

  it("renames the active view in place on double-click", async () => {
    renderEditor();
    await screen.findByText("Write spec");
    fireEvent.doubleClick(screen.getByText("Grid"));
    const input = screen.getByDisplayValue("Grid");
    fireEvent.change(input, { target: { value: "All tasks" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("dialog")).toBeNull();
    const view = editor!.state.doc
      .child(0)
      .attrs.views.find((v: any) => v.id === "t");
    expect(view.name).toBe("All tasks");
  });

  it("only shows members someone is assigned to as board groups", async () => {
    renderEditor();
    fireEvent.click(await screen.findByText("Board"));
    act(() => {
      editor!.commands.command(({ tr }) => {
        updateDatabaseView(tr, 0, "k", { groupBy: "owner" });
        return true;
      });
    });
    const lanes = [...document.querySelectorAll("[data-lane-key]")].map(
      (lane) => (lane as HTMLElement).dataset.laneKey,
    );
    expect(lanes).toEqual(["u1", "u2"]);
  });

  it("shows documents the viewer can see, and only a lock for the others", async () => {
    renderEditor();
    await screen.findByText("Write spec");
    await waitFor(() =>
      expect(document.querySelector('a[data-page-id="p1"]')?.textContent).toBe(
        "Spec",
      ),
    );
    const link = document.querySelector('a[data-page-id="p1"]')!;
    expect(link.getAttribute("href")).toBe("/s/eng/p/spec-abc");
    const hidden = document.querySelector('[data-page-id="p2"]')!;
    expect(hidden.hasAttribute("data-unavailable")).toBe(true);
    expect(hidden.tagName).not.toBe("A");
    // English counts as half width, so four CJK widths fit "No acces".
    expect(hidden.textContent).toBe("No acces…");
  });

  it("clamps member names to three and document titles to four CJK characters", () => {
    expect(clampText("张三丰", 3)).toBe("张三丰");
    expect(clampText("欧阳娜娜", 3)).toBe("欧阳娜…");
    expect(clampText("产品需求文档", 4)).toBe("产品需求…");
    expect(clampText("Annabel", 3)).toBe("Annabe…");
  });

  it("lists only the viewer's rows in the Mine view", async () => {
    renderEditor();
    fireEvent.click(await screen.findByText("Me"));
    expect(await screen.findByText("Write spec")).toBeTruthy();
    expect(screen.getByText("Ship it")).toBeTruthy();
    expect(screen.queryByText("Not mine")).toBeNull();
    fireEvent.click(screen.getByLabelText("New row"));
    expect(rows().at(-1)!.values.owner).toEqual(["u1"]);
  });

  it("lays the timeline out by the dates that have rows, undated last", async () => {
    renderEditor();
    fireEvent.click(await screen.findByText("Plan"));
    const dates = [...document.querySelectorAll("[data-timeline-date]")].map(
      (node) => (node as HTMLElement).dataset.timelineDate,
    );
    expect(dates).toEqual(["2026-11-03"]);
    const dated = document.querySelector('[data-timeline-date="2026-11-03"]')!;
    expect(within(dated as HTMLElement).getByText("Ship it")).toBeTruthy();
    expect(screen.getByText("No date (2)")).toBeTruthy();
  });

  it("drops Expand from the row menu while the row number shows its own", async () => {
    renderEditor();
    await screen.findByText("Write spec");
    fireEvent.click(screen.getAllByLabelText("More")[0]);
    const insert = await screen.findByText("Insert above");
    const menu = insert.closest(".mantine-Popover-dropdown") as HTMLElement;
    expect(within(menu).queryByText("Expand")).toBeNull();
  });

  it("labels every card field with its icon and name", async () => {
    renderEditor();
    fireEvent.click(await screen.findByText("Board"));
    act(() => {
      editor!.commands.command(({ tr }) => {
        setDatabaseCellValue(tr, 0, "r1", "due", "2026-11-03");
        return true;
      });
    });
    const card = document.querySelector('[data-card-id="r1"]') as HTMLElement;
    const names = [...card.querySelectorAll("span[title]")]
      .filter((label) => !label.closest("[data-field]"))
      .map((label) => label.textContent);
    expect(names).toEqual(["Due", "Owner", "Doc"]);
    expect(within(card).getByText("Ann")).toBeTruthy();
  });

  it("filters rows with the search box", async () => {
    renderEditor();
    await screen.findByText("Write spec");
    fireEvent.click(screen.getByLabelText("Search"));
    const input = screen.getByPlaceholderText("Search");
    await act(async () => {
      fireEvent.change(input, { target: { value: "ship" } });
    });
    expect(screen.queryByText("Write spec")).toBeNull();
    expect(document.querySelector("mark")?.textContent).toBe("Ship");
  });
});
