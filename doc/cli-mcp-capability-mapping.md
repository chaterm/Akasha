# CLI → MCP 能力映射审计

本文以已删除版本的 `skills/akasha/scripts/akasha.py` 命令注册和
`api_client.py` 方法为基准，与当前服务端 MCP Tool 逐项核对。结论是：业务能力没有减少，
变化仅在调用边界（本地 CLI 改为远程 MCP，凭据改由宿主注入）。

## 旧 CLI 到 MCP

| 旧 CLI 命令 | 旧 API 方法 | 当前 MCP Tool | 判定 | 说明 |
| --- | --- | --- | --- | --- |
| `query <question> [--space-id]` | `query_compiled_wiki` | `query_knowledge` | ✅ 等价 | 空间为空时由服务端按 ACL 分页解析全部空间；保留 answer/citation 语义并裁剪证据 |
| `space list` | `list_space_summaries` | `list_spaces` | ✅ 等价 | 返回当前 API Key 可访问空间 |
| `citation get <page-url>` | `get_citation_page` | `get_citation_page` | ✅ 等价 | 支持 `/p/<slug>` 和完整浏览器 URL，服务端复核 Page ACL |
| `page create` | `create_page` / `create_personal_page` | `create_page` | ✅ 等价 | `spaceId` 可省略，默认个人空间 |
| `page update <id>` | `update_page` / `update_personal_page` | `update_page` | ✅ 等价 | `append`、`prepend`、`replace` 均支持 |
| `page search <query>` | `search_pages` / `search_personal_pages` | `search_pages` | ✅ 等价 | 可选空间和分页参数由 Tool 传递 |
| `page get <id>` | `get_page` / `get_personal_page` | `get_page` | ✅ 等价 | 返回格式和页面权限信息 |
| `page delete <id>` | `delete_personal_page` | `delete_page` | ✅ 等价 | 仅个人空间软删除 |
| `page restore <id>` | `restore_personal_page` | `restore_page` | ✅ 等价 | 仅恢复个人空间回收站页面 |
| `page recent` | `list_recent_personal_pages` | `list_recent_pages` | ✅ 等价 | 支持分页 |
| `page trash` | `list_deleted_personal_pages` | `list_trash_pages` | ✅ 等价 | 支持分页 |
| `page attachment upload` | `upload_file` | `upload_attachment` | ✅ 等价 | 受限 Base64 上传；返回附件元数据和 Markdown |
| `page attachment replace` | `replace_file` | `upload_attachment` + `attachmentId` | ✅ 等价 | 保留原附件 ID 和 URL |
| `page attachment download --output` | `download_attachment` | `download_attachment` | ⚠️ 访问方式变化 | MCP 返回 ACL 保护的下载 URL；由 Agent 获取字节并决定本地输出位置 |
| （无 CLI 命令） | `get_attachment_info` | `get_attachment_info` | ✅ 新增 | 附件元数据和下载 URL |
| `auth login/status/logout` | 本地 `credentials.py` | 无对应 Tool | ✅ 按设计移除 | 认证改为宿主 MCP 配置中的静态 Bearer Key；不是业务能力 |

## MCP 新增能力

当前 MCP 还额外提供：

`list_pages`、`list_child_pages`、`duplicate_page`、`copy_page_to_space`、`move_page`、
`move_page_to_space`、`get_comments`、`create_comment`、
`update_comment`、`search_attachments`、`list_workspace_members`、`get_current_user`。

因此新能力集是旧 CLI 业务能力的超集。

## 关键行为核验

### 空间范围

旧 CLI 在客户端分页解析可见空间；`query_knowledge` 在服务端通过
`KnowledgeMcpToolExtension.resolveSpaceIds` 分页解析 OWNER 的工作区空间或普通用户可加入的
全部空间，之后仍由知识服务执行 ACL 过滤。客户端不再接触空间枚举结果，行为等价且边界更安全。

### 附件下载

MCP 不把大二进制直接塞入 Tool 响应。`download_attachment` 是兼容 CLI 语义的明确入口，
返回 ACL 校验后的 `downloadUrl`，由 Agent 获取字节并决定本地输出位置；
`get_attachment_info` 只返回元数据。两者职责因此分开。

### 认证和错误

MCP 使用 `McpAuthService` 验证 API Key JWT；Controller 将缺失/无效凭据返回
`AUTH_REQUIRED`，workspace 开关关闭返回 `MCP_DISABLED`，Tool 内部 ACL 拒绝返回
`FORBIDDEN`。Tool 参数和执行失败分别映射到 `INVALID_ARGUMENT` 与 `TOOL_FAILED`。

### EE 接线

`McpModule` 导出 `McpToolRegistry`，`LlmWikiModule` 导入该模块并注册
`KnowledgeMcpToolExtension`。扩展在 `onModuleInit` 注册 `query_knowledge`，复用
`AiKnowledgeChatService`、空间 ACL、审计事件和 `KnowledgeQueryAuditRepo`。

## 审计结论

旧 CLI 的全部业务命令均能在当前 MCP Tool 集中找到对应实现；唯一的可见差异是附件下载由
客户端负责落盘，以及认证不再是业务 Tool。服务端类型检查、MCP 测试和 Plugin 校验应作为
发布前回归门槛。
