<div align="center">
  <a href="./README.md">English</a> / 中文
</div>
<br>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3-blue?style=for-the-badge" alt="License"></a>
  <img src="https://img.shields.io/badge/Self--Hosted-First-0086FF?style=for-the-badge&logo=docker&logoColor=white" alt="Self-Hosted">
  <img src="https://img.shields.io/badge/Agent--Native-MCP-6E56CF?style=for-the-badge" alt="Agent Native">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/AI-Native-blue?style=flat" alt="AI Native">
  <img src="https://img.shields.io/badge/PostgreSQL-pgvector-336791?style=flat&logo=postgresql&logoColor=white" alt="pgvector">
  <img src="https://img.shields.io/badge/Node.js-22+-5FA04E?style=flat&logo=nodedotjs&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/pnpm-workspace-F69220?style=flat&logo=pnpm&logoColor=white" alt="pnpm">
</p>

## 目录

- [简介](#简介)
  - [为什么选择 Akasha](#为什么选择-akasha)
  - [核心特性](#核心特性)
  - [核心概念](#核心概念)
    - [三层记忆](#三层记忆)
    - [上下文图谱](#上下文图谱)
    - [活的知识](#活的知识)
    - [认知复利](#认知复利)
  - [设计哲学](#设计哲学)
  - [技术栈](#技术栈)
  - [开发指南](#开发指南)
    - [环境要求](#环境要求)
    - [安装](#安装)
    - [启动依赖服务](#启动依赖服务)
    - [本地开发](#本地开发)
    - [构建](#构建)
    - [故障排查](#故障排查)
  - [Agent Skill](#agent-skill)
  - [私有化部署优先](#私有化部署优先)
  - [致谢](#致谢)
  - [贡献者](#贡献者)

# 简介

Akasha 是一个同时面向人类和 Agent 的企业记忆系统，致力于将散落在个人、团队和业务中的经验，转化为可沉淀、可复用、可持续进化的组织知识。

它主要解决三个问题：

1. **让碎片信息变成知识。** 将文档、会议、对话、邮件等多渠道信息统一沉淀，减少知识流失。

2. **让知识持续保持准确。** 通过 Dream Cycle 自动整理、验证和更新知识，并逐步构建知识图谱。

3. **让 Agent 掌握领域经验。** 通过 Skills 和渐进式披露，为 Agent 提供领域知识和操作经验。

> "没有记忆，智能只是算法；有了记忆，智能才成为一个物种。"

![Preview image](resources/hero1.webp)

![Preview image](resources/hero2.webp)

## 为什么选择 Akasha

Akasha 不是一个更好的 wiki，而是一套记忆系统。知识库在等待被查询，记忆则主动参与。

- 🧠 **记忆，而非存储** — 主动记住、关联并呈现上下文，而不只是把文档归档

- 🌱 **知识自然涌现** — 从真实工作流中生长出来，而不是靠"记得更新 wiki"的自上而下要求

- 🔄 **自我维护** — Dream Cycle 持续验证并刷新知识，避免答案腐化

- 🤖 **同时服务 Agent** — 人和 Agent 都是一等公民，共用同一套权限模型

- 🔍 **来源可追溯** — 每条记忆都带有出处、时效性和置信度

- 🏠 **私有化部署** — 数据、记忆和推理都归你自己

## 核心特性

- 🗂️ **统一沉淀**

  文档、会议、对话、邮件汇聚到一个系统，而不是散落在十几个工具里，知识不再在流转中丢失。

  实体与关系抽取在写入时同步完成，权限随内容一起流动。

- 🌙 **Dream Cycle**

  后台自动整理、验证和更新知识，并在这个过程中逐步构建知识图谱。

  过期检测、置信度评分和矛盾发现，避免答案悄悄失效。

- ⚡ **面向 Agent 的 Skills**

  把领域知识和操作经验封装成可加载、可复用的 Skills。

  渐进式披露让上下文窗口保持精简：Agent 只在任务需要时才拉取细节。

- 🕸️ **上下文图谱**

  把人、决策、事件、服务和承诺连成一张活的地图，记录组织的含义，而不只是它存了什么。

  图谱遍历能回答搜索框回答不了的问题，比如某个决策为什么这么定、当时谁持反对意见。

- 📝 **协作工作区**

  实时协同编辑、空间与项目、Markdown、富文本、版本历史、评论以及 RBAC 权限。

- 🔌 **兼容 MCP 的接口**

  记忆、图谱和检索接口通过 MCP 暴露，带完整审计轨迹，Agent 在权限边界内读写记忆。

## 核心概念

### 三层记忆

| 层次 | 回答的问题 | 承载的内容 |
|------|-----------|-----------|
| 事实记忆 | 发生了什么 | 带出处、权限、时效性和关联关系的产出物 |
| 交互记忆 | 为什么重要 | 决策、分歧、取舍、承诺、尚未验证的假设 |
| 行动记忆 | 接下来做什么 | 工作流、护栏，以及过往执行的结果 |

事实记忆不止是 RAG，它是一套有稳定结构的语义文件系统。交互记忆捕捉的是那些几乎不会落到任何文档里的组织推理过程：会议记录不够，摘要也不够。行动记忆真正参与组织运转，其中**"什么都不做"也是一等公民的动作** — 一个无法有意识地保持不动的系统，也无法被信任去有意识地行动。

### 上下文图谱

推理层，事实在这里变成一个关于公司的模型：

```text
客户通话 → 商机 → 产品缺口 → 工程取舍 → 路线图决策 → 战略
服务 → 团队 → 代码库 → 部署 → 故障 → SOP → 负责人 → 技能
```

元认知也发生在这一层：判断证据何时不足、上下文何时过期、团队之间何时持有冲突假设、哪个承诺没有负责人，以及 Agent 何时需要求助。

### 活的知识

知识会诞生、被验证、被使用、被强化、被质疑、过期，最后退役。Dream Cycle 管理这整个生命周期 — 时效与过期检测、置信度评分、矛盾发现、语义版本差异、废弃提醒，以及当沉睡的知识重新变得相关时把它重新激活。

### 认知复利

一个 Agent 学到的东西，以零边际学习成本传播给所有 Agent。每一次执行都产生训练信号，模式从积累的行动记忆中浮现，Skills 通过反馈循环不断改进。组织变得更聪明，而不需要任何人专门去"做知识管理"。

## 设计哲学

1. **记忆，而非存储。** 知识库在等待，记忆在参与。
2. **涌现，而非强加。** 如果维护系统和做事本身是两件事，这个系统就会死掉。
3. **参与，而非检索。** 目标是零检索：上下文一变，记忆自己出现。
4. **判断，而非只会行动。** 知道何时**不该**动手，和知道如何动手一样重要。
5. **来源，而非只有内容。** 在企业环境里，一个看似合理但无从追溯的答案是危险的。
6. **复利，而非堆积。** 每次执行都是训练，每次交互都是一次贝叶斯更新。
7. **人负责意义。** AI 处理无限的"怎么做"，人来定义"为什么"。

## 技术栈

| 层次 | 选型 |
|------|------|
| 前端 | React、ProseMirror / TipTap |
| 后端 | NestJS、pnpm workspace monorepo（Nx） |
| 存储 | PostgreSQL 18 + pgvector、Redis |
| 知识 | 实体抽取、语义关系引擎、带时效与置信度加权的向量检索 |
| Agent | MCP 记忆接口、支持渐进式披露的 Skills、带护栏的执行框架 |

## 开发指南

### 环境要求

- [Node.js](https://nodejs.org/) 22+（推荐 LTS）
- [pnpm](https://pnpm.io/) 10.4.0（见 `package.json` 中的 `packageManager`）
- PostgreSQL 18，且已安装 [pgvector](https://github.com/pgvector/pgvector) 扩展
- Redis（本地安装或容器）

迁移脚本会自己执行 `CREATE EXTENSION IF NOT EXISTS vector`，不需要手动创建扩展。你需要保证的是这台 PostgreSQL 服务器**已经装了 pgvector**，否则该条迁移会失败。

### 安装

```bash
git clone https://github.com/jarvishappy/Akasha.git
cd Akasha
pnpm install
```

> 请使用 `pnpm`，不要用 `npm`。这是一个 pnpm workspace monorepo。

复制环境变量文件并设置本地密钥：

```bash
cp .env.example .env
openssl rand -hex 32   # 用输出结果作为 APP_SECRET
```

其余默认值已经适配仓库内置的 PostgreSQL Docker Compose 服务，以及本地 `6379` 端口的 Redis。

### 启动依赖服务

**PostgreSQL — 方式 A，Docker（推荐）。** `pgvector/pgvector` 镜像自带扩展，Compose 也已经预置了 `akasha` 角色和数据库：

```bash
docker compose up -d db
```

**PostgreSQL — 方式 B，本机安装（macOS / Homebrew）。** `postgresql@18` 是 keg-only 的，可执行文件不在 `PATH` 里，所以下面的命令都通过 `$PGB` 调用：

```bash
brew install postgresql@18 pgvector
export PGB=/opt/homebrew/opt/postgresql@18/bin

# 初始化数据目录（只需一次）并启动服务
$PGB/initdb --locale=C -E UTF-8 -D /opt/homebrew/var/postgresql@18
mkdir -p /opt/homebrew/var/log
$PGB/pg_ctl -D /opt/homebrew/var/postgresql@18 \
  -l /opt/homebrew/var/log/postgresql@18.log start

# 创建 DATABASE_URL 对应的角色和数据库
$PGB/psql -d postgres -c \
  "CREATE ROLE akasha LOGIN PASSWORD 'STRONG_DB_PASSWORD' SUPERUSER;"
$PGB/createdb -O akasha akasha

# 确认服务器能看到 pgvector
$PGB/psql -d akasha -c "CREATE EXTENSION IF NOT EXISTS vector;" \
  -c "SELECT extname, extversion FROM pg_extension;"
```

**Redis：**

```bash
brew services start redis                    # 作为后台托管服务
redis-server --port 6379 --daemonize yes     # 或作为普通进程
docker run -d --name akasha-redis -p 6379:6379 redis:7   # 或用容器

redis-cli ping   # -> PONG
```

### 本地开发

先执行迁移，再同时启动前后端：

```bash
pnpm --filter ./apps/server run migration:latest
pnpm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。前端开发服务器跑在 3000 端口，并把 `/api`、`/socket.io`、`/collab` 代理到 `BACKEND_URL`。

验证后端及其依赖：

```bash
curl http://127.0.0.1:8080/api/health
```

一切正常时，两个依赖都会报 `up`：

```json
{
  "status": "ok",
  "info": { "database": { "status": "up" }, "redis": { "status": "up" } },
  "error": {},
  "details": { "database": { "status": "up" }, "redis": { "status": "up" } }
}
```

重启机器后，Docker Compose 和 `brew services` 会自己恢复。用 `pg_ctl` 启动的本机 PostgreSQL，或用 `--daemonize` 启动的 Redis 不会 — 在 `pnpm run dev` 之前需要手动拉起来。

### 构建

```bash
pnpm run build           # 全部包
pnpm run client:build    # 仅前端
pnpm run server:build    # 仅后端
```

### 故障排查

**通过 Homebrew 安装 `postgresql@18` 后报 `initdb: error: file ".../postgres.bki" does not exist`。** Homebrew 会先装好 keg，再在独立的 post-install 步骤里创建 prefix 软链。在较旧的 Homebrew 版本上这一步可能中断（`unknown install step: link_dir`，或 `undefined method 'stop_timeout'`），导致 keg 的 `share/postgresql` 没有被链接，而是留在 `share/postgresql@18` — 而后者正是 `pg_config` 指向的位置。先升级 Homebrew 本身，再重装让这一步跑完：

```bash
brew update
brew reinstall postgresql@18
```

**AI 功能没有反应。** AI 和知识编译相关功能由 `AI_DRIVER` 控制。未设置时，`apps/server/src/integrations/environment/environment.validation.ts` 中的校验会跳过所有 AI 相关变量，这些子系统保持空转；wiki、编辑器和实时协作不受影响。要启用的话，设置 `AI_DRIVER` 以及对应 provider 的凭证。

**`DATABASE_URL` 指向了不存在的数据库。** `.env` 里的库名必须和你实际创建的数据库一致。从上游项目继承下来的旧 `.env` 可能还写着 `docmost` 而不是 `akasha`；要么改连接串并重新执行迁移，要么按已配置的名字建库。

## Agent Skill

Akasha Agent Skill 可让编码 Agent 查询带可信论据的 Wiki 知识、按站内地址读取有权限访问的共享 Page，以及在个人空间中创建、读取、更新、删除和恢复 Page。

```bash
npx skills add chaterm/Akasha --skill akasha --agent codex --global --yes
```

安装完成后请新建一个会话，以便 Agent 发现并加载 Skill。去掉 `--agent codex` 可以在交互提示中选择其他目标 Agent。首次使用时，在自己的本地终端执行 Agent 提供的认证命令，并在隐藏提示中输入 API Key — 不要把密钥放进命令参数、源代码、日志或聊天消息里。

详细说明见 [`skills/README.md`](./skills/README.md)，完整行为和权限约束见 [`skills/akasha/SKILL.md`](./skills/akasha/SKILL.md)。

## 私有化部署优先

Akasha 面向企业私有化部署、私有云、本地机房、离网环境和内部 AI 系统设计。组织完全拥有自己的数据、记忆、推理、工作流和组织智能。

记忆不是租来的东西。你租不到一套神经系统。

## 致谢

Akasha 建立在优秀的开源项目之上，在此致谢：

- **[Docmost](https://github.com/docmost/docmost)** — 工作区与编辑器层所基于的协作 wiki 基础。

## 贡献者

感谢每一位贡献者！
更多信息请参阅<a href="./CONTRIBUTING_zh.md">贡献指南</a>。

<div align=center style="margin-top: 30px;">
  <a href="https://github.com/jarvishappy/Akasha/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=jarvishappy/Akasha&refresh=true" />
  </a>
</div>
