import { describe, expect, it } from "vitest";
import { getSchema, type JSONContent } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import Heading from "@tiptap/extension-heading";
import Image from "@tiptap/extension-image";
import { Node as PMNode } from "@tiptap/pm/model";
import {
  PAGE_IMAGE_LIMIT,
  PAGE_SIZE_LIMIT_BYTES,
  PAGE_WORD_LIMIT,
  type ContentStats,
  exceedsLimits,
  headingLevels,
  limitStatus,
  measureBlocks,
  measureDoc,
  balancedStarts,
  buildPages,
  moveStart,
  packStarts,
  recommendStarts,
  splitUnits,
  recommendLevel,
  splitSections,
  splittableLevels,
  displayLevels,
} from "./page-split.utils";

const h = (level: number, text: string): JSONContent => ({
  type: "heading",
  attrs: { level },
  content: text ? [{ type: "text", text }] : undefined,
});
const p = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const img = (size?: number | string): JSONContent => ({
  type: "image",
  attrs: { src: "/files/x.png", size },
});
const images = (count: number) => Array.from({ length: count }, () => img());

const doc = [
  p("intro"),
  h(1, "A"),
  p("a"),
  h(2, "A1"),
  p("a1"),
  h(3, "A1x"),
  h(2, "A2"),
  h(1, "B"),
  p("b"),
];

const texts = (content: JSONContent) =>
  (content.content ?? []).map((block) => block.content?.[0]?.text ?? "");

describe("measureBlocks", () => {
  it("counts nested images and adds their recorded sizes", () => {
    const blocks = [img(100), { type: "callout", content: [img("200"), img()] }];
    const stats = measureBlocks(blocks);
    expect(stats.imageCount).toBe(3);
    const jsonBytes = blocks.reduce(
      (sum, block) => sum + new TextEncoder().encode(JSON.stringify(block)).length,
      0,
    );
    expect(stats.bytes).toBe(jsonBytes + 300);
  });

  it("counts words with the editor's counter, CJK included", () => {
    expect(measureBlocks([p("hello world"), h(1, "你好世界")]).words).toBe(6);
    // 嵌套块之间按空格分隔，不会把相邻段落的单词粘在一起。
    expect(measureBlocks([{ type: "blockquote", content: [p("one"), p("two")] }]).words).toBe(2);
  });

  it("detects any limit being exceeded", () => {
    const stats = (patch: Partial<ContentStats>) => ({ imageCount: 0, bytes: 0, words: 0, ...patch });
    expect(exceedsLimits(stats({ imageCount: PAGE_IMAGE_LIMIT }))).toBe(false);
    expect(exceedsLimits(stats({ imageCount: PAGE_IMAGE_LIMIT + 1 }))).toBe(true);
    expect(exceedsLimits(stats({ bytes: PAGE_SIZE_LIMIT_BYTES + 1 }))).toBe(true);
    expect(exceedsLimits(stats({ words: PAGE_WORD_LIMIT }))).toBe(false);
    expect(exceedsLimits(stats({ words: PAGE_WORD_LIMIT + 1 }))).toBe(true);
  });

  it("reports near-limit at 80% of any limit", () => {
    const stats = (patch: Partial<ContentStats>) => ({ imageCount: 0, bytes: 0, words: 0, ...patch });
    expect(limitStatus(stats({ imageCount: 119 }))).toBe("ok");
    expect(limitStatus(stats({ imageCount: 120 }))).toBe("near");
    expect(limitStatus(stats({ bytes: PAGE_SIZE_LIMIT_BYTES * 0.8 }))).toBe("near");
    expect(limitStatus(stats({ words: 80_000 }))).toBe("near");
    expect(limitStatus(stats({ imageCount: PAGE_IMAGE_LIMIT + 1 }))).toBe("over");
  });

  it("measures a ProseMirror doc the same as its JSON blocks", () => {
    const schema = getSchema([
      Document,
      Paragraph,
      Text,
      Heading,
      Image.extend({
        addAttributes() {
          return { ...this.parent?.(), size: { default: null } };
        },
      }),
    ]);
    const json = {
      type: "doc",
      content: [h(1, "A"), p("x"), img(100)],
    };
    const doc = PMNode.fromJSON(schema, json);
    const expected = measureBlocks(doc.toJSON().content);
    expect(measureDoc(doc)).toEqual(expected);
    expect(measureDoc(doc).imageCount).toBe(1);
  });
});

describe("splitSections", () => {
  it("cuts at headings no deeper than the level and keeps the intro", () => {
    const { intro, sections } = splitSections(doc, 2);
    expect(intro.map((b) => b.content?.[0]?.text)).toEqual(["intro"]);
    expect(sections.map((s) => s.title)).toEqual(["A", "A1", "A2", "B"]);
    expect(sections[1].blocks).toHaveLength(3);
  });

  it("ignores empty headings and lists present levels", () => {
    const blocks = [h(1, "A"), h(2, ""), p("x"), h(3, "C")];
    expect(headingLevels(blocks)).toEqual([1, 3]);
    expect(splitSections(blocks, 2).sections.map((s) => s.blocks.length)).toEqual([4]);
  });
});

describe("recommendLevel", () => {
  it("picks the shallowest level whose sections all fit", () => {
    expect(recommendLevel(doc)).toBe(1);
    const blocks = [h(1, "A"), h(2, "A1"), ...images(100), h(2, "A2"), ...images(100)];
    expect(recommendLevel(blocks)).toBe(2);
    // 整节 120 张未超限，但已达 80%，推荐更深一级。
    const near = [h(1, "A"), h(2, "A1"), ...images(60), h(2, "A2"), ...images(60)];
    expect(recommendLevel(near)).toBe(2);
  });

  it("works for articles that start at H2 without any H1", () => {
    const blocks = [h(2, "A"), ...images(100), h(2, "B"), ...images(100), h(3, "B1"), ...images(10)];
    expect(splittableLevels(blocks)).toEqual([2, 3]);
    expect(recommendLevel(blocks)).toBe(2);
  });

  it("works for articles whose sections are H3 only", () => {
    const blocks = [p("intro"), h(3, "A"), ...images(60), h(3, "B"), ...images(60), h(3, "C"), ...images(60)];
    expect(splittableLevels(blocks)).toEqual([3]);
    expect(recommendLevel(blocks)).toBe(3);
    expect(splitUnits(blocks, 3).map((unit) => unit.title)).toEqual(["", "A", "B", "C"]);
  });

  it("goes down to H3 when H1 and H2 are only titles", () => {
    // 一个 H1 总标题、一个 H2 副标题，章节都在 H3。
    const blocks = [
      h(1, "Title"), h(2, "Subtitle"),
      h(3, "A"), ...images(80), h(3, "B"), ...images(80), h(3, "C"), ...images(80),
    ];
    // 按 H2 只能拆成「总标题」和「其余全部」，后者已超限，所以推荐 H3。
    expect(splittableLevels(blocks)).toEqual([2, 3]);
    expect(recommendLevel(blocks)).toBe(3);
  });

  it("skips a level that holds only one section, like a single H1 title", () => {
    const blocks = [h(1, "Title"), h(2, "A"), ...images(50), h(2, "B"), ...images(50)];
    expect(splittableLevels(blocks)).toEqual([2]);
    expect(recommendLevel(blocks)).toBe(2);
    // 标题前有正文时，正文本身算一个单元，单个 H1 也能拆成两部分。
    expect(splittableLevels([p("intro"), h(1, "A"), p("a")])).toEqual([1]);
  });

  it("shows at most the two shallowest splittable levels", () => {
    const sections = (...levels: number[]) =>
      levels.flatMap((level, i) => [h(level, `S${i}`), p("x"), h(level, `T${i}`), p("x")]);
    expect(displayLevels(sections(1))).toEqual([1]);
    expect(displayLevels(sections(1, 2))).toEqual([1, 2]);
    expect(displayLevels(sections(2))).toEqual([2]);
    expect(displayLevels(sections(2, 3))).toEqual([2, 3]);
    expect(displayLevels(sections(1, 2, 3))).toEqual([1, 2]);
    // 推荐只在这两个层级里选；都不够时取较深的那个。
    const deep = [h(1, "A"), h(2, "A1"), ...images(130), h(2, "A2"), ...images(10), h(1, "B"), p("b")];
    expect(recommendLevel(deep)).toBe(2);
  });

  it("falls back to the deepest level, or null without headings", () => {
    const oversized = [
      h(1, "A"), ...images(PAGE_IMAGE_LIMIT + 1),
      h(1, "B"), ...images(PAGE_IMAGE_LIMIT + 1),
    ];
    expect(recommendLevel(oversized)).toBe(1);
    expect(recommendLevel([p("x")])).toBeNull();
    // 只有一个标题、前面也没有正文时拆不出两部分。
    expect(recommendLevel([h(1, "A"), ...images(PAGE_IMAGE_LIMIT + 1)])).toBeNull();
  });
});

describe("page plans", () => {
  // intro(0 张) | S1 60 | S2 60 | S3 60 | S4 10
  const blocks = [
    p("intro"),
    h(2, "S1"), ...images(60),
    h(2, "S2"), ...images(60),
    h(2, "S3"), ...images(60),
    h(2, "S4"), ...images(10),
  ];
  const units = splitUnits(blocks, 2);
  const summary = (starts: number[]) =>
    buildPages(units, starts).map((page) => [page.title, page.unitIndexes, page.stats.imageCount]);

  it("treats content before the first heading as an untitled unit", () => {
    expect(units.map((unit) => unit.title)).toEqual(["", "S1", "S2", "S3", "S4"]);
    expect(splitUnits([h(1, "A"), p("a")], 1).map((unit) => unit.title)).toEqual(["A"]);
  });

  it("packs adjacent units while staying below 80% of the limit", () => {
    // 60 + 60 = 120 张已达上限的 80%，不再合并。
    expect(summary(packStarts(units))).toEqual([
      ["S1", [0, 1], 60],
      ["S2", [2], 60],
      ["S3 ~ S4", [3, 4], 70],
    ]);
    const small = splitUnits([h(1, "A"), ...images(59), h(1, "B"), ...images(60)], 1);
    expect(packStarts(small)).toEqual([0]);
  });

  it("balances units across a chosen page count", () => {
    expect(summary(balancedStarts(units, 3))).toEqual([
      ["S1", [0, 1], 60],
      ["S2", [2], 60],
      ["S3 ~ S4", [3, 4], 70],
    ]);
    expect(balancedStarts(units, 1)).toEqual([0]);
    expect(balancedStarts(units, 99)).toEqual([0, 1, 2, 3, 4]);
  });

  it("finds the most even split instead of cutting greedily", () => {
    const counts = (list: ReturnType<typeof splitUnits>, starts: number[]) =>
      buildPages(list, starts).map((page) => page.stats.imageCount);
    const uneven = splitUnits(
      [h(1, "A"), ...images(40), h(1, "B"), ...images(10), h(1, "C"), ...images(10), h(1, "D"), ...images(40)],
      1,
    );
    expect(counts(uneven, balancedStarts(uneven, 3))).toEqual([40, 20, 40]);
    // 内容相同的章节按个数均分。
    const same = splitUnits(
      Array.from({ length: 6 }, (_, i) => [h(1, `S${i}`), ...images(10)]).flat(),
      1,
    );
    expect(counts(same, balancedStarts(same, 3))).toEqual([20, 20, 20]);
  });

  it("recommends the packed page count but spreads content evenly", () => {
    const list = splitUnits(
      [h(1, "A"), ...images(60), h(1, "B"), ...images(50), h(1, "C"), ...images(10), h(1, "D"), ...images(10)],
      1,
    );
    // 顺序合并得到 [60 50] [10 10]（110 / 20 张），均匀重排为 [60] [50 10 10]（60 / 70 张）。
    expect(packStarts(list)).toEqual([0, 2]);
    expect(recommendStarts(list)).toEqual([0, 1]);
    const skewed = splitUnits(
      [h(1, "A"), ...images(10), h(1, "B"), ...images(10), h(1, "C"), ...images(90), h(1, "D"), ...images(20)],
      1,
    );
    // 顺序合并得到 [10 10 90] [20]，均匀重排为 [10 10] [90 20]。
    expect(packStarts(skewed)).toEqual([0, 3]);
    expect(recommendStarts(skewed)).toEqual([0, 2]);
  });

  it("assigns from a heading to the previous or next page", () => {
    // 页面 [0 1 2 3] [4 5 6 7]，共 8 个单元。
    const pagesOf = (starts: number[]) =>
      starts.map((start, i) => Array.from({ length: (starts[i + 1] ?? 8) - start }, (_, k) => start + k));
    // 第 2 页的单元 5：本页开头到它划给上一页。
    expect(pagesOf(moveStart([0, 4], 1, 6, 8))).toEqual([[0, 1, 2, 3, 4, 5], [6, 7]]);
    // 第 1 页的单元 2：它到本页末尾划给下一页。
    expect(pagesOf(moveStart([0, 4], 1, 2, 8))).toEqual([[0, 1], [2, 3, 4, 5, 6, 7]]);
    // 对本页最后一个单元向上划分：整页并入上一页。
    expect(moveStart([0, 4], 1, 8, 8)).toEqual([0]);
    expect(moveStart([0, 3, 4], 1, 4, 8)).toEqual([0, 4]);
    // 对下一页之前的首个单元向下划分：本页并入下一页。
    expect(moveStart([0, 3, 5], 2, 3, 8)).toEqual([0, 3]);
  });

  it("keeps a valid empty doc for pages without body", () => {
    const [page] = buildPages(splitUnits([h(1, "only")], 1), [0]);
    expect(page.title).toBe("only");
    expect(texts(page.content)).toEqual(["only"]);
    expect(buildPages([], [0])[0].content).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
  });
});
