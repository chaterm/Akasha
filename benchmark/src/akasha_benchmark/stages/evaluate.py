from __future__ import annotations

import sqlite3
from typing import Any

import httpx

from .. import naming
from ..config import load_config
from ..datasets import DataDependency, get_adapter
from ..judge import (
    answer_correctness,
    answer_relevancy,
    context_relevancy,
    faithfulness,
)
from ..judge.client import (
    JudgeProvider,
    complete_many,
    parse_json_object,
)
from ..judge.providers import resolve_provider
from ..metrics import attribution, multihop, qa, registry, retrieval
from ..model_configs import feature_of
from ..store import (
    compile_store,
    config_store,
    eval_store,
    loads,
    query_store,
    run_store,
)
from ..task import TaskContext

DEFAULT_KS = retrieval.DEFAULT_KS

MAX_JUDGE_FAILURE_RATE = 0.1
MAX_JUDGE_CONCURRENCY = 16


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _scalars(source: dict[str, Any]) -> dict[str, float]:
    return {k: float(v) for k, v in source.items() if isinstance(v, (int, float, bool))}


def _aggregate(rows: list[dict[str, Any]]) -> dict[str, float]:
    if not rows:
        return {}
    names = sorted({name for row in rows for name in row["metrics"]})
    return {n: _mean([float(r["metrics"].get(n, 0.0)) for r in rows]) for n in names}


def resolve_metrics(selected: list[str] | None) -> list[str]:
    if not selected:
        return sorted(registry.METRIC_REGISTRY)
    unknown = sorted(set(selected) - set(registry.METRIC_REGISTRY))
    if unknown:
        raise ValueError(f"未知指标：{unknown}")
    return sorted(set(selected))


def _keep(selected: frozenset[str]):
    def keep(name: str) -> bool:
        try:
            return registry.get_metric(name).name in selected
        except KeyError:
            return True

    return keep


def evaluate_dataset(
    connection: sqlite3.Connection,
    eval_id: int,
    query_id: int,
    compile_id: int,
    dataset: str,
    ks: tuple[int, ...],
    selected: frozenset[str],
    ctx: TaskContext | None = None,
    progress_offset: int = 0,
    progress_total: int | None = None,
    report_progress: bool = False,
) -> dict[str, Any]:
    adapter = get_adapter(dataset)
    provides = adapter.provides
    has_gold = DataDependency.GOLD_DOCS in provides
    omitted = [d.name for d in registry.omitted(provides) if d.kind == registry.KIND_DETERMINISTIC]

    samples = {
        s["sample_id"]: s for s in compile_store.compile_samples(connection, compile_id, dataset)
    }
    responses = query_store.responses_of(connection, query_id, dataset)
    if not responses:
        raise ValueError(f"{dataset} 没有查询响应")

    page_to_doc = compile_store.page_to_doc(connection, compile_id, dataset) if has_gold else {}
    keep = _keep(selected)
    eval_store.clear_eval_results(connection, eval_id, dataset)

    per_sample: list[dict[str, Any]] = []
    http_failures = 0

    for position, row in enumerate(responses, 1):
        sample = samples.get(row["sample_id"])
        if sample is None:
            raise ValueError(f"{dataset}: 样本 {row['sample_id']!r} 有响应但不在这次编译的子集里")
        if row["question"] != sample["question"]:
            raise ValueError(f"{row['sample_id']}: 响应与子集的问题文本不一致，子集被重建过")

        status = row["http_status"] or 0
        body = row["response"] or {}
        if not (200 <= status < 300 and isinstance(body, dict)):
            http_failures += 1
            body = {}

        retrieved = body.get("retrievedSources") or []
        citations = body.get("citations") or []
        snippets = body.get("snippets") or []
        answer = body.get("answer") or ""

        scored = qa.score_answer(answer, sample["answers"])
        metrics: dict[str, float] = dict(scored)
        detail: dict[str, Any] = {
            "metadata": dict(sample["metadata"]),
            "gold_doc_ids": list(sample["gold_doc_ids"]),
            "reference_answers": list(sample["answers"]),
            "question": sample["question"],
            "error": row["error"],
            "qa": scored,
        }

        if has_gold:
            ranked = retrieval.ranked_doc_ids(retrieved, page_to_doc)
            detail["unmapped_page_ids"] = retrieval.unmapped_page_ids(retrieved, page_to_doc)
            detail["retrieval"] = retrieval.evaluate_sample(ranked, sample["gold_doc_ids"], ks)
            detail["attribution"] = attribution.evaluate_sample(
                citations, retrieved, sample["gold_doc_ids"], page_to_doc
            )
            detail["multihop"] = multihop.evaluate_sample(
                snippets, sample["gold_doc_ids"], page_to_doc
            )
            metrics.update(detail["retrieval"])
            metrics.update(_scalars(detail["attribution"]))
            metrics.update(_scalars(detail["multihop"]))

        metrics = {name: value for name, value in metrics.items() if keep(name)}
        entry = {
            "sample_id": row["sample_id"],
            "answer_mode": row["answer_mode"],
            "metrics": metrics,
        }
        per_sample.append(entry)

        eval_store.record_sample_eval(
            connection,
            eval_id,
            sample_id=row["sample_id"],
            dataset=dataset,
            answer_mode=row["answer_mode"],
            http_status=status,
            answer=answer,
            detail=detail,
            metrics=metrics,
        )
        if ctx and report_progress:
            ctx.progress(
                progress_offset + position,
                progress_total if progress_total is not None else len(responses),
                "评测样本",
            )
        if position % 50 == 0 or position == len(responses):
            connection.commit()
    connection.commit()

    knowledge = [e for e in per_sample if e["answer_mode"] == "knowledge"]
    overall = _aggregate(per_sample)
    eval_store.record_metric_summary(
        connection, eval_id, dataset, "overall", overall, len(per_sample)
    )

    eval_store.record_metric_summary(
        connection, eval_id, dataset, "knowledge_only", _aggregate(knowledge), len(knowledge)
    )
    eval_store.record_dataset_eval(
        connection,
        eval_id,
        dataset,
        responses_evaluated=len(per_sample),
        http_failures=http_failures,
        omitted_metrics=omitted,
        answer_modes=qa.answer_mode_distribution([e["answer_mode"] for e in per_sample]),
    )
    connection.commit()

    return {
        "dataset": dataset,
        "responses_evaluated": len(per_sample),
        "http_failures": http_failures,
        "knowledge_count": len(knowledge),
        "overall": overall,
        "omitted_metrics": omitted,
    }


def _judge_task(
    metric: str, question: str, answer: str, reference: str, body: dict[str, Any]
) -> tuple[tuple[str, str], Any] | None:
    if metric == "faithfulness":
        prompt = faithfulness.build_prompt(question, answer, body)
        return (prompt, faithfulness.parse_verdict) if prompt else None
    if metric == "context_relevancy":
        built = context_relevancy.build_prompt(question, body)
        if not built:
            return None
        system, user, count = built
        return (system, user), lambda payload: context_relevancy.parse_verdict(payload, count)
    if metric == "answer_correctness":
        prompt = answer_correctness.build_prompt(question, answer, reference)
        return (prompt, answer_correctness.parse_verdict) if prompt else None
    raise ValueError(f"没有实现 judge 指标 {metric!r}")


def _answer_relevancy_task(
    connection: sqlite3.Connection,
    question: str,
    answer: str,
    model_snapshot: dict[str, Any],
) -> tuple[tuple[str, str], Any] | None:
    built = answer_relevancy.build_prompt(answer)
    if built is None or not question.strip():
        return None
    applied = feature_of(model_snapshot, "embedding") or {}
    records = config_store.list_model_providers(connection, "embedding")
    record = next(
        (
            row
            for row in records
            if (row.get("api_key") or "").strip()
            and row.get("model") == applied.get("model")
            and str(row.get("base_url") or "").rstrip("/")
            == str(applied.get("baseUrl") or "").rstrip("/")
        ),
        None,
    )
    if record is None:
        return None
    config = load_config(connection)

    def parse(payload: dict[str, Any]) -> tuple[float, dict[str, Any]]:
        generated = answer_relevancy.parse_generated_question(payload)
        try:
            score = answer_relevancy.embedding_similarity(
                question,
                generated,
                base_url=str(record["base_url"]),
                model=str(record["model"]),
                api_key=str(record["api_key"]),
                timeout_seconds=config.timeout_seconds,
            )
        except (httpx.HTTPError, OSError, ValueError, TypeError, KeyError) as exc:
            raise ValueError(f"embedding similarity failed: {type(exc).__name__}: {exc}") from exc
        return score, {
            "method": "generated_question_embedding",
            "generated_question": generated,
            "embedding_model": record["model"],
        }

    return built, parse


def _record_reply(
    ctx: TaskContext, eval_id: int, metric: str, row: dict[str, Any], parse: Any, reply: Any
) -> None:
    raw = {"raw_response": reply.content, "raw_http_response": (reply.raw or "")[:2000]}
    if reply.failure_kind:
        eval_store.record_judge_verdict(
            ctx.db,
            eval_id,
            sample_id=row["sample_id"],
            metric=metric,
            score=None,
            failure_kind=reply.failure_kind,
            latency_ms=reply.latency_ms,
            detail=raw,
        )
        return
    try:
        score, reasoning = parse(parse_json_object(reply.content or ""))
    except ValueError as exc:
        eval_store.record_judge_verdict(
            ctx.db,
            eval_id,
            sample_id=row["sample_id"],
            metric=metric,
            score=None,
            failure_kind="parse_error",
            detail={"error": str(exc)[:300], **raw},
        )
        ctx.log(f"{metric} parse_error sample={row['sample_id']}: {exc}", level="warn")
        return
    eval_store.record_judge_verdict(
        ctx.db,
        eval_id,
        sample_id=row["sample_id"],
        metric=metric,
        score=score,
        failure_kind=None,
        detail={**reasoning, **raw},
    )
    ctx.log(f"{metric} sample={row['sample_id']} score={score}", level="info")
    if score is not None:
        eval_store.record_sample_eval(
            ctx.db,
            eval_id,
            sample_id=row["sample_id"],
            dataset=row["dataset"],
            answer_mode=row["answer_mode"],
            http_status=row["http_status"],
            answer=row["answer"] or "",
            detail=row["detail"],
            metrics={metric: score},
        )


def _judge(
    ctx: TaskContext,
    eval_id: int,
    query_id: int,
    provider: JudgeProvider,
    metrics: list[str],
    concurrency: int,
) -> None:
    for metric in metrics:
        eval_store.restore_judge_metrics(ctx.db, eval_id, metric)
    ctx.db.commit()
    already_by_metric = {
        metric: eval_store.completed_judge_sample_ids(ctx.db, eval_id, metric)
        for metric in metrics
    }
    rows = eval_store.sample_evals(ctx.db, eval_id)
    query_run = query_store.get_query_run(ctx.db, query_id) or {}
    query_model_snapshot = loads(query_run.get("model_configs_json"))
    for position, row in enumerate(rows, 1):
        ctx.checkpoint()
        response = query_store.response_of(ctx.db, query_id, row["sample_id"]) or {}
        body = response.get("response") or {}
        question = response.get("question") or ""
        answer = row["answer"] or ""
        references = (row["detail"] or {}).get("reference_answers") or []
        pending: list[tuple[str, Any, tuple[str, str]]] = []
        for metric in metrics:
            if row["sample_id"] in already_by_metric[metric]:
                continue
            if metric == "answer_relevancy":
                task = _answer_relevancy_task(
                    ctx.db, question, answer, query_model_snapshot
                )
            else:
                task = _judge_task(
                    metric,
                    question,
                    answer,
                    references[0] if references else "",
                    body,
                )
            if task is None:
                eval_store.record_judge_verdict(
                    ctx.db,
                    eval_id,
                    sample_id=row["sample_id"],
                    metric=metric,
                    score=None,
                    failure_kind=None,
                    detail={"skipped": "not applicable to this sample"},
                )
            else:
                prompt, parse = task
                pending.append((metric, parse, prompt))

        replies = (
            complete_many(provider, [prompt for _, _, prompt in pending], concurrency)
            if pending
            else []
        )
        for (metric, parse, _), reply in zip(pending, replies, strict=True):
            _record_reply(ctx, eval_id, metric, row, parse, reply)

        ctx.db.commit()
        ctx.progress(position, len(rows), "Judge")

    for metric in metrics:
        summary = eval_store.judge_summary(ctx.db, eval_id, metric)
        for dataset, mean, count in eval_store.judge_means_by_dataset(ctx.db, eval_id, metric):
            eval_store.record_metric_summary(
                ctx.db, eval_id, dataset, "judge", {metric: mean}, count
            )
        ctx.db.commit()
        ctx.log(
            f"{metric} 均值 {summary['mean']}，已评分 {summary['scored']}，"
            f"失败率 {summary['failure_rate']:.3f}"
        )
        if summary["failure_rate"] > MAX_JUDGE_FAILURE_RATE:
            raise RuntimeError(
                f"{metric} 的 Judge 失败率 {summary['failure_rate']:.3f} 超过 "
                f"{MAX_JUDGE_FAILURE_RATE}。均值只覆盖成功的那部分，已不代表整体。"
                f"失败类型：{summary['failures_by_kind']}"
            )


def run(ctx: TaskContext) -> None:
    params = ctx.params
    query_id = int(params.get("query_id") or 0)
    if not query_id:
        raise ValueError("请选择一次查询")

    query_run = query_store.get_query_run(ctx.db, query_id)
    if query_run is None:
        raise ValueError(f"查询 #{query_id} 不存在")
    if query_run["status"] != run_store.STATUS_SUCCEEDED:
        raise ValueError("请选择已完成的查询记录")

    available = query_store.response_datasets(ctx.db, query_id)
    datasets = list(params.get("datasets") or available)
    unknown = sorted(set(datasets) - set(available))
    if unknown:
        raise ValueError(f"这些数据集没有查询响应：{unknown}")

    ks = tuple(int(k) for k in (params.get("ks") or DEFAULT_KS))
    if any(k < 1 for k in ks):
        raise ValueError("k 必须大于 0")
    metrics = resolve_metrics(list(params.get("metrics") or []))
    judge_selected = any(registry.get_metric(name).kind == registry.KIND_JUDGE for name in metrics)
    concurrency = int(params.get("concurrency") or 1)
    if not 1 <= concurrency <= MAX_JUDGE_CONCURRENCY:
        raise ValueError(f"Judge 并发必须在 1 到 {MAX_JUDGE_CONCURRENCY} 之间")

    provider: JudgeProvider | None = None
    provider_id = params.get("judge_provider_id")
    provider_id = int(provider_id) if provider_id else None
    if judge_selected:
        provider = resolve_provider(ctx.db, provider_id, "judge")
        provider_id = provider.provider_id

    name = (
        str(params.get("name") or "").strip()
        or naming.child_name(ctx.db, str(query_run["name"]), "e")
    )
    eval_id = ctx.target("eval")
    ctx.freeze(
        name=name, datasets=datasets, ks=list(ks), metrics=metrics,
        judge_provider_id=provider_id, concurrency=concurrency
    )
    if eval_id is None:
        if eval_store.eval_run_by_name(ctx.db, name):
            raise ValueError(f"评测名称 {name!r} 已存在，请换个名称或继续原任务")
        eval_id = eval_store.create_eval_run(
            ctx.db,
            name=name,
            query_id=query_id,
            ks=list(ks),
            metrics=metrics,
            judge_provider_id=provider_id if judge_selected else None,
            concurrency=concurrency if judge_selected else 1,
        )
        ctx.bind("eval", eval_id)

    response_counts = {
        dataset: len(query_store.responses_of(ctx.db, query_id, dataset))
        for dataset in datasets
    }
    sample_total = sum(response_counts.values())
    ctx.progress(0, sample_total, "评测样本")
    progress_offset = 0
    for dataset in datasets:
        ctx.checkpoint()
        summary = evaluate_dataset(
            ctx.db,
            eval_id,
            query_id,
            int(query_run["compile_id"]),
            dataset,
            ks,
            frozenset(metrics),
            ctx,
            progress_offset,
            sample_total,
            provider is None,
        )
        progress_offset += response_counts[dataset]
        ctx.log(
            f"{dataset}: 样本 {summary['responses_evaluated']}，"
            f"HTTP 失败 {summary['http_failures']}，"
            f"EM {summary['overall'].get('em', 0.0):.3f} "
            f"F1 {summary['overall'].get('f1', 0.0):.3f}"
        )
        if summary["omitted_metrics"]:
            ctx.log(
                f"{dataset}: 缺 gold 标注，省略 {len(summary['omitted_metrics'])} 个指标"
                "（不伪造 0 分）"
            )

    if provider is not None:
        judge_metrics = [
            name for name in metrics if registry.get_metric(name).kind == registry.KIND_JUDGE
        ]
        ctx.log(f"执行 Judge：{provider.model}，指标 {judge_metrics}")
        _judge(ctx, eval_id, query_id, provider, judge_metrics, concurrency)
    ctx.progress(sample_total, sample_total, "评测完成")
