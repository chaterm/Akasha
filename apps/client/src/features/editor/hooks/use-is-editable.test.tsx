import { act, render, screen } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { useIsEditable } from "./use-is-editable";

function Probe({ editor }: { editor: Editor | null }) {
  return <div data-testid="flag">{String(useIsEditable(editor))}</div>;
}

function flag() {
  return screen.getByTestId("flag").textContent;
}

function createEditor(editable: boolean) {
  return new Editor({
    extensions: [StarterKit],
    content: "<p>hi</p>",
    editable,
  });
}

describe("useIsEditable", () => {
  it("follows setEditable without a parent re-render", () => {
    const editor = createEditor(false);
    render(<Probe editor={editor} />);

    expect(flag()).toBe("false");

    act(() => editor.setEditable(true));
    expect(flag()).toBe("true");

    act(() => editor.setEditable(false));
    expect(flag()).toBe("false");

    editor.destroy();
  });

  it("reports the initial state without waiting for an event", () => {
    const editor = createEditor(true);
    render(<Probe editor={editor} />);

    expect(flag()).toBe("true");

    editor.destroy();
  });

  it("reports false for a missing editor", () => {
    render(<Probe editor={null} />);

    expect(flag()).toBe("false");
  });
});
