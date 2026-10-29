from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any

from akasha_benchmark.metrics import registry
from akasha_benchmark.model_configs import feature_of
from akasha_benchmark.store import (
    attribution_store,
    compile_store,
    config_store,
    eval_store,
    loads,
    query_store,
)

_MISSING = object()


@dataclass(frozen=True, slots=True)
class _Lookups:
    compile_stats: dict[int, list[dict[str, Any]]]
    compile_samples: dict[int, dict[str, int]]
    queries_by_compile: dict[int, list[dict[str, Any]]]
    evals_by_query: dict[int, list[dict[str, Any]]]
    attributions_by_eval: dict[int, list[dict[str, Any]]]
    query_stats: dict[int, list[dict[str, Any]]]
    query_sample_counts: dict[int, int]
    eval_samples: dict[int, list[dict[str, Any]]]
    verdicts: dict[tuple[int, str, str], str | None]
    attribution_counts: dict[int, dict[str, Any]]
    provider_labels: dict[int, str]
    config_labels: dict[tuple[str, str, str], str]
    embed_runs: dict[int, list[tuple[str, int | None]]]


def build_compile_tree(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    compile_rows = compile_store.list_compile_runs(connection)
    compile_stats = _grouped(
        [
            dict(row)
            for row in connection.execute(
                """
                SELECT cd.compile_id, cd.dataset, COUNT(*) AS docs,
                       SUM(cd.page_id IS NOT NULL) AS imported, SUM(cd.is_gold) AS gold
                FROM compile_doc cd
                GROUP BY cd.compile_id, cd.dataset
                """
            )
        ],
        "compile_id",
    )
    compile_samples: dict[int, dict[str, int]] = {}
    for row in connection.execute(
        """
        SELECT cs.compile_id, s.dataset, COUNT(*) AS samples
        FROM compile_sample cs JOIN sample s ON s.sample_id = cs.sample_id
        GROUP BY cs.compile_id, s.dataset
        """
    ):
        compile_samples.setdefault(int(row["compile_id"]), {})[row["dataset"]] = int(row["samples"])
    query_stats = _grouped(query_store.all_query_stats(connection), "query_id")
    query_sample_counts = {
        int(row["query_id"]): int(row["samples"])
        for row in connection.execute(
            "SELECT query_id, COUNT(*) AS samples FROM query_sample GROUP BY query_id"
        )
    }
    eval_samples = _grouped(
        [dict(row) for row in connection.execute("SELECT eval_id, sample_id, http_status FROM sample_eval")],
        "eval_id",
    )
    verdicts = {
        (int(row["eval_id"]), row["sample_id"], row["metric"]): row["failure_kind"]
        for row in connection.execute(
            "SELECT eval_id, sample_id, metric, failure_kind FROM judge_verdict"
        )
    }
    attribution_counts = {
        int(row["attribution_id"]): dict(row)
        for row in connection.execute(
                """
                SELECT ar.id AS attribution_id,
                       COALESCE(samples.samples, 0) AS samples,
                       COALESCE(results.succeeded, 0) AS succeeded
                FROM attribution_run ar
                LEFT JOIN (
                    SELECT eval_id, COUNT(*) AS samples
                    FROM sample_eval GROUP BY eval_id
                ) samples ON samples.eval_id = ar.eval_id
                LEFT JOIN (
                SELECT attribution_id, COUNT(*) AS succeeded
                FROM attribution_result GROUP BY attribution_id
            ) results ON results.attribution_id = ar.id
            """
        )
    }
    provider_labels = {
        int(row["id"]): row["label"]
        for row in connection.execute("SELECT id, label FROM model_provider")
    }
    config_labels = config_store.remote_label_map(connection)
    embed_runs: dict[int, list[tuple[str, int | None]]] = {}
    for row in connection.execute(
        """
        SELECT json_extract (params_json, '$.compile_id') AS compile_id,
               json_extract (params_json, '$.embedding_concurrency') AS concurrency,
               finished_at
        FROM task
        WHERE stage = 'embed' AND status = 'succeeded' AND finished_at IS NOT NULL
          AND json_extract (params_json, '$.compile_id') IS NOT NULL
        ORDER BY finished_at
        """
    ):
        embed_runs.setdefault(int(row["compile_id"]), []).append(
            (
                str(row["finished_at"]),
                None if row["concurrency"] is None else int(row["concurrency"]),
            )
        )

    lookups = _Lookups(
        compile_stats=compile_stats,
        compile_samples=compile_samples,
        queries_by_compile=_grouped(query_store.list_query_runs(connection), "compile_id"),
        evals_by_query=_grouped(eval_store.list_eval_runs(connection), "query_id"),
        attributions_by_eval=_grouped(
            attribution_store.list_attribution_runs(connection), "eval_id"
        ),
        query_stats=query_stats,
        query_sample_counts=query_sample_counts,
        eval_samples=eval_samples,
        verdicts=verdicts,
        attribution_counts=attribution_counts,
        provider_labels=provider_labels,
        config_labels=config_labels,
        embed_runs=embed_runs,
    )
    return [_compile_view(row, lookups) for row in compile_rows]


def _compile_view(row: dict[str, Any], lookups: _Lookups) -> dict[str, Any]:
    compile_id = int(row["id"])
    stats = {
        item["dataset"]: {key: value for key, value in item.items() if key != "compile_id"}
        for item in lookups.compile_stats.get(compile_id, [])
    }
    for dataset, count in lookups.compile_samples.get(compile_id, {}).items():
        stats.setdefault(dataset, {"dataset": dataset})["samples"] = count
    missing = sum(
        int(item.get("docs") or 0) - int(item.get("imported") or 0) for item in stats.values()
    )
    configs = loads(row["model_configs_json"], {})
    return {
        **public_run(row),
        "model_label": _remote_model_label(configs, "compiler", lookups.config_labels),
        "embedding_label": _remote_model_label(configs, "embedding", lookups.config_labels),
        "datasets": loads(row["datasets_json"], []),
        "stats": stats,
        "quality": loads(row["quality_json"]),
        "pace": loads(row["pace_json"]),
        "readiness": compile_store.compile_readiness(row, missing=missing),
        "compiled_pages": _compiled_pages(row, stats),
        "queries": [
            _query_view(query, lookups)
            for query in lookups.queries_by_compile.get(compile_id, [])
        ],
    }


def _query_view(row: dict[str, Any], lookups: _Lookups) -> dict[str, Any]:
    query_id = int(row["id"])
    stats = {
        item["dataset"]: {key: value for key, value in item.items() if key != "query_id"}
        for item in lookups.query_stats.get(query_id, [])
    }
    response_count = sum(int(item["responses"] or 0) for item in stats.values())
    configs = loads(row["model_configs_json"], {})
    embedding = feature_of(configs, "embedding") or {}
    return {
        **public_run(row),
        "model_label": _remote_model_label(configs, "answer", lookups.config_labels),
        "embedding_label": _remote_model_label(configs, "embedding", lookups.config_labels),
        "embedding_model": str(embedding["model"]) if embedding.get("model") else None,
        "embedding_concurrency": _embed_concurrency_at(
            lookups.embed_runs.get(int(row["compile_id"]), []), str(row["created_at"])
        ),
        "sample_count": lookups.query_sample_counts.get(query_id, 0) or response_count,
        "success_count": sum(
            int(item["responses"] or 0) - int(item["failures"] or 0)
            for item in stats.values()
        ),
        "stats": stats,
        "evals": [
            _eval_view(evaluation, lookups)
            for evaluation in lookups.evals_by_query.get(query_id, [])
        ],
    }


def _eval_view(row: dict[str, Any], lookups: _Lookups) -> dict[str, Any]:
    eval_id = int(row["id"])
    samples = lookups.eval_samples.get(eval_id, [])
    metrics = [
        name for name in loads(row["metrics_json"], []) if name in registry.METRIC_REGISTRY
    ]
    judge_metrics = {
        name for name in metrics if registry.get_metric(name).kind == registry.KIND_JUDGE
    }
    succeeded = sum(
        1
        for sample in samples
        if 200 <= int(sample["http_status"] or 0) < 300
        and all(
            lookups.verdicts.get((eval_id, sample["sample_id"], metric), _MISSING) is None
            for metric in judge_metrics
        )
    )
    return {
        **public_run(row),
        "model_label": (
            lookups.provider_labels.get(int(row["judge_provider_id"]))
            if row.get("judge_provider_id") is not None
            else "确定性指标"
        ),
        "sample_count": len(samples),
        "success_count": succeeded,
        "ks": loads(row["ks_json"], []),
        "metrics": metrics,
        "attributions": [
            {
                **public_run(attribution),
                "model_label": (
                    lookups.provider_labels.get(int(attribution["report_provider_id"]))
                    if attribution.get("report_provider_id") is not None
                    else "规则归因"
                ),
                "sample_count": int(counts.get("samples") or 0),
                "success_count": int(counts.get("succeeded") or 0),
            }
            for attribution in lookups.attributions_by_eval.get(eval_id, [])
            for counts in [lookups.attribution_counts.get(int(attribution["id"]), {})]
        ],
    }


def _embed_concurrency_at(
    runs: list[tuple[str, int | None]], started_at: str
) -> int | None:
    picked = [value for finished_at, value in runs if finished_at <= started_at]
    return picked[-1] if picked else None


def _grouped(rows: list[dict[str, Any]], key: str) -> dict[int, list[dict[str, Any]]]:
    grouped: dict[int, list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(int(row[key]), []).append(row)
    return grouped


def _compiled_pages(run: dict[str, Any], stats: dict[str, Any]) -> int | None:
    quality = loads(run["quality_json"]) or {}
    succeeded = (quality.get("progress") or {}).get("succeeded")
    if isinstance(succeeded, int) and not isinstance(succeeded, bool):
        return succeeded
    if quality.get("passed") is True:
        return sum(int(item.get("imported") or 0) for item in stats.values())
    return None


def public_run(row: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in row.items() if not key.endswith("_json")}


def _remote_model_label(
    configs: dict[str, Any], feature: str, config_labels: dict[tuple[str, str, str], str]
) -> str | None:
    config = feature_of(configs, feature) or {}
    if not config.get("model"):
        return None
    model = str(config["model"])
    return config_labels.get((feature, model, str(config.get("baseUrl") or "")), model)
