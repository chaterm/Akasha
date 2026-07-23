---
name: akasha
description: Use when a user asks to query Akasha or 已编译 Wiki knowledge, create a 个人空间 Page, or search, read, and update an existing personal Page.
---

# Akasha

## 核心原则

通过随包 Python CLI 使用 Akasha。知识问答只查询已编译 Wiki；仅在编辑个人空间 Page 时搜索或读取原文。Page 原文读写只面向个人空间，最终权限始终由 Akasha API 决定。

从当前 `SKILL.md` 的实际路径解析本 Skill 所在目录，并记为 <AKASHA_SKILL_DIR>。不要假设它位于固定的全局目录，也不要让用户查找或猜测 Skill 目录。执行：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py <command>

Windows 可将 python3 替换为 py。

## 首次认证

用户首次要求使用 Akasha 时，直接执行对应命令；该命令会自动检查认证状态。当命令提示缺少凭据或返回退出码 3 时，使用已解析的 <AKASHA_SKILL_DIR> 生成完整登录命令。若服务地址未知，只询问非敏感的 Akasha base URL，然后引导用户在自己的本地终端执行：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py auth login --base-url <AKASHA_BASE_URL>

命令中必须替换为实际绝对路径和服务地址，不要把 `<AKASHA_SKILL_DIR>` 占位符留给用户。让用户在隐藏提示中输入 Key；不要由 Agent 通过聊天或工具 stdin 代为输入。不要让用户把 API Key 粘贴到聊天，也不要把 Key 放进命令参数、临时文件、日志或 Skill 目录。

用户确认登录完成后，重新执行原始 Akasha 命令；不要要求用户手动执行 query 或 Page 命令。

macOS 凭据保存在 `~/.akasha/credentials.env`，Linux 保存在 `~/.config/akasha/credentials.env`，Windows 保存在 `%USERPROFILE%\.akasha\credentials.env`。不要使用其他凭据目录。

后续命令自动读取已保存凭据。需要诊断当前配置时执行 auth status；只有用户明确要求退出时才执行 auth logout。

## 查询知识

用户询问工作区知识、制度、流程、决策或项目上下文时，执行：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py query "用户问题"

默认查询 API Key 可见的全部空间。只有用户明确限定空间且已提供可信 space ID 时，才增加一个或多个 --space-id。

使用返回的 answer 回答，并保留 citations、warnings 和 completenessNotice 中的重要限制。不要自行声称结果完整。

知识问答不搜索或读取原始 Page，不调用 Page 搜索/原文接口，也不在本地拼接原始内容。`page search` 和 `page get` 不能用于回答普通知识问题。

## 查找和读取待编辑的个人 Page

仅在用户明确要求编辑个人空间 Page 时，才可搜索原文：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py page search "关键词" --limit 10

根据 title 和 excerpt 选择目标。若多个结果都可能匹配，先让用户确认，不要猜测。取得可信 page ID 后读取完整原文：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py page get <PAGE_ID>

只能读取 API 返回为个人空间的 Page。遇到共享空间或 403 时立即停止；不要用知识查询结果代替完整原文，也不要尝试其他 Page 接口。

## 创建个人空间 Page

用户明确要求创建 Page 时，将确认后的 UTF-8 内容放入工作文件，然后执行：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py page create \
      --title "标题" \
      --content-file <CONTENT_FILE>

需要创建子 Page 时增加 --parent-page-id。不要传 space ID；脚本从 API 的 personalSpaceId 选择个人空间。不要尝试向共享空间写入。

## 更新个人空间 Page

必须有可信 page ID 和用户明确要求的修改。需要改写既有内容时，先用 `page get` 读取完整原文，只修改指定部分，并保留用户未要求修改的内容。

- 仅修改标题：只传 --title。
- 增加内容：传 --content-file，并选择 --operation append 或 prepend。
- 精准改写：把修改后的完整原文写入 UTF-8 工作文件，使用 replace。
- 完整覆盖：仅当已读取个人 Page 的完整原文，或用户提供完整替换内容并明确要求覆盖时使用 replace。

执行：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py page update <PAGE_ID> \
      --content-file <CONTENT_FILE> \
      --operation replace

不要发送 space ID，不要移动 Page，不要推断缺失的原文。

## 权限与错误处理

每个联网命令都会先检查当前用户。若 JSON 结果包含 `skillUpdateNotice`，先完成用户当前请求，再根据其中的 message、latestVersion 和 upgradeUrl 提示用户有新版本；未经用户明确确认，不要自动升级 Skill。

| 退出码 | 处理 |
| --- | --- |
| 0 | 使用 JSON 结果继续 |
| 2 | 修正命令参数或内容文件 |
| 3 | 引导用户在本地重新执行 auth login |
| 4 | 权限不足；立即停止 |
| 5 | 报告网络或 API 暂时不可用 |
| 6 | 报告服务端契约尚未满足 |

遇到 403 时停止，不要改用其他接口、账号或路径绕过。普通用户 API Key 只能读取和写入个人 Page 原文；其他空间只能通过已编译 Wiki 查询知识。

不提供 Page 删除或 ACL 修改，也不要建议用户用脚本直接调用这些接口。

创建或更新成功后，告诉用户需要等待 Wiki 编译；在编译完成前，query 可能暂时查不到新内容。没有编译状态接口时不要盲目轮询。

## API 参考

仅在排查接口契约、响应字段或退出码时读取 references/api.md。常规使用直接运行 scripts/akasha.py，不要重新实现 HTTP 请求。
