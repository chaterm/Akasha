import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { countWords } from "alfaaz";

// 与服务端知识编译的 MAX_KNOWLEDGE_IMAGES_PER_PAGE 一致，超出的图片不会被识别。
export const PAGE_IMAGE_LIMIT = 150;
// 与单文件导入上限（100mb）一致。
export const PAGE_SIZE_LIMIT_BYTES = 100 * 1024 * 1024;
export const PAGE_WORD_LIMIT = 100_000;

export interface ContentStats {
  imageCount: number;
  /** 正文 JSON 的 UTF-8 字节数 + 图片节点记录的附件大小。 */
  bytes: number;
  /** 与编辑器字数统计同一算法。 */
  words: number;
}

const EMPTY_STATS: ContentStats = { imageCount: 0, bytes: 0, words: 0 };

export function addStats(a: ContentStats, b: ContentStats): ContentStats {
  return {
    imageCount: a.imageCount + b.imageCount,
    bytes: a.bytes + b.bytes,
    words: a.words + b.words,
  };
}

const encoder = new TextEncoder();

function addImages(node: JSONContent, stats: ContentStats) {
  if (node.type === "image") {
    stats.imageCount += 1;
    const size = Number(node.attrs?.size);
    if (Number.isFinite(size) && size > 0) stats.bytes += size;
  }
  node.content?.forEach((child) => addImages(child, stats));
}

// 子块之间以空格分隔，与编辑器统计字数时取文本的方式一致。
function blockText(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  const children = node.content ?? [];
  const inline = children.every((child) => child.type === "text" || child.type === "hardBreak");
  return children.map(blockText).join(inline ? "" : " ");
}

// 同一份快照会被反复统计，按块缓存避免重复序列化。
const blockStatsCache = new WeakMap<JSONContent, ContentStats>();

function measureBlock(block: JSONContent): ContentStats {
  let stats = blockStatsCache.get(block);
  if (!stats) {
    stats = {
      imageCount: 0,
      bytes: encoder.encode(JSON.stringify(block)).length,
      words: countWords(blockText(block)),
    };
    addImages(block, stats);
    blockStatsCache.set(block, stats);
  }
  return stats;
}

export function measureBlocks(blocks: JSONContent[]): ContentStats {
  return blocks.map(measureBlock).reduce(addStats, EMPTY_STATS);
}

export function exceedsLimits(stats: ContentStats): boolean {
  return (
    stats.imageCount > PAGE_IMAGE_LIMIT ||
    stats.bytes > PAGE_SIZE_LIMIT_BYTES ||
    stats.words > PAGE_WORD_LIMIT
  );
}

// 达到上限的 80% 视为即将超限。
const NEAR_LIMIT_RATIO = 0.8;

export function limitStatus(stats: ContentStats): "ok" | "near" | "over" {
  if (exceedsLimits(stats)) return "over";
  if (
    stats.imageCount >= PAGE_IMAGE_LIMIT * NEAR_LIMIT_RATIO ||
    stats.bytes >= PAGE_SIZE_LIMIT_BYTES * NEAR_LIMIT_RATIO ||
    stats.words >= PAGE_WORD_LIMIT * NEAR_LIMIT_RATIO
  ) {
    return "near";
  }
  return "ok";
}

// 未改动的顶层节点在事务间保持同一引用，编辑时只需重算改动的块。
const nodeStatsCache = new WeakMap<PMNode, ContentStats>();

/** 结果与 measureBlocks(doc.toJSON().content) 一致。 */
export function measureDoc(doc: PMNode): ContentStats {
  let stats = EMPTY_STATS;
  doc.forEach((node) => {
    let own = nodeStatsCache.get(node);
    if (!own) {
      own = measureBlocks([node.toJSON()]);
      nodeStatsCache.set(node, own);
    }
    stats = addStats(stats, own);
  });
  return stats;
}

function textOf(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(textOf).join("");
}

function headingLevel(block: JSONContent): number | null {
  if (block.type !== "heading" || !textOf(block).trim()) return null;
  return Number(block.attrs?.level) || 1;
}

/** 页面顶层出现过的（非空）标题层级，升序。 */
export function headingLevels(blocks: JSONContent[]): number[] {
  const levels = new Set<number>();
  for (const block of blocks) {
    const level = headingLevel(block);
    if (level !== null) levels.add(level);
  }
  return [...levels].sort((a, b) => a - b);
}

/** 按该层级切分后至少有两个单元的标题层级，排除只有一个总标题的层级。 */
export function splittableLevels(blocks: JSONContent[]): number[] {
  return headingLevels(blocks).filter((level) => splitUnits(blocks, level).length >= 2);
}

/** 界面上可选的层级：最浅的两个可拆分层级。 */
export function displayLevels(blocks: JSONContent[]): number[] {
  return splittableLevels(blocks).slice(0, 2);
}

export interface Section {
  title: string;
  blocks: JSONContent[];
  stats: ContentStats;
}

/** 以不深于 level 的标题为边界切分章节，第一个边界标题之前的内容单独作为 intro。 */
export function splitSections(
  blocks: JSONContent[],
  level: number,
): { intro: JSONContent[]; sections: Section[] } {
  const intro: JSONContent[] = [];
  const groups: { title: string; blocks: JSONContent[] }[] = [];
  for (const block of blocks) {
    const blockLevel = headingLevel(block);
    if (blockLevel !== null && blockLevel <= level) {
      groups.push({ title: textOf(block).trim(), blocks: [block] });
    } else if (groups.length) {
      groups[groups.length - 1].blocks.push(block);
    } else {
      intro.push(block);
    }
  }
  return {
    intro,
    sections: groups.map((group) => ({ ...group, stats: measureBlocks(group.blocks) })),
  };
}

/** 可选层级中最浅的、每个章节都低于上限 80% 的层级；都做不到时取较深的那个。 */
export function recommendLevel(blocks: JSONContent[]): number | null {
  const levels = displayLevels(blocks);
  for (const level of levels) {
    const { sections } = splitSections(blocks, level);
    if (sections.every((section) => limitStatus(section.stats) === "ok")) return level;
  }
  return levels.length ? levels[levels.length - 1] : null;
}

/** 分页的最小单元：章节，第一个标题前的内容作为无标题单元。 */
export function splitUnits(blocks: JSONContent[], level: number): Section[] {
  const { intro, sections } = splitSections(blocks, level);
  return intro.length
    ? [{ title: "", blocks: intro, stats: measureBlocks(intro) }, ...sections]
    : sections;
}


// 分页方案用 starts 表示：每页第一个单元的下标，升序，首项恒为 0。

/** 相邻单元依次合并，保持每页低于上限 80%，得到最少页数；留出余量，避免拆完又提示即将超限。 */
export function packStarts(units: Section[]): number[] {
  const starts: number[] = [];
  let stats = EMPTY_STATS;
  units.forEach((unit, index) => {
    const merged = addStats(stats, unit.stats);
    if (index === 0 || limitStatus(merged) !== "ok") {
      starts.push(index);
      stats = unit.stats;
    } else {
      stats = merged;
    }
  });
  return starts;
}

/**
 * 指定页数下最均匀的连续划分：动态规划求各页内容量平方和最小。
 * 内容量取图片数、大小、字数中占上限比例最高者，并混入少量章节个数，避免纯文字章节挤在一页。
 */
export function balancedStarts(units: Section[], count: number): number[] {
  const n = units.length;
  const pageCount = Math.max(1, Math.min(count, n));
  if (pageCount <= 1) return [0];

  const loads = units.map((unit) =>
    Math.max(
      unit.stats.imageCount / PAGE_IMAGE_LIMIT,
      unit.stats.bytes / PAGE_SIZE_LIMIT_BYTES,
      unit.stats.words / PAGE_WORD_LIMIT,
    ),
  );
  const totalLoad = loads.reduce((sum, load) => sum + load, 0);
  const COUNT_WEIGHT = 0.1;
  const prefix = new Float64Array(n + 1);
  units.forEach((_, index) => {
    const share = totalLoad > 0 ? loads[index] / totalLoad : 0;
    prefix[index + 1] = prefix[index] + (1 - COUNT_WEIGHT) * share + COUNT_WEIGHT / n;
  });

  // cost[k][i]：前 i 个单元分成 k 页的最小平方和；cut 记录第 k 页的起点。
  const cost = Array.from({ length: pageCount + 1 }, () =>
    new Float64Array(n + 1).fill(Infinity),
  );
  const cut = Array.from({ length: pageCount + 1 }, () => new Int32Array(n + 1));
  cost[0][0] = 0;
  for (let k = 1; k <= pageCount; k++) {
    for (let i = k; i <= n - (pageCount - k); i++) {
      for (let j = k - 1; j < i; j++) {
        const page = prefix[i] - prefix[j];
        const value = cost[k - 1][j] + page * page;
        if (value < cost[k][i]) {
          cost[k][i] = value;
          cut[k][i] = j;
        }
      }
    }
  }

  const starts: number[] = [];
  for (let k = pageCount, i = n; k >= 1; k--) {
    i = cut[k][i];
    starts.unshift(i);
  }
  return starts;
}

/** 按 packStarts 的页数均匀重排；若因此有更多页达到 80%，退回 packStarts 的结果。 */
export function recommendStarts(units: Section[]): number[] {
  const packed = packStarts(units);
  const balanced = balancedStarts(units, packed.length);
  const notOk = (starts: number[]) =>
    starts.filter((start, page) => {
      const end = starts[page + 1] ?? units.length;
      return limitStatus(measureBlocks(units.slice(start, end).flatMap((unit) => unit.blocks))) !== "ok";
    }).length;
  return notOk(balanced) <= notOk(packed) ? balanced : packed;
}

/** 把第 page 页的起点移到 to，变空的页被合并。 */
export function moveStart(
  starts: number[],
  page: number,
  to: number,
  unitCount: number,
): number[] {
  const next = [...starts];
  next[page] = to;
  return next.filter(
    (start, index) =>
      index === 0 || (start > next[index - 1] && start < unitCount),
  );
}

export interface PlannedPage {
  /** 本页第一个单元的下标，用作稳定 key。 */
  start: number;
  /** 本页包含的单元下标。 */
  unitIndexes: number[];
  /** 首节标题，多节时为「首节 ~ 末节」；只含无标题单元时为空。 */
  title: string;
  content: JSONContent;
  stats: ContentStats;
}

function toDoc(blocks: JSONContent[]): JSONContent {
  return {
    type: "doc",
    content: blocks.length ? blocks : [{ type: "paragraph" }],
  };
}

/** 按 starts 组装页面，标题块保留在正文中。 */
export function buildPages(units: Section[], starts: number[]): PlannedPage[] {
  return starts.map((start, page) => {
    const end = starts[page + 1] ?? units.length;
    const group = units.slice(start, end);
    const titles = group.map((unit) => unit.title).filter(Boolean);
    const blocks = group.flatMap((unit) => unit.blocks);
    return {
      start,
      unitIndexes: group.map((_, offset) => start + offset),
      title:
        titles.length > 1 ? `${titles[0]} ~ ${titles[titles.length - 1]}` : (titles[0] ?? ""),
      content: toDoc(blocks),
      stats: measureBlocks(blocks),
    };
  });
}
