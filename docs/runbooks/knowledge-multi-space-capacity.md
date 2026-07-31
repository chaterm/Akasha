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

| 项目 | 证据 |
|---|---|
| 部署平台/集群/namespace | 待填写 |
| workload 名称与配置版本 | 待填写 |
| 应用副本数为 3 | 待填写 |
| 三实例 Worker env 同构 | 待填写 |
| 三实例 `DATABASE_MAX_POOL=25` | 待填写 |
| PostgreSQL `max_connections` 与保留量 | 待填写 |
| 其他数据库进程连接池合计 | 待填写 |
| 容量公式核查结果 | 待填写 |
| 100 空间预发压测报告 | 待填写 |
| stalled/续锁故障注入报告 | 待填写 |

任一项为空时，只能认定“仓库实现完成”，不能认定“生产上线验收完成”。

## 仓库实现验收账本

本账本对应架构方案 Task 11 的 43 条场景。状态只表示当前仓库能提供的证据，不替代预发压测或部署证明。

| 证据层级 | 场景 | 主要自动化证据 | 当前状态 |
|---|---|---|---|
| 调度与时间片 | 1–9、17–19、22–24 | `multi-space-compilation.integration.spec.ts`、`knowledge-space-runner.service.spec.ts`、`knowledge-space-compilation.repo.postgres.spec.ts`、`knowledge-space-execution.repo.postgres.spec.ts`、`knowledge-clean-cutover.spec.ts` | 单元/集成测试已实现；真实 PostgreSQL 场景需连接测试库复跑 |
| lease、fence 与恢复 | 10、12、16、21、27–30、36 | `knowledge-space.processor.spec.ts`、`knowledge-run-reaper.service.spec.ts`、`knowledge-image-reaper.service.spec.ts`、`knowledge-space-execution.repo.postgres.spec.ts`、`knowledge-import.service.spec.ts` | 逻辑与 CAS 测试已实现；真实续锁中断、进程退出仍须预发故障注入 |
| 单图共享队列 | 13–15、31–35 | `knowledge-image.processor.spec.ts`、`knowledge-space-compilation.service.spec.ts`、`knowledge-image-extraction.repo.postgres.spec.ts`、`knowledge-space-execution.repo.postgres.spec.ts`、`queue.module.spec.ts` | 单图冻结、每 Run 窗口、恢复和 50 图上限已实现；retention 数值须由 100 空间压测校准 |
| Run 语义与知识一致性 | 20–23、37–40 | `knowledge-space-compilation.repo.postgres.spec.ts`、`knowledge-space-compilation.service.spec.ts`、`knowledge-space-execution.repo.postgres.spec.ts`、`environment.validation.spec.ts`、`knowledge-compiler-llm.provider.spec.ts` | 查询、状态机和跨字段校验已实现；PostgreSQL 测试需在可用测试库执行 |
| 有界外部调用与维护任务 | 27、40–43 | `knowledge-operation-budget.spec.ts`、`knowledge-embedding-provider.service.spec.ts`、`knowledge-vector-index.service.spec.ts`、`knowledge-access-indexer.service.spec.ts`、`knowledge-image-understanding-provider.service.spec.ts`、`knowledge-space-aggregator.service.spec.ts`、`knowledge-diagnostics.service.spec.ts` | 超时、批次、并发和错误分类已有自动化测试；真实 provider P99 与 5000 页样本须预发校准 |
| Diagnostics | 25、43 | `knowledge-diagnostics.service.spec.ts`、`knowledge-diagnostics.service.postgres.spec.ts`、client `knowledge-admin.test.tsx` | 分页、等待分类、容量 estimate 和预算超时展示已实现；大数据查询计划须预发确认 |
| 部署和全局容量 | 11、26 | 启动配置校验、本文外部部署证据表 | 仓库内不能完成；3 replicas、同构配置和 PostgreSQL 全局连接预算是上线硬门槛 |

本地没有 PostgreSQL 测试连接时，带 `.postgres.spec.ts` 的套件会被显式跳过，不能把“测试文件存在”解释为数据库验收通过。发布流水线必须设置 `AKASHA_MIGRATION_TEST_DATABASE_URL`，并把跳过的 PostgreSQL 套件视为失败或未完成。

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

## Diagnostics 验收

Owner 应能看到：

- 活动 Run、活动空间槽、排队 Run、等待初始化。
- Run 总时长与当前时间片等待分别展示。
- phase/status 分布、sequence、yield reason、workerId。
- 空间/图片 queue counts、估算 worker/capacity，并标明 `exact=false`。
- DB 已预留但投递未确认、过期 lease、恢复中/恢复耗尽。
- 最近 stalled/lock renewal failed。
- RunPage 分页详情与 `retryable_exhausted`/`permanent` 图片失败分类。

非 Owner 只能看到 ACL 可读空间，不能看到全局 queue/capacity；敏感错误只能在授权详情中查看。

## 发布判定与回退

发布必须同时满足：

- server/client 构建和知识编译测试通过。
- 100 空间预发压测通过。
- 数据库全局连接预算通过。
- 外部部署证据表填写完整。
- 无旧 Worker 与新 Worker 混跑。

回退只能整体回退应用版本并停止所有新 Worker，不能让两种架构并行消费。由于采用 clean cutover，回退后需要重新清理目标知识队列，并在重新上线新版本后对空间再次强制编译。
