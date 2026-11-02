import { afterEach, describe, expect, it } from "vitest";
import { Editor, getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import { prosemirrorToYDoc } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import {
  Database,
  DatabaseCell,
  DatabaseRow,
  buildDatabaseJSON,
  insertDatabaseRow,
  moveDatabaseRow,
  readDatabaseRows,
  setDatabaseCellValue,
} from "@docmost/editor-ext";

const DB_POS = 2; // The empty paragraph before the database.
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function createPeers() {
  const extensions = [
    StarterKit.configure({ undoRedo: false }),
    Database.extend({
      addNodeView() {
        return undefined;
      },
    }),
    DatabaseRow,
    DatabaseCell,
  ];
  const schema = getSchema(extensions);
  const doc = schema.nodeFromJSON({
    type: "doc",
    content: [
      { type: "paragraph" },
      buildDatabaseJSON({
        columns: [{ id: "name", name: "Name", type: "text" }],
        views: [{ id: "table", name: "Table", type: "table" }],
        rows: [
          { id: "r1", values: { name: "Original A" } },
          { id: "r2", values: { name: "Original B" } },
        ],
      }),
      { type: "paragraph" },
    ],
  });
  const seed = prosemirrorToYDoc(doc);
  const update = Y.encodeStateAsUpdate(seed);
  const docs = [new Y.Doc(), new Y.Doc()];
  const peers = docs.map((document) => {
    Y.applyUpdate(document, update);
    return new Editor({
      extensions: [
        ...extensions,
        Collaboration.configure({ document, field: "prosemirror" }),
      ],
    });
  });
  cleanups.push(() => {
    peers.forEach((editor) => editor.destroy());
    docs.forEach((document) => document.destroy());
    seed.destroy();
  });
  return {
    a: peers[0],
    b: peers[1],
    sync(reverse = false) {
      const [first, second] = reverse ? [...docs].reverse() : docs;
      Y.applyUpdate(first, Y.encodeStateAsUpdate(second));
      Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
    },
  };
}

const rowsOf = (editor: Editor) =>
  readDatabaseRows(editor.state.doc.nodeAt(DB_POS)!);

describe("database collaboration", () => {
  for (const rowId of ["r1", "r2"]) {
    it.each([false, true])(
      `preserves concurrent edits to ${rowId} while reordering (reverse sync: %s)`,
      (reverse) => {
        const { a, b, sync } = createPeers();
        a.view.dispatch(moveDatabaseRow(a.state.tr, DB_POS, "r1", null));
        b.view.dispatch(
          setDatabaseCellValue(b.state.tr, DB_POS, rowId, "name", "Edited"),
        );
        sync(reverse);
        const expected = [
          {
            id: "r2",
            values: { name: rowId === "r2" ? "Edited" : "Original B" },
          },
          {
            id: "r1",
            values: { name: rowId === "r1" ? "Edited" : "Original A" },
          },
        ];
        expect(rowsOf(a)).toEqual(expected);
        expect(rowsOf(b)).toEqual(expected);
      },
    );
  }

  it("preserves concurrent edits when inserting above an existing row", () => {
    const { a, b, sync } = createPeers();
    const tr = a.state.tr;
    insertDatabaseRow(tr, DB_POS, {
      id: "new",
      beforeRowId: "r1",
      values: { name: "New row" },
    });
    a.view.dispatch(tr);
    b.view.dispatch(
      setDatabaseCellValue(b.state.tr, DB_POS, "r1", "name", "Edited"),
    );
    sync();
    expect(rowsOf(a)).toEqual([
      { id: "new", values: { name: "New row" } },
      { id: "r1", values: { name: "Edited" } },
      { id: "r2", values: { name: "Original B" } },
    ]);
    expect(rowsOf(b)).toEqual(rowsOf(a));
  });

  it("keeps concurrently appended rows when another peer reorders", () => {
    const { a, b, sync } = createPeers();
    a.view.dispatch(moveDatabaseRow(a.state.tr, DB_POS, "r1", null));
    const tr = b.state.tr;
    insertDatabaseRow(tr, DB_POS, { id: "new", values: { name: "New row" } });
    b.view.dispatch(tr);
    sync();
    expect(rowsOf(a).map((row) => row.id)).toEqual(["r2", "r1", "new"]);
    expect(rowsOf(b)).toEqual(rowsOf(a));
  });

  it("undoes a reorder without undoing another peer's cell edit", () => {
    const { a, b, sync } = createPeers();
    a.view.dispatch(moveDatabaseRow(a.state.tr, DB_POS, "r1", null));
    b.view.dispatch(
      setDatabaseCellValue(b.state.tr, DB_POS, "r1", "name", "Edited"),
    );
    sync();
    a.commands.undo();
    sync();
    expect(rowsOf(a)).toEqual([
      { id: "r1", values: { name: "Edited" } },
      { id: "r2", values: { name: "Original B" } },
    ]);
    expect(rowsOf(b)).toEqual(rowsOf(a));
  });
});
