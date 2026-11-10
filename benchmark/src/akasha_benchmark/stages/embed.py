from __future__ import annotations

import time
from typing import Any

from ..akasha_client import AkashaClient
from ..config import load_config
from ..lineage import LineageReader, LineageUnavailable, active_coverage
from ..model_configs import feature_of, matches
from ..store import compile_store
from ..task import TaskContext

POLL_INTERVAL_SECONDS = 15.0
MAX_IDLE_POLLS = 20
MAX_EMBEDDING_CONCURRENCY = 50


def _target_model(configs: dict[str, Any]) -> str:
    entry = feature_of(configs, "embedding") or {}
    model = str(entry.get("model") or "")
    if not model:
        raise RuntimeError("远端没有配置 embedding 模型，无法重建")
    return model


def _coverage(reader: LineageReader, space_id: str, model: str) -> dict[str, Any]:
    report = reader.space_embedding_generations(space_id)
    return {
        **active_coverage(report["generations"], model),
        "generations": report["generations"],
    }


def _usage_note(usage: dict[str, Any]) -> str:
    chunks = usage["chunks"]
    tokens = sum(entry.get("total_tokens") or 0 for entry in usage["models"])
    duration = sum(entry.get("duration_ms_sum") or 0 for entry in usage["models"])
    per_chunk = duration / chunks if chunks else 0
    failed = f"，{usage['failed']} 个失败" if usage["failed"] else ""
    return (
        f"{chunks} 个 chunk 分 {usage['batches']} 批{failed}，token 合计 {tokens}，"
        f"墙钟 {duration / 1000:.1f}s，约 {per_chunk:.0f}ms/chunk"
    )


def run(ctx: TaskContext) -> None:
    compile_id = int(ctx.params.get("compile_id") or 0)
    if not compile_id:
        raise ValueError("请选择一次编译")

    raw_concurrency = ctx.params.get("embedding_concurrency")
    concurrency = None if raw_concurrency is None else int(raw_concurrency)
    if concurrency is not None and not 1 <= concurrency <= MAX_EMBEDDING_CONCURRENCY:
        raise ValueError(f"嵌入并发必须在 1 到 {MAX_EMBEDDING_CONCURRENCY} 之间")

    compile_run = compile_store.get_compile_run(ctx.db, compile_id)
    if compile_run is None:
        raise ValueError(f"编译 #{compile_id} 不存在")
    space_id = compile_run["space_id"]
    if not space_id:
        raise ValueError(f"编译 {compile_run['run_id']!r} 还没有 Akasha 空间")

    config = load_config(ctx.db)
    config.require_credentials()
    try:
        reader = LineageReader(config.database_url)
    except LineageUnavailable as exc:
        raise RuntimeError(
            f"重建嵌入需要 PostgreSQL 判定完成度：{exc}。"
            "远端重建不产生 run 记录，HTTP 侧没有进度可查。"
        ) from exc

    with AkashaClient(config) as client:
        client.login()
        me = client.current_user()
        role = ((me or {}).get("user") or {}).get("role")
        if role not in {"owner", "admin"}:
            raise RuntimeError(f"当前账号角色是 {role!r}，重建嵌入需要 owner 或 admin")
        mismatch = compile_store.workspace_mismatch(
            ctx.db, compile_id, ((me or {}).get("workspace") or {}).get("id")
        )
        if mismatch:
            raise RuntimeError(mismatch)

        current = client.get_model_configs()
        target = _target_model(current)
        ctx.freeze(model_configs=current, target_model=target)
        ctx.log(f"重建 {compile_run['run_id']} 的嵌入，目标模型 {target}")

        coverage = _coverage(reader, space_id, target)
        if not coverage["total"]:
            ctx.log("空间里没有活跃 chunk，先编译再重建")
            return
        ctx.log(f"当前活跃 chunk 的模型：{', '.join(coverage['models']) or '（无）'}")

        since = str(ctx.params.get("rebuild_since") or "") or reader.server_now()
        ctx.checkpoint()
        result = client.rebuild_space_embeddings(
            [str(space_id)], embedding_concurrency=concurrency
        )
        job_ids = [str(value) for value in result.get("jobIds") or []]
        if not job_ids:
            raise RuntimeError(f"Akasha 没有返回重建 job：{result!r}")
        ctx.freeze(rebuild_job_ids=job_ids, rebuild_since=since)
        ctx.log(
            f"已请求重建，远端 job {', '.join(job_ids)}，"
            f"嵌入并发 {concurrency if concurrency else '远端默认'}"
        )

        usage = _wait_for_batches(ctx, reader, str(space_id), since, coverage["total"])

        final_configs = client.get_model_configs()
        if not matches(final_configs, current, "embedding"):
            raise RuntimeError("重建期间远端 embedding 配置发生变化，结果可能混合")

    coverage = _coverage(reader, space_id, target)
    if not coverage["ready"]:
        raise RuntimeError(
            f"批次已跑完，但活跃 chunk 只有 {coverage['matched']} / {coverage['total']} 是 "
            f"{target}（现有 {', '.join(coverage['models']) or '（无）'}）。"
            "请检查 Akasha 的 embedding 端点"
        )
    ctx.log(f"重建完成：{_usage_note(usage)}")


def _wait_for_batches(
    ctx: TaskContext,
    reader: LineageReader,
    space_id: str,
    since: str,
    total: int,
) -> dict[str, Any]:
    usage = reader.space_rebuild_usage(space_id, since=since)
    done = usage["chunks"]
    idle = 0
    while done < total:
        ctx.progress(done, total, "重建嵌入")
        time.sleep(POLL_INTERVAL_SECONDS)
        ctx.checkpoint()
        usage = reader.space_rebuild_usage(space_id, since=since)
        if usage["chunks"] > done:
            done = usage["chunks"]
            idle = 0
            continue
        idle += 1
        if idle >= MAX_IDLE_POLLS:
            raise RuntimeError(_stall_message(usage, done, total))
    ctx.progress(total, total, "重建完成")
    return usage


def _stall_message(usage: dict[str, Any], done: int, total: int) -> str:
    minutes = int(POLL_INTERVAL_SECONDS * MAX_IDLE_POLLS / 60)
    if not usage["batches"]:
        return (
            f"重建停滞：{minutes} 分钟内远端没有产生任何重建批次。"
            "请检查 Akasha 的 worker 是否在消费队列（需要 Redis）"
        )
    failed = f"，{usage['failed']} 个 chunk 失败" if usage["failed"] else ""
    return (
        f"重建停滞：{minutes} 分钟内进度停在 {done} / {total}{failed}。"
        "请检查 Akasha 的 worker 和 embedding 端点"
    )
