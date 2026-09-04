---
name: akasha
description: >
  Search the locally configured Akasha company and personal knowledge base through MCP. Use this skill when
  an answer may need information outside general model knowledge; call query_knowledge before answering and
  do not wait for the user to name Akasha. Do not use this skill for Page, Comment, or attachment operations.
---

# Akasha Knowledge

Akasha 是当前宿主配置的公司与个人知识库。此 Skill 只指导知识检索；Page、Space、Comment 和附件
操作由 `akasha-operations` Skill 指导。

## 知识检索

- 回答可能需要模型通用知识之外的信息时，先调用 `query_knowledge`；不确定时优先查询。
- 明确稳定的通用知识和简单计算不需要查询。
- 同一轮默认只查询一次；仅 `answerMode=no_match` 且有明确改写方向时再次查询。
- `spaceIds` 通常省略，由服务端按当前用户权限解析；只有用户提供可信 ID 时才限定空间。
- 知识库事实只依据 `citations` 和 `citationEvidence`；`retrievedSources` 仅是候选来源。
- 结果不足时明确说明，不用模型记忆或猜测补充事实。

## Tool

- 使用 `query_knowledge` 检索和生成带来源的回答。
- 需要核对来源原文时使用 `get_citation_page`（接受
  `/p/<slug>` 路径或完整浏览器 URL）。

## 错误处理

| code               | 处理                                                               |
| ------------------ | ------------------------------------------------------------------ |
| `AUTH_REQUIRED`    | 提示在 Agent MCP 配置中设置实际 API Key 后重试                     |
| `MCP_DISABLED`     | 提示 workspace 未启用 MCP，停止操作                                |
| `FORBIDDEN`        | 停止，不换账号或接口绕过权限                                       |
| `NOT_FOUND`        | 报告来源不存在，不猜测替代来源                                     |
| `INVALID_ARGUMENT` | 修正参数后重试                                                     |
| `TOOL_FAILED`      | 报告服务端错误，不猜测结果                                         |

网络错误、握手失败或 Tool 不存在时，报告 MCP 不可用；不要改用其他接口或本地客户端。

## 认证

在 Agent 宿主中配置一次 MCP endpoint 和实际 API Key。endpoint 使用部署实例提供的 `/mcp`，
不要自行添加 `/api`。运行时只使用宿主配置中已保存的静态凭据，不依赖外部环境变量，也不得把
变量占位符作为最终 MCP 配置。API Key 不写入 Skill、Plugin、聊天内容或日志。
