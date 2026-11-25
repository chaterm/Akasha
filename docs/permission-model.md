# 权限模型

本文描述 Akasha 的访问控制模型：有哪些凭证、每种凭证对应什么身份、身份如何落到空间和页面上。只描述当前实现。

---

## 判定链

一次请求依次经过七层，任一层不通过即拒绝：

```
凭证 → 凭证适用范围 → 身份 → 端点白名单 → 空间范围 → 空间角色 → 页面限制
```

- **凭证**：请求携带的身份证明
- **凭证适用范围**：该凭证是否被当前接口接受。个人密钥只对 `/mcp` 有效，MCP 附件令牌只对两个附件接口有效
- **身份**：凭证解析出的主体。真实用户，或 Agent 密钥单独使用时该密钥的 agent 用户行
- **端点白名单**：带 Agent 密钥时，该接口是否对 Agent 密钥开放（读写均可开放）
- **空间范围**：Agent 密钥的绑定集合。单独使用时就是该身份的全部空间关系；叠在用户凭证上时，普通接口与本人空间关系取**交集**，知识查询接口取**并集**
- **空间角色**：在某个空间内的角色，决定该空间的基础能力
- **页面限制**：单个页面的额外收紧，可覆盖空间角色

## 凭证

| 凭证 | 作用 | 位置 | 适用范围 |
| --- | --- | --- | --- |
| 会话凭证 | 身份：真实用户 | Cookie | 全部 HTTP 接口 |
| SSO 令牌 | 身份：真实用户（含数字员工） | `x-token` | 全部 HTTP 接口 |
| 个人 API 密钥 | 身份：真实用户，过期时间可选 | `Authorization: Bearer` | **仅 `/mcp`** |
| MCP 附件令牌 | 身份：真实用户 | `Authorization: Bearer` | 仅两个附件接口 |
| Agent API 密钥 | 身份：agent 用户行（单独使用时）；或只提供空间范围（叠在用户凭证上时） | `x-akasha-public-key` | 白名单接口 |

### 个人 API 密钥

只能认证 `/mcp`，在其他任何 HTTP 接口都返回 401（`Personal API keys are only valid for the MCP endpoint`）。

- 过期时间可选，不设则永不过期
- 不可轮换。`api_keys_agent_fields_check` 约束要求 `key_type = 'personal'` 的行 `credential_version IS NULL`，轮换机制只对 Agent 密钥存在
- 失效手段只有撤销（软删密钥行）。密钥创建者本人、工作区所有者和管理员均可撤销

### MCP 附件令牌

MCP 的 `upload_attachment` 和 `download_attachment` 工具在校验完权限后签发，供 Agent 在本地直接发 HTTP 请求传输文件字节。

- 10 分钟有效
- 上传令牌绑定单个页面（替换附件时还绑定该附件 ID），下载令牌绑定单个附件
- 只在声明了 `MCP_COMPANION_ALLOWED` 的接口上被识别，即 `POST /api/files/upload` 和 `GET /api/files/:fileId/:fileName`；其他接口上落到常规 Bearer 校验并被拒绝
- 范围不符返回 403，接口内仍按令牌解析出的用户重新执行空间角色与页面限制判定
- 不可与 Agent 密钥同时使用

### Agent API 密钥

不过期、可轮换，轮换后旧密钥立即失效。只在 `x-akasha-public-key` 头被接受，放进 `Authorization` 头返回 401（`Agent API keys are not accepted in the Authorization header`）。

有两种用法，由请求里**有没有其他身份凭证**决定：

**单独使用（`x-akasha-public-key`，无会话 Cookie、无 `x-token`、无 `Authorization`）**

机器人语义：请求背后没有人，身份就是该密钥的 agent 用户行。这个身份在绑定空间里是写入者，因此在白名单接口内可读可写。能做什么由这个身份自己的空间角色决定，和任何真实用户无关。页面的 `creator_id`、`last_updated_by_id` 记的就是这个 agent 用户行。

**叠在用户凭证上（会话／SSO 令牌 + `x-akasha-public-key`）**

密钥不构成身份，只收窄范围。身份仍是真实用户，能做什么完全由本人的权限决定；密钥决定的是在哪些空间内、通过哪些接口。

两种用法下密钥都不携带页面级权限，只携带空间范围。

### 凭证组合

| 组合 | 结果 |
| --- | --- |
| 仅会话／SSO 令牌 | 真实用户身份 |
| 会话／SSO 令牌 + Agent 密钥 | 真实用户身份 + 空间范围 |
| 仅 Agent 密钥 | agent 用户行身份，绑定空间内写入者 |
| 仅个人密钥（HTTP 接口） | **401**，个人密钥只对 `/mcp` 有效 |
| 仅 MCP 附件令牌（两个附件接口） | 真实用户身份，收窄到令牌范围 |
| MCP 附件令牌 + Agent 密钥 | **401** |
| 个人密钥 + SSO 令牌 | **401**（`Unsupported credential combination`） |

身份槽（会话／Bearer／`x-token`）与范围槽（`x-akasha-public-key`）互不冲突，但身份槽内部互斥：`x-token` 和 `Authorization` 同时出现直接拒绝。身份槽为空时范围槽自己升格成身份槽，这就是单独使用。

少数外部集成接口要求必须带 Agent 密钥（见下文端点表的 ※ 标记），缺少时返回 401。另有接口要求 Agent 密钥**必须**配一个真实用户凭证（† 标记），单独使用时返回 403。

## 身份

身份是真实用户，或 Agent 密钥单独使用时该密钥的 agent 用户行。两者都有工作区角色：所有者、管理员、成员。agent 用户行恒为成员。

- 工作区所有者和管理员在空间层面被直接视为空间管理员，不需要空间成员关系
- 空间关系来自两个来源：直接成员，以及通过用户组间接成为成员；取其中最高角色
- 所有者跳过全部页面限制检查

SSO 令牌有两种验证路径：普通用户令牌，以及带 `x-iself-agent: 1` 的数字员工令牌。两者都按邮箱落到一个**普通用户行**上，解析出的身份没有区别。

### Agent 用户行

每把 Agent 密钥在创建时会生成一个 `userType = 'agent'` 的用户行，邮箱形如 `agent-user-<id>@akasha.net`，工作区角色为成员。绑定空间时会同步写入该行的空间成员关系，**角色为写入者**。

这个用户行的用途：

- 密钥单独使用时作为请求身份，它的空间成员关系就是判定依据
- 使用统计中的操作者归因（`actor_id`）
- `api_keys.agent_user_id` 外键和密钥重名校验

密钥叠在用户凭证上时，这个用户行不参与权限判定，判定主体是真实用户。

两张表记录同一组绑定，在同一个事务里一起改写：`api_key_spaces` 是权威来源，范围判定读它；`space_members` 是同步出来的副本，供单独使用时的空间角色判定。

## 端点白名单

带 Agent 密钥的请求只能调用显式声明了 `@AgentCallable` 的接口，其余一律 403（`Agent API key cannot call this endpoint`）。守卫只检查声明是否存在，**不校验声明的能力名与接口实际行为是否一致**。

当前开放的接口：

| 接口 | 声明的能力 |
| --- | --- |
| `POST /api/pages/info` | `page.read` |
| `POST /api/pages/search` | `page.read` |
| `POST /api/pages/sidebar-pages` | `page.tree.read` |
| `POST /api/pages/permission-info` | `page.permission.read` |
| `POST /api/pages/permissions` | `page.permission.read` |
| `POST /api/pages/create` | `page.create` |
| `POST /api/pages/update` | `page.content.update` |
| `POST /api/files/upload` | `attachment.upload` |
| `GET /api/files/:fileId/:fileName` | `attachment.read` |
| `POST /api/files/info` | `attachment.read` |
| `POST /api/pages/attachments` | `attachment.read` |
| `POST /api/spaces/` | `space.read` |
| `POST /api/spaces/info` | `space.read` |
| `POST /api/spaces/members` | `space.member.read` |
| `POST /api/groups/members` | `group.member.read` |
| `POST /api/llm-wiki/query` | `knowledge.query`（robot 模式必须带，见下） |
| `POST /api/llm-wiki/citation-page` | `page.read` |
| `POST /api/iself/space` | `space.read` |
| `POST /api/iself/llm-wiki/query` ※ | `knowledge.query` |
| `POST /api/iself/space-api-key/update` ※† | `space.binding.update` |

※ = 必须携带 Agent 密钥，缺少返回 401。† = 必须同时携带真实用户凭证，单独使用返回 403（`This endpoint requires a user credential alongside the Agent API key`）。改绑定要求发起人是每个目标空间的管理员，agent 身份达不到这个条件，否则密钥就能自己扩自己的范围。

两处额外收紧：

- `GET /api/files/:fileId/:fileName` 对 AI 对话附件（`ai_chat_id` 非空）拒绝 Agent 密钥，这类附件只有创建者本人能取
- `POST /api/groups/members` 不按空间收窄，而是要求**该组在某个绑定空间里有授权**：`space_members` 里有该组在绑定空间的成员行，或 `page_permissions` 里有该组的授权行且其 `page_access.space_id` 落在绑定空间内。两者都不满足返回 403（`Group has no grant in any space bound to the Agent API key`）。用户组是工作区级的，没有「组所在空间」可判定，所以判授权而不判归属

`POST /api/llm-wiki/query` 的 `type` 决定模式，默认值跟用法走：密钥单独使用时默认 `robot`，其余默认 `user`。

| 模式 | 要求 |
| --- | --- |
| `robot` | 必须带 Agent 密钥，缺少返回 401（`Robot queries require an Agent API key in the x-akasha-public-key header`） |
| `user` | 不得带 Agent 密钥，带了返回 400 |

`robot` 模式与 `/api/iself/llm-wiki/query` 等价。两个知识查询接口都接受密钥单独使用，此时检索范围的两个来源合成一个——身份自己的可读空间就是绑定空间，并集退化为绑定集合本身。

**MCP（`/mcp`）不接受 Agent 密钥**，连接时即返回 401。MCP 只支持个人密钥和 SSO 令牌。

白名单之外的接口（含 `pages/delete`、`pages/restore`、`pages/move-to-space`、`pages/move`、`pages/duplicate`、页面权限管理、评论等）带 Agent 密钥一律 403。

白名单对两种用法是同一份，区别只在 † 标记的接口。

> 带 Agent 密钥是**整个请求**降到白名单内，不是「只有 Agent 相关逻辑受限」。同一个人用会话能调 `pages/delete`，加上 Agent 密钥后同一请求会 403。客户端若把密钥固定配在所有请求上，会连本人原有的能力一起失去；要混用必须按接口决定是否发送该头。

## 空间范围

每把 Agent 密钥绑定一组空间。该集合如何参与判定，取决于**密钥是单独使用还是叠在用户凭证上**，以及**接口类型**。

### 单独使用：绑定集合就是全部范围

身份是 agent 用户行，它的空间成员关系与绑定集合同步，所以范围判定和空间角色判定指向同一组空间，不存在交集或并集的问题：

| 空间状态 | 结果 |
| --- | --- |
| 已绑定 | 可访问，写入者权限 |
| 未绑定 | 拒绝 |

受限页面仍需单独授权给这个 agent 用户行，密钥不绕过页面限制。

### 叠在用户凭证上：普通接口取交集

页面、空间、附件等接口，有效范围是**绑定集合与本人空间关系的交集**：

| 空间状态 | 结果 |
| --- | --- |
| 已绑定 + 本人是成员 | 可访问 |
| 已绑定 + 本人不是成员 | 拒绝 |
| 未绑定 + 本人是成员 | 拒绝 |
| 两者都无 | 拒绝 |

密钥只收窄范围。本人在范围内的权限与不带密钥时完全一致——读、写、`canEdit` 全由本人的空间角色和页面授权决定。

### 叠在用户凭证上：知识查询接口取并集

`llm-wiki/query` 和 `iself/llm-wiki/query` 不取交集。密钥的绑定空间在检索时**追加**到本人的可读范围上：

| 空间状态 | 结果 |
| --- | --- |
| 已绑定 + 本人是成员 | 可检索 |
| 已绑定 + 本人不是成员 | **可检索**（密钥扩展） |
| 未绑定 + 本人是成员 | 可检索（本人权限） |
| 两者都无 | 检索不到 |

绑定空间跳过空间角色检查，但**不跳过页面限制**：该空间内的受限页面仍需本人有自己的授权。所以密钥扩展的是空间层的触达，不是页面层的授权。

这两个接口不预检「请求的空间是否都在密钥范围内」：范围外但本人能读的空间照常可用，两者都不满足的空间检索为空。

### 两种用法共通

- 个人空间和非个人空间都可被绑定。绑定个人空间只是把 agent 用户行加成该空间的写入者，主人自己的成员关系不变（恒为管理员）
- 绑定通过 `POST /api/iself/space-api-key/update` 修改，发起人必须是每个目标空间的管理员（或工作区所有者），且必须带真实用户凭证
- 列表类接口按该范围过滤

不带 Agent 密钥的请求没有空间范围概念，直接使用本人的空间关系。

## 空间角色

角色构成一条链，能力逐级包含：

```
无 < 阅读者 < 写入者 < 空间管理员
```

| 角色 | 空间设置 | 成员管理 | 页面 | 分享 |
| --- | --- | --- | --- | --- |
| 空间管理员 | 管理 | 管理 | 管理 | 管理 |
| 写入者 | 只读 | 只读 | 管理 | 管理 |
| 阅读者 | 只读 | 只读 | 只读 | 只读 |

空间有「公开／私有」可见性字段，但当前没有任何判定读取它，也没有「加入空间」的入口。空间可见性完全由成员关系决定。

## 页面限制

页面默认继承空间角色。页面也可以单独设限，且沿页面层级向下继承：

- 判断一个受限页面是否可见，要看从它到根的整条路径上**每一个设了限制的层级**是否都单独授权过。漏掉任何一层即不可见。
- 是否可编辑，由**最近**的那个受限层级上的最高角色决定，不是整条路径取交。
- 授权可以直接授予个人，也可以授予用户组。
- 工作区所有者跳过全部页面检查。

Agent 密钥叠在用户凭证上时，这一层的判定主体仍是本人，与不带密钥时相同。受限页面本人有编辑授权即可写入，密钥不额外收紧。接口返回的 `canEdit` 描述的是本人的真实编辑权限。

密钥单独使用时判定主体是 agent 用户行，规则不变：绑定空间里的受限页面要让它读写，得把授权直接给到这个用户行（或它所在的用户组）。绑定空间只给到空间层的写入者角色，不自动穿透页面限制。

带 MCP 附件令牌时同理：判定主体是令牌 `sub` 指向的用户，签发时校验过的权限在请求时重新校验一遍。

## 使用统计归因

`analytics_events` 的 `agent_op` 事件按通道区分凭证：

| 通道 | 凭证类型 | `op` |
| --- | --- | --- |
| `api` | 恒为 `agent` | 接口声明的能力名 |
| `mcp` | `personal` 或 `sso` | `mcp:<工具名>` |

`api` 通道只记录带 Agent 密钥的请求，而带密钥必然命中声明了能力名的白名单接口，所以该通道的 `op` 恒为能力名之一。能力名缺失意味着守卫约束被绕过，此时记一条告警并跳过，不编造 op。

`agent_op.delegated_user_id` 记请求身份：叠在用户凭证上时是那个真实用户，单独使用时就是 agent 用户行自己，与 `agent_user_id` 相同。

历史数据中存在 `api` 通道 + `personal` 凭证类型的记录，筛选器保留这个取值组合以便查阅。

## 已知不一致

**能力名不参与判定。** 守卫只检查 `@AgentCallable` 声明是否存在，不校验能力名与接口实际行为是否一致。能力名只用于使用统计。
