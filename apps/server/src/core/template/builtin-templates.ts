/**
 * 内置公共模板：写在代码里、所有工作区共享、只读。
 * 随版本统一更新；需要改动的用户可以先用它建页，再"另存为模板"。
 */

type Lang = 'zh' | 'en';

interface BuiltinTemplateLocale {
  title: string;
  description: string;
  content: Record<string, any>;
}

export interface BuiltinTemplate {
  /** 固定 UUID，便于复用现有按 id 的接口与校验 */
  id: string;
  icon: string;
  /** 建页标题格式：{date} 为用户本地日期，{title} 为模板标题。 */
  pageTitlePattern?: string;
  locales: Record<Lang, BuiltinTemplateLocale>;
}

/** 内置模板没有真实的创建/更新时间，用发布日期占位。 */
export const BUILTIN_TEMPLATE_DATE = new Date('2026-10-27T00:00:00.000Z');

// ---- 文档节点构造 ----

const text = (value: string, bold = false) => ({
  type: 'text',
  text: value,
  ...(bold ? { marks: [{ type: 'bold' }] } : {}),
});

const p = (...content: any[]) => ({
  type: 'paragraph',
  ...(content.length ? { content } : {}),
});

const h = (level: number, value: string) => ({
  type: 'heading',
  attrs: { level },
  content: [text(value)],
});

const bullets = (...items: string[]) => ({
  type: 'bulletList',
  content: items.map((item) => ({
    type: 'listItem',
    content: [p(text(item))],
  })),
});

const tasks = (...items: string[]) => ({
  type: 'taskList',
  content: items.map((item) => ({
    type: 'taskItem',
    attrs: { checked: false },
    content: [p(text(item))],
  })),
});

const steps = (...items: string[]) => ({
  type: 'orderedList',
  attrs: { start: 1 },
  content: items.map((item) => ({
    type: 'listItem',
    content: [p(text(item))],
  })),
});

/** 内置提示块；默认 info（蓝色），用来放填写说明，和正文区分开。 */
const callout = (value: string, type: 'info' | 'note' | 'success' | 'warning' = 'info') => ({
  type: 'callout',
  attrs: { type },
  content: [p(text(value))],
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

const doc = (...content: any[]) => ({ type: 'doc', content });

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
  locales: {
    zh: {
      title: '周报',
      description: '总结本周进展，同步下周计划。',
      content: doc(
        h(2, '📈 本周进展'),
        h(3, '已完成'),
        bullets('事项：结果 / 产出链接', '事项：结果 / 产出链接'),
        h(3, '问题记录'),
        bullets('问题：问题描述'),
        h(2, '🗓️ 下周计划'),
        tasks('计划事项 1', '计划事项 2', '计划事项 3'),
      ),
    },
    en: {
      title: 'Weekly report',
      description:
        'Summarize this week’s progress and share next week’s plan.',
      content: doc(
        h(2, '📈 Progress'),
        h(3, 'Done'),
        bullets('Item: result / link to output', 'Item: result / link to output'),
        h(3, 'Issues'),
        bullets('Issue: description'),
        h(2, '🗓️ Next week'),
        tasks('Planned item 1', 'Planned item 2', 'Planned item 3'),
      ),
    },
  },
};

const todoChecklist: BuiltinTemplate = {
  id: '0b6f8a3e-5c1d-4e2a-9f47-1a2b3c4d5e04',
  icon: '✅',
  pageTitlePattern: '{date}-{title}',
  locales: {
    zh: {
      title: '待办清单',
      description: '用勾选清单记下要做的事，完成一项勾一项。',
      content: doc(
        h(2, '🔥 紧急'),
        tasks('今天必须完成的事', '卡住别人的事'),
        h(2, '⭐ 重要'),
        tasks('需要重点推进的事'),
        h(2, '📌 一般'),
        tasks('有空再做的小事'),
        h(2, '📝 备注'),
        bullets('相关链接、补充说明'),
      ),
    },
    en: {
      title: 'To-do checklist',
      description: 'Jot down what needs doing and check items off as you go.',
      content: doc(
        h(2, '🔥 Urgent'),
        tasks('Must finish today', 'Blocking someone else'),
        h(2, '⭐ Important'),
        tasks('Needs focused effort'),
        h(2, '📌 Normal'),
        tasks('Small things for later'),
        h(2, '📝 Notes'),
        bullets('Related links and details'),
      ),
    },
  },
};

const flowchart: BuiltinTemplate = {
  id: '0b6f8a3e-5c1d-4e2a-9f47-1a2b3c4d5e05',
  icon: '🧭',
  locales: {
    zh: {
      title: '流程图',
      description: '从一张示例流程图开始，双击画布就能改成自己的流程。',
      content: doc(
        h(2, '🎨 画布'),
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
        h(2, '📝 说明'),
        callout('图形约定：椭圆是开始 / 结束，矩形是步骤，菱形是判断'),
        bullets(
          '这段流程解决什么问题、覆盖哪些场景',
          '分支条件、负责人或时间要求',
        ),
      ),
    },
    en: {
      title: 'Flowchart',
      description:
        'Start from a sample flow and reshape it in the canvas; saved as an attachment.',
      content: doc(
        h(2, '🎨 Canvas'),
        {
          type: 'excalidraw',
          attrs: {
            initialScene: flowchartScene({
              start: 'Start',
              submit: 'Submit request',
              decision: 'Approved?',
              yes: 'Yes',
              no: 'No',
              execute: 'Carry out',
              revise: 'Revise & resubmit',
              end: 'End',
            }),
          },
        },
        h(2, '📝 Notes'),
        callout('Shapes: ovals are start / end, rectangles are steps, diamonds are decisions'),
        bullets(
          'What this flow solves and where it applies',
          'Branch conditions, owners or timing',
        ),
      ),
    },
  },
};

const operationManual: BuiltinTemplate = {
  id: '0b6f8a3e-5c1d-4e2a-9f47-1a2b3c4d5e06',
  icon: '📖',
  locales: {
    zh: {
      title: '操作手册',
      description: '把一件事的做法写成步骤，新人照着就能完成。',
      content: doc(
        h(2, '🎯 适用场景'),
        callout('什么情况下用这份手册，由谁来操作。'),
        h(2, '🧰 准备'),
        bullets('需要的权限、账号或工具', '开始前要确认的事项'),
        h(2, '🪜 操作步骤'),
        steps(
          '第一步：做什么，在哪里操作',
          '第二步：做什么，预期看到什么结果',
          '第三步：做什么，怎么确认完成',
        ),
        h(2, '❓ 常见问题'),
        h(3, '问题：遇到什么情况'),
        p(text('原因和处理方法。')),
        h(2, '🔗 相关链接'),
        bullets('@相关文档、负责人或联系方式'),
      ),
    },
    en: {
      title: 'User manual',
      description:
        'Write down how to get something done step by step, so anyone can follow along.',
      content: doc(
        h(2, '🎯 When to use'),
        callout('When this manual applies and who performs it.'),
        h(2, '🧰 Before you start'),
        bullets('Permissions, accounts or tools needed', 'Things to check first'),
        h(2, '🪜 Steps'),
        steps(
          'Step 1: what to do and where',
          'Step 2: what to do and what you should see',
          'Step 3: what to do and how to confirm it is done',
        ),
        h(2, '❓ Troubleshooting'),
        h(3, 'Problem: what happens'),
        p(text('Cause and how to fix it.')),
        h(2, '🔗 Related links'),
        bullets('@Related docs, owners or contacts'),
      ),
    },
  },
};

const techDesign: BuiltinTemplate = {
  id: '0b6f8a3e-5c1d-4e2a-9f47-1a2b3c4d5e07',
  icon: '🛠️',
  locales: {
    zh: {
      title: '技术方案',
      description: '写清背景、方案和计划，内含流程图、代码块和公式示例。',
      content: doc(
        h(2, '🎯 背景与目标'),
        callout('先写结论和关键取舍，再展开细节。'),
        bullets('要解决什么问题，现在是什么情况', '做到什么程度算完成，哪些不在本次范围内'),
        h(2, '💡 方案概述'),
        p(text('用几句话说明打算怎么做。')),
        h(2, '🔀 流程'),
        code(
          'mermaid',
          [
            'flowchart LR',
            '  A[提出需求] --> B[方案设计] --> C[开发实现] --> D[测试验证] --> E[上线]',
          ].join('\n'),
        ),
        h(2, '🧩 关键细节'),
        p(text('需要贴代码、配置或命令时，放在代码块里：')),
        code(
          'json',
          [
            '{',
            '  "名称": "示例功能",',
            '  "开关": true,',
            '  "生效范围": ["空间 A", "空间 B"]',
            '}',
          ].join('\n'),
        ),
        h(2, '📐 工作量估算'),
        p(
          text('按各项工作的人天 '),
          inlineMath('d_i'),
          text(' 和风险系数 '),
          inlineMath('r'),
          text(' 估算：'),
        ),
        math(String.raw`\text{总工作量} = r \times \sum_{i=1}^{n} d_i`),
        math(String.raw`r = 1.2,\ d = (3, 5, 2) \;\Rightarrow\; \text{总工作量} = 1.2 \times 10 = 12\ \text{人天}`),
        h(2, '⚖️ 备选方案'),
        bullets('方案 A：怎么做，好处和不足', '为什么选择当前方案'),
        h(2, '🚀 实施计划'),
        tasks('分几步做，每步的时间', '需要谁配合', '出问题时怎么回退'),
        h(2, '❓ 待确认问题'),
        bullets('@负责人 需要确认的问题'),
      ),
    },
    en: {
      title: 'Technical design',
      description:
        'Lay out background, approach and plan, with sample flowchart, code block and formulas.',
      content: doc(
        h(2, '🎯 Background & goals'),
        callout('Lead with the conclusion and key trade-offs, then go into detail.'),
        bullets(
          'What problem this solves and where things stand today',
          'What “done” looks like and what is out of scope',
        ),
        h(2, '💡 Overview'),
        p(text('A few sentences on how you plan to do it.')),
        h(2, '🔀 Flow'),
        code(
          'mermaid',
          [
            'flowchart LR',
            '  A[Request] --> B[Design] --> C[Build] --> D[Test] --> E[Launch]',
          ].join('\n'),
        ),
        h(2, '🧩 Key details'),
        p(text('Put code, config or commands in a code block:')),
        code(
          'json',
          [
            '{',
            '  "name": "Sample feature",',
            '  "enabled": true,',
            '  "scope": ["Space A", "Space B"]',
            '}',
          ].join('\n'),
        ),
        h(2, '📐 Effort estimate'),
        p(
          text('Estimate from the effort of each task '),
          inlineMath('d_i'),
          text(' (person-days) and a risk factor '),
          inlineMath('r'),
          text(':'),
        ),
        math(String.raw`\text{Total effort} = r \times \sum_{i=1}^{n} d_i`),
        math(String.raw`r = 1.2,\ d = (3, 5, 2) \;\Rightarrow\; \text{Total} = 1.2 \times 10 = 12\ \text{person-days}`),
        h(2, '⚖️ Alternatives'),
        bullets('Option A: approach, upsides and downsides', 'Why the chosen approach wins'),
        h(2, '🚀 Plan'),
        tasks('Steps and timing', 'Who needs to help', 'How to roll back if something goes wrong'),
        h(2, '❓ Open questions'),
        bullets('@owner Questions to confirm'),
      ),
    },
  },
};

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  weeklyReport,
  todoChecklist,
  flowchart,
  operationManual,
  techDesign,
];

export function findBuiltinTemplate(id: string): BuiltinTemplate | undefined {
  return BUILTIN_TEMPLATES.find((tpl) => tpl.id === id);
}

/** 用户语言为中文时用中文内容，其余用英文（与前端 fallbackLng 一致）。 */
export function builtinLang(locale: string | null | undefined): Lang {
  return locale?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
