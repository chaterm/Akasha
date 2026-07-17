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
jest.mock('../../integrations/import/services/import-attachment.service', () => ({
  ImportAttachmentService: class ImportAttachmentService {},
}));
jest.mock('../../core/page/services/page.service', () => ({
  PageService: class PageService {},
}));

describe('ConfluenceImportService page mapping persistence', () => {
  it.each([
    {
      name: 'index hierarchy path',
      files: {
        'index.html': '<div id="content"><ul><li><a href="10.html">页面 10</a></li></ul></div>',
        '10.html': '<h1 id="title-heading">空间 : 页面 10</h1><div id="main-content"><p>正文</p></div>',
      },
      sourcePageId: '10',
      title: '页面 10',
    },
    {
      name: 'flat fallback path',
      files: {
        '20.html': '<h1 id="title-heading">空间 : 页面 20</h1><div id="main-content"><p>正文</p></div>',
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
          },
        ],
      });
      expect(harness.events).toEqual([
        'transaction:start',
        'insert:pages',
        'update:fileTasks',
        'transaction:end',
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

function createHarness({ failMetadataUpdate = false } = {}) {
  const insertedPages: Record<string, any>[] = [];
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
    db as never,
    { emit: (...args: unknown[]) => emitted.push(args) } as never,
  );

  return {
    service,
    insertedPages,
    emitted,
    events,
    get taskMetadata() {
      return taskMetadata;
    },
  };
}
