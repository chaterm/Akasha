# Akasha API 契约

## 目录

- 当前用户与 Skill 更新提示
- 可见空间与已编译 Wiki 查询
- 有权限的共享 Page 读取
- 个人 Page 搜索、读取、创建和更新
- 错误处理

所有请求均为 JSON POST，并携带：

    Authorization: Bearer <API_KEY>
    Content-Type: application/json
    X-Akasha-Skill-Version: 1.1.0

Akasha 服务的成功响应使用统一包装，Skill 会自动取出 `data`；下文描述的响应字段均指 `data` 内部字段：

    {
      "data": {"...": "..."},
      "success": true,
      "status": 200
    }

知识问答只能使用已编译 Wiki 接口。当前用户有 ACL 权限的共享 Page 可通过独立只读接口按站内地址获取，地址不要求来自知识问答；任意 Page 搜索、读取和写入仍仅限用户明确要求编辑的个人空间 Page。

## 当前用户

POST /api/users/me

请求体：

    {}

个人 Page 原文读写能力要求响应包含稳定字段：

    {
      "user": {"id": "user-1"},
      "workspace": {"id": "workspace-1"},
      "apiAccess": {
        "personalSpaceId": "space-personal",
        "policy": "ordinary-user"
      },
      "skillUpdateNotice": {
        "currentVersion": "1.0.0",
        "latestVersion": "1.1.0",
        "message": "当前 Skill 版本较旧，建议提示用户升级。",
        "upgradeUrl": "https://example.com/akasha-skill"
      }
    }

缺少 apiAccess.personalSpaceId 时可以继续查询知识，但必须禁用个人 Page 搜索、读取和写入。
`skillUpdateNotice` 仅在服务端配置了更新版本且请求版本较旧时出现。CLI 会把它附加到本次命令的最终 JSON；完成用户当前请求后提示升级，不要自行安装。

## 可见空间

POST /api/spaces

首次请求：

    {"limit": 100}

后续分页：

    {"limit": 100, "cursor": "<nextCursor>"}

持续请求到 meta.hasNextPage 为 false。只能把返回的可见空间 ID 用作默认查询范围。

## 已编译 Wiki 查询

POST /api/llm-wiki/query

    {
      "query": "用户问题",
      "spaceIds": ["space-1", "space-2"]
    }

可选传入 chatContext。默认保留 `answer`、`answerMode`、可信 `citations`、`citationEvidence`、`retrievedSources`、`warnings` 和 `completenessNotice`，不默认输出 snippets 或内部检索诊断。

`citations` 只包含回答实际采用且由核验原文支持的来源；`citationEvidence` 带有摘录、原文范围和 quote hash；`retrievedSources` 只是候选召回记录，不能替代可信论据。

这是 Skill 唯一的知识问答入口。服务端仍需过滤不可读空间和不可读来源。

## 读取有权限的共享 Page

POST /api/llm-wiki/citation-page

    {
      "pageUrl": "/p/page-slug"
    }

`pageUrl` 可由用户提供，也可使用知识问答 `citations[].url` 返回的地址；接口仅接受单段 `/p/<slug>` 站内地址，不要求地址来自某次知识问答。服务端按当前 workspace 定位未删除 Page，并使用当前用户的空间权限和 Page ACL 校验读取能力。

成功响应：

    {
      "pageId": "page-1",
      "spaceId": "space-1",
      "title": "Kafka Guide",
      "url": "/p/page-slug",
      "content": "# Kafka Guide\n\n完整 Markdown 原文",
      "updatedAt": "2026-07-29T00:00:00.000Z"
    }

接口只读。400 表示地址不是合法站内 Page 地址，404 表示 Page 不存在、已删除或不属于当前 workspace，403 表示当前用户无权读取；任何一种失败都不能回退到其他 Page 原文接口。

## 搜索待编辑的个人 Page

POST /api/pages/search

    {
      "query": "雷雨",
      "limit": 10
    }

请求不接受 spaceId。服务端只能从 API Key 上下文读取 personalSpaceId，并只在当前 workspace 的个人空间中搜索未删除 Page。响应只返回定位所需字段：

    {
      "items": [
        {
          "pageId": "page-1",
          "title": "雷雨",
          "excerpt": "雷声越过屋檐",
          "updatedAt": "2026-07-22T00:00:00.000Z"
        }
      ],
      "meta": {"count": 1, "limit": 10}
    }

## 读取待编辑的个人 Page

POST /api/pages/info

    {
      "pageId": "page-1",
      "format": "markdown"
    }

API Key 只能读取 personalSpaceId 对应空间的原文；共享空间必须返回 403。Skill 还必须校验响应 spaceId 与 personalSpaceId 一致。

## 创建个人空间 Page

POST /api/pages/create

    {
      "spaceId": "<apiAccess.personalSpaceId>",
      "title": "标题",
      "content": "Markdown 正文",
      "format": "markdown",
      "parentPageId": "可选"
    }

CLI 不接受用户提供 spaceId。API 必须拒绝向其他空间写入。

## 更新个人空间 Page

POST /api/pages/update

    {
      "pageId": "page-1",
      "title": "可选",
      "content": "可选",
      "format": "markdown",
      "operation": "replace"
    }

operation 支持 replace、append 和 prepend。不要发送 spaceId。精准改写既有内容时，应先读取个人 Page 的完整原文、保留未要求修改的部分，再以 replace 提交完整修改稿。API 必须根据 pageId 校验其属于当前用户个人空间。

## 错误处理

| 状态 | Skill 行为 |
| --- | --- |
| 401 | 提示 Key 无效或失效，退出码 3 |
| 403 | 停止操作，不尝试绕过，退出码 4 |
| 429、5xx、网络错误 | 返回不含 Key 的通用错误，退出码 5 |
| 缺少必要响应字段 | 返回 API 契约错误，退出码 6 |

Page 写入成功不代表已完成 Wiki 编译。没有编译状态接口时不要盲目轮询，应提示用户稍后查询。
