---
name: akasha-operations
description: >
  Use Akasha MCP for explicit operations on Pages, Spaces, Comments, workspace members, identity, and
  attachments. Use when the user asks to search, read, create, update, delete, restore, copy, move, comment,
  upload, or download. Do not use this skill for general knowledge questions; use the akasha skill instead.
---

# Akasha Operations

此 Skill 只指导对 Akasha 对象的显式操作。知识问答和来源核对使用 `akasha` Skill。

## Tool 选择

- Page：`search_pages`、`get_page`、`create_page`、`update_page`、`delete_page`、`restore_page`、
  `list_recent_pages`、`list_trash_pages`、`list_pages`、`list_child_pages`、`duplicate_page`、
  `copy_page_to_space`、`move_page`、`move_page_to_space`。
- Space：`list_spaces`、`get_space`。
- Workspace 与身份：`get_current_user`、`list_workspace_members`。
- Comment：`get_comments`、`create_comment`、`update_comment`。
- 附件：`search_attachments`、`get_attachment_info`、`download_attachment`、`upload_attachment`。
- 写入、删除、恢复、复制和移动前确认用户意图；不要猜测 ID，不绕过服务端 ACL。

## 操作约定

- 所有 `pageId`、`spaceId`、`commentId` 和 `attachmentId` 必须来自 Tool 返回结果或用户明确提供；
  先搜索或读取，再执行后续操作。
- `list_pages`、`list_child_pages`、`list_spaces`、`get_comments`、`list_recent_pages`、
  `list_trash_pages` 和 `list_workspace_members` 使用游标分页。返回 `meta.hasNextPage=true` 时，将
  `meta.nextCursor` 用作下一次 `cursor`；`search_pages` 使用 `limit` 与 `offset`。
- Page 内容的 `format` 只能是 `json`、`markdown` 或 `html`。写入 Markdown/HTML 时必须显式指定
  `format`；省略时服务端按 JSON 处理。
- `update_page` 传 `content` 时必须传 `operation`：`append`、`prepend` 或 `replace`；只更新标题
  或图标时不要传 `operation`。
- `create_page` 省略 `spaceId` 时写入当前用户个人空间；指定空间或父页面前先确认用户意图和权限。
- 评论 `content` 必须是 JSON 对象、数组或 JSON 编码后的字符串；`type` 使用 `page` 或 `inline`。
  回复评论传 `parentCommentId`，内联评论同时提供 `selection`。
- `move_page` 的 `position` 是页面排序键。先用 `list_pages` 或 `list_child_pages` 获取同级页面的
  `position`；跨空间移动使用 `move_page_to_space`。
- `duplicate_page` 在原空间复制，`copy_page_to_space` 跨空间复制；两者都会产生新页面。
- 附件上传使用非空且不超过 Tool Schema 限制的 `contentBase64`；替换附件时传 `attachmentId`。
  `download_attachment` 返回受 ACL 保护的 URL，需要携带宿主中的 Bearer 凭据下载。无法获取或写入
  文件时，明确说明只提供下载地址，不声称已经下载。

## 错误处理

| code               | 处理                                                               |
| ------------------ | ------------------------------------------------------------------ |
| `AUTH_REQUIRED`    | 提示在 Agent MCP 配置中设置实际 API Key 后重试                     |
| `MCP_DISABLED`     | 提示 workspace 未启用 MCP，停止操作                                |
| `FORBIDDEN`        | 停止，不换账号或接口绕过权限                                       |
| `NOT_FOUND`        | 检查用户提供或前序 Tool 返回的 ID，不猜测替代对象                  |
| `INVALID_ARGUMENT` | 修正参数后重试                                                     |
| `TOOL_FAILED`      | 报告服务端错误，不猜测结果                                         |

网络错误、握手失败或 Tool 不存在时，报告 MCP 不可用；不要改用其他接口或本地客户端。

## 认证

使用宿主中已配置的 Akasha MCP endpoint 与静态 API Key。endpoint 为部署实例的 `/mcp`，不要添加
`/api`。API Key 不写入 Skill、Plugin、聊天内容或日志。
