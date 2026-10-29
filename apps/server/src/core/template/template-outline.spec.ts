import { buildOutline } from './template-outline';

const p = (text?: string) => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text }] : [],
});

describe('buildOutline', () => {
  it('提取标题、段落、列表和待办，并去掉末尾空段落', () => {
    const outline = buildOutline({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '议题' }] },
        p('第一项'),
        { type: 'bulletList', content: [{ type: 'listItem', content: [p('A')] }] },
        { type: 'taskList', content: [{ type: 'taskItem', content: [p('待办')] }] },
        { type: 'table', content: [] },
        p(),
        p(),
      ],
    });
    expect(outline).toEqual([
      { kind: 'heading', level: 2, text: '议题' },
      { kind: 'text', text: '第一项' },
      { kind: 'bullet', text: 'A' },
      { kind: 'task', text: '待办' },
      { kind: 'block', label: 'table' },
    ]);
  });

  it('最多 9 项，长文本截断', () => {
    const outline = buildOutline({
      type: 'doc',
      content: Array.from({ length: 20 }, () => p('字'.repeat(60))),
    });
    expect(outline).toHaveLength(9);
    expect((outline[0] as any).text).toHaveLength(41);
  });

  it('画布节点生成一行文字占位，避免缩略图缺一行', () => {
    const outline = buildOutline({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '画布' }] },
        { type: 'excalidraw', attrs: { initialScene: { elements: [] } } },
        { type: 'drawio', attrs: { src: '' } },
        p('说明'),
      ],
    });
    expect(outline).toEqual([
      { kind: 'heading', level: 2, text: '画布' },
      { kind: 'text', text: '' },
      { kind: 'text', text: '' },
      { kind: 'text', text: '说明' },
    ]);
  });

  it('空正文返回空数组', () => {
    expect(buildOutline(null)).toEqual([]);
  });
});
