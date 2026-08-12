import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ConfluenceImportService } from './confluence-import.service';

jest.mock('../../integrations/import/utils/import-formatter', () => ({
  formatImportHtml: jest.fn(async ({ html }) => ({ html, backlinks: [] })),
}));
jest.mock('../../integrations/import/services/import.service', () => ({
  ImportService: class ImportService {},
}));
jest.mock(
  '../../integrations/import/services/import-attachment.service',
  () => ({
    ImportAttachmentService: class ImportAttachmentService {},
  }),
);
jest.mock('../../core/page/services/page.service', () => ({
  PageService: class PageService {},
}));

describe('ConfluenceImportService page mapping persistence', () => {
  it.each([
    {
      name: 'index hierarchy path',
      files: {
        'index.html':
          '<div id="content"><ul><li><a href="10.html">页面 10</a></li></ul></div>',
        '10.html':
          '<h1 id="title-heading">空间 : 页面 10</h1><div id="main-content"><p>正文</p></div>',
      },
      sourcePageId: '10',
      title: '页面 10',
    },
    {
      name: 'flat fallback path',
      files: {
        '20.html':
          '<h1 id="title-heading">空间 : 页面 20</h1><div id="main-content"><p>正文</p></div>',
      },
      sourcePageId: '20',
      title: '页面 20',
    },
  ])('stores mappings in the same transaction for $name', async (fixture) => {
    const extractDir = await mkdtemp(path.join(tmpdir(), 'confluence-import-'));
    try {
      for (const [fileName, content] of Object.entries(fixture.files)) {
        await writeFile(path.join(extractDir, fileName), content, 'utf8');
      }

      const harness = createHarness();
      await harness.service.processConfluenceImport({
        extractDir,
        fileTask: {
          id: 'task-1',
          source: 'confluence',
          status: 'processing',
          creatorId: 'user-1',
          spaceId: 'space-1',
          workspaceId: 'workspace-1',
          metadata: {
            confluence: { spaceId: '6389822', spaceKey: 'open' },
          },
        } as never,
      });

      expect(harness.insertedPages).toHaveLength(1);
      expect(harness.insertedPages[0].id).not.toBe(fixture.sourcePageId);
      expect(harness.insertedPages[0].title).toBe(fixture.title);
      expect(harness.taskMetadata).toEqual({
        confluence: { spaceId: '6389822', spaceKey: 'open' },
        pageMappings: [
          {
            confluencePageId: fixture.sourcePageId,
            akashaPageId: harness.insertedPages[0].id,
            title: fixture.title,
            spaceKey: 'open',
            targetUrl: expect.stringContaining(
              `https://akasha.example.test/s/space-slug/p/`,
            ),
          },
        ],
      });
      expect(harness.insertedLegacyMappings).toEqual([
        expect.objectContaining({
          workspaceId: 'workspace-1',
          source: 'confluence',
          legacySpaceKey: 'open',
          legacyPageId: fixture.sourcePageId,
          legacyTitle: fixture.title,
          legacyPath: `/pages/viewpage.action?pageId=${fixture.sourcePageId}`,
          targetSpaceId: 'space-1',
          targetPageId: harness.insertedPages[0].id,
          targetUrl: expect.stringContaining(
            'https://akasha.example.test/s/space-slug/p/',
          ),
          importTaskId: 'task-1',
        }),
      ]);
      expect(harness.events).toEqual([
        'transaction:start',
        'insert:pages',
        'insert:legacyLinkMappings',
        'update:fileTasks',
        'transaction:end',
      ]);
      expect(harness.emitted).toEqual([
        [
          'page.created',
          expect.objectContaining({
            workspaceId: 'workspace-1',
            skipKnowledgeCompile: true,
          }),
        ],
      ]);
    } finally {
      await rm(extractDir, { recursive: true, force: true });
    }
  });

  it('falls back to zip index.html space key when metadata is missing', async () => {
    const extractDir = await mkdtemp(path.join(tmpdir(), 'confluence-import-'));
    try {
      await writeFile(
        path.join(extractDir, 'index.html'),
        [
          '<html><body>',
          '<table>',
          '<tr><th>Key</th><td>~xuhong_yao@intsig.net</td></tr>',
          '<tr><th>Name</th><td>姚旭红</td></tr>',
          '</table>',
          '<ul><li><a href="385483223.html">姚旭红的主页</a></li></ul>',
          '</body></html>',
        ].join(''),
        'utf8',
      );
      await writeFile(
        path.join(extractDir, '385483223.html'),
        '<h1 id="title-heading">姚旭红 : 姚旭红的主页</h1><div id="main-content"><p>正文</p></div>',
        'utf8',
      );

      const harness = createHarness();
      await harness.service.processConfluenceImport({
        extractDir,
        fileTask: {
          id: 'task-1',
          source: 'confluence',
          status: 'processing',
          creatorId: 'user-1',
          spaceId: 'space-1',
          workspaceId: 'workspace-1',
          metadata: null,
        } as never,
      });

      expect(harness.insertedLegacyMappings).toEqual([
        expect.objectContaining({
          legacySpaceKey: '~xuhong_yao@intsig.net',
          legacyPageId: '385483223',
        }),
      ]);
    } finally {
      await rm(extractDir, { recursive: true, force: true });
    }
  });

  it('rolls back the import when task metadata persistence fails', async () => {
    const extractDir = await mkdtemp(path.join(tmpdir(), 'confluence-import-'));
    try {
      await writeFile(
        path.join(extractDir, '30.html'),
        '<h1 id="title-heading">空间 : 页面 30</h1><div id="main-content"><p>正文</p></div>',
        'utf8',
      );
      const harness = createHarness({ failMetadataUpdate: true });

      await expect(
        harness.service.processConfluenceImport({
          extractDir,
          fileTask: {
            id: 'task-1',
            source: 'confluence',
            status: 'processing',
            creatorId: 'user-1',
            spaceId: 'space-1',
            workspaceId: 'workspace-1',
            metadata: null,
          } as never,
        }),
      ).rejects.toThrow(/metadata write failed/);
      expect(harness.events).toContain('insert:pages');
      expect(harness.events).toContain('insert:legacyLinkMappings');
      expect(harness.events).toContain('update:fileTasks');
      expect(harness.emitted).toHaveLength(0);
    } finally {
      await rm(extractDir, { recursive: true, force: true });
    }
  });

  it('imports a title_pageId parent and keeps its numeric child subtree', async () => {
    const extractDir = await mkdtemp(path.join(tmpdir(), 'confluence-import-'));
    try {
      await writeFile(
        path.join(extractDir, 'index.html'),
        [
          '<div id="content"><ul><li>',
          '<a href="named_parent_40.html">命名父页面</a>',
          '<ul><li><a href="41.html">子页面</a></li></ul>',
          '</li></ul></div>',
        ].join(''),
        'utf8',
      );
      await writeFile(
        path.join(extractDir, 'named_parent_40.html'),
        '<h1 id="title-heading">空间 : 命名父页面</h1><div id="main-content"><p>父正文</p></div>',
        'utf8',
      );
      await writeFile(
        path.join(extractDir, '41.html'),
        '<h1 id="title-heading">空间 : 子页面</h1><div id="main-content"><p>子正文</p></div>',
        'utf8',
      );
      const harness = createHarness();

      await harness.service.processConfluenceImport({
        extractDir,
        fileTask: {
          id: 'task-1',
          source: 'confluence',
          status: 'processing',
          creatorId: 'user-1',
          spaceId: 'space-1',
          workspaceId: 'workspace-1',
          metadata: null,
        } as never,
      });

      expect(harness.insertedPages).toHaveLength(2);
      expect(
        (harness.taskMetadata as any).pageMappings.map(
          (mapping: any) => mapping.confluencePageId,
        ),
      ).toEqual(['40', '41']);
      expect(harness.insertedPages[1].parentPageId).toBe(
        harness.insertedPages[0].id,
      );
    } finally {
      await rm(extractDir, { recursive: true, force: true });
    }
  });
});

describe('ConfluenceImportService transformNoformatMacros', () => {
  const transform = (html: string): string =>
    (createHarness().service as any).transformNoformatMacros(html);

  it('converts a paneled noformat macro into a plaintext code block', () => {
    const input = [
      '<div class="preformatted panel" style="border-width: 1px;">',
      '<div class="preformattedContent panelContent">',
      '<pre>line1\nline2</pre>',
      '</div></div>',
    ].join('');

    const out = transform(input);

    // 标注 language-plaintext:避免 codeBlock 自动语法高亮把纯文本误着色
    expect(out).toContain('<code class="language-plaintext">');
    expect(out).toContain('line1\nline2');
    // 面板容器已被替换掉
    expect(out).not.toContain('preformatted');
    expect(out).not.toContain('panelContent');
  });

  it('converts a bare (nopanel) pre into a plaintext code block', () => {
    const input = '<pre>raw\ntext</pre>';

    const out = transform(input);

    expect(out).toContain('<code class="language-plaintext">');
    expect(out).toContain('raw\ntext');
  });

  it('does not touch a pre that already has a code child (code macro output)', () => {
    const input = '<pre><code class="language-java">int a = 1;</code></pre>';

    const out = transform(input);

    // 语言标识必须保留,不能被剥成无语言代码块
    expect(out).toContain('language-java');
    expect(out).toContain('int a = 1;');
    // 只有一个 code 元素,没有被重复包裹
    expect(out.match(/<code/g)).toHaveLength(1);
  });

  it('handles both paneled and bare noformat in one document', () => {
    const input = [
      '<div class="preformatted panel"><div class="preformattedContent panelContent">',
      '<pre>paneled</pre></div></div>',
      '<pre>bare</pre>',
    ].join('');

    const out = transform(input);

    expect(out.match(/<code class="language-plaintext">/g)).toHaveLength(2);
    expect(out).toContain('paneled');
    expect(out).toContain('bare');
    expect(out).not.toContain('preformatted');
  });

  it('leaves html without noformat unchanged in structure', () => {
    const input = '<p>普通段落</p>';
    const out = transform(input);
    expect(out).toContain('<p>普通段落</p>');
    expect(out).not.toContain('<pre>');
  });
});

describe('ConfluenceImportService transformExpandMacros', () => {
  const transform = (html: string): string =>
    (createHarness().service as any).transformExpandMacros(html);

  it('converts an expand macro into a details/summary/detailsContent block', () => {
    const input = [
      '<div id="expander-123" class="expand-container">',
      '<div class="expand-control"><span class="expand-control-text">点击展开</span></div>',
      '<div class="expand-content expand-hidden"><p>隐藏正文</p></div>',
      '</div>',
    ].join('');

    const out = transform(input);

    expect(out).toMatch(/<details open="?"?>/);
    expect(out).toContain('<summary>点击展开</summary>');
    expect(out).toContain('<div data-type="detailsContent">');
    expect(out).toContain('<p>隐藏正文</p>');
    // 原始 Confluence 容器结构已被替换掉
    expect(out).not.toContain('expand-container');
    expect(out).not.toContain('expand-content');
  });

  it('falls back to a default summary when control text is empty', () => {
    const input = [
      '<div class="expand-container">',
      '<div class="expand-control"><span class="expand-control-text">   </span></div>',
      '<div class="expand-content"><p>正文</p></div>',
      '</div>',
    ].join('');

    const out = transform(input);

    expect(out).toContain('<summary>Details</summary>');
    expect(out).toContain('<p>正文</p>');
  });

  it('handles nested expand macros from inside out', () => {
    const input = [
      '<div class="expand-container">',
      '<div class="expand-control"><span class="expand-control-text">外层</span></div>',
      '<div class="expand-content">',
      '<p>外层正文</p>',
      '<div class="expand-container">',
      '<div class="expand-control"><span class="expand-control-text">内层</span></div>',
      '<div class="expand-content"><p>内层正文</p></div>',
      '</div>',
      '</div>',
      '</div>',
    ].join('');

    const out = transform(input);

    // 两个 expand 都转成了 details,且内层正文保留
    expect(out.match(/<details/g)).toHaveLength(2);
    expect(out).toContain('<summary>外层</summary>');
    expect(out).toContain('<summary>内层</summary>');
    expect(out).toContain('<p>外层正文</p>');
    expect(out).toContain('<p>内层正文</p>');
    expect(out).not.toContain('expand-container');
  });

  it('leaves html without expand macros unchanged in structure', () => {
    const input = '<p>普通段落</p>';
    const out = transform(input);
    expect(out).toContain('<p>普通段落</p>');
    expect(out).not.toContain('details');
  });
});

describe('ConfluenceImportService transformInfoMacros', () => {
  const transform = (html: string): string =>
    (createHarness().service as any).transformInfoMacros(html);

  it.each([
    { suffix: 'tip', type: 'success' },
    { suffix: 'information', type: 'info' },
    { suffix: 'note', type: 'warning' },
    { suffix: 'warning', type: 'danger' },
  ])(
    'maps confluence-information-macro-$suffix to callout type $type',
    ({ suffix, type }) => {
      const input = [
        `<div class="confluence-information-macro confluence-information-macro-${suffix}">`,
        '<span class="aui-icon aui-icon-small"></span>',
        '<div class="confluence-information-macro-body"><p>正文内容</p></div>',
        '</div>',
      ].join('');

      const out = transform(input);

      expect(out).toContain('data-type="callout"');
      expect(out).toContain(`data-callout-type="${type}"`);
      expect(out).toContain('<p>正文内容</p>');
      // 原始 Confluence 结构与图标已被替换掉
      expect(out).not.toContain('confluence-information-macro');
      expect(out).not.toContain('aui-icon');
    },
  );

  it('unknown macro suffix falls back to info type', () => {
    const input = [
      '<div class="confluence-information-macro confluence-information-macro-unknown">',
      '<div class="confluence-information-macro-body"><p>正文</p></div>',
      '</div>',
    ].join('');

    const out = transform(input);

    expect(out).toContain('data-callout-type="info"');
    expect(out).toContain('<p>正文</p>');
  });

  it('converts the title parameter into a bold first paragraph', () => {
    const input = [
      '<div class="confluence-information-macro confluence-information-macro-note">',
      '<span class="aui-icon"></span>',
      '<p class="title">重要提醒</p>',
      '<div class="confluence-information-macro-body"><p>正文</p></div>',
      '</div>',
    ].join('');

    const out = transform(input);

    expect(out).toContain('data-callout-type="warning"');
    expect(out).toContain('<strong>重要提醒</strong>');
    expect(out).toContain('<p>正文</p>');
    // 加粗标题排在正文前面
    expect(out.indexOf('重要提醒')).toBeLessThan(out.indexOf('正文'));
    // title 元素本身不残留(已转成 strong)
    expect(out).not.toContain('class="title"');
  });

  it('handles a macro without an explicit body wrapper', () => {
    const input = [
      '<div class="confluence-information-macro confluence-information-macro-tip">',
      '<span class="aui-icon"></span>',
      '<p>裸正文</p>',
      '</div>',
    ].join('');

    const out = transform(input);

    expect(out).toContain('data-callout-type="success"');
    expect(out).toContain('<p>裸正文</p>');
    expect(out).not.toContain('aui-icon');
  });

  it('leaves html without info macros unchanged in structure', () => {
    const input = '<p>普通段落</p>';
    const out = transform(input);
    expect(out).toContain('<p>普通段落</p>');
    expect(out).not.toContain('callout');
  });
});

describe('ConfluenceImportService transformStatusMacros', () => {
  const transform = (html: string): string =>
    (createHarness().service as any).transformStatusMacros(html);

  it.each([
    { aui: 'aui-lozenge-success', color: 'green' },
    { aui: 'aui-lozenge-error', color: 'red' },
    { aui: 'aui-lozenge-current', color: 'blue' },
    { aui: 'aui-lozenge-moved', color: 'yellow' },
    { aui: 'aui-lozenge-complete', color: 'gray' },
  ])('maps $aui to data-color $color', ({ aui, color }) => {
    const input = `<p>状态:<span class="status-macro aui-lozenge ${aui}">已完成</span></p>`;

    const out = transform(input);

    expect(out).toContain('data-type="status"');
    expect(out).toContain(`data-color="${color}"`);
    expect(out).toContain('>已完成</span>');
    // 原始 AUI lozenge class 已被替换掉
    expect(out).not.toContain('aui-lozenge');
    expect(out).not.toContain('status-macro');
  });

  it('defaults to gray when no type modifier class is present', () => {
    const input = '<span class="status-macro aui-lozenge">草稿</span>';

    const out = transform(input);

    expect(out).toContain('data-type="status"');
    expect(out).toContain('data-color="gray"');
    expect(out).toContain('>草稿</span>');
  });

  it('keeps the status inline within surrounding text', () => {
    const input =
      '<p>前 <span class="aui-lozenge aui-lozenge-success">OK</span> 后</p>';

    const out = transform(input);

    expect(out).toContain('data-type="status"');
    expect(out).toContain('前 ');
    expect(out).toContain(' 后');
    expect(out).toContain('>OK</span>');
  });

  it('converts multiple status macros in one document', () => {
    const input = [
      '<span class="aui-lozenge aui-lozenge-success">完成</span>',
      '<span class="aui-lozenge aui-lozenge-error">失败</span>',
    ].join('');

    const out = transform(input);

    expect(out.match(/data-type="status"/g)).toHaveLength(2);
    expect(out).toContain('data-color="green"');
    expect(out).toContain('data-color="red"');
    expect(out).not.toContain('aui-lozenge');
  });

  it('leaves html without status macros unchanged in structure', () => {
    const input = '<p>普通段落</p>';
    const out = transform(input);
    expect(out).toContain('<p>普通段落</p>');
    expect(out).not.toContain('data-type="status"');
  });
});

function createHarness({ failMetadataUpdate = false } = {}) {
  const insertedPages: Record<string, any>[] = [];
  const insertedLegacyMappings: Record<string, any>[] = [];
  const emitted: unknown[] = [];
  const events: string[] = [];
  let taskMetadata: unknown;

  const trx = {
    insertInto(table: string) {
      return {
        values(value: Record<string, any>) {
          if (table === 'pages') {
            insertedPages.push(value);
            events.push('insert:pages');
          }
          if (table === 'legacyLinkMappings') {
            const rows = Array.isArray(value) ? value : [value];
            insertedLegacyMappings.push(...rows);
            events.push('insert:legacyLinkMappings');
          }
          return this;
        },
        onConflict() {
          return this;
        },
        async execute() {
          return [];
        },
      };
    },
    updateTable(table: string) {
      return {
        set(value: Record<string, any>) {
          if (table === 'fileTasks') {
            taskMetadata = value.metadata;
            events.push('update:fileTasks');
          }
          return this;
        },
        where() {
          return this;
        },
        async execute() {
          if (failMetadataUpdate) throw new Error('metadata write failed');
          return [];
        },
      };
    },
  };

  const db = {
    selectFrom() {
      return {
        select() {
          return this;
        },
        where() {
          return this;
        },
        async executeTakeFirst() {
          return { slug: 'space-slug' };
        },
      };
    },
    transaction() {
      return {
        async execute(callback: (transaction: unknown) => Promise<unknown>) {
          events.push('transaction:start');
          const result = await callback(trx);
          events.push('transaction:end');
          return result;
        },
      };
    },
  };

  const importService = {
    async processHTML() {
      return { type: 'doc', content: [{ type: 'paragraph', content: [] }] };
    },
    extractTitleAndRemoveHeading(value: any) {
      return { title: null, prosemirrorJson: value };
    },
    async createYdoc() {
      return Buffer.from('ydoc');
    },
  };
  const service = new ConfluenceImportService(
    importService as never,
    { processAttachments: async ({ html }: { html: string }) => html } as never,
    { nextPagePosition: async () => 'a0' } as never,
    { insertBacklink: async () => undefined } as never,
    { getAppUrl: () => 'https://akasha.example.test' } as never,
    db as never,
    { emit: (...args: unknown[]) => emitted.push(args) } as never,
  );

  return {
    service,
    insertedPages,
    insertedLegacyMappings,
    emitted,
    events,
    get taskMetadata() {
      return taskMetadata;
    },
  };
}
