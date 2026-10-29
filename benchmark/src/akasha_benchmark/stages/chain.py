from __future__ import annotations

from typing import Any

from .. import naming
from ..datasets import get_adapter
from ..metrics import registry
from ..store import (
    attribution_store,
    compile_store,
    data_store,
    eval_store,
    query_store,
)
from . import compile

DATASETS = ("hotpotqa", "2wikimultihopqa", "musique")


def verify_query(connection, query_id: int) -> None:
    run = query_store.get_query_run(connection, query_id)
    if run is None:
        raise RuntimeError("查询记录丢失")
    responses = query_store.responses_of(connection, query_id)
    expected = {
        s["sample_id"] for s in compile_store.compile_samples(connection, int(run["compile_id"]))
    }
    if {r["sample_id"] for r in responses} != expected:
        raise RuntimeError("查询响应没有覆盖全部样本")
    failed = [r["sample_id"] for r in responses if query_store.response_is_retryable(r)]
    if failed:
        raise RuntimeError(f"{len(failed)} 条查询响应未通过质量阀门：{failed[:3]}")
    unmapped = [
        r["sample_id"]
        for r in responses
        if isinstance(r["response"], dict)
        and r["response"].get("answerMode") == "knowledge"
        and not (r["response"].get("retrievedSources") or [])
    ]
    if unmapped:
        raise RuntimeError(f"knowledge 响应没有 retrievedSources：{unmapped[:3]}")


def verify_evaluate(connection, eval_id: int) -> None:
    run = eval_store.get_eval_run(connection, eval_id)
    if run is None:
        raise RuntimeError("评测记录丢失")
    query_run = query_store.get_query_run(connection, int(run["query_id"]))
    if query_run is None:
        raise RuntimeError("评测指向的查询记录丢失")
    expected = {
        s["sample_id"]
        for s in compile_store.compile_samples(connection, int(query_run["compile_id"]))
    }
    if {r["sample_id"] for r in eval_store.sample_evals(connection, eval_id)} != expected:
        raise RuntimeError("评测没有覆盖全部样本")


def verify_attribute(connection, attribution_id: int) -> None:
    run = attribution_store.get_attribution_run(connection, attribution_id)
    if run is None:
        raise RuntimeError("归因记录不存在")
    expected = {row["sample_id"] for row in eval_store.sample_evals(connection, int(run["eval_id"]))}
    actual = {
        row["sample_id"]
        for row in attribution_store.attribution_results(connection, attribution_id)
    }
    if actual != expected:
        raise RuntimeError("归因没有覆盖评测的全部样本")


def follow_up_steps() -> list[dict[str, Any]]:
    return [
        {
            "stage": "evaluate",
            "link": "query_id",
            "params": {
                "metrics": [
                    definition.name
                    for definition in registry.METRIC_DEFINITIONS
                    if definition.kind == registry.KIND_DETERMINISTIC
                ],
            },
        },
        {"stage": "attribute", "link": "eval_id", "params": {"use_model": False}},
    ]


def build(params: dict[str, Any], connection) -> list[dict[str, Any]]:
    dataset = str(params.get("dataset") or DATASETS[0])
    if dataset not in DATASETS:
        raise ValueError(f"链路测试仅支持 {DATASETS}")
    if data_store.get_dataset(connection, dataset) is None:
        raise ValueError(f"请先归一化 {dataset}")
    sample_id = str(params.get("sample_id") or "").strip()
    if not sample_id:
        raise ValueError("请选择一个测试样本")
    sample = data_store.get_sample(connection, sample_id)
    if sample is None or sample["dataset"] != dataset:
        raise ValueError(f"{dataset} 里没有样本 {sample_id!r}")

    gold_count = len(sample["gold_doc_ids"])
    if gold_count > 5:
        raise ValueError(
            f"所选问题有 {gold_count} 篇 gold 文档，无法补成固定 5 篇测试语料"
        )
    negatives_ratio = (5 - gold_count) / gold_count if gold_count else 0.0

    run_id = naming.smoke_name(connection, dataset)
    available_metrics = registry.available(get_adapter(dataset).provides)
    with_judge = bool(params.get("with_judge", False))
    metrics = [
        definition.name
        for definition in available_metrics
        if with_judge or definition.kind == registry.KIND_DETERMINISTIC
    ]
    evaluate_params: dict[str, Any] = {
        "metrics": metrics,
        "ks": [2],
    }
    if params.get("judge_provider_id"):
        evaluate_params["judge_provider_id"] = params["judge_provider_id"]

    return [
        {
            "stage": "compile",
            "params": {
                "run_id": run_id,
                "datasets": [dataset],
                "qa_limit": 1,
                "sample_ids": [sample_id],
                "negatives_ratio": negatives_ratio,
                "seed": params.get("seed") or compile.default_seed(),
            },
        },
        {"stage": "query", "link": "compile_id", "params": {}},
        {"stage": "evaluate", "link": "query_id", "params": evaluate_params},
        {
            "stage": "attribute",
            "link": "eval_id",
            "params": {
                "use_model": bool(params.get("use_model", False)),
                "provider_id": params.get("provider_id"),
            },
        },
    ]
