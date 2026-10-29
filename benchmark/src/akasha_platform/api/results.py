from __future__ import annotations

from collections import Counter
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from akasha_benchmark import textdiff
from akasha_benchmark.config import load_config
from akasha_benchmark.lineage import BadPageId, LineageReader, LineageUnavailable
from akasha_benchmark.metrics.interpretation import (
    build_metric_evidence,
    interpret_sample_metrics,
)
from akasha_benchmark.store import (
    attribution_store,
    compile_store,
    data_store,
    eval_store,
    loads,
    query_store,
)

from ..run_tree import public_run
from ._common import db, reject_if_busy, writable

router = APIRouter(prefix="/api")


@router.get("/evals/{eval_id}/samples")
def eval_samples(
    request: Request,
    eval_id: int,
    dataset: str | None = None,
    answer_mode: str | None = None,
    q: str | None = None,
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    with db(request) as connection:
        if eval_store.get_eval_run(connection, eval_id) is None:
            raise HTTPException(404, f"评测 #{eval_id} 不存在")
        total, counts, rows = eval_store.sample_eval_page(
            connection,
            eval_id,
            dataset=dataset,
            answer_mode=answer_mode,
            search=(q or "").strip() or None,
            limit=limit,
            offset=offset,
        )
        sample_ids = [row["sample_id"] for row in rows]
        metrics = eval_store.sample_metrics_for(connection, eval_id, sample_ids)
        verdicts = eval_store.judge_verdicts_for(connection, eval_id, sample_ids)
        samples = [
            {
                "sample_id": row["sample_id"],
                "dataset": row["dataset"],
                "question": row["detail"].get("question", ""),
                "answer_mode": row["answer_mode"],
                "http_status": row["http_status"],
                "answer": row["answer"],
                "metrics": metrics.get(row["sample_id"], {}),
                "judge_verdicts": verdicts.get(row["sample_id"], []),
            }
            for row in rows
        ]
    return {
        "eval_id": eval_id,
        "total": total,
        "count_by_answer_mode": counts,
        "offset": offset,
        "limit": limit,
        "samples": samples,
    }


@router.get("/evals/{eval_id}")
def eval_detail(request: Request, eval_id: int) -> dict[str, Any]:
    with db(request) as connection:
        row = eval_store.get_eval_run(connection, eval_id)
        if row is None:
            raise HTTPException(404, f"评测 #{eval_id} 不存在")
        query_run = query_store.get_query_run(connection, int(row["query_id"]))

        scopes: dict[str, dict[str, dict[str, float]]] = {}
        for entry in eval_store.metric_summaries(connection, eval_id):
            scopes.setdefault(entry["dataset"], {}).setdefault(entry["scope"], {})[
                entry["metric"]
            ] = entry["value"]

        return {
            **public_run(row),
            "ks": loads(row["ks_json"], []),

            "metrics": loads(row["metrics_json"], []),
            "query": public_run(query_run or {}),
            "datasets": [
                {**entry, "scopes": scopes.get(entry["dataset"], {})}
                for entry in eval_store.dataset_evals(connection, eval_id)
            ],
            "judge": eval_store.judge_summary(connection, eval_id),
        }


@router.get("/evals/{eval_id}/samples/{sample_id}")
def sample_detail(request: Request, eval_id: int, sample_id: str) -> dict[str, Any]:
    with db(request) as connection:
        eval_run = eval_store.get_eval_run(connection, eval_id)
        if eval_run is None:
            raise HTTPException(404, f"评测 #{eval_id} 不存在")
        row = eval_store.sample_eval(connection, eval_id, sample_id)
        if row is None:
            raise HTTPException(404, f"评测 #{eval_id} 里没有样本 {sample_id!r}")
        query_id = int(eval_run["query_id"])
        query_run = query_store.get_query_run(connection, query_id) or {}
        compile_id = int(query_run.get("compile_id") or 0)
        response = query_store.response_of(connection, query_id, sample_id)
        response_body = (response or {}).get("response") or {}
        page_to_doc = compile_store.page_to_doc(connection, compile_id, row["dataset"])
        doc_to_page = {doc: page for page, doc in page_to_doc.items()}
        documents = {
            doc["doc_id"]: doc
            for doc in data_store.corpus_of(connection, row["dataset"])
        }
        metrics = eval_store.sample_metrics_of(connection, eval_id, sample_id)

        verdicts = [
            v for v in eval_store.judge_verdicts(connection, eval_id) if v["sample_id"] == sample_id
        ]
        dataset_eval = next(
            (entry for entry in eval_store.dataset_evals(connection, eval_id) if entry["dataset"] == row["dataset"]),
            None,
        )
        configured_metrics = loads(eval_run["metrics_json"], [])
        ks = loads(eval_run["ks_json"], [])
        metric_evidence = build_metric_evidence(
            configured_metrics,
            ks,
            metrics,
            row["detail"],
            response_body,
            page_to_doc,
            documents,
            verdicts,
        )
        return {
            **row,
            "metrics": metrics,
            "metric_interpretations": interpret_sample_metrics(
                configured_metrics,
                ks,
                metrics,
                row["detail"],
                verdicts,
                (dataset_eval or {}).get("omitted_metrics", []),
                metric_evidence,
            ),
            "eval_id": eval_id,
            "query_id": query_id,
            "compile_id": compile_id,
            "response": response_body,

            "gold_pages": {
                doc: doc_to_page.get(doc) for doc in row["detail"].get("gold_doc_ids") or []
            },
            "judge_verdicts": verdicts,
        }


@router.delete("/evals/{eval_id}")
def delete_eval(request: Request, eval_id: int) -> dict[str, Any]:
    with writable(request) as connection:
        if eval_store.get_eval_run(connection, eval_id) is None:
            raise HTTPException(404, f"评测 #{eval_id} 不存在")
        reject_if_busy(connection, "eval", eval_id)
        removed = eval_store.delete_eval_run(connection, eval_id)
    return {"deleted": removed}


@router.get("/attributions/{attribution_id}")
def attribution_detail(request: Request, attribution_id: int) -> dict[str, Any]:
    with db(request) as connection:
        row = attribution_store.get_attribution_run(connection, attribution_id)
        if row is None:
            raise HTTPException(404, f"归因 #{attribution_id} 不存在")
        results = attribution_store.attribution_results(connection, attribution_id)
    return {
        **public_run(row),
        "count_by_root_cause": dict(sorted(Counter(r["root_cause"] for r in results).items())),
        "results": results,
    }


@router.delete("/attributions/{attribution_id}")
def delete_attribution(request: Request, attribution_id: int) -> dict[str, Any]:
    with writable(request) as connection:
        if attribution_store.get_attribution_run(connection, attribution_id) is None:
            raise HTTPException(404, f"归因 #{attribution_id} 不存在")
        reject_if_busy(connection, "attribution", attribution_id)
        removed = attribution_store.delete_attribution_run(connection, attribution_id)
    return {"deleted": removed}


@router.get("/lineage/{page_id}")
def lineage(request: Request, page_id: str, question: str = "") -> dict[str, Any]:
    with db(request) as connection:
        config = load_config(connection)
    try:
        chain = LineageReader(config.database_url).lineage(page_id)
    except LineageUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    except BadPageId as exc:
        raise HTTPException(400, str(exc)) from exc
    return {
        **textdiff.build(chain, question),

        "artifacts": chain["artifacts"],
        "chunks": chain["chunks"],
        "source_chunks": chain["source_chunks"],
    }
