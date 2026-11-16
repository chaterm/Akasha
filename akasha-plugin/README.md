# Akasha Agent Plugin

本目录面向 Skill 开发者，包含 Agent 使用策略（Skill）、跨宿主元数据及打包脚本，不涉及服务端部署。
业务能力均由 MCP 工具提供，Skill 负责界定任务边界、调用顺序与失败处理。安装与使用说明请参阅根目录
[README](../README_zh.md#agent-集成)。

## Skill 划分

三个 Skill 以"单次请求形成完整闭环"为原则进行划分：

| Skill | 职责 | 主要工具 |
| --- | --- | --- |
| [`akasha-query`](./skills/akasha-query/SKILL.md) | 只读问答，答案须附来源 | `query_knowledge`、`get_citation_page`、`search_pages`、`search_attachments` |
| [`akasha-pages`](./skills/akasha-pages/SKILL.md) | 页面、空间、评论及附件的读写，包括按节点定位的正文精确修改 | `get_page`、`edit_page`、`update_page`、`create_page`、`move_page` 等 |
| [`akasha-weekly-report`](./skills/akasha-weekly-report/SKILL.md) | 周报起草与两步保存 | `prepare_weekly_report`、`save_weekly_report`、`update_page` |

每个 Skill 目录均为自包含结构，由 `SKILL.md` 及其 `references/` 组成。安装器以目录为单位复制，跨目录
引用不会随之安装，因此连接方式、凭据及错误码等通用约定须分别写入各 Skill 的 `SKILL.md`。

## 安装入口

用户可通过以下三种方式安装，均以 `main` 分支为来源。Skill 的名称、目录或数量发生变化时，须同步更新
全部入口：

- [`install.md`](./install.md)：根目录 README 中的安装指令引导 Agent 读取该文件。安装步骤及目录对照表
  均在此定义，默认全局安装到 Agent 当前所在的宿主。
- `npx skills add chaterm/Akasha`：skills CLI 从 `akasha-plugin/skills/` 发现 Skill，仅读取
  frontmatter 中的 `name` 与 `description`。
- [`dist/akasha-skills.zip`](./dist/akasha-skills.zip)：适用于无 Node.js 环境的离线安装，详见
  [打包与离线分发](#打包与离线分发)。

修改完成后，请在仓库根目录执行以下命令，确认各入口均能识别全部三个 Skill：

```bash
npx -y skills@latest add . --list
python3 akasha-plugin/scripts/package-skills.py --verify-only
```

## 知识查询规则

涉及公司制度、内部项目、个人笔记，或用户明确要求查询 Akasha 时，应优先查询；通用公共知识不予查询，
除非用户明确指定 Akasha。模型自身不确定或公共信息可能过时，均不构成查询依据。权威表述及触发示例见
[`akasha-query`](./skills/akasha-query/SKILL.md#何时查询)，其他文档仅作引用，不再重复。

## 正文编辑

[`akasha-pages`](./skills/akasha-pages/SKILL.md) 通过 `edit_page` 修改已有页面的局部内容：

- **块级节点**按稳定 `id` 定位。`heading`、`paragraph`、`table`、`callout`、`taskItem`、
  `database` 等 31 种可定位类型见
  [`references/node-reference.md`](./skills/akasha-pages/references/node-reference.md)。该文件由
  服务端 schema 生成，不应手工维护。
- **表格单元格**按 `tableId` 及行列网格坐标定位（合并单元格由 `TableMap` 解析），支持修改单元格及
  插入、删除行列。
- **database** 采用三级地址 `database.id` → `databaseRow.id` → `databaseCell.columnId`。行、
  单元格、列及视图均有专用操作，取值按列类型归一化。

单次调用最多包含 50 个操作，在同一 Yjs 事务中按序执行，要么全部成功，要么全部不生效。每个操作可通过
`expect` 断言当前值；断言不符时返回 `EDIT_CONFLICT`，且整批操作均不写入。与 `update_page` 的
`replace` 相比，按节点修改不会覆盖他人的并发编辑：不同段落、不同单元格或同一行的不同列均可正确合并。

节点清单为客户端与服务端共享的 `ADDRESSABLE_NODE_TYPES`
（`packages/editor-ext/src/lib/unique-id/addressable-types.ts`），两端须保持一致，否则 schema 不匹配
将导致内容静默丢失。修改后须重新生成参考文档：

```bash
pnpm --filter ./apps/server run skill:node-reference
```

`node-reference.spec.ts` 会校验该文件与当前 schema 是否一致，文件过期时测试将失败。

## 周报

[`akasha-weekly-report`](./skills/akasha-weekly-report/SKILL.md) 要求使用**个人 API Key**：工作区须
启用 MCP（`settings.ai.mcp=true`），用户须在个人设置的 API keys 页面自行创建 Key，并具有目标空间、
模板及父页面的访问权限。使用 Agent Key 或 `x-token` SSO 调用 `prepare_weekly_report`、
`save_weekly_report`、`list_templates`、`get_template` 时，将返回 `IDENTITY_UNSUPPORTED`。时区固定为
`Asia/Shanghai`，无需配置。

默认模板与保存位置可通过 MCP 连接的请求头统一配置：

```json
{
  "X-Akasha-Weekly-Template-Id": "<默认模板UUID>",
  "X-Akasha-Weekly-Parent-Page-Id": "<默认上级页面短标识或UUID>"
}
```

两个请求头均为可选项：未配置模板时使用内置周报模板，未配置父页面时使用个人空间中的「周报」父页面。
不需要某项默认值时，应删除对应请求头，而非填写空字符串。取值优先级为：本次工具参数 > 连接请求头 >
系统默认。如需在单次调用中恢复内置模板或个人空间位置，可传入 `templateId:null` 或
`parentPageId:null`，无需修改连接配置。

`references/content-rules.md` 中的 JSON 示例由服务端用例
`apps/server/src/core/weekly-report/weekly-report-examples.spec.ts` 按实际保存路径校验，修改示例后
须运行该用例。

## 打包与离线分发

离线包 [`dist/akasha-skills.zip`](./dist/akasha-skills.zip) 随仓库提交，供无 Node.js 环境的机器及仅
支持上传压缩包的宿主使用。该包由 [`scripts/package-skills.py`](./scripts/package-skills.py) 生成
（仅依赖标准库，需要 Python 3）。文件名固定、不含版本号，以保证下载地址稳定。包内顶层即为三个
Skill 目录，解压至宿主的 Skill 目录即可使用。**任何 Skill 修改后，均须重新打包并一并提交**：

```bash
python3 akasha-plugin/scripts/package-skills.py --check-source  # 仅校验源文件，不生成产物
python3 akasha-plugin/scripts/package-skills.py                 # 生成 dist/akasha-skills.zip
python3 akasha-plugin/scripts/package-skills.py --verify-only   # 校验已提交的包与源文件一致
```

脚本校验以下内容：frontmatter 中的 `name` 与目录名一致，`description` 存在且非空；各 `SKILL.md`
中的相对链接均指向包内存在的文件；Skill 目录中仅包含 `SKILL.md` 与 `references/`。条目顺序、时间戳
及 `ZIP_STORED` 压缩方式均固定，相同的源文件始终生成字节一致的产物。

## 认证与安全

MCP 接口地址为部署实例的 `/mcp`，不应额外添加 `/api`。API Key 不得写入 Skill、Plugin、代码仓库、
对话内容或日志，仅可保存在宿主的本地安全配置中；发行包及仓库中只允许出现占位符。
[`.mcp.template.json`](./.mcp.template.json) 为部署适配器使用的模板，占位符须在使用前替换，不得
原样提供给 Agent。

## 文件

- [`install.md`](./install.md)：供 Agent 读取的安装说明。
- [`skills/akasha-query/SKILL.md`](./skills/akasha-query/SKILL.md)：知识检索与作答规则。
- [`skills/akasha-pages/SKILL.md`](./skills/akasha-pages/SKILL.md)：对象读写与正文精确修改；操作
  契约见 [`references/edit-operations.md`](./skills/akasha-pages/references/edit-operations.md)，
  节点清单见 [`references/node-reference.md`](./skills/akasha-pages/references/node-reference.md)。
- [`skills/akasha-weekly-report/SKILL.md`](./skills/akasha-weekly-report/SKILL.md)：周报生成、两步
  保存与去重；正文规则见
  [`references/content-rules.md`](./skills/akasha-weekly-report/references/content-rules.md)，工具
  契约见 [`references/mcp-contract.md`](./skills/akasha-weekly-report/references/mcp-contract.md)。
- [`dist/akasha-skills.zip`](./dist/akasha-skills.zip)：离线安装包，以固定地址供 Agent 及手动安装
  下载。
- [`scripts/package-skills.py`](./scripts/package-skills.py)：离线打包与校验脚本。
- [`.mcp.template.json`](./.mcp.template.json)：部署适配器使用的 MCP 配置模板。
- [`hooks/session-start.sh`](./hooks/session-start.sh)：Claude Code 会话启动时的路由提示。
- [`agents/openai.yaml`](./skills/akasha-query/agents/openai.yaml)：Codex 展示用元数据，每个 Skill
  各一份。
