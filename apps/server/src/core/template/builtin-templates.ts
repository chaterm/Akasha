/**
 * 内置公共模板：写在代码里、所有工作区共享、只读，只提供中文。
 * 随版本统一更新；需要改动的用户可以先用它建页，再"另存为模板"。
 */

import {
  addDatabaseDays,
  buildDatabaseJSON,
  diffDatabaseDays,
  generateNodeId,
  type DatabaseCellValue,
  type DatabaseColumn,
  type DatabaseRowInput,
  type DatabaseSelectOption,
  type DatabaseViewInput,
} from '@docmost/editor-ext';

export interface BuiltinTemplate {
  /** 固定 UUID，便于复用现有按 id 的接口与校验 */
  id: string;
  icon: string;
  title: string;
  description: string;
  /** 建页标题格式：{date} 为用户本地日期，{title} 为模板标题。 */
  pageTitlePattern?: string;
  content: Record<string, any>;
}

/** 内置模板没有真实的创建/更新时间，用发布日期占位。 */
export const BUILTIN_TEMPLATE_DATE = new Date('2026-10-27T00:00:00.000Z');

// ---- 文档节点构造 ----

type Inline = string | Record<string, any>;

const text = (value: string, bold = false) => ({
  type: 'text',
  text: value,
  ...(bold ? { marks: [{ type: 'bold' }] } : {}),
});

/** 加粗文字，用于"字段名：内容"这类行内标签。 */
const b = (value: string) => text(value, true);

const inline = (items: Inline[]) =>
  items.map((item) => (typeof item === 'string' ? text(item) : item));

const p = (...content: Inline[]) => ({
  type: 'paragraph',
  ...(content.length ? { content: inline(content) } : {}),
});

const h = (level: number, value: string) => ({
  type: 'heading',
  attrs: { level },
  content: [text(value)],
});

const bullets = (...items: Array<Inline | Inline[]>) => ({
  type: 'bulletList',
  content: items.map((item) => ({
    type: 'listItem',
    content: [p(...(Array.isArray(item) ? item : [item]))],
  })),
});

const tasks = (...items: Array<Inline | Inline[]>) => ({
  type: 'taskList',
  content: items.map((item) => ({
    type: 'taskItem',
    attrs: { checked: false },
    content: [p(...(Array.isArray(item) ? item : [item]))],
  })),
});

type CalloutType = 'default' | 'info' | 'note' | 'success' | 'warning' | 'danger';

/** 高亮块：用来放填写说明、结论或风险提示，和正文区分开。 */
const callout = (type: CalloutType, icon: string, ...content: any[]) => ({
  type: 'callout',
  attrs: { type, icon },
  content: content.map((c) => (typeof c === 'string' ? p(c) : c)),
});

const code = (language: string, value: string) => ({
  type: 'codeBlock',
  attrs: { language },
  content: [text(value)],
});

/** 块级公式，内容为 KaTeX / LaTeX。 */
const math = (latex: string) => ({ type: 'mathBlock', attrs: { text: latex } });

/** 行内公式。 */
const inlineMath = (latex: string) => ({ type: 'mathInline', attrs: { text: latex } });

type StatusColor = 'gray' | 'blue' | 'green' | 'yellow' | 'red' | 'purple';

/** 行内状态标签。 */
const status = (value: string, color: StatusColor) => ({
  type: 'status',
  attrs: { text: value, color },
});

type Cell = Inline | Inline[];

const cell = (type: 'tableHeader' | 'tableCell', value: Cell, width?: number) => ({
  type,
  attrs: { colspan: 1, rowspan: 1, colwidth: width ? [width] : null },
  content: [p(...(Array.isArray(value) ? value : [value]))],
});

/** 首行为表头的表格；widths 为各列宽度（px），不给则平均分配。 */
const table = (header: string[], rows: Cell[][], widths: number[] = []) => ({
  type: 'table',
  content: [
    { type: 'tableRow', content: header.map((v, i) => cell('tableHeader', v, widths[i])) },
    ...rows.map((row) => ({
      type: 'tableRow',
      content: row.map((v, i) => cell('tableCell', v, widths[i])),
    })),
  ],
});

/**
 * 页头信息表：左列为字段名（表头样式），右列为内容；
 * 放在正文最前面，记录负责人、日期、状态等元信息。
 */
const infoTable = (rows: Array<[string, Cell]>) => ({
  type: 'table',
  content: rows.map(([label, value]) => ({
    type: 'tableRow',
    content: [cell('tableHeader', label, 140), cell('tableCell', value, 520)],
  })),
});

/** 分栏；每个参数是一栏里的块。 */
const columns = (...cols: any[][]) => ({
  type: 'columns',
  attrs: { layout: cols.length === 3 ? 'three_equal' : 'two_equal' },
  content: cols.map((blocks) => ({ type: 'column', content: blocks })),
});

/** 折叠块：标题常显，内容点开再看。 */
const details = (summary: string, ...content: any[]) => ({
  type: 'details',
  attrs: { open: false },
  content: [
    { type: 'detailsSummary', content: [text(summary)] },
    { type: 'detailsContent', content: content.map((c) => (typeof c === 'string' ? p(c) : c)) },
  ],
});

/** 目录，收录二、三级标题。 */
const toc = () => ({ type: 'toc', attrs: { minLevel: 2, maxLevel: 3 } });

const doc = (...content: any[]) => ({ type: 'doc', content });

// ---- 数据库块 ----

/** 示例日期的基准日，建页时整体平移到用户的今天。 */
const SAMPLE_TODAY = '2026-11-02';

/** 相对基准日期第 n 天。 */
const day = (n: number) => addDatabaseDays(SAMPLE_TODAY, n);

/** 人员列里的"我"，建页时换成创建人。 */
const ME = '$me';

const database = (
  title: string,
  columns: DatabaseColumn[],
  views: DatabaseViewInput[],
  rows: Array<Record<string, DatabaseCellValue>>,
) =>
  buildDatabaseJSON({
    id: 'database',
    title,
    columns,
    views,
    rows: rows.map((values, i): DatabaseRowInput => ({ id: `row-${i + 1}`, values })),
  });

/** 视图里隐藏这些列。 */
const hide = (...ids: string[]) => ids.map((id) => ({ id, width: null, align: null, hidden: true }));

const option = (id: string, name: string, color: DatabaseSelectOption['color']) => ({ id, name, color });

const ownerColumn: DatabaseColumn = {
  id: 'owner',
  name: '负责人',
  type: 'person',
  options: [option(ME, '我', 'blue')],
};

const priorityColumn: DatabaseColumn = {
  id: 'priority',
  name: '优先级',
  type: 'select',
  options: [option('p0', 'P0 紧急', 'red'), option('p1', 'P1 重要', 'orange'), option('p2', 'P2 一般', 'gray')],
};

export interface BuiltinTemplateContext {
  /** 用户本地日期，YYYY-MM-DD */
  today: string;
  user: { id: string; name: string; avatarUrl?: string };
}

/** 建页时实例化：数据库和行换新 id，日期平移到今天，"我"换成创建人。不改动入参。 */
export function instantiateBuiltinContent(content: Record<string, any>, ctx: BuiltinTemplateContext) {
  const shift = diffDatabaseDays(SAMPLE_TODAY, ctx.today);
  const me: DatabaseSelectOption = {
    id: ctx.user.id,
    name: ctx.user.name,
    color: 'blue',
    ...(ctx.user.avatarUrl ? { avatarUrl: ctx.user.avatarUrl } : {}),
  };

  const visit = (node: any): any => {
    if (node?.type !== 'database') {
      return node?.content ? { ...node, content: node.content.map(visit) } : node;
    }
    const columns: DatabaseColumn[] = node.attrs.columns.map((column: DatabaseColumn) =>
      column.type === 'person'
        ? { ...column, options: column.options!.map((o) => (o.id === ME ? me : o)) }
        : column,
    );
    const types = new Map(columns.map((column) => [column.id, column.type]));
    const value = (columnId: string, v: any) => {
      const type = types.get(columnId);
      if (type === 'date' && typeof v === 'string') return addDatabaseDays(v, shift);
      if (type === 'person' && Array.isArray(v)) return v.map((id) => (id === ME ? me.id : id));
      return v;
    };
    return {
      ...node,
      attrs: { ...node.attrs, id: generateNodeId(), columns },
      content: (node.content ?? []).map((row: any) => ({
        ...row,
        attrs: { ...row.attrs, id: generateNodeId() },
        content: (row.content ?? []).map((cell: any) => ({
          ...cell,
          attrs: { ...cell.attrs, value: value(cell.attrs.columnId, cell.attrs.value) },
        })),
      })),
    };
  };

  return visit(structuredClone(content));
}

// ---- Excalidraw scene 构造（模板预置画布） ----

const sceneElement = (
  type: string,
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  extra: Record<string, any> = {},
) => ({
  id,
  type,
  x,
  y,
  width,
  height,
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  index: null,
  roundness: type === 'rectangle' ? { type: 3 } : null,
  seed: 100,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: [],
  updated: 1,
  link: null,
  locked: false,
  ...extra,
});

interface FlowchartLabels {
  start: string;
  submit: string;
  decision: string;
  yes: string;
  no: string;
  execute: string;
  revise: string;
  end: string;
}

type FlowShape = 'ellipse' | 'rectangle' | 'diamond';

const LINE_HEIGHT = 1.25;

/** 估算单行文字宽度：中日韩字符按一个字号宽，其余按 0.55 个字号。 */
const textWidth = (value: string, fontSize: number) =>
  [...value].reduce(
    (w, ch) => w + (/[⺀-鿿豈-﫿＀-￯]/.test(ch) ? fontSize : fontSize * 0.55),
    0,
  );

/** 文字绑定到容器（图形或箭头），居中放在 (cx, cy)；拖动容器时文字跟着走。 */
const boundText = (id: string, containerId: string, value: string, cx: number, cy: number, fontSize: number) => {
  const width = textWidth(value, fontSize);
  const height = fontSize * LINE_HEIGHT;
  return sceneElement('text', id, cx - width / 2, cy - height / 2, width, height, {
    text: value,
    originalText: value,
    fontSize,
    fontFamily: 2,
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId,
    lineHeight: LINE_HEIGHT,
    autoResize: true,
  });
};

/**
 * 示例流程图：常见的审批流程，使用标准流程图图形——
 * 椭圆为开始/结束，矩形为步骤，菱形为判断；"否"的分支修改后回到提交，形成循环。
 *
 *   (开始) → [提交申请] → <审核通过？> —是→ [执行] → (结束)
 *                ↑             └—否→ [修改后重新提交] ┘
 *
 * 文字绑定在图形 / 箭头上，箭头两端绑定到图形，拖动节点时连线和文字都会跟着动。
 */
const flowchartScene = (labels: FlowchartLabels) => {
  const nodes: Array<{
    id: string;
    shape: FlowShape;
    label: string;
    x: number;
    y: number;
    width: number;
    height: number;
    fill: string;
  }> = [
    { id: 'start', shape: 'ellipse', label: labels.start, x: 180, y: 20, width: 160, height: 60, fill: '#b2f2bb' },
    { id: 'submit', shape: 'rectangle', label: labels.submit, x: 160, y: 130, width: 200, height: 64, fill: '#a5d8ff' },
    { id: 'decision', shape: 'diamond', label: labels.decision, x: 150, y: 254, width: 220, height: 120, fill: '#ffec99' },
    { id: 'execute', shape: 'rectangle', label: labels.execute, x: 160, y: 434, width: 200, height: 64, fill: '#a5d8ff' },
    { id: 'end', shape: 'ellipse', label: labels.end, x: 180, y: 558, width: 160, height: 60, fill: '#ffc9c9' },
    { id: 'revise', shape: 'rectangle', label: labels.revise, x: 460, y: 282, width: 220, height: 64, fill: '#ffd8a8' },
  ];

  // 连线端点离图形边缘留 8px；坐标为画布绝对坐标
  const edges: Array<{ id: string; from: string; to: string; points: Array<[number, number]>; label?: string }> = [
    { id: 'start-submit', from: 'start', to: 'submit', points: [[260, 88], [260, 122]] },
    { id: 'submit-decision', from: 'submit', to: 'decision', points: [[260, 202], [260, 246]] },
    { id: 'decision-execute', from: 'decision', to: 'execute', points: [[260, 382], [260, 426]], label: labels.yes },
    { id: 'decision-revise', from: 'decision', to: 'revise', points: [[378, 314], [452, 314]], label: labels.no },
    // 回到"提交申请"：从修改框顶部向上，再向左接到提交框右侧
    { id: 'revise-submit', from: 'revise', to: 'submit', points: [[570, 274], [570, 162], [368, 162]] },
    { id: 'execute-end', from: 'execute', to: 'end', points: [[260, 506], [260, 550]] },
  ];

  const boundElements = new Map<string, Array<{ id: string; type: 'arrow' | 'text' }>>();
  const bind = (containerId: string, id: string, type: 'arrow' | 'text') =>
    boundElements.set(containerId, [...(boundElements.get(containerId) ?? []), { id, type }]);

  const texts: any[] = [];
  nodes.forEach((node) => {
    const textId = `${node.id}-text`;
    bind(node.id, textId, 'text');
    texts.push(
      boundText(textId, node.id, node.label, node.x + node.width / 2, node.y + node.height / 2, 20),
    );
  });

  const arrows: any[] = [];
  const labelTexts: any[] = [];
  edges.forEach((edge) => {
    const [x, y] = edge.points[0];
    const relative = edge.points.map(([px, py]) => [px - x, py - y]);
    const xs = relative.map(([px]) => px);
    const ys = relative.map(([, py]) => py);
    bind(edge.from, edge.id, 'arrow');
    bind(edge.to, edge.id, 'arrow');

    const binding = (elementId: string) => ({ elementId, mode: 'orbit', fixedPoint: [0.5, 0.5] });
    arrows.push(
      sceneElement('arrow', edge.id, x, y, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), {
        points: relative,
        lastCommittedPoint: null,
        startBinding: binding(edge.from),
        endBinding: binding(edge.to),
        startArrowhead: null,
        endArrowhead: 'arrow',
        elbowed: false,
        roundness: { type: 2 },
      }),
    );

    if (edge.label) {
      const labelId = `${edge.id}-label`;
      bind(edge.id, labelId, 'text');
      const [[x1, y1], [x2, y2]] = edge.points;
      labelTexts.push(boundText(labelId, edge.id, edge.label, (x1 + x2) / 2, (y1 + y2) / 2, 16));
    }
  });

  const shapes = nodes.map((node) =>
    sceneElement(node.shape, node.id, node.x, node.y, node.width, node.height, {
      backgroundColor: node.fill,
      roundness: node.shape === 'rectangle' ? { type: 3 } : node.shape === 'diamond' ? { type: 2 } : null,
    }),
  );

  // 每个图形后面紧跟它的文字（Excalidraw 的约定），连线在后；同一张图里每个元素用不同 seed，线条手绘感不重复
  const elements = [
    ...shapes.flatMap((shape, i) => [shape, texts[i]]),
    ...arrows.flatMap((arrow) => [arrow, ...labelTexts.filter((t) => t.containerId === arrow.id)]),
  ].map((element, i) => ({
    ...element,
    seed: 100 + i,
    boundElements: boundElements.get(element.id) ?? [],
  }));

  return { elements, appState: { viewBackgroundColor: '#ffffff' }, files: {} };
};

// ---- 模板 ----

const weeklyReport: BuiltinTemplate = {
  id: '0b6f8a3e-5c1d-4e2a-9f47-1a2b3c4d5e01',
  icon: '📅',
  pageTitlePattern: '{date}-{title}',
  title: '周报',
  description: '用一张进展表同步本周结果、关键数据和下周计划。',
  content: doc(
    infoTable([
      ['汇报人', '@姓名'],
      ['周期', '第 N 周（MM/DD – MM/DD）'],
      ['整体状态', [status('正常推进', 'green')]],
    ]),
    callout('info', '💡', p(b('本周要点：'), '用一两句话写最重要的结果，读者只看这一段也能知道进展。')),
    h(2, '一、本周进展'),
    table(
      ['事项', '状态', '结果 / 产出'],
      [
        ['事项名称', [status('已完成', 'green')], '结果说明，附产出链接'],
        ['事项名称', [status('进行中', 'blue')], '当前进度，预计完成时间'],
        ['事项名称', [status('有风险', 'red')], '卡在哪里，需要谁支持'],
      ],
      [200, 110, 350],
    ),
    h(2, '二、关键数据'),
    table(
      ['指标', '本周', '上周', '变化'],
      [
        ['指标名称', '0', '0', '+0%'],
        ['指标名称', '0', '0', '+0%'],
      ],
      [200, 150, 150, 160],
    ),
    h(2, '三、问题与风险'),
    callout('warning', '⚠️', '问题描述、影响范围，以及需要谁在什么时间前协助。'),
    h(2, '四、下周计划'),
    tasks('计划事项 1（负责人 / 截止时间）', '计划事项 2（负责人 / 截止时间）', '计划事项 3（负责人 / 截止时间）'),
  ),
};

const todoChecklist: BuiltinTemplate = {
  id: '0b6f8a3e-5c1d-4e2a-9f47-1a2b3c4d5e04',
  icon: '✅',
  pageTitlePattern: '{date}-{title}',
  title: '待办清单',
  description: '按优先级分三栏记下要做的事，完成一项勾一项。',
  content: doc(
    callout('default', '🎯', p(b('今日聚焦：'), '写下今天最想完成的一件事。')),
    columns(
      [p(status('P0 紧急', 'red')), tasks('今天必须完成的事', '卡住别人的事')],
      [p(status('P1 重要', 'yellow')), tasks('需要重点推进的事', '本周内要完成的事')],
      [p(status('P2 一般', 'gray')), tasks('有空再做的小事')],
    ),
    h(2, '等待他人'),
    tasks('@某人 需要对方给出的内容（预计时间）'),
    h(2, '备注'),
    bullets('相关链接、补充说明'),
  ),
};

const flowchart: BuiltinTemplate = {
  id: '0b6f8a3e-5c1d-4e2a-9f47-1a2b3c4d5e05',
  icon: '🧭',
  title: '流程图',
  description: '从一张示例审批流程开始，双击画布就能改成自己的流程。',
  content: doc(
    callout('info', '✏️', '双击画布进入编辑，拖动图形时连线和文字会跟着走。'),
    h(2, '一、流程图'),
    {
      type: 'excalidraw',
      attrs: {
        initialScene: flowchartScene({
          start: '开始',
          submit: '提交申请',
          decision: '审核通过？',
          yes: '是',
          no: '否',
          execute: '执行',
          revise: '修改后重新提交',
          end: '结束',
        }),
      },
    },
    h(2, '二、图形说明'),
    table(
      ['图形', '含义'],
      [
        ['椭圆', '开始 / 结束'],
        ['矩形', '一个具体步骤'],
        ['菱形', '判断，按条件走不同分支'],
      ],
      [160, 500],
    ),
    h(2, '三、步骤说明'),
    table(
      ['步骤', '负责人', '说明'],
      [
        ['提交申请', '@姓名', '需要填写哪些信息'],
        ['审核', '@姓名', '审核标准和时限'],
        ['执行', '@姓名', '执行内容和完成标志'],
      ],
      [160, 140, 360],
    ),
  ),
};

const operationManual: BuiltinTemplate = {
  id: '0b6f8a3e-5c1d-4e2a-9f47-1a2b3c4d5e06',
  icon: '📖',
  title: '操作手册',
  description: '把一件事的做法写成步骤，新人照着就能完成。',
  content: doc(
    infoTable([
      ['适用场景', '什么情况下用这份手册'],
      ['操作人', '谁来操作，需要什么角色'],
      ['维护人', '@姓名'],
      ['预计耗时', '约 N 分钟'],
    ]),
    h(2, '一、准备工作'),
    table(
      ['需要准备', '获取方式'],
      [
        ['权限 / 账号', '找谁申请，审批要多久'],
        ['工具 / 环境', '下载地址或配置说明'],
      ],
      [220, 440],
    ),
    h(2, '二、操作步骤'),
    h(3, '步骤 1：做什么'),
    p(b('操作：'), '在哪里、点什么、填什么。'),
    p(b('预期结果：'), '完成后应该看到什么。'),
    h(3, '步骤 2：做什么'),
    p(b('操作：'), '在哪里、点什么、填什么。'),
    p(b('预期结果：'), '完成后应该看到什么。'),
    h(3, '步骤 3：确认完成'),
    p(b('操作：'), '怎么检查结果。'),
    p(b('预期结果：'), '确认成功的标志。'),
    callout('warning', '⚠️', p(b('注意：'), '容易出错或不可撤销的操作写在这里。')),
    h(2, '三、常见问题'),
    details('问题：遇到什么情况', p(b('原因：'), '为什么会这样。'), p(b('处理：'), '怎么解决。')),
    details('问题：遇到什么情况', p(b('原因：'), '为什么会这样。'), p(b('处理：'), '怎么解决。')),
    h(2, '四、相关资料'),
    bullets('@相关文档', '负责人或联系方式'),
  ),
};

const techDesign: BuiltinTemplate = {
  id: '0b6f8a3e-5c1d-4e2a-9f47-1a2b3c4d5e07',
  icon: '🛠️',
  title: '技术方案',
  description: '写清背景、方案、取舍和排期，内含流程图、代码块和公式示例。',
  content: doc(
    infoTable([
      ['作者', '@姓名'],
      ['评审人', '@姓名'],
      ['状态', [status('草稿', 'gray')]],
      ['相关需求', '需求文档链接'],
    ]),
    callout('info', '📌', p(b('一句话结论：'), '要做什么、选了哪个方案、预计多久上线。')),
    toc(),
    h(2, '一、背景与目标'),
    h(3, '1. 背景'),
    p('要解决什么问题，现在是什么情况。'),
    h(3, '2. 目标'),
    bullets('做到什么程度算完成，最好有可衡量的指标'),
    h(3, '3. 不在本次范围'),
    bullets('明确不做的事，避免评审时发散'),
    h(2, '二、方案设计'),
    h(3, '1. 整体流程'),
    code(
      'mermaid',
      ['flowchart LR', '  A[提出需求] --> B[方案设计] --> C[开发实现] --> D[测试验证] --> E[上线]'].join('\n'),
    ),
    h(3, '2. 关键细节'),
    p('接口、数据结构或配置放在代码块里：'),
    code(
      'json',
      ['{', '  "名称": "示例功能",', '  "开关": true,', '  "生效范围": ["空间 A", "空间 B"]', '}'].join('\n'),
    ),
    h(2, '三、备选方案'),
    table(
      ['方案', '做法', '优点', '缺点', '结论'],
      [
        ['方案 A', '怎么做', '好处', '不足', [status('采用', 'green')]],
        ['方案 B', '怎么做', '好处', '不足', [status('不采用', 'gray')]],
      ],
      [100, 170, 130, 130, 100],
    ),
    h(2, '四、工作量与排期'),
    p('按各项工作的人天 ', inlineMath('d_i'), ' 和风险系数 ', inlineMath('r'), ' 估算：'),
    math(String.raw`\text{总工作量} = r \times \sum_{i=1}^{n} d_i`),
    math(String.raw`r = 1.2,\ d = (3, 5, 2) \;\Rightarrow\; \text{总工作量} = 1.2 \times 10 = 12\ \text{人天}`),
    table(
      ['里程碑', '时间', '负责人', '状态'],
      [
        ['方案评审', 'MM/DD', '@姓名', [status('未开始', 'gray')]],
        ['开发完成', 'MM/DD', '@姓名', [status('未开始', 'gray')]],
        ['上线', 'MM/DD', '@姓名', [status('未开始', 'gray')]],
      ],
      [200, 140, 160, 130],
    ),
    h(2, '五、风险与回退'),
    callout('warning', '⚠️', '可能出问题的地方、影响范围，以及出问题时怎么回退。'),
    h(2, '六、待确认问题'),
    tasks('@负责人 需要确认的问题'),
  ),
};

const taskBoard: BuiltinTemplate = {
  id: '0b6f8a3e-5c1d-4e2a-9f47-1a2b3c4d5e08',
  icon: '📋',
  title: '任务看板',
  description: '待办、进行中、受阻、已完成四栏看板，拖动卡片更新状态，按负责人和截止日期跟进。',
  content: doc(
    callout(
      'info',
      '💡',
      p(b('怎么用：'), '拖动卡片改状态，双击卡片上的字段直接修改；点卡片打开详情，填负责人、截止日期和进度。'),
      '切到"按负责人"看每个人手上的事，切到"我的任务"只看分给自己的。',
    ),
    database(
      '任务',
      [
        { id: 'title', name: '任务', type: 'text' },
        ownerColumn,
        {
          id: 'status',
          name: '状态',
          type: 'select',
          options: [
            option('todo', '待办', 'gray'),
            option('doing', '进行中', 'blue'),
            option('blocked', '受阻', 'red'),
            option('done', '已完成', 'green'),
          ],
        },
        priorityColumn,
        { id: 'due', name: '截止日期', type: 'date' },
        { id: 'progress', name: '进度', type: 'progress' },
        { id: 'note', name: '备注', type: 'text' },
      ],
      [
        { id: 'board', name: '看板', type: 'kanban', groupBy: 'status', columns: hide('status', 'note') },
        { id: 'by-owner', name: '按负责人', type: 'kanban', groupBy: 'owner', columns: hide('owner', 'note') },
        { id: 'list', name: '列表', type: 'table', sorts: [{ columnId: 'due', direction: 'asc' }] },
        { id: 'calendar', name: '日历', type: 'calendar', dateColumnId: 'due' },
        { id: 'mine', name: '我的任务', type: 'mine' },
      ],
      [
        { title: '整理需求清单', owner: [ME], status: 'todo', priority: 'p1', due: day(3), progress: 0, note: '' },
        { title: '确认排期', owner: [], status: 'todo', priority: 'p2', due: day(5), progress: 0, note: '' },
        { title: '完成方案初稿', owner: [ME], status: 'doing', priority: 'p0', due: day(1), progress: 60, note: '' },
        { title: '准备评审材料', owner: [], status: 'doing', priority: 'p1', due: day(2), progress: 30, note: '' },
        { title: '采购物料', owner: [], status: 'blocked', priority: 'p1', due: day(4), progress: 20, note: '等待预算审批' },
        { title: '同步项目目标', owner: [ME], status: 'done', priority: 'p1', due: day(-2), progress: 100, note: '' },
        { title: '建立沟通群', owner: [], status: 'done', priority: 'p2', due: day(-3), progress: 100, note: '' },
      ],
    ),
    h(2, '一、状态约定'),
    bullets(
      [b('待办：'), '已经确认要做、还没开始的事。'],
      [b('进行中：'), '有人正在做；同一个人手上的进行中任务最好不超过 3 件。'],
      [b('受阻：'), '卡住了做不下去，在备注里写清卡在哪里、需要谁帮忙。'],
      [b('已完成：'), '已经交付并确认，不再需要跟进。'],
    ),
    h(2, '二、使用建议'),
    bullets(
      '每天或每次例会花几分钟过一遍看板，先看"受阻"，再看快到期的任务。',
      '在"列表"里按截止日期排序，在"日历"里看本周和下周的安排。',
      '已完成的卡片太多时，在看板列的菜单里隐藏"已完成"这一栏。',
    ),
  ),
};

const projectPlan: BuiltinTemplate = {
  id: '0b6f8a3e-5c1d-4e2a-9f47-1a2b3c4d5e09',
  icon: '🗂️',
  title: '项目计划',
  description: '从启动到验收排好项目任务，用表格、看板、日历、时间线等视图跟进，改一处各视图同步。',
  content: doc(
    callout(
      'info',
      '📌',
      p(b('一份数据，多种看法：'), '下面每个视图都是同一张任务表，在任何一个视图里改动，其他视图同步更新。'),
      '示例任务是一个通用的项目流程，换成自己的任务和类型即可，活动策划、市场推广、产品研发都适用。',
    ),
    database(
      '项目任务',
      [
        { id: 'title', name: '任务', type: 'text' },
        ownerColumn,
        {
          id: 'status',
          name: '状态',
          type: 'select',
          options: [
            option('todo', '未开始', 'gray'),
            option('doing', '进行中', 'blue'),
            option('review', '待确认', 'purple'),
            option('done', '已完成', 'green'),
          ],
        },
        priorityColumn,
        {
          id: 'tags',
          name: '类型',
          type: 'multiSelect',
          options: [
            option('plan', '规划', 'pink'),
            option('research', '调研', 'purple'),
            option('execute', '执行', 'cyan'),
            option('communicate', '沟通协调', 'teal'),
            option('review', '评审验收', 'yellow'),
          ],
        },
        { id: 'start', name: '开始', type: 'date' },
        { id: 'end', name: '结束', type: 'date' },
        { id: 'progress', name: '进度', type: 'progress' },
        { id: 'budget', name: '预算', type: 'number', format: 'CNY', decimals: 0 },
        { id: 'risk', name: '有风险', type: 'checkbox' },
        { id: 'link', name: '相关链接', type: 'url' },
      ],
      [
        { id: 'all', name: '全部任务', type: 'table', sorts: [{ columnId: 'start', direction: 'asc' }] },
        {
          id: 'by-status',
          name: '按状态',
          type: 'kanban',
          groupBy: 'status',
          columns: hide('status', 'start', 'budget', 'link'),
        },
        {
          id: 'by-priority',
          name: '按优先级',
          type: 'kanban',
          groupBy: 'priority',
          orientation: 'horizontal',
          columns: hide('priority', 'tags', 'start', 'budget', 'risk', 'link'),
        },
        { id: 'calendar', name: '日历', type: 'calendar', dateColumnId: 'start', endDateColumnId: 'end' },
        { id: 'timeline', name: '时间线', type: 'timeline', dateColumnId: 'start', endDateColumnId: 'end' },
        {
          id: 'focus',
          name: '重点关注',
          type: 'table',
          sorts: [{ columnId: 'end', direction: 'asc' }],
          filter: {
            type: 'group',
            mode: 'and',
            conditions: [
              { type: 'condition', columnId: 'status', op: 'isNoneOf', value: ['done'] },
              {
                type: 'group',
                mode: 'or',
                conditions: [
                  { type: 'condition', columnId: 'priority', op: 'isAnyOf', value: ['p0'] },
                  { type: 'condition', columnId: 'risk', op: 'isChecked', value: null },
                ],
              },
            ],
          },
        },
        { id: 'mine', name: '我的任务', type: 'mine' },
      ],
      [
        { title: '项目启动会', owner: [ME], status: 'done', priority: 'p0', tags: ['communicate'], start: day(-10), end: day(-10), progress: 100, budget: 1000, risk: false, link: 'https://example.com/projects/2026/kickoff-meeting-notes-and-action-items' },
        { title: '现状调研', owner: [], status: 'done', priority: 'p1', tags: ['research'], start: day(-9), end: day(-5), progress: 100, budget: 5000, risk: false, link: '' },
        { title: '制定方案', owner: [ME], status: 'review', priority: 'p0', tags: ['plan'], start: day(-4), end: day(1), progress: 90, budget: 2000, risk: false, link: '' },
        { title: '方案评审', owner: [], status: 'doing', priority: 'p0', tags: ['review'], start: day(-1), end: day(2), progress: 50, budget: 500, risk: false, link: '' },
        { title: '资源与预算申请', owner: [], status: 'doing', priority: 'p1', tags: ['communicate'], start: day(0), end: day(4), progress: 30, budget: 0, risk: false, link: '' },
        { title: '执行落地', owner: [ME], status: 'todo', priority: 'p1', tags: ['execute'], start: day(3), end: day(12), progress: 0, budget: 30000, risk: true, link: '' },
        { title: '中期复盘', owner: [], status: 'todo', priority: 'p2', tags: ['review', 'communicate'], start: day(8), end: day(8), progress: 0, budget: 500, risk: false, link: '' },
        { title: '验收与总结', owner: [ME], status: 'todo', priority: 'p0', tags: ['review'], start: day(13), end: day(15), progress: 0, budget: 1000, risk: false, link: 'https://example.com/projects/2026/acceptance-checklist-and-final-report' },
      ],
    ),
    h(2, '一、视图说明'),
    bullets(
      [b('全部任务：'), '表格，按开始日期排序；点列名可以排序、改列类型或隐藏列，筛选在视图上方的工具栏里。'],
      [b('按状态：'), '看板，拖动卡片就会修改状态。'],
      [b('按优先级：'), '横向泳道，每个优先级一行。'],
      [b('日历：'), '按开始和结束日期画出跨天的任务条，拖动可以改日期。'],
      [b('时间线：'), '按日期顺序列出任务，适合看近期安排。'],
      [b('重点关注：'), '筛选出未完成、且是 P0 或有风险的任务。'],
      [b('我的任务：'), '只显示负责人包含自己的任务。'],
    ),
    h(2, '二、试一试'),
    tasks(
      '在"按状态"里把一张卡片拖到"已完成"',
      '在"日历"里拖动任务条，改开始日期',
      '点开一行，拖动进度条或直接输入数字，再填上预算',
      '把"执行落地"的"有风险"取消勾选，看它从"重点关注"里消失',
      '新建一个看板视图，在视图设置里改成按"类型"分组',
    ),
  ),
};

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  weeklyReport,
  todoChecklist,
  flowchart,
  operationManual,
  techDesign,
  taskBoard,
  projectPlan,
];

export function findBuiltinTemplate(id: string): BuiltinTemplate | undefined {
  return BUILTIN_TEMPLATES.find((tpl) => tpl.id === id);
}
