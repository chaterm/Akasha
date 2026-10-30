jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class CollaborationGateway {},
}));

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { TemplateService } from './template.service';
import { UserRole } from '../../common/helpers/types/permission';
import { jsonToNode } from '../../collaboration/collaboration.util';
import { BUILTIN_TEMPLATES } from './builtin-templates';

const [WEEKLY_ID, CHECKLIST_ID, FLOWCHART_ID, MANUAL_ID, DESIGN_ID] =
  BUILTIN_TEMPLATES.map((t) => t.id);
const BUILTIN_IDS = BUILTIN_TEMPLATES.map((t) => t.id);
/** 每个内置模板必须保留下来的块（未知节点会被静默剥掉） */
const EXPECTED_BLOCKS: Record<string, string[]> = {
  [WEEKLY_ID]: ['table', 'tableHeader', 'status', 'callout', 'heading', 'taskList'],
  [CHECKLIST_ID]: ['callout', 'columns', 'column', 'status', 'taskList', 'taskItem', 'bulletList'],
  [FLOWCHART_ID]: ['callout', 'heading', 'excalidraw', 'table'],
  [MANUAL_ID]: ['table', 'heading', 'callout', 'details', 'detailsSummary', 'bulletList'],
  [DESIGN_ID]: ['table', 'status', 'callout', 'toc', 'heading', 'codeBlock', 'mathBlock', 'mathInline', 'taskList', 'bulletList'],
};

const DOC = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: '你好' }] }],
};

const row = (over: Record<string, any> = {}) => ({
  id: 't1',
  title: '模板',
  allSpaces: false,
  spaceIds: ['space-1'],
  creatorId: 'member-1',
  content: DOC,
  ...over,
});

describe('TemplateService', () => {
  const admin = { id: 'admin-1', role: UserRole.ADMIN } as any;
  const member = { id: 'member-1', role: UserRole.MEMBER } as any;
  const ws = (allowMemberTemplates = false) =>
    ({ id: 'ws-1', settings: { templates: { allowMemberTemplates } } }) as any;

  const createSubject = (opts?: {
    template?: any;
    userSpaceIds?: string[];
    cannotCreateIn?: string[];
    page?: any;
  }) => {
    const templateRepo = {
      findById: jest.fn().mockResolvedValue(opts?.template),
      findTemplates: jest.fn().mockResolvedValue({ items: [], meta: {} }),
      insertTemplate: jest.fn().mockResolvedValue({ id: 'tpl-new' }),
      updateTemplate: jest.fn().mockResolvedValue(undefined),
      setTemplateSpaces: jest.fn().mockResolvedValue(undefined),
      deleteTemplate: jest.fn().mockResolvedValue(undefined),
    };
    const pageRepo = { findById: jest.fn().mockResolvedValue(opts?.page) };
    const spaceMemberRepo = {
      getUserSpaceIds: jest
        .fn()
        .mockResolvedValue(opts?.userSpaceIds ?? ['space-1', 'space-2']),
    };
    const spaceAbility = {
      createForUser: jest.fn(async (_user, spaceId: string) => ({
        cannot: jest
          .fn()
          .mockReturnValue((opts?.cannotCreateIn ?? []).includes(spaceId)),
      })),
    };
    const pageAccessService = {
      validateCanView: jest.fn().mockResolvedValue(undefined),
      validateCanEdit: jest.fn().mockResolvedValue({}),
    };
    const pageService = {
      create: jest.fn().mockResolvedValue({ id: 'page-new', spaceId: 'space-1' }),
    };
    const auditService = { log: jest.fn() };
    // 事务直接执行回调
    const db = {
      transaction: () => ({ execute: (cb: any) => cb('trx') }),
    };

    const service = new TemplateService(
      templateRepo as any,
      pageRepo as any,
      spaceMemberRepo as any,
      spaceAbility as any,
      pageAccessService as any,
      pageService as any,
      auditService as any,
      db as any,
    );
    return { service, templateRepo, pageService, pageAccessService };
  };

  describe('create', () => {
    it('管理员可创建"所有空间"模板，并提取纯文本', async () => {
      const { service, templateRepo } = createSubject({
        template: row({ allSpaces: true, spaceIds: [], creatorId: 'admin-1' }),
      });
      const result = await service.create(
        { title: '周报', allSpaces: true, content: DOC },
        admin,
        ws(),
      );
      expect(templateRepo.insertTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ allSpaces: true, textContent: '你好' }),
        'trx',
      );
      expect(templateRepo.setTemplateSpaces).toHaveBeenCalledWith('tpl-new', [], 'trx');
      expect(result.canManage).toBe(true);
    });

    it('可指定多个空间，重复空间去重', async () => {
      const { service, templateRepo } = createSubject({ template: row() });
      await service.create(
        { title: 't', spaceIds: ['space-1', 'space-2', 'space-1'] },
        admin,
        ws(),
      );
      expect(templateRepo.setTemplateSpaces).toHaveBeenCalledWith(
        'tpl-new',
        ['space-1', 'space-2'],
        'trx',
      );
    });

    it('既不是所有空间也没指定空间时返回 400', async () => {
      const { service } = createSubject();
      await expect(
        service.create({ title: 't', spaceIds: [] }, admin, ws()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('未指定范围时默认"所有空间"', async () => {
      const { service, templateRepo } = createSubject({
        template: row({ allSpaces: true, spaceIds: [] }),
      });
      await service.create({ title: 't' }, member, ws(true));
      expect(templateRepo.insertTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ allSpaces: true }),
        'trx',
      );
      expect(templateRepo.setTemplateSpaces).toHaveBeenCalledWith('tpl-new', [], 'trx');
    });

    it('获准的成员也可以创建"所有空间"模板，并能管理它', async () => {
      const { service } = createSubject({
        template: row({ allSpaces: true, spaceIds: [], creatorId: 'member-1' }),
      });
      const view = await service.create({ title: 't', allSpaces: true }, member, ws(true));
      expect(view.canManage).toBe(true);
    });

    it('普通用户可以创建指定到空间的模板', async () => {
      const { service } = createSubject({
        template: row({ spaceIds: ['space-1'], creatorId: 'member-1' }),
      });
      const view = await service.create(
        { title: 't', spaceIds: ['space-1'] },
        member,
        ws(false),
      );
      expect(view.canManage).toBe(true);
    });

    it('任一指定空间没有建页权限时拒绝', async () => {
      const { service, templateRepo } = createSubject({ cannotCreateIn: ['space-2'] });
      await expect(
        service.create(
          { title: 't', spaceIds: ['space-1', 'space-2'] },
          member,
          ws(true),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(templateRepo.insertTemplate).not.toHaveBeenCalled();
    });

    it('另存为模板时校验页面可读并复制正文', async () => {
      const { service, templateRepo, pageAccessService } = createSubject({
        template: row(),
        page: { id: 'p1', workspaceId: 'ws-1', content: DOC },
      });
      await service.create(
        { title: 't', spaceIds: ['space-1'], sourcePageId: 'p1' },
        member,
        ws(true),
      );
      expect(pageAccessService.validateCanView).toHaveBeenCalled();
      expect(templateRepo.insertTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ content: DOC }),
        'trx',
      );
    });

    it('来源页面跨工作区时返回 404', async () => {
      const { service } = createSubject({
        page: { id: 'p1', workspaceId: 'ws-other', content: DOC },
      });
      await expect(
        service.create({ title: 't', allSpaces: true, sourcePageId: 'p1' }, admin, ws()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('非法正文返回 400', async () => {
      const { service } = createSubject();
      await expect(
        service.create(
          { title: 't', allSpaces: true, content: { type: 'nope' } },
          admin,
          ws(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('可见性与管理', () => {
    it('模板创建者可以看到自己的模板，即使指定的空间不在访问范围内', async () => {
      const { service } = createSubject({
        template: row({ spaceIds: ['space-x', 'space-y'], creatorId: 'member-1' }),
        userSpaceIds: ['space-1'],
      });
      const view = await service.getById('t1', member, ws());
      expect(view.canManage).toBe(true);
      expect(view.spaceIds).toEqual([]);
      expect(view.otherSpaceCount).toBe(2);
    });

    it('只返回用户可访问的空间，并给出其余空间数量', async () => {
      const { service } = createSubject({
        template: row({ spaceIds: ['space-1', 'space-x', 'space-y'] }),
        userSpaceIds: ['space-1'],
      });
      const view = await service.getById('t1', member, ws());
      expect(view.spaceIds).toEqual(['space-1']);
      expect(view.otherSpaceCount).toBe(2);
    });

    it('成员只能删除自己创建的模板', async () => {
      const own = createSubject({ template: row() });
      await own.service.delete('t1', member, ws(true));
      expect(own.templateRepo.deleteTemplate).toHaveBeenCalled();

      const other = createSubject({ template: row({ creatorId: 'someone' }) });
      await expect(other.service.delete('t1', member, ws(true))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('改为指定空间但一个都没选时返回 400', async () => {
      const { service } = createSubject({
        template: row({ allSpaces: true, spaceIds: [] }),
      });
      await expect(
        service.update(
          { templateId: 't1', allSpaces: false, spaceIds: [] },
          admin,
          ws(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('更新空间时保留用户看不到的已指定空间', async () => {
      const { service, templateRepo } = createSubject({
        template: row({ spaceIds: ['space-1', 'space-hidden'] }),
        userSpaceIds: ['space-1', 'space-2'],
      });
      await service.update(
        { templateId: 't1', spaceIds: ['space-2'] },
        admin,
        ws(),
      );
      expect(templateRepo.setTemplateSpaces).toHaveBeenCalledWith(
        't1',
        ['space-2', 'space-hidden'],
        'trx',
      );
    });

    it('只对新增的空间校验建页权限', async () => {
      const { service } = createSubject({
        // 管理员对原空间 space-1 已无建页权限，但没有新增空间时不应被拦
        template: row({ spaceIds: ['space-1'] }),
        cannotCreateIn: ['space-1'],
      });
      await expect(
        service.update({ templateId: 't1', spaceIds: ['space-1'] }, admin, ws()),
      ).resolves.toBeDefined();
    });
  });

  describe('内置模板', () => {
    it('列表首页把内置模板排在最前，内容只有中文', async () => {
      const { service, templateRepo } = createSubject();
      templateRepo.findTemplates.mockResolvedValue({ items: [row()], meta: {} });

      const zh = await service.list({ ...member, locale: 'zh-CN' }, ws(), {} as any);
      expect(zh.items.map((t) => t.id)).toEqual([...BUILTIN_IDS, 't1']);
      expect(zh.items[0]).toMatchObject({
        title: '周报',
        builtin: true,
        allSpaces: true,
        canManage: false,
      });
      expect(zh.items[0].outline.length).toBeGreaterThan(0);
      expect(zh.items[zh.items.length - 1].builtin).toBe(false);

      const en = await service.list({ ...member, locale: 'en-US' }, ws(), {} as any);
      expect(en.items[0].title).toBe('周报');
    });

    it('翻页、按指定空间筛选或搜索不命中时不返回内置模板', async () => {
      const { service } = createSubject();
      const ids = async (dto: any) =>
        (await service.list(member, ws(), dto)).items.map((t) => t.id);

      expect(await ids({ cursor: 'next' })).toEqual([]);
      expect(await ids({ scope: 'space', spaceId: 'space-1' })).toEqual([]);
      expect(await ids({ query: '不存在的模板' })).toEqual([]);
      expect(await ids({ query: '周报' })).toEqual([WEEKLY_ID]);
      expect(await ids({ query: '清单' })).toEqual([CHECKLIST_ID]);
      expect(await ids({ query: '手册' })).toEqual([MANUAL_ID]);
      expect(await ids({ query: '技术方案' })).toEqual([DESIGN_ID]);
      expect(await ids({ scope: 'available', spaceId: 'space-1' })).toEqual(BUILTIN_IDS);
    });

    it('内置模板可以查看详情，正文是合法文档', async () => {
      const { service, templateRepo } = createSubject();
      const view = await service.getById(WEEKLY_ID, admin, ws());
      expect(templateRepo.findById).not.toHaveBeenCalled();
      expect(view.builtin).toBe(true);
      expect(view.content).toEqual(BUILTIN_TEMPLATES[0].content);
      // 正文要能被编辑器 schema 解析
      for (const tpl of BUILTIN_TEMPLATES) {
        const node = jsonToNode(tpl.content);
        expect(() => node.check()).not.toThrow();
        // 未知节点会被静默剥掉，这里确认关键块都还在
        const types = new Set<string>();
        node.descendants((n) => {
          types.add(n.type.name);
        });
        for (const type of EXPECTED_BLOCKS[tpl.id]) {
          expect(types).toContain(type);
        }
      }
    });

    it('内置模板的状态标签和高亮块属性完整，转换后不丢', () => {
      for (const tpl of BUILTIN_TEMPLATES) {
        jsonToNode(tpl.content).descendants((n) => {
          if (n.type.name === 'status') {
            expect(n.attrs.text.length).toBeGreaterThan(0);
            expect(['gray', 'blue', 'green', 'yellow', 'red', 'purple']).toContain(n.attrs.color);
          }
          if (n.type.name === 'callout') {
            expect(n.attrs.icon).toBeTruthy();
          }
        });
      }
    });

    it('技术方案模板：代码块带语言（含 Mermaid 流程图），公式不为空', () => {
      const tpl = BUILTIN_TEMPLATES.find((t) => t.id === DESIGN_ID)!;
      {
        const languages: string[] = [];
        const formulas: string[] = [];
        jsonToNode(tpl.content).descendants((n) => {
          if (n.type.name === 'codeBlock') {
            languages.push(n.attrs.language);
            expect(n.textContent.trim().length).toBeGreaterThan(0);
          }
          if (n.type.name === 'mathBlock' || n.type.name === 'mathInline') {
            formulas.push(n.attrs.text);
          }
        });
        expect(languages).toEqual(['mermaid', 'json']);
        expect(formulas.every((f) => f.trim().length > 0)).toBe(true);
        expect(formulas).toHaveLength(4);
      }
    });

    it('流程图模板的示例画布：标准图形，文字和连线都绑定在图形上，引用互相一致', () => {
      const tpl = BUILTIN_TEMPLATES.find((t) => t.id === FLOWCHART_ID)!;
      {
        const excalidraw = tpl.content.content.find((n: any) => n.type === 'excalidraw');
        const elements: any[] = excalidraw.attrs.initialScene.elements;
        const byId = new Map(elements.map((e) => [e.id, e]));
        expect(byId.size).toBe(elements.length);

        const shapes = elements.filter((e) => ['ellipse', 'rectangle', 'diamond'].includes(e.type));
        expect(shapes.map((s) => s.type).sort()).toEqual([
          'diamond',
          'ellipse',
          'ellipse',
          'rectangle',
          'rectangle',
          'rectangle',
        ]);

        // 文字 ↔ 容器 双向绑定
        for (const text of elements.filter((e) => e.type === 'text')) {
          const container = byId.get(text.containerId);
          expect(container).toBeDefined();
          expect(container.boundElements).toContainEqual({ id: text.id, type: 'text' });
          expect(text.text.length).toBeGreaterThan(0);
        }
        // 每个图形都有文字
        for (const shape of shapes) {
          expect(shape.boundElements.some((b: any) => b.type === 'text')).toBe(true);
        }

        // 箭头两端绑定到存在的图形，且图形里登记了这条箭头
        const arrows = elements.filter((e) => e.type === 'arrow');
        expect(arrows).toHaveLength(6);
        for (const arrow of arrows) {
          for (const binding of [arrow.startBinding, arrow.endBinding]) {
            const target = byId.get(binding.elementId);
            expect(['ellipse', 'rectangle', 'diamond']).toContain(target?.type);
            expect(target.boundElements).toContainEqual({ id: arrow.id, type: 'arrow' });
            expect(binding.mode).toBe('orbit');
          }
          expect(arrow.points[0]).toEqual([0, 0]);
        }
        // 判断节点有"是 / 否"两个分支，"否"的分支回到提交（循环）
        const decision = shapes.find((s) => s.type === 'diamond');
        const outgoing = arrows.filter((a) => a.startBinding.elementId === decision.id);
        expect(outgoing.map((a) => a.boundElements.length)).toEqual([1, 1]);
        const revise = byId.get(outgoing[1].endBinding.elementId);
        expect(
          arrows.some(
            (a) => a.startBinding.elementId === revise.id && a.endBinding.elementId === 'submit',
          ),
        ).toBe(true);
      }
    });

    it('管理员也不能修改或删除内置模板', async () => {
      const { service, templateRepo } = createSubject();
      await expect(
        service.update({ templateId: WEEKLY_ID, title: 'x' }, admin, ws()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.delete(WEEKLY_ID, admin, ws())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(templateRepo.updateTemplate).not.toHaveBeenCalled();
      expect(templateRepo.deleteTemplate).not.toHaveBeenCalled();
    });
  });

  describe('use', () => {
    it('以模板标题/图标/正文创建页面', async () => {
      const { service, pageService } = createSubject({
        template: row({ allSpaces: true, spaceIds: [], title: '会议纪要', icon: '📝' }),
      });
      await service.use({ templateId: 't1', spaceId: 'space-1' }, member, ws());
      expect(pageService.create).toHaveBeenCalledWith('member-1', 'ws-1', {
        spaceId: 'space-1',
        parentPageId: undefined,
        title: '会议纪要',
        icon: '📝',
        content: DOC,
        format: 'json',
      });
    });

    it('可以用内置模板建页，且不查数据库', async () => {
      const { service, templateRepo, pageService } = createSubject();
      await service.use(
        { templateId: WEEKLY_ID, spaceId: 'space-1' },
        { ...member, locale: 'zh-CN' },
        ws(),
      );
      expect(templateRepo.findById).not.toHaveBeenCalled();
      expect(pageService.create).toHaveBeenCalledWith(
        'member-1',
        'ws-1',
        expect.objectContaining({
          spaceId: 'space-1',
          title: expect.stringMatching(/^\d{4}\/\d{2}\/\d{2}-周报$/),
          format: 'json',
        }),
      );
    });

    it('内置周报按用户本地创建日期命名标题', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-27T02:00:00.000Z'));
      try {
        const { service, pageService } = createSubject();
        await service.use(
          { templateId: WEEKLY_ID, spaceId: 'space-1' },
          { ...member, locale: 'zh-CN', timezone: 'Asia/Shanghai' },
          ws(),
        );
        expect(pageService.create).toHaveBeenCalledWith(
          'member-1',
          'ws-1',
          expect.objectContaining({ title: '2026/10/27-周报' }),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('模板未指定到目标空间时返回 400', async () => {
      const { service, pageService } = createSubject({
        template: row({ spaceIds: ['space-1'] }),
      });
      await expect(
        service.use({ templateId: 't1', spaceId: 'space-2' }, member, ws()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(pageService.create).not.toHaveBeenCalled();
    });

    it('目标空间无建页权限时拒绝', async () => {
      const { service, pageService } = createSubject({
        template: row({ allSpaces: true, spaceIds: [] }),
        cannotCreateIn: ['space-1'],
      });
      await expect(
        service.use({ templateId: 't1', spaceId: 'space-1' }, member, ws()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(pageService.create).not.toHaveBeenCalled();
    });

    it('父页面不在目标空间时返回 404', async () => {
      const { service } = createSubject({
        template: row({ allSpaces: true, spaceIds: [] }),
        page: { id: 'p1', workspaceId: 'ws-1', spaceId: 'space-2' },
      });
      await expect(
        service.use(
          { templateId: 't1', spaceId: 'space-1', parentPageId: 'p1' },
          member,
          ws(),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
