# Akasha Agent Plugin 与 MCP 设计

## 1. 目标

Akasha 是由宿主配置的知识库服务（默认用于公司内部知识）。Agent 侧分发使用策略（Skill）和 MCP 配置模板；安装适配器负责
将真实 endpoint 注册到宿主。宿主 Bootstrap 在会话边界加载检索规则，Agent 自动发现 MCP Tool，并根据
Skill 判断何时调用。

```text
安装 Skill/Plugin
  -> 加载 skills/akasha/SKILL.md（知识检索）
  -> 按需发现 skills/akasha-operations/SKILL.md（对象操作）
  -> 使用真实绝对 URL 注册远程 Akasha MCP Server
  -> tools/list 发现全部 Tool
  -> 宿主 Bootstrap 加载检索策略
  -> Agent 按检索策略自主调用
```

CLI 不再是交付物、回退通道或认证入口。所有 Akasha 业务能力统一由 MCP 提供，认证也只
在 Agent 宿主的 MCP 配置中完成一次。

## 2. 能力分层

Akasha 服务端 `/mcp` 提供知识、Page、Space、Comment 和附件等完整业务能力；具体 Tool
清单以服务端 `tools/list` 为准。知识检索与对象操作使用不同 Skill，避免检索入口被操作说明稀释。

Skill 不实现业务逻辑，也不执行 HTTP 请求；Plugin 不部署 Akasha 服务端；MCP 是唯一的
业务能力入口。宿主的权限确认策略由宿主决定，Plugin 不声明额外的 Skill permissions。

## 3. 跨宿主清单

`akasha-plugin/manifest.json` 只描述通用能力，不能假设所有 Agent 使用同一安装格式：

```json
{
  "schemaVersion": 1,
  "name": "akasha",
  "version": "1.3.0",
  "activation": "auto",
  "instructions": "skills/akasha/SKILL.md",
  "toolProvider": {
    "type": "mcp",
    "serverName": "akasha",
    "endpoint": "https://<your-akasha-host>/mcp",
    "transport": "http"
  }
}
```

`.mcp.template.json` 使用同一 endpoint，并以占位符表示实际 API Key。它是部署适配器输入，
不是可直接加载的最终配置；安装时必须在目标宿主配置中替换两个占位符：

```json
{
  "mcpServers": {
    "akasha": {
      "type": "http",
      "url": "https://<your-akasha-host>/mcp",
      "headers": {
        "Authorization": "Bearer <your-akasha-api-key>"
      }
    }
  }
}
```

服务端虽然对 REST API 使用全局 `/api` 前缀，但 `main.ts` 明确将 `mcp` 路由排除在全局
前缀之外，因此 MCP 真实路径是 `/mcp`。部署实例变更时更新 endpoint，并在目标宿主配置中
更新实际 API Key。

## 4. Tool 契约

服务端保留现有 Tool 名称和权限语义，只新增唯一的知识入口 `query_knowledge`，不创建
`akasha_get_page` 等重复前缀 Tool。MCP 响应包含稳定的 `code` 字段；错误码语义和 Agent
行为见 [`SKILL.md`](../akasha-plugin/skills/akasha/SKILL.md)。

知识结果默认裁剪证据总量（服务端当前上限 12 KB），并返回截断标记；附件上传通过受限
Base64 参数完成，超过限制时提示用户。

检索判定、Tool 选择和回答规则以 [`SKILL.md`](../akasha-plugin/skills/akasha/SKILL.md)
为唯一执行规范，避免在设计文档中复制指令文本。

## 5. 认证与安全

认证配置和错误处理以 [`SKILL.md`](../akasha-plugin/skills/akasha/SKILL.md) 为准。API Key 不得
写入 Skill、Plugin manifest、发行包、仓库、聊天内容或日志；仅写入宿主本地静态配置。服务端
继续执行认证、workspace MCP 开关和 Page/Space ACL；客户端安装器不能隐式修改这些设置。

## 6. 宿主适配

Claude Code、Codex、OpenCode 以及其他同时支持 Skill 和 MCP 的 Agent 都可以接入：

- 能解析模板的部署适配器：安装时把 endpoint 和 API Key 占位符替换为实际值，再生成宿主静态配置；
  真实 Key 不进入发行包或仓库。
- Codex 通用包：Plugin 只加载 Skill，需在 `~/.codex/config.toml` 写入真实 URL 和
  `http_headers.Authorization`。
- Claude Code：Plugin 注册 `SessionStart` Bootstrap，加载路由规则及完整 Skill。其他宿主需用其
  官方 Hook/Instructions 机制实现等价适配。
- 其他只有独立安装入口的宿主：分别安装 `skills/akasha/SKILL.md` 和
  `skills/akasha-operations/SKILL.md`，再按宿主标准配置
  同一个 HTTP MCP Server；两者缺一不可。
- 只有 Skill 或只有 MCP 的宿主：只能获得部分能力，不宣称完整 Akasha 集成。

适配器只负责格式转换、幂等注册、更新、卸载和会话刷新，不复制 Akasha 业务逻辑。重复
安装不能产生重复 server，卸载只能移除 Akasha 自己的配置。

## 7. 当前目录结构

```text
akasha-plugin/
├── .codex-plugin/plugin.json
├── .mcp.template.json
├── manifest.json
├── README.md
├── hooks/
│   ├── hooks.json
│   └── session-start.sh
└── skills/
    ├── akasha/
    │   ├── SKILL.md
    │   └── agents/openai.yaml
    └── akasha-operations/
        ├── SKILL.md
        └── agents/openai.yaml
```

通用 Codex Plugin 的 `plugin.json` 不声明 `mcpServers`，避免 Codex 把未展开的 URL 当成
relative URL。部署专用发行包可以用真实绝对 URL 生成 `.mcp.json` 并增加该声明。

不存在 `scripts/`、`tests/` 或 CLI 凭据文件；旧 `skills/` 顶层目录已迁移并删除。

## 8. 服务端实现要求

`McpToolRegistry` 允许业务模块注册扩展 Tool；`McpModule` 导出 Registry，业务模块通过
模块导入获得依赖。`KnowledgeMcpToolExtension` 注册 `query_knowledge` 并复用现有知识服务、
空间 ACL 与审计；核心 `McpService` 暴露 Page、Space、Comment、来源和附件 Tool。

Controller 路由为 `/mcp`（显式排除全局 `/api` 前缀）。MCP 禁用异常必须返回
`{ code: "MCP_DISABLED", ... }`，与 ACL 的 `FORBIDDEN` 区分。

## 9. 验收标准

- 部署专用发行包校验通过，安装后 Skill 与 MCP server 同时可见；通用 Codex 包安装后
  通过显式绝对 URL 注册 MCP。
- Claude Code 会话启动后加载 Skill，并由 Agent 自主判断是否调用 `query_knowledge`；通用问题不强制检索。
  其他宿主按其 Bootstrap/Instructions 适配能力验收。
- 全部既有 CLI 能力均可由 MCP Tool 完成：知识、Page、Space、Comment、附件和软删除恢复。
- MCP 认证、开关、ACL 和参数错误返回稳定 code。
- 重复安装、更新、卸载不会影响其他 Agent 配置。
- API Key 不出现在 Plugin、发行包、仓库静态文件、日志或聊天内容中；仅存在于宿主本地配置。
- 服务端构建、MCP 测试和 Plugin manifest 校验通过。

## 10. 实施状态

服务端 MCP 扩展、Claude Code Bootstrap 与 Plugin 包已实现并在本地 Claude Code
端到端验证。CLI 源码、脚本、CLI 测试和 CLI 凭据流程已移除。后续仅需针对 Codex、OpenCode
及其他宿主实现等价 Bootstrap 适配，并验证其官方安装入口和远程 HTTP MCP 认证细节；这
属于适配器发布工作，不改变 Akasha 的 MCP 能力内核。
