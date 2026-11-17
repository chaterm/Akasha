import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { countWords } from "alfaaz";

export const PAGE_IMAGE_LIMIT = 150;
export const PAGE_SIZE_LIMIT_BYTES = 100 * 1024 * 1024;
export const PAGE_WORD_LIMIT = 100_000;

export interface ContentStats {
  imageCount: number;
  bytes: number;
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

function blockText(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  const children = node.content ?? [];
  const inline = children.every(
    (child) => child.type === "text" || child.type === "hardBreak",
  );
  return children.map(blockText).join(inline ? "" : " ");
}

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

const nodeStatsCache = new WeakMap<PMNode, ContentStats>();

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

export function headingLevels(blocks: JSONContent[]): number[] {
  const levels = new Set<number>();
  for (const block of blocks) {
    const level = headingLevel(block);
    if (level !== null) levels.add(level);
  }
  return [...levels].sort((a, b) => a - b);
}

export function splittableLevels(blocks: JSONContent[]): number[] {
  return headingLevels(blocks).filter(
    (level) => splitUnits(blocks, level).length >= 2,
  );
}

export function displayLevels(blocks: JSONContent[]): number[] {
  return splittableLevels(blocks).slice(0, 2);
}

export interface Section {
  title: string;
  blocks: JSONContent[];
  stats: ContentStats;
}

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
    sections: groups.map((group) => ({
      ...group,
      stats: measureBlocks(group.blocks),
    })),
  };
}

export function recommendLevel(blocks: JSONContent[]): number | null {
  const levels = displayLevels(blocks);
  for (const level of levels) {
    const { sections } = splitSections(blocks, level);
    if (sections.every((section) => limitStatus(section.stats) === "ok"))
      return level;
  }
  return levels.length ? levels[levels.length - 1] : null;
}

export function splitUnits(blocks: JSONContent[], level: number): Section[] {
  const { intro, sections } = splitSections(blocks, level);
  return intro.length
    ? [{ title: "", blocks: intro, stats: measureBlocks(intro) }, ...sections]
    : sections;
}

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
    prefix[index + 1] =
      prefix[index] + (1 - COUNT_WEIGHT) * share + COUNT_WEIGHT / n;
  });

  const cost = Array.from({ length: pageCount + 1 }, () =>
    new Float64Array(n + 1).fill(Infinity),
  );
  const cut = Array.from(
    { length: pageCount + 1 },
    () => new Int32Array(n + 1),
  );
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

export function recommendStarts(units: Section[]): number[] {
  const packed = packStarts(units);
  const balanced = balancedStarts(units, packed.length);
  const notOk = (starts: number[]) =>
    starts.filter((start, page) => {
      const end = starts[page + 1] ?? units.length;
      return (
        limitStatus(
          measureBlocks(units.slice(start, end).flatMap((unit) => unit.blocks)),
        ) !== "ok"
      );
    }).length;
  return notOk(balanced) <= notOk(packed) ? balanced : packed;
}

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
  start: number;
  unitIndexes: number[];
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
        titles.length > 1
          ? `${titles[0]} ~ ${titles[titles.length - 1]}`
          : (titles[0] ?? ""),
      content: toDoc(blocks),
      stats: measureBlocks(blocks),
    };
  });
}
