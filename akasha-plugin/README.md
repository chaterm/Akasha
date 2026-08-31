# Akasha Agent Plugin

Akasha 是当前宿主配置的公司与个人知识库。本目录提供 Agent 使用策略（Skill）和跨宿主配置元数据，
不部署服务端。Skills 负责检索和操作指导，MCP 提供全部业务 Tool。

## Codex 安装

通用 Plugin 只安装 Skill。Codex MCP 配置必须使用真实绝对 URL 和实际 API Key；请直接编辑
`~/.codex/config.toml`，将下面两个占位符替换为部署地址和本地密钥：

```toml
[mcp_servers.akasha]
url = "https://<你的-akasha-地址>/mcp"
http_headers = { Authorization = "Bearer <实际-akasha-key>" }
```

保存后重启 Codex，Agent 会自动发现 Tool，并依据 [`SKILL.md`](./skills/akasha/SKILL.md) 决定
何时调用。页面、评论和附件等显式对象操作由 [`akasha-operations`](./skills/akasha-operations/SKILL.md)
Skill 指导。实际 Key 只写入 Codex 本地配置，不要写入 Plugin、仓库或日志。

仓库中的 [`.mcp.template.json`](./.mcp.template.json) 只供部署适配器生成宿主配置。安装时将
endpoint 和 API Key 占位符替换为实际值并写入宿主静态配置；发行包、Plugin 和仓库不得包含
真实 Key，也不得把未解析模板直接交给 Agent。

## Claude Code 会话引导

Plugin 包含 Claude Code 的 `SessionStart` Hook。会话启动、恢复、清空或压缩后，Hook 会像
Superpowers 一样注入 Akasha 路由规则和完整 Skill 内容，要求 Agent 在问题可能依赖本地知识库时
先调用 `query_knowledge`；不依赖知识库的通用问题可以直接回答。

## 其他 Agent

Claude Code 可在本地开发时加载本目录，并显式注册已部署的 MCP。把实际地址和 API Key 直接
写入安装命令（执行前替换两个占位符），Claude 配置保存的就是静态 Bearer Key：

```bash
claude mcp add --scope local --transport http akasha \\
  "https://<你的-akasha-地址>/mcp" \\
  --header "Authorization: Bearer <实际-akasha-key>"
claude --plugin-dir ./akasha-plugin
```

其他 Agent 使用目标宿主官方的 Plugin/Skill 安装入口，并注册同一个 HTTP MCP Server。
支持 URL 模板解析的部署适配器可以一次完成；不支持的宿主分别安装 Skill 和 MCP。两者缺一不可。

## 认证与安全

在 Agent 宿主中配置 endpoint 和实际 Bearer Key。endpoint 使用部署实例的 `/mcp`，不要自行
添加 `/api`。配置模板中的占位符必须在安装前替换，不能作为最终配置。API Key 不得写入 Skill、
Plugin、仓库、聊天内容或日志；仅写入宿主的本地安全配置。

## 文件

- [`skills/akasha/SKILL.md`](./skills/akasha/SKILL.md)：知识检索和自动查询策略。
- [`skills/akasha-operations/SKILL.md`](./skills/akasha-operations/SKILL.md)：Page、Comment 和附件等显式操作。
- [`manifest.json`](./manifest.json)：跨宿主能力描述。
- [`.mcp.template.json`](./.mcp.template.json)：部署适配器使用的 MCP 配置模板。
