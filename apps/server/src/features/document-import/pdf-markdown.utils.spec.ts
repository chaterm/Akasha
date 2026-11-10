import { normalizePdfTableOfContents } from './pdf-markdown.utils';

describe('normalizePdfTableOfContents', () => {
  it('splits joined entries into rows and keeps subsequent body content', () => {
    const markdown = [
      '### 目 录',
      '',
      '第一章 范围........ 5 第二章 差旅和费用报销原则........ 5',
      '',
      '一、费用报销类型........6 （一）发票要求........ 7',
      '',
      '## 第一章 范围',
      '',
      '本政策适用于所有员工。',
    ].join('\n');
    expect(normalizePdfTableOfContents(markdown)).toBe(
      [
        '### 目 录',
        '',
        '- 第一章 范围 …… 5',
        '- 第二章 差旅和费用报销原则 …… 5',
        '- 一、费用报销类型 …… 6',
        '- （一）发票要求 …… 7',
        '',
        '## 第一章 范围',
        '',
        '本政策适用于所有员工。',
      ].join('\n'),
    );
  });

  it('preserves double-digit page numbers and alternative dot leaders', () => {
    expect(
      normalizePdfTableOfContents(
        '## Contents\nOverview．．．． 10 Details………… 120',
      ),
    ).toContain('- Overview …… 10\n- Details …… 120');
  });

  it('escapes pipes inside directory titles', () => {
    expect(
      normalizePdfTableOfContents('## 目录\nA|B........ 1 C........ 2'),
    ).toContain('- A\\|B …… 1');
  });

  it.each([
    '正文标题........ 5 第二章........ 6',
    '## 正文\n标题........ 5 第二章........ 6',
    '## 目录\n说明文字与正文。',
    '## 目录\n标题........ 5 这不是另一条完整目录',
    '## 目录\n| 章节 | 页码 |\n| --- | --- |\n| 范围 | 5 |',
    '```md\n## 目录\n标题........ 5 第二章........ 6\n```',
  ])(
    'leaves non-directory content and valid tables unchanged: %s',
    (markdown) => {
      expect(normalizePdfTableOfContents(markdown)).toBe(markdown);
    },
  );
});
