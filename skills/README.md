# Akasha 周报 Skill：安装与联调

技能版本：`0.1.0-preview.6`。源码在 `akasha-weekly-report/`；默认产物为仓库根目录 `dist/skills/akasha-weekly-report.zip`。本文和本地验证脚本不进入 ZIP。

开发分支：`feat/weekly-report-skill`，从本地 `beta` 的 `9919dd64` 创建。联调前先让测试实例运行本分支服务端和前端，并应用新增的 `20261030T120000-weekly-reports` 迁移。

当前交付为待实机验收的内测包。最低服务端要求以能力为准：增强的 `get_current_user` 以及下列四个新增工具全部可发现、契约匹配；目前没有已验证的最低发布版本号。WorkBuddy 的 ZIP 导入层级、辅助资源可读性、目标版本/模型的生成质量和端到端保存均须由用户实测，尚不能宣称已兼容或达到发布条件。

## 开发者准备服务端

在测试实例先部署本分支服务端与向后兼容迁移，再分发技能。需要 PostgreSQL（pgvector）、Redis、可访问的 Akasha 外部地址，以及正常初始化的真实用户个人空间。按根 README 准备本地 `.env` 的数据库/Redis/应用密钥；不要把凭据加入分发包。下列迁移、启动命令已核对根 `package.json`、`apps/server/package.json` 和 `apps/server/src/database/migrate.ts`。开发验证已在独立 PostgreSQL 测试容器中执行迁移与事务测试；本地开发数据库已在 2026-11-02 应用新增迁移，其他环境仍需各自执行：

```bash
pnpm install
# 按仓库 README 配好 .env 并启动测试数据库、Redis 后：
pnpm --filter ./apps/server run migration:latest
pnpm run dev
```

已有开发依赖与基础服务时可直接执行后两条。仅启动后端用 `pnpm run server:dev`；生产构建/启动对应 `pnpm run build`、`pnpm run start`，沿用部署环境的既有配置，不把技能安装当成服务器升级。正文模型在 WorkBuddy 中运行，服务端只校验保存。

管理员须启用工作区 MCP（`settings.ai.mcp=true`），允许用户创建/使用 API Key；若工作区限制仅管理员创建 Key，先由管理员处理。用户在 Akasha 个人设置的 API keys 页面创建有效的**个人 API Key**，该用户必须能访问目标空间、模板与父页面。此流程不支持 Agent Key 或 `x-token` SSO；浏览器已登录不等于 MCP 已获授权。个人空间缺失先初始化，不靠技能创建空间。

## 用户安装与连接

1. 取得上述 ZIP，通过当前 WorkBuddy 客户端提供的技能本地导入入口安装。包目前固定为单个顶层 `akasha-weekly-report/`，其下是 `SKILL.md` 和两个参考文件；这是待验证的候选层级。若客户端拒绝，记录完整错误和 WorkBuddy 版本，由维护者依据真实导入结果调整打包脚本，不能仅凭压缩包里有 SKILL.md 就判断成功。
2. 在 WorkBuddy 的 MCP 设置中连接**自己的 Akasha 实例**，地址为 `https://<你的实例域名>/mcp`，传输为 Streamable HTTP（配置名称通常为 `streamableHttp`）。在宿主的凭据/请求头设置填 `Authorization: Bearer <个人 API Key>`；不要把 Key 发到聊天或放入技能目录、截图和日志。若客户端配置形式不同，按该版本界面填写同一地址/传输/请求头语义。
3. 上传 Skill 不会自动配置 MCP。连接成功后刷新/重新发现工具，核对身份与下述四工具；缺工具先升级服务端，不用通用 `create_page` 临时绕过。
4. 模板和上级页面可以在 MCP 连接的自定义请求头里配置一次，下次直接说「生成本周周报并保存」即可。也可以在本次对话临时指定模板 ID 或上级页面链接/ID，覆盖连接默认值；页面链接先由 AI 读取取得真实 UUID。无需本地偏好文件，只有读取用户提供的本地素材时才需要相应文件授权。

一次配置示例（把所有占位符替换为真实值；本地同机联调可使用 `http://localhost:3000/mcp`）：

```json
{
  "mcpServers": {
    "akasha": {
      "type": "streamableHttp",
      "url": "https://<你的实例域名>/mcp",
      "headers": {
        "Authorization": "Bearer <你的个人APIKey>",
        "X-Akasha-Weekly-Template-Id": "<默认模板UUID>",
        "X-Akasha-Weekly-Parent-Page-Id": "<默认上级页面短标识或UUID>"
      }
    }
  }
}
```

两个自定义请求头均可省略：未配置模板时使用内置周报；未配置父页面时使用个人空间「周报」父页面。不用某个默认值时删除对应请求头，不填空字符串或 `null` 文本。模板填写 UUID；父页面可以填写页面上可见的十位短标识，无需获取内部 UUID。例如 `MJ3eqsj1Ac` 或复制时带分隔符的 `-MJ3eqsj1Ac` 都支持；短标识由数据库保证唯一，服务端读取页面后仍校验工作区、权限和锁定。完整页面地址可先让 AI 只读解析，不能直接放入 ID 请求头。

优先级：本次参数 > 连接请求头 > 系统默认。需要本次回到内置模板或个人空间位置时，分别传 `templateId:null` 或 `parentPageId:null`，不必改连接设置。配置错误、不存在或无权限时明确报错，不静默回退。

连接默认值、短标识解析和自动上海时区需要本分支服务端支持；首次更新这些功能需重启服务端、导入最新版 Skill 并刷新或重连 MCP。preview.6 只修复 WorkBuddy 导入元数据，服务端已经是相应版本时重新导入 ZIP 即可。请求头不授予额外权限；准备后改配置不改变 Token 目标。

时区默认固定为 `Asia/Shanghai`（北京时间），无需用户填写、选择或额外配置。工具要求时区参数时由 AI 自动补齐；个人资料时区为空或不同不阻断生成。仅用户主动指定其他时区时才覆盖。

### 保存改为两步

WorkBuddy 实测出现长 Token 与完整 Tiptap JSON 合并调用时反复缺少 `saveToken` 的现象；隔离 HTTP/SDK 复测仍可完整传输 6–64 KB，未证明具体是截断、模型漏参还是宿主组装异常。本版按实测可用性切换工作流，避免将长 Token 和完整正文放在一次调用：

1. `save_weekly_report` 仅携带 Token、标题和固定「正文待写入」标记，短参数创建或复用原周报页，保留默认父页面创建、权限和业务周期去重。
2. `get_page` 确认仍为本人可编辑的固定占位页后，使用 `update_page`，传短页面 ID、`operation:replace`、`format:json` 和完整正文。写后回读确认，才报告全文保存成功。

回执 `contentPending=true` 表示页面待填写，后续相同周期可恢复第二步；已经有正文的报告不自动覆盖。仅创建占位页时不安排知识编译，正文写入后按原协作更新流程处理。两步不构成一个整体事务，第二步失败会留下待填写页；应保留链接、有限重试或恢复，不再连续重发大参数或换通用建页工具制造副本。通用内容替换不提供两位写入者的并发比较交换保证，应串行填写同一报告。

[WorkBuddy 官方 Connector 文档](https://open.workbuddy.cn/en/docs/connector) 描述了 MCP + Skill、Streamable HTTP 和用户提供凭据的集成方式；[Skill 开发说明](https://open.workbuddy.cn/en/docs/skill) 是格式参考。这些文档不能代替当前客户端的本地导入测试。本包不包含 Connector 元数据，不假定仓库 `akasha-plugin/manifest.json` 可直接导入 WorkBuddy，也不要求用户安装 Python/Node 运行技能。

## 四工具发现检查（只读起步）

先让 WorkBuddy 显示 MCP 工具清单，并调用现有 `get_current_user({})`：预期 `credentialType=personal_key`，用户姓名/工作区正确；资料时区可为空，不要求补填。不要在聊天里回显 Key。随后依次检查四个新增工具的名称与输入 schema：

1. `list_templates`：接受 `query?`, `spaceId?`, `limit?`, `cursor?`。按需浏览可见模板，不要求每次调用。
2. `get_template`：接受 `templateId`, `spaceId`。已知 ID 可读取详情，或直接交给准备工具，无须先列模板。
3. `prepare_weekly_report`：接受 `period?`, `periodStart?`, `periodEnd?`, `timezone?`, `templateId?`, `parentPageId?`。模板为 UUID；父页面为 UUID 或十位短标识（允许前导分隔符），也支持本次重置 `null` 或省略继承默认值。完整地址先通过只读工具解析。返回 `status=prepared` + saveToken，或 `status=existing` + 已有结果及 `contentPending`。只读准备不创建任何页面。
4. `save_weekly_report`：**只检查 schema，不作探测写入**；第一步发送 `saveToken`, `title?`, `content`，其中正文固定为短占位标记。随后需要已有 `get_page`、`update_page` 完成第二步，完整正文不携带 Token。实际周期和目标由 Token 绑定。

身份不是 personal_key 则停止周报流程。用测试 SSO 会话做负向验收时，四个新增工具均应返回 `IDENTITY_UNSUPPORTED`；通用 get_current_user 的身份查询仍可使用。不要为了测试否定分支在真实生产实例冒用身份。

## 用户实机验收

在测试空间、用户主动要求保存的会话中进行。每轮记录：WorkBuddy 版本、模型、设置、服务端版本/提交、技能版本/ZIP SHA-256、首次内容校验结果、错误路径和自动重试次数；只保存去敏摘要，不记录 Key、完整 Token、私人来源或正文。以下均为待用户执行的验收，不是已完成测试：

| 提示/操作 | 预期 |
| --- | --- |
| 「根据这些要点整理本周周报草稿：完成 A 文档；B 在联调；指标未统计。不要保存。」 | 展示草稿与待补项，保留进行中，指标不沿用模板 0/+0%；无目录、周报或写入请求记录。纯本地草稿可不连接；加载服务器模板/页面需连接。 |
| 「生成并保存本周周报到 Akasha：完成 A 文档；B 在联调；下周做 C。」 | 自动按上海时区计算，不追问时区；短参数建页，再以页面 ID 写入完整正文并回读确认。本周未结束标明截至日期。 |
| 用户资料时区为空、无效或为其他地区 | 未明确指定其他时区时仍使用上海，无需选择或修改资料；主动指定其他合法时区才覆盖。 |
| 再分别用「文档评审完成、开发进行中、风险待确认」及「修复测试问题、发布待排期、数据待补充」素材测试其他未登记周期/目标 | 连同前一轮，在实际同一版本和模型上验证内置模板三份不同素材**连续首次输出通过**严格 schema，记录是否达成；已有周报去重不能算一次新内容通过。 |
| 「使用模板 ID〔真实自定义模板 UUID〕生成上周周报草稿，来源只读〔指定页面〕。」 | 保留真实自定义模板章节/表格/节点；只读授权来源，未知节点不发明或丢弃，无法可靠填充说明限制。无保存。 |
| MCP 请求头已配置模板和父页面，再直接说「生成本周周报并保存」 | 省略两个工具参数，服务端采用配置；再次生成无需重发 ID。仍检查当前权限、锁定和周期重复。 |
| 请求头父页面填 `MJ3eqsj1Ac` 或 `-MJ3eqsj1Ac` | 均解析到同一页面的内部 UUID，仍校验工作区与权限，不能因短标识绕过 ACL。 |
| 对话中只指定真实 templateId，不指定上级页面 | 临时模板覆盖连接默认模板，位置继续采用连接默认或个人空间位置，无本地偏好文件读写。 |
| 对话中只指定上级页面链接，不指定模板 | AI 读取链接取得 UUID，传 `parentPageId`，模板继续采用连接默认或内置模板。 |
| 用户明确本次使用内置模板与个人空间 | 传两个 `null`，本次跳过连接默认值，连接配置保持不变。 |
| 配置了无效 UUID、不存在或不可写父页面 | 周报准备明确报错，不改存其他位置；其他通用 MCP 工具仍可使用。 |
| 指定非法 ID、已删除模板 ID 或不可读取的上级页面地址 | 明确报错，无静默模板或保存位置回退；不把 URL 原样传入 `parentPageId`。 |
| 「按该模板生成〔未登记日期范围〕并保存到〔真实父页面链接〕下面。」 | 直接在该父页面建子页，无多余「周报」层；周期标题一致、可编辑。 |
| 目标不存在、不可写、锁定、跨工作区；默认目录同名多份 | 明确错误/可见候选，无新增页面、无位置回退。只给空间名须补父页面；准备后锁定也必须拒绝首次保存。 |
| 对同用户/位置/周期重复生成，或中断第二步后再生成 | 已完成报告返回链接、不覆盖；`contentPending=true` 时检查固定标记后复用原页写正文，不重复建页。不在生产故意断网。 |
| 已登记结果移动、删除或失去访问权后再准备 | 移动仍可见返回实际位置 + locationChanged；删除/不可见返回 RESULT_UNAVAILABLE，无自动重建。 |
| 测试 SSO / Agent Key、失效 Key、工作区关闭 MCP | 非个人身份四工具拒绝 IDENTITY_UNSUPPORTED；失效/关闭按结构化错误停止。SSO 不误报个人空间不存在。 |

补充覆盖跨年、闰日、主动指定其他时区时的夏令时边界和自定义日期；默认始终为上海，不询问时区。保存后确认表格、状态、任务和链接可编辑，回读无丢失。保存成功不等于知识编译完成；正文走既有策略，空目录初次跳过编译，均正常搜索和 ACL 重索引。

## 本地验证与打包

在仓库根执行（开发者需要 Python 3、已安装的 pnpm 工作区依赖；Skill 使用者不需要）：

```bash
python3 skills/scripts/package-weekly-report-skill.py --check-source
(cd apps/server && npx jest src/core/weekly-report/weekly-report-examples.spec.ts)
python3 skills/scripts/package-weekly-report-skill.py
python3 skills/scripts/package-weekly-report-skill.py --verify-only
```

节点检查是服务端 jest 用例 `apps/server/src/core/weekly-report/weekly-report-examples.spec.ts`，随服务端测试自动运行。它直接提取 content-rules.md 中 JSON，以真实服务端 `jsonToNode` + `node.check()` 及专用 `normalizeWeeklyReportContent` 验证，确认显式节点/文本/marks/属性不丢失、表格网格有效，并验证 Y.Doc 同 schema 规范化回读和 textContent；同时检查仓库内置周报模板、12 种节点和 2 种 marks。

打包脚本检查 WorkBuddy 所需的八个顶层 frontmatter 字符串字段：`name`、`version`、`display_name`、`display_name_en`、`description`、`description_zh`、`description_en`、`author`；其中 `metadata.version` 不能代替顶层 `version`。要求来源见 [WorkBuddy 官方 Skill 说明](https://open.workbuddy.cn/docs/skill)。包内采用单行字符串元数据，脚本同时检查非空字段、重复键、名称和版本格式，源文件与 ZIP 都执行校验。使用 `--check-source` 可只校验而不生成 ZIP。

打包使用固定文件白名单、排序、时间戳、权限和 ZIP_STORED；检查文件集合、重复项、CRC、归档元数据和内容。拒绝额外文件及符号链接，只含三个技能文件。脚本打印版本号和 SHA-256，可对比相同源码两次打包。实际 WorkBuddy 导入与模型任务仍以用户复测为准。

本地静态与结构检查不能证明服务端真实数据库事务、并发、回滚、outbox 投递，也不能证明 WorkBuddy 生成质量。发布前仍需服务端集成验证与上述用户真实宿主验收，保留真实结果，未执行项明确标记「未测」。

### 开发验证记录（更新于 2026-11-02）

- WorkBuddy 源文件和 ZIP frontmatter 检查：使用打包脚本的 `--check-source` 和 `--verify-only`，核对八项顶层必填字段。
- `0.1.0-preview.2`：已移除本地偏好示例，包内只保留 Skill 和两个参考文件；模板 ID 与上级页面 ID 均通过 MCP 参数传递，页面链接先由只读工具解析。MCP 定向测试 11 项及服务端类型检查通过。
- `0.1.0-preview.3`：增加 MCP 连接级模板/父页面默认请求头及显式 `null` 重置，相关服务端 72 项测试和类型检查通过；模板和父页面的现有权限检查继续生效。
- `0.1.0-preview.4`：父页面支持唯一短标识及可选的前导分隔符；Skill 改为短参数建待填写页、短页面 ID 写正文两步，首次建页仍使用专用接口保留业务去重。实际 WorkBuddy 新流程仍待用户联调，不将隔离 HTTP 可传输视为已定位宿主故障。
- `0.1.0-preview.5`：默认自动使用上海时区；移除询问用户时区的约定，服务端与 MCP schema 同时补齐默认值，用户主动指定其他时区时仍可覆盖。
- `0.1.0-preview.6`：将版本号移到 frontmatter 顶层，补齐中英文展示名、描述与 author，增加 WorkBuddy 专用打包前校验；不改变周报生成或服务端行为。
- 本轮服务端 153 项测试和类型检查通过，含 16 项隔离 PostgreSQL 测试；验证短标识解析、占位页恢复、编译抑制及已完成页不被当作占位页。真实 WorkBuddy 的二步工具参数生成仍需重新测试。
- `weekly-report-examples.spec.ts`（原 `skills/validate-weekly-report-examples.ts`，已迁入服务端 jest）：示例及仓库内置周报均通过 schema、专用严格规范化、显式值保留、表格网格、Y.Doc 与文本回读；覆盖 12 种节点、2 种 marks。
- `python3 skills/scripts/package-weekly-report-skill.py` 及 `--verify-only`：通过。临时目录中重复打包字节一致；额外归档项、正文篡改、意外源文件和源符号链接均被拒绝。`dist/skills/akasha-weekly-report.zip` 受现有根 `.gitignore` 忽略。
- 服务端 PostgreSQL 集成测试：在隔离容器的临时 schema 执行实际新增迁移，覆盖双连接并发保存、正文变化的 Token 重放、默认/指定父页面、数据库异常后全量回滚、锁定变化、结果移动/删除、模板普通编辑、JSON/文本/Y.Doc 一致性及提交后索引、ACL 和编译任务；测试 schema 用后删除。
- 未调用生产 MCP、未读取用户 Key。WorkBuddy 版本/模型尚未登记；ZIP 导入、辅助文件可读性、真实自定义模板、三份素材连续首轮通过及实际保存/编辑均为**未测，待用户联调**。
