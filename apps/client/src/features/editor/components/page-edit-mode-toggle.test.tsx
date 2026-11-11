import { MantineProvider } from "@mantine/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import {
  PageEditModeProvider,
  usePageEditMode,
} from "../page-edit-mode-context";
import { PageEditModeControls } from "./page-edit-mode-toggle";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function renderControls() {
  return render(
    <MantineProvider>
      <PageEditModeProvider>
        <PageEditModeControls size="xs" />
      </PageEditModeProvider>
    </MantineProvider>,
  );
}

describe("PageEditModeControls", () => {
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
    global.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it("shows Save only in edit mode and returns to read mode when clicked", () => {
    renderControls();

    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    fireEvent.click(screen.getByText("Edit"));
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("shows saving state and stays in edit mode when the save fails", async () => {
    let finishSave: (saved: boolean) => void = () => {};
    const onSave = vi.fn(
      (_beforeSave: () => Promise<void>) =>
        new Promise<boolean>((resolve) => (finishSave = resolve)),
    );
    render(
      <MantineProvider>
        <PageEditModeProvider onSave={onSave}>
          <PageEditModeControls size="xs" />
        </PageEditModeProvider>
      </MantineProvider>,
    );

    fireEvent.click(screen.getByText("Edit"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const savingButton = await screen.findByRole("button", {
      name: "Saving...",
    });
    expect(savingButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(savingButton);
    expect(onSave).toHaveBeenCalledTimes(1);

    await act(async () => finishSave(false));
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => finishSave(true));
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("runs registered before-save work ahead of the snapshot", async () => {
    const order: string[] = [];
    function TitleFlush() {
      const { registerBeforeSave } = usePageEditMode();
      useEffect(
        () =>
          registerBeforeSave(async () => {
            order.push("title");
          }),
        [registerBeforeSave],
      );
      return null;
    }
    const onSave = vi.fn(async (beforeSave: () => Promise<void>) => {
      await beforeSave();
      order.push("snapshot");
      return true;
    });
    render(
      <MantineProvider>
        <PageEditModeProvider onSave={onSave}>
          <TitleFlush />
          <PageEditModeControls size="xs" />
        </PageEditModeProvider>
      </MantineProvider>,
    );

    fireEvent.click(screen.getByText("Edit"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(order).toEqual(["title", "snapshot"]);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("saves from Ctrl+S while editing", () => {
    renderControls();
    fireEvent.click(screen.getByText("Edit"));

    const event = fireEvent.keyDown(document.documentElement, {
      key: "s",
      ctrlKey: true,
    });

    expect(event).toBe(false);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});
