# 多空间知识编译容量与上线验收手册

## 目的

本手册用于一次提交最多 100 个空间时的上线前验收。调度事实以 PostgreSQL 的 Run、RunPage、RunImage 和 execution lease 为准；Redis 只承载共享队列。Diagnostics 中的 worker 数与容量来自 BullMQ `CLIENT LIST`，均为近似展示值，不能参与准入、限流或状态转换。

本仓库没有 server/app 的 Kubernetes、Helm 或生产 Compose manifest。下述“3 实例”必须在真实部署平台或外部部署仓库完成并留存证据；本手册不能替代部署变更。

## 基准配置

每个应用实例使用相同配置：

```text
KNOWLEDGE_SPACE_CONCURRENCY=10
KNOWLEDGE_IMAGE_CONCURRENCY=5
KNOWLEDGE_SPACE_SLICE_MAX_PAGES=5
KNOWLEDGE_SPACE_SLICE_MAX_MS=300000
KNOWLEDGE_SPACE_HEARTBEAT_MS=30000
KNOWLEDGE_SPACE_LEASE_TTL_MS=180000
DATABASE_MAX_POOL=25
```

空间与图片 Worker 必须同构声明：

```text
lockDuration=120000
stalledInterval=30000
maxStalledCount=2
```

`concurrency`、`lockDuration` 按 Worker 生效；`stalledInterval`、`maxStalledCount` 虽由每个 Worker 声明，但 stalled 扫描互斥后对同一物理队列整体生效。滚动发布期间不允许混用不同值。

默认 3 个实例时，空间容量估算为 `3 × 10 = 30`，图片容量估算为 `3 × 5 = 15`。增加实例会线性增加估算容量，不设置系统级 global concurrency。

## 数据库连接预算

每实例最低约束：

```text
DATABASE_MAX_POOL >= SPACE_CONCURRENCY + IMAGE_CONCURRENCY + 10
25 >= 10 + 5 + 10
```

上线前还必须核对 PostgreSQL 全局预算：

```text
应用实例数 × DATABASE_MAX_POOL
+ collaboration/maintenance/迁移等其他进程的连接池
<= max_connections - 管理保留连接
```

建议采集：

```sql
show max_connections;
show superuser_reserved_connections;

select application_name, state, count(*)
from pg_stat_activity
group by application_name, state
order by count(*) desc;
```

若无法满足总预算，不得仅提高 `DATABASE_MAX_POOL`；应先调整 PostgreSQL 容量、实例数或其他进程的池配置。

## 外部部署证据（上线硬门槛）

上线负责人必须填写并附到发布单：

| 项目                                  | 证据                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 部署平台/集群/namespace               | 待填写                                                                                                                            |
| workload 名称与配置版本               | 待填写                                                                                                                            |
| 应用副本数为 3                        | 待填写                                                                                                                            |
| 三实例 Worker env 同构                | 待填写                                                                                                                            |
| 三实例 `DATABASE_MAX_POOL=25`         | 待填写                                                                                                                            |
| PostgreSQL `max_connections` 与保留量 | 2026-08-03 线上只读采样：`max_connections=1000`、`reserved_connections=0`、`superuser_reserved_connections=3`，普通连接可用量 997 |
| 其他数据库进程连接池合计              | 待填写                                                                                                                            |
| 容量公式核查结果                      | 待填写                                                                                                                            |
| 100 空间预发压测报告                  | 待填写                                                                                                                            |
| stalled/续锁故障注入报告              | 待填写                                                                                                                            |

任一项为空时，只能认定“仓库实现完成”，不能认定“生产上线验收完成”。

2026-08-03 线上只读连接采样同时观察到 `current_client_connections=3`、`active_client_connections=1`、`idle_in_transaction_connections=0`、保守剩余连接 994。默认 3 个知识实例的配置池上限为 `3 × 25 = 75`，占 997 个普通可用连接约 7.5%；即使另行保留 15% 安全余量，其他进程仍有约 772 个配置池名额。因此 PostgreSQL 全局连接数量门槛已通过。该结论只覆盖连接数量预算，不替代 HTTP + space + image 混合压测中的数据库 CPU、内存、锁等待和 HTTP P95 验收。

## 仓库实现验收账本

本账本对应架构方案 Task 11 的 44 条场景。状态只表示当前仓库能提供的证据，不替代预发压测或部署证明。

| 证据层级               | 场景                      | 主要自动化证据                                                                                                                                                                                                                                                                                                                                                                                | 当前状态                                                                                                 |
| ---------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 调度与时间片           | 1–9、17–19、22–24         | `multi-space-compilation.integration.spec.ts`、`knowledge-space-runner.service.spec.ts`、`knowledge-space-compilation.repo.postgres.spec.ts`、`knowledge-space-execution.repo.postgres.spec.ts`、`knowledge-clean-cutover.spec.ts`                                                                                                                                                            | 单元/集成、本地真实 PostgreSQL 与本地三进程 Worker 注册已通过；100 空间仍须预发验证                      |
| lease、fence 与恢复    | 10、12、16、21、27–30、36 | `knowledge-space.processor.spec.ts`、`knowledge-run-reaper.service.spec.ts`、`knowledge-image-reaper.service.spec.ts`、`knowledge-space-execution.repo.postgres.spec.ts`、`knowledge-import.service.spec.ts`                                                                                                                                                                                  | 逻辑/CAS 及本地进程、容器中断接管已验证；主动续锁阻断仍须预发故障注入                                    |
| 单图共享队列           | 13–15、31–35              | `knowledge-image.processor.spec.ts`、`knowledge-space-compilation.service.spec.ts`、`knowledge-image-extraction.repo.postgres.spec.ts`、`knowledge-space-execution.repo.postgres.spec.ts`、`queue.module.spec.ts`                                                                                                                                                                             | 单图冻结、每 Run 窗口、恢复和 50 图上限及本地 PostgreSQL 测试已通过；retention 数值须由 100 空间压测校准 |
| Run 语义与知识一致性   | 20–23、37–40              | `knowledge-space-compilation.repo.postgres.spec.ts`、`knowledge-space-compilation.service.spec.ts`、`knowledge-space-execution.repo.postgres.spec.ts`、`environment.validation.spec.ts`、`knowledge-compiler-llm.provider.spec.ts`                                                                                                                                                            | 查询、状态机、跨字段校验及本地真实 PostgreSQL 测试已通过                                                 |
| 有界外部调用与维护任务 | 27、40–44                 | `knowledge-operation-budget.spec.ts`、`knowledge-embedding-provider.service.spec.ts`、`knowledge-vector-index.service.spec.ts`、`knowledge-access-indexer.service.spec.ts`、`knowledge-image-understanding-provider.service.spec.ts`、`knowledge-space-aggregator.service.spec.ts`、`knowledge-source-exporter.service.spec.ts`、`page.repo.spec.ts`、`knowledge-diagnostics.service.spec.ts` | 超时、批次、并发、无损分页和错误分类已有自动化测试；真实 provider P99 与 5000 页样本须预发校准           |
| Diagnostics            | 25、43                    | `knowledge-diagnostics.service.spec.ts`、`knowledge-diagnostics.service.postgres.spec.ts`、`knowledge-quality.service.postgres.spec.ts`、client `knowledge-admin.test.tsx`                                                                                                                                                                                                                    | 逻辑、客户端及本地真实 PostgreSQL 测试已通过；大数据查询计划仍须预发确认                                 |
| 管理取消与审计         | Run 控制                  | `knowledge-run-cancellation.repo.postgres.spec.ts`、`cancelled-knowledge-runs.migration.spec.ts`、`knowledge-space-cancellation.service.spec.ts`、`llm-wiki-cancellation.controller.spec.ts`、client `knowledge-admin.test.tsx`                                                                                                                                                               | exact runId、事务 fence、子任务收敛、Redis 精确清理、权限/审计与 UI 确认已通过本地自动化验证             |
| 部署和全局容量         | 11、26                    | 启动配置校验、本文外部部署证据表                                                                                                                                                                                                                                                                                                                                                              | 仓库内不能完成；3 replicas、同构配置和 PostgreSQL 全局连接预算是上线硬门槛                               |

本地没有 PostgreSQL 测试连接时，带 `.postgres.spec.ts` 的套件会被显式跳过，不能把“测试文件存在”解释为数据库验收通过。发布流水线必须设置 `AKASHA_MIGRATION_TEST_DATABASE_URL`，并把跳过的 PostgreSQL 套件视为失败或未完成。

2026-08-03 本地验收已显式设置 `AKASHA_MIGRATION_TEST_DATABASE_URL`：空间 request/execution、单图 extraction、Diagnostics 四个 PostgreSQL 套件共 21 项通过；完整知识迁移序列、Quality 与 force reset 三个 PostgreSQL 套件共 6 项通过。正式取消入口补充的取消事务 2 项和 `cancelled` 状态迁移 1 项也已在真实 PostgreSQL 通过。该结果证明本地 schema/事务边界，不替代上表的预发容量与部署证据。

同日当前提交复核：Task 0 外部调用/分页/复杂度上界 23 个套件 207 项通过；Worker 配置、队列 retention、processor 事件 6 个套件 76 项通过；知识调度/恢复/Diagnostics/controller 16 个套件 122 项通过（另有 3 个需要显式 PostgreSQL URL 的套件由上一段 21 项独立覆盖）；client 全量 30 个文件 158 项通过，client production build 通过。

正式取消完成后的当前工作树又执行了一次完整 Knowledge 回归：服务端 70 个套件、512 项通过；随后显式连接真实 PostgreSQL 的 8 个套件、32 项通过。取消事务额外覆盖了“RunPage 已初始化但 RunImage 冻结计划尚未插入”的窗口，确认取消后图片与 merge 子状态均无 `pending/queued/processing` 残留。服务端 TypeScript 检查和 `pnpm nx run server:build --skip-nx-cache` 均通过，构建产物与 8080 运行实例都包含该收敛逻辑。取消入口合入后再次运行 clean-cutover、100 空间集成、队列注入和队列配置四个套件，共 20 项通过；生产代码搜索只保留空间 text/image-merge 与单图三类新编译协议，文字队列只消费 `PAGE_CONTENT_UPDATED`、access/vector/stale 维护和 review 六类保留任务，不再接受旧逐页编译、逐页 merge 或旧 aggregate Job。

同一轮终态不变量审计发现，早期 force rebuild 产生的历史 `superseded` 测试 Run 曾保留 token/lease，并且没有收敛新架构的 RunImage 状态。当前实现已让 force supersede 与管理取消复用同一个事务内子任务收敛步骤：旧 Run 统一成为 `superseded/complete`，清空 execution/reservation/rerun，终态化 RunPage/RunImage，并返回 space、单图和遗留字段中的全部 exact Job ID。真实 PostgreSQL force-reset 测试覆盖了 active 单图、父页计数、开放子状态为 0 和旧 lease 清空。Redis 清理也已覆盖 `prioritized`：本地隔离临时队列实测 priority=5 的 Job 状态为 `prioritized`，精确 `remove()` 后不可查询；实现现在删除所有 non-active exact Job，active Job只依赖数据库 fence。历史本地测试记录没有回写；活动 Run/lease 与上线后的新 force 路径不受影响。

同日以同一份本地配置启动 3 个真实后端进程，分别监听 8080/8081/8082。三个健康检查均返回 200，BullMQ `Queue.getWorkers()` 对 `{knowledge-space-queue}` 和 `{knowledge-image-queue}` 均返回 3 个 Worker，证明实例没有绑定空间、扩容时会共同消费相同物理队列；按同构配置估算容量为 30 个空间槽和 15 个图片槽。测试后已停止 8081/8082，仅保留原 8080。测试期间 PostgreSQL 报告 `max_connections=100`、`superuser_reserved_connections=3`，三实例池配置上限合计 75，观测连接数为 37。这个结果证明本地多进程注册和本地预算可行，不等价于真实部署平台的 3 replicas 证据，也不替代 HTTP/编译高负载下的连接等待与 P95 验收。

同日本地真实数据演练以一个 bulk 请求提交 10 个空间，峰值 10 个空间 Job active；source exporter 微秒 cursor OOM 修复后，`多空间编译1`～`9` 共 9 个 Run 自然终态化（2 succeeded、7 partial），Run/RunPage 计数全部闭合，文字/图片/merge 开放状态和残留 execution lease 均为 0。`多空间编译0` 在完成 374 页文字、initial aggregate 和 202 张图片终态后，因完整 867 页数据不适合作为日常 smoke test，按操作要求使用当时尚未产品化的精确事务取消：历史记录为 `superseded/manual_cancelled`，411 张未完成图片置 skipped，Redis 无该 Run waiting/active Job。此后已增加正式 `cancelled` 终态和带审计的 exact-run 管理入口；历史记录不回写。该结果可证明真实数据调度、时间片、共享单图队列和故障恢复路径，不等价于“10 个 Run 全部自然完成”，也不解除 3 实例/100 空间预发硬门槛。

Diagnostics 的文字/图片/Merge 主进度必须显示 `succeeded + failed + skipped` 的终态数，次行中性展示三类结果；不得把 succeeded 单独伪装成处理进度。Merge 分母在初始化后按需处理页面冻结，`waiting_images` 不能让分母从 0 动态增长。客户端全量 30 文件 158 项、Diagnostics/controller 45 项、Diagnostics PostgreSQL 3 项和 client production build 已覆盖该口径；server 必须使用 `--skip-nx-cache` 完整构建并验证 `dist/main.js` 存在，不能把失败后留下的不完整 `dist` 缓存命中当作成功。

## Clean cutover

当前产品尚未正式上线，不迁移旧编译中的 Run 或 Redis Job，也不双写旧/新架构：

1. 停止旧版本应用，确保没有旧 Worker 继续消费。
2. 清空知识编译相关旧 Redis Job；不要删除其他业务队列。
3. 部署所有新实例，确认全部使用相同 Worker 参数。
4. 旧空间数据无需转换；上线后对已有空间发起强制编译，由新架构重新建立知识数据。
5. 禁止新旧知识 Worker 混跑；旧 Job 名在新 Processor 中必须被拒绝。

清理 Redis 前必须先按环境解析精确队列前缀和目标，保留操作记录；不得对 Redis 实例执行无范围的 `FLUSHALL`。

## 预发容量测试

准备至少 100 个空间，包含无图片、缓存命中、多图、复杂页面和 5000 页大空间样本。一次提交 100 空间后验证：

- PostgreSQL 出现 100 个 queued/active Run，不出现逐页文字 Job 风暴。
- 初始最多约 30 个空间时间片 active；其余 Run 保持排队且能在时间片边界前进。
- 正常时间片最多完成 5 页或运行 5 分钟，当前页面完成 checkpoint 后才让出。
- `images` phase Run 不计入空间 active slot。
- 单个 Run 的 `RunImage queued + processing <= 5`；所有空间共享一个图片队列。
- merge continuation 在 active Job 完成时间片后优先收敛，但不宣称能够抢占 active Job。
- Run 列表仅查询当前页；RunPage 仅打开详情后查询。
- `page_timeout` 单列为预算超时，不与 provider 或 publication 错误混合。

记录吞吐、Run P50/P95/P99、当前时间片等待 P95/P99、页面 provider P99、图片耗时、数据库池等待、PostgreSQL active connections 和 Redis 内存。用实际分布校准页面 15 分钟 deadline、图片 Job retention count、单 Run outstanding=5 和 materialization 上限。

## 故障注入

至少执行：

1. 在页面 provider 调用中终止 Worker，确认同 sequence retry 从未完成页恢复，已发布页不重做。
2. 阻断 BullMQ 续锁，确认 stalled/lockRenewalFailed 可观测，旧 execution token 无法发布。
3. 让 DB heartbeat 延迟超过 lease TTL，但保留 exact BullMQ Job 为 active，确认 reaper 不误杀。
4. 让空间 Job 消失，确认前三次有界重排队，耗尽后 recovery lease 经唯一 `finishRun()` 终态化。
5. DB 预留后临时中断 Redis，恢复后用确定性 jobId 补投且不重复处理。
6. 删除单图 Job，确认 missing 最多恢复 3 次；final failed/completed-without-DB-terminal 能被收敛。
7. 将 `CLIENT LIST` 设为不可用，确认 Diagnostics 显示 unknown，调度继续以 PostgreSQL 运转。
8. 分别在文字 provider、图片 processing 和 image merge active 时通过管理页取消精确 Run，确认 API 先提交 `cancelled/complete` fence，未完成子任务全部终态化；waiting/delayed Job 被精确移除，active Job 返回后无法写 Run、RunPage、RunImage 或 canonical publication，重复取消返回 `already_terminal`。

## Diagnostics 验收

Owner 应能看到：

- 活动 Run、活动空间槽、排队 Run、等待初始化。
- Run 总时长与当前时间片等待分别展示。
- phase/status 分布、sequence、yield reason、workerId。
- 空间/图片 queue counts、估算 worker/capacity，并标明 `exact=false`。
- DB 已预留但投递未确认、过期 lease、恢复中/恢复耗尽。
- 最近 stalled/lock renewal failed。
- RunPage 分页详情与 `retryable_exhausted`/`permanent` 图片失败分类。
- 文字、图片、Merge 主进度显示终态数/冻结总数，次行以中性色分列 succeeded/failed/skipped；少量失败不把整格染红，Merge 分母不随阶段推进增长。
- 独立的 Health and quarantine Tab；打开后才请求按空间聚合的 quality、分页 quarantine 和 retrieval 摘要，5 秒 Run 轮询不得重复执行这些查询。
- 初次进入默认选择“全部空间”，Run 列表只显示 `queued/compiling/aggregate_pending/aggregating`；全空间请求省略 `spaceIds` 并由服务端执行 ACL 过滤。
- 全部空间范围不提供更新、force rebuild 或维护写操作；操作者必须显式选择具体空间后才能看到对应按钮。
- Owner/Admin 在每个非终态 Run 行可执行 `Cancel run`；确认框明确说明不回滚已发布知识，要求输入精确空间名。取消后的 `cancelled` 使用灰色状态并可通过历史筛选查询，普通成员看不到操作按钮。

非 Owner 只能看到 ACL 可读空间，不能看到全局 queue/capacity；敏感错误只能在授权详情中查看。

## 发布判定与回退

发布必须同时满足：

- server/client 构建和知识编译测试通过。
- 文字、图片和 merge 三个阶段的正式取消 smoke test 通过，审计记录可查询。
- 100 空间预发压测通过。
- 数据库全局连接预算通过。
- 外部部署证据表填写完整。
- 无旧 Worker 与新 Worker 混跑。

回退只能整体回退应用版本并停止所有新 Worker，不能让两种架构并行消费。由于采用 clean cutover，回退后需要重新清理目标知识队列，并在重新上线新版本后对空间再次强制编译。
