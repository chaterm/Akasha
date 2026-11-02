import type { JSONContent } from '@tiptap/core';

/** A fixed, non-factual marker lets a two-step Skill resume only its unfilled page. */
export const WEEKLY_REPORT_DRAFT_TEXT = '【Akasha 周报草稿：正文待写入】';

export function isWeeklyReportDraft(
  content: JSONContent | null | undefined,
): boolean {
  const paragraph = content?.content?.[0];
  const text = paragraph?.content?.[0];
  return (
    content?.type === 'doc' &&
    content.content?.length === 1 &&
    paragraph?.type === 'paragraph' &&
    paragraph.content?.length === 1 &&
    text?.type === 'text' &&
    text.text === WEEKLY_REPORT_DRAFT_TEXT &&
    (!text.marks || text.marks.length === 0)
  );
}
