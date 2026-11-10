from __future__ import annotations

import sqlite3
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from typing import Any

import httpx

from .. import naming
from ..akasha_client import AkashaClient, AkashaError, client_pool
from ..config import load_config
from ..lineage import (
    BadPageId,
    LineageReader,
    LineageUnavailable,
    active_coverage,
    query_hash,
)
from ..model_configs import drift, feature_of, matches
from ..store import compile_store, loads, query_store
from ..task import TaskContext


def _query_one(
    client: AkashaClient,
    sample: dict[str, Any],
    space_id: str,
) -> dict[str, Any]:
    try:
        response = client.query(sample["question"], [space_id])
        status, body, latency = response.status, response.body, response.latency_ms
        error = None
    except (AkashaError, httpx.RequestError, OSError) as exc:
        status, body, latency, error = 0, None, None, f"{type(exc).__name__}: {exc}"

    return {
        "sample_id": sample["sample_id"],
        "dataset": sample["dataset"],
        "question": sample["question"],
        "http_status": status,
        "latency_ms": latency,
        "error": error,
        "response": body,
    }


def _collect_timings(ctx: TaskContext, query_id: int, since: str | None) -> None:
    rows = query_store.responses_of(ctx.db, query_id)
    questions = [str(row.get("question") or "") for row in rows]
    samples_by_hash: dict[str, list[str]] = {}
    for row, question in zip(rows, questions, strict=True):
        samples_by_hash.setdefault(query_hash(question), []).append(row["sample_id"])

    try:
        reader = LineageReader(load_config(ctx.db).database_url)
        audits = reader.query_audits(questions, since=since)
    except LineageUnavailable as exc:
        ctx.log(f"阶段耗时未采集：{exc}", "warn")
        return

    timings = {}
    for digest, metadata in audits.items():
        parsed = query_store.timings_from_audit(metadata)
        if parsed:
            for sample_id in samples_by_hash.get(digest, []):
                timings[sample_id] = parsed

    updated = query_store.record_timings(ctx.db, query_id, timings)
    ctx.db.commit()
    if updated:
        ctx.log(f"已回填 {updated} / {len(rows)} 条阶段耗时")
    else:
        ctx.log("审计表没有可用的阶段耗时（远端可能未开启 timings）", "warn")


def _require_rebuilt_embeddings(
    ctx: TaskContext, compile_run: dict[str, Any], current: dict[str, Any]
) -> None:
    target = str((feature_of(current, "embedding") or {}).get("model") or "")
    space_id = compile_run["space_id"]
    try:
        reader = LineageReader(load_config(ctx.db).database_url)
        report = reader.space_embedding_generations(str(space_id))
    except (LineageUnavailable, BadPageId) as exc:
        raise RuntimeError(
            f"远端 embedding 配置与编译时不同，无法用 PostgreSQL 确认是否已重建：{exc}。"
            "请先在查询页点「重建嵌入」，并填好 database_url 以便确认重建结果；"
            "或重新编译"
        ) from exc

    coverage = active_coverage(report["generations"], target)
    if coverage["ready"]:
        ctx.log(
            f"embedding 已整体重建为 {target}（{coverage['total']} 个 chunk），"
            "语料仍是原 compiler 编译的产物",
            "warn",
        )
        return
    if coverage["matched"]:
        raise RuntimeError(
            f"嵌入重建未完成：已重建 {coverage['matched']} / 共 {coverage['total']} 个 chunk，"
            "新旧向量混在一起，检索结果不可用。请等重建任务跑完"
        )
    raise RuntimeError(
        f"远端 embedding 配置是 {target}，但空间里的 chunk 还是 "
        f"{', '.join(coverage['models']) or '（无）'}。"
        "dense 检索按 embedding profile 过滤，会一条都召回不到。请先在查询页点「重建嵌入」"
    )


def _select_samples(
    connection: sqlite3.Connection,
    compile_id: int,
    datasets: list[str],
    limit: int | None,
) -> list[dict[str, Any]]:
    picked: list[dict[str, Any]] = []
    for dataset in datasets:
        samples = compile_store.compile_samples(connection, compile_id, dataset)
        picked.extend(samples[:limit] if limit else samples)
    return picked


def run(ctx: TaskContext) -> None:
    params = ctx.params
    compile_id = int(params.get("compile_id") or 0)
    if not compile_id:
        raise ValueError("请选择一次编译")

    compile_run = compile_store.get_compile_run(ctx.db, compile_id)
    if compile_run is None:
        raise ValueError(f"编译 #{compile_id} 不存在")

    readiness = compile_store.compile_ready(ctx.db, compile_id)
    if not readiness["ready"]:
        raise ValueError("这次编译还不能用于查询：" + "；".join(readiness["reasons"]))

    datasets = list(params.get("datasets") or loads(compile_run["datasets_json"], []))
    available = set(compile_store.compile_stats(ctx.db, compile_id))
    unknown = sorted(set(datasets) - available)
    if unknown:
        raise ValueError(f"这次编译不含数据集：{unknown}")

    limit = params.get("sample_limit")
    limit = int(limit) if limit else None
    config = load_config(ctx.db)
    config.require_credentials()
    concurrency = max(1, int(params.get("concurrency") or 5))
    query_id = ctx.target("query")
    resuming = query_id is not None

    with AkashaClient(config) as client:
        client.login()

        me = client.current_user()
        mismatch = compile_store.workspace_mismatch(
            ctx.db, compile_id, ((me or {}).get("workspace") or {}).get("id")
        )
        if mismatch:
            raise RuntimeError(mismatch)

        current = client.get_model_configs()
        ctx.freeze(model_configs=current)
        snapshot = loads(compile_run["model_configs_json"])
        changed = drift(current, snapshot)
        if changed["embedding"]:
            _require_rebuilt_embeddings(ctx, compile_run, current)
        if resuming:
            existing_query = query_store.get_query_run(ctx.db, query_id) or {}
            query_snapshot = loads(existing_query.get("model_configs_json"))
            resume_changed = [
                feature
                for feature in ("embedding", "answer")
                if query_snapshot and not matches(current, query_snapshot, feature)
            ]
            if resume_changed:
                raise RuntimeError(
                    "远端模型配置已变化，不能继续原查询：" + ", ".join(resume_changed)
                )
        for feature in ("compiler", "answer", "image"):
            if changed[feature]:
                ctx.log(
                    f"{feature} 配置与编译时不同；允许查询，两次运行不可完全对比",
                    "warn",
                )

        name = (
            str(params.get("name") or "").strip()
            or naming.child_name(
                ctx.db,
                str(compile_run["run_id"]),
                "q",
                naming.query_slug(ctx.db, current),
            )
        )
        ctx.freeze(
            name=name,
            datasets=datasets,
            concurrency=concurrency,
            sample_limit=limit,
        )
        if query_id is None:
            if query_store.query_run_by_name(ctx.db, name):
                raise ValueError(f"查询名称 {name!r} 已存在，请换个名称或继续原任务")
            query_id = query_store.create_query_run(
                ctx.db,
                name=name,
                compile_id=compile_id,
                concurrency=concurrency,
                model_configs=current,
            )
            ctx.bind("query", query_id)

        if not query_store.query_samples(ctx.db, query_id):
            selected = _select_samples(ctx.db, compile_id, datasets, limit)
            if not selected:
                raise ValueError("所选数据集在这次编译里没有样本")
            query_store.freeze_query_samples(ctx.db, query_id, selected)
            ctx.db.commit()

        if params.get("retry_failed"):
            removed = query_store.delete_retryable_responses(ctx.db, query_id)
            ctx.db.commit()
            ctx.log(f"已清除 {removed} 条失败或空回答响应以便重试")
            ctx.freeze(retry_failed=False)

        _issue(ctx, client, query_id, compile_run["space_id"], concurrency)
        _collect_timings(
            ctx, query_id, (query_store.get_query_run(ctx.db, query_id) or {}).get("created_at")
        )
        retryable = query_store.retryable_responses(ctx.db, query_id)
        if retryable:
            examples = [row["sample_id"] for row in retryable[:3]]
            raise RuntimeError(
                f"查询质量阀门未通过：{len(retryable)} 条响应失败或为空回答；"
                f"可使用查询记录上的重试入口（示例：{examples}）"
            )
        final_configs = client.get_model_configs()
        changed_during_run = [
            feature
            for feature in ("embedding", "answer")
            if not matches(final_configs, current, feature)
        ]
        if changed_during_run:
            raise RuntimeError(
                "查询期间远端模型配置发生变化，结果可能混合："
                + ", ".join(changed_during_run)
            )

    stats = query_store.query_stats(ctx.db, query_id)
    for dataset, row in stats.items():
        ttft = row.get("ttft_ms_mean")
        ctx.log(
            f"{dataset}: 响应 {row['responses']}，失败 {row['failures']}，"
            f"平均 {int(row['latency_mean'] or 0)}ms"
            + (f"，TTFT {int(ttft)}ms" if ttft else "")
        )


def _issue(
    ctx: TaskContext,
    client: AkashaClient,
    query_id: int,
    space_id: str,
    concurrency: int,
) -> None:
    todo = query_store.pending_query_samples(ctx.db, query_id)
    total = len(query_store.query_samples(ctx.db, query_id))
    done = total - len(todo)
    if not todo:
        ctx.log(f"{total} 条样本均已有响应，跳过")
        return
    ctx.log(f"待查询 {len(todo)} / 共 {total}，并发 {concurrency}")

    def emit(row: dict[str, Any]) -> None:
        nonlocal done
        query_store.record_response(
            ctx.db,
            query_id,
            sample_id=row["sample_id"],
            dataset=row["dataset"],
            question=row["question"],
            http_status=row["http_status"],
            latency_ms=row["latency_ms"],
            error=row["error"],
            response=row["response"],
        )

        ctx.db.commit()
        done += 1
        if done % 5 == 0 or done == total:
            ctx.progress(done, total, "查询")

    if concurrency <= 1:
        for sample in todo:
            ctx.checkpoint()
            emit(_query_one(client, sample, space_id))
        return

    with client_pool(client, concurrency, AkashaClient) as call:
        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            pending: set[Future[dict[str, Any]]] = set()
            cursor = 0

            def fill_window() -> None:
                nonlocal cursor
                while cursor < len(todo) and len(pending) < concurrency:
                    pending.add(executor.submit(call, _query_one, todo[cursor], space_id))
                    cursor += 1

            fill_window()
            while pending:
                completed, pending = wait(pending, return_when=FIRST_COMPLETED)
                for future in completed:
                    emit(future.result())
                ctx.checkpoint()
                fill_window()
