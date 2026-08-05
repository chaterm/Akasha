import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  PageEditMode,
  PageEditModeProvider,
  usePageEditMode,
} from "./page-edit-mode-context";

function ModeControl() {
  const { pageEditMode, setPageEditMode } = usePageEditMode();

  return (
    <>
      <span>{pageEditMode}</span>
      <button type="button" onClick={() => setPageEditMode(PageEditMode.Edit)}>
        Edit
      </button>
    </>
  );
}

describe("PageEditModeProvider", () => {
  it("defaults every newly entered page to read mode", () => {
    const { rerender } = render(
      <PageEditModeProvider key="page-1">
        <ModeControl />
      </PageEditModeProvider>,
    );

    expect(screen.getByText(PageEditMode.Read)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText(PageEditMode.Edit)).toBeTruthy();

    rerender(
      <PageEditModeProvider key="page-2">
        <ModeControl />
      </PageEditModeProvider>,
    );

    expect(screen.getByText(PageEditMode.Read)).toBeTruthy();
  });
});
