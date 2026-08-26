---
name: akasha
description: Use when a user asks to query Akasha or 已编译 Wiki knowledge (optionally limited to specific spaces), list readable spaces, read an ACL-authorized Page from an internal /p/slug URL, create/search/read/update Pages or upload/replace/download Page attachments according to the user's Akasha permissions, or delete, restore, list recent, and list trashed personal Pages.
---

# Akasha

## 核心原则

通过随包 Python CLI 使用 Akasha。知识问答只查询已编译 Wiki；可以按用户提供或 Akasha 返回的准确站内 Page 地址读取当前用户有权限访问的 Page 原文。Page 搜索、读取、创建、更新以及 Page 附件上传、替换和下载遵循 API Key 所属用户在 Akasha 中已有的空间和页面权限；公共/共享空间只要该用户有编辑权限即可写入。页面写入走 Akasha 正常版本历史，写错可在页面中回滚，最终权限始终由 Akasha API 决定。

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

默认查询 API Key 可见的全部空间。只有用户明确限定空间且已提供可信 space ID 时，才增加一个或多个 --space-id。若用户想限定空间但不知道有哪些，先用下面的 `space list` 列出可见空间，让用户挑选，再用 `--space-id` 检索，不要猜测 space ID。

按以下语义使用结果：

- `answerMode` 为 `no_match` 时，明确说明当前知识范围没有足够依据，不要补写答案。
- `answer` 是已清除内部引用标记的回答正文。
- `citations` 只包含回答实际采用且有可核验原文的可信来源。
- `citationEvidence` 提供每个可信来源的核验摘录、原文范围和 quote hash；论证回答时优先使用这些摘录。
- `retrievedSources` 仅表示被召回的候选来源，不能当作回答已采用的论据。
- 保留 `warnings` 和 `completenessNotice` 中的重要限制，不要自行声称结果完整。

知识问答不调用 Page 搜索或个人 Page 原文接口，也不在本地拼接搜索结果。`page search` 和 `page get` 不能用于回答普通知识问题；需要查看可信论据的完整来源或读取指定共享 Page 时，使用下面的 `citation get`。

## 列出可见空间

当用户想按空间检索但不确定有哪些空间，或需要挑选 `query --space-id` 的目标时，执行：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py space list

返回每个可见空间的 `spaceId`、`name`、`slug` 和 `isPersonal`（是否为当前用户个人空间）。据此和用户确认目标空间，再用可信 `spaceId` 作为 `query --space-id` 或 Page 命令的 `--space-id`。这是只读列表，不用于创建、修改或删除空间本身。

## 读取有权限的 Page

当用户要求读取共享 Page、查看完整来源，或回答确实需要核对论据摘录之外的上下文时，使用用户提供或 Akasha 返回的准确站内 Page 地址；不要改写、补全或猜测地址：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py citation get <PAGE_URL>

命令接受准确的 `/p/<slug>` 站内地址，不要求该地址来自知识问答。服务端会按当前用户的空间与 Page ACL 检查权限，成功时返回 `pageId`、`spaceId`、`title`、`url`、完整 Markdown `content` 和 `updatedAt`。原始 Page 可能比已编译知识更新，若两者不一致，应明确说明依据来自当前 Page 原文。

如果需要编辑该 Page，仍需先获得可信 page ID，并确保用户明确要求修改。`citation get` 返回 403 时立即停止，不要改用搜索、其他账号或猜测的 Page ID 绕过。

## 查找和读取待编辑的 Page

仅在用户明确要求编辑 Page 时，才可搜索原文。默认搜索个人空间：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py page search "关键词" --limit 10

若用户要编辑公共/共享空间，必须先用 `space list` 或用户提供的可信 space ID 确认目标空间，再指定：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py page search "关键词" --space-id <SPACE_ID> --limit 10

根据 title 和 excerpt 选择目标。若多个结果都可能匹配，先让用户确认，不要猜测。取得可信 page ID 后读取完整原文：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py page get <PAGE_ID>

只能读取 API 返回允许访问的 Page。遇到 403 时立即停止；不要用知识查询结果代替完整原文，也不要尝试其他账号或猜测 Page ID。

## 创建 Page

用户明确要求创建 Page 时，将确认后的 UTF-8 内容放入工作文件，然后执行：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py page create \
      --title "标题" \
      --content-file <CONTENT_FILE>

默认创建到个人空间。需要创建到公共/共享空间时，必须使用用户提供或 `space list` 返回的可信 `spaceId`：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py page create \
      --space-id <SPACE_ID> \
      --title "标题" \
      --content-file <CONTENT_FILE>

需要创建子 Page 时增加 --parent-page-id。是否允许创建由 Akasha 服务端权限决定。

## 更新 Page

必须有可信 page ID 和用户明确要求的修改。需要改写既有内容时，先用 `page get` 读取完整原文，只修改指定部分，并保留用户未要求修改的内容。

- 仅修改标题：只传 --title。
- 增加内容：传 --content-file，并选择 --operation append 或 prepend。
- 精准改写：把修改后的完整原文写入 UTF-8 工作文件，使用 replace。
- 完整覆盖：仅当已读取 Page 的完整原文，或用户提供完整替换内容并明确要求覆盖时使用 replace。

执行：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py page update <PAGE_ID> \
      --content-file <CONTENT_FILE> \
      --operation replace

不要发送 space ID，不要移动 Page，不要推断缺失的原文。公共/共享空间 Page 只有在 API Key 所属用户具备编辑权限时才会成功；否则服务端返回 403。

## 上传、替换和下载 Page 附件

支持常规 Page 附件。图片会生成可直接渲染的 Markdown 图片语法，PDF、DOCX、ZIP 等普通文件会生成可下载的 Markdown 链接；具体文件大小和类型限制由服务端决定。仅当用户明确要求把本地文件放进某个 Page 时，才执行上传；上传不会自动修改 Page 正文。

已有 Page 时，先取得可信 `pageId`，再执行：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py page attachment upload <PAGE_ID> \
      --file <FILE>

上传结果包含 `attachmentId`、受 ACL 保护的 `url` 和可直接插入正文的 `markdown` 字段。图片示例：

    ![diagram.png](/api/files/<attachment-id>/diagram.png)

普通文件示例：

    [guide.pdf](/api/files/<attachment-id>/guide.pdf)

把返回的 `markdown` 原样放入 Markdown 内容文件，再使用 `page update` 提交。不要猜测或手写附件 URL。

新建带附件的 Page 时，先创建 Page，再用返回的 `pageId` 上传文件，最后用 `page update` 把返回的 `markdown` 插入指定位置；不要尝试在没有 `pageId` 时上传。

替换已有附件时，使用原附件的 `attachmentId`：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py page attachment replace \
      <PAGE_ID> <ATTACHMENT_ID> \
      --file <NEW_FILE>

替换要求新旧文件使用相同扩展名。服务端会复用原附件 ID，Skill 会保留原文件名，因此原正文中的 Markdown 地址无需修改；成功结果中的 `replaced` 为 `true`。不要把普通 `upload` 当作替换操作，也不要猜测 `attachmentId`。

下载已授权附件时执行：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py page attachment download <ATTACHMENT_ID> \
      --output <OUTPUT_FILE>

下载命令会先读取附件元数据，再使用当前 API Key 下载文件并写入本地路径。`attachmentId` 必须来自 Akasha API 或之前的上传结果；遇到 403/404 时停止，不要改用其他页面或猜测文件名。

附件上传和下载只处理附件本身；不要把 Base64 内容塞进 Markdown，也不要让服务端抓取任意外部 URL。

## 删除和恢复个人空间 Page

仅在用户明确要求删除个人 Page 时执行；删除只做软删除（移入回收站），可恢复：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py page delete <PAGE_ID>

脚本会先读取该 Page 确认属于个人空间，再软删除；目标不在个人空间时按 403 停止，不删除共享空间 Page。绝不做永久删除，也不要尝试其他删除接口或参数绕过。

从回收站恢复：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py page restore <PAGE_ID>

需要先知道已删除 Page 的 ID 时，用下面的 `page trash` 列出回收站。恢复同样只针对个人空间 Page。

## 查看个人空间最近 Page 与回收站

用户想知道自己最近在个人空间写了什么、但没有明确关键词时，用最近列表代替关键词搜索：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py page recent --limit 20

列出回收站中可恢复的个人 Page：

    python3 <AKASHA_SKILL_DIR>/scripts/akasha.py page trash --limit 20

两者都只返回个人空间的 `pageId`、`title`、`updatedAt` 和 `deletedAt`，用于定位；取得可信 page ID 后再用 `page get` 读原文、`page update` 修改、`page restore` 恢复。两者都不接受 space ID，脚本从 API 的 personalSpaceId 锁定个人空间。结果多时用 --limit 或返回的 nextCursor 翻页。

## 常见错误

| 错误 | 正确处理 |
| --- | --- |
| 把 `retrievedSources` 当作回答论据 | 只使用 `citations` 和对应的 `citationEvidence` |
| 拼接或猜测 Page 地址 | 使用用户提供或 Akasha 返回的准确 `/p/<slug>` 地址 |
| 每次 query 后读取所有完整 Page | 仅在用户要求或确需更多上下文时调用 `citation get` |
| 绕过权限写公共空间 Page | 只使用 `page get/search/create/update`，由服务端按 API Key 所属用户的空间和 Page 权限校验 |
| 手写 `/api/files/...` 附件地址 | 只使用 `page attachment upload` 或 `replace` 返回的 `markdown` 字段 |
| 未绑定 Page 直接上传附件 | 先创建或读取目标 Page，使用可信 `pageId` |

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

遇到 403 时停止，不要改用其他接口、账号或路径绕过。普通用户 API Key 可通过 `citation get` 只读访问当前用户有 Page ACL 的共享 Page，不要求地址来自知识问答；Page 原文搜索以及 Page 创建/更新按 API Key 所属用户在目标空间和目标 Page 上的真实权限执行。

个人 Page 支持软删除和恢复，但不提供永久删除、跨空间移动或 ACL 修改，也不要建议用户用脚本直接调用这些接口。

创建或更新成功后，告诉用户需要等待 Wiki 编译；在编译完成前，query 可能暂时查不到新内容。没有编译状态接口时不要盲目轮询。

## API 参考

仅在排查接口契约、响应字段或退出码时读取 references/api.md。常规使用直接运行 scripts/akasha.py，不要重新实现 HTTP 请求。
