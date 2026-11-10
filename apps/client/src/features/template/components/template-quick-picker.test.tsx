import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TemplateQuickPicker } from "./template-quick-picker";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const templates = [
  {
    id: "b1",
    title: "内置周报",
    allSpaces: true,
    spaceIds: [],
    icon: "📅",
    description: null,
    builtin: true,
  },
  {
    id: "g1",
    title: "全局周报",
    allSpaces: true,
    spaceIds: [],
    icon: null,
    description: null,
  },
  {
    id: "o1",
    title: "别的空间",
    allSpaces: false,
    spaceIds: ["space-2"],
    icon: null,
    description: null,
  },
  {
    id: "p1",
    title: "本空间纪要",
    allSpaces: false,
    spaceIds: ["space-2", "space-1"],
    icon: "📝",
    description: "会议用",
  },
];

vi.mock("../api/template-hooks", () => ({
  useTemplateList: () => ({ data: templates, isLoading: false }),
  useTemplate: (id: string | null) => ({
    data: id
      ? {
          ...templates.find((t) => t.id === id),
          content: { type: "doc", content: [] },
        }
      : undefined,
    isFetching: false,
  }),
}));

vi.mock("../lib/use-space-names", () => ({
  useSpaceDirectory: () => ({ availabilityLabel: () => "scope" }),
}));

// 编辑器渲染与本测试无关
vi.mock("./template-preview", () => ({ TemplatePreview: () => null }));
vi.mock("./template-creator", () => ({ TemplateCreator: () => null }));

const renderPicker = (onConfirm = vi.fn()) => {
  render(
    <MantineProvider>
      <TemplateQuickPicker
        opened
        onClose={vi.fn()}
        onConfirm={onConfirm}
        title="pick"
        confirmLabel="go"
        preferredSpaceId="space-1"
      />
    </MantineProvider>,
  );
  return onConfirm;
};

describe("TemplateQuickPicker", () => {
  beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    Element.prototype.scrollIntoView = vi.fn();
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any;
  });

  it("本空间模板排第一，其次所有空间、其他空间，公共模板单独一组排最后", async () => {
    renderPicker();
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("本空间纪要"),
      expect.stringContaining("全局周报"),
      expect.stringContaining("别的空间"),
      expect.stringContaining("内置周报"),
    ]);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(
      screen
        .getByRole("group", { name: "Built-in templates" })
        .contains(options[3]),
    ).toBe(true);
  });

  it("方向键移动高亮，回车确认当前模板", async () => {
    const onConfirm = renderPicker();
    const input = await screen.findByLabelText("Search templates");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() =>
      expect(
        screen.getAllByRole("option")[1].getAttribute("aria-selected"),
      ).toBe("true"),
    );

    // 从第一项向上循环到最后一项
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    await waitFor(() =>
      expect(
        screen.getAllByRole("option")[3].getAttribute("aria-selected"),
      ).toBe("true"),
    );

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({ id: "b1" }),
      ),
    );
  });
});
