from __future__ import annotations

from collections.abc import Sequence
from math import log2
from typing import Any

DEFAULT_KS: tuple[int, ...] = (2, 5, 10, 20)


def ranked_doc_ids(retrieved: Sequence[dict[str, Any]], page_to_doc: dict[str, str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for source in retrieved:
        page_id = source.get("sourcePageId")
        if not page_id:
            continue
        doc_id = page_to_doc.get(page_id)
        key = doc_id if doc_id is not None else f"__unmapped__:{page_id}"
        if key in seen:
            continue
        seen.add(key)
        ordered.append(key)
    return ordered


def unmapped_page_ids(
    retrieved: Sequence[dict[str, Any]], page_to_doc: dict[str, str]
) -> list[str]:
    return sorted(
        {
            s["sourcePageId"]
            for s in retrieved
            if s.get("sourcePageId") and s["sourcePageId"] not in page_to_doc
        }
    )


def recall_at_k(ranked: Sequence[str], gold: Sequence[str], k: int) -> float:
    gold_set = set(gold)
    if not gold_set:
        raise ValueError("recall_at_k requires at least one gold document")
    return len(gold_set & set(ranked[:k])) / len(gold_set)


def precision_at_k(ranked: Sequence[str], gold: Sequence[str], k: int) -> float:
    if not set(gold):
        raise ValueError("precision_at_k requires at least one gold document")
    top = list(ranked[:k])
    if not top:
        return 0.0
    return len(set(top) & set(gold)) / len(top)


def retrieval_f1(ranked: Sequence[str], gold: Sequence[str]) -> float:
    gold_set = set(gold)
    if not gold_set:
        raise ValueError("retrieval_f1 requires at least one gold document")
    returned = set(ranked)
    if not returned:
        return 0.0
    hits = len(returned & gold_set)
    precision = hits / len(returned)
    recall = hits / len(gold_set)
    return 2 * precision * recall / (precision + recall) if precision + recall else 0.0


def hit_at_k(ranked: Sequence[str], gold: Sequence[str], k: int) -> float:
    return 1.0 if set(gold) & set(ranked[:k]) else 0.0


def mrr(ranked: Sequence[str], gold: Sequence[str]) -> float:
    gold_set = set(gold)
    for position, doc_id in enumerate(ranked, 1):
        if doc_id in gold_set:
            return 1.0 / position
    return 0.0


def ndcg_at_k(ranked: Sequence[str], gold: Sequence[str], k: int) -> float:
    gold_set = set(gold)
    if not gold_set:
        raise ValueError("ndcg_at_k requires at least one gold document")
    dcg = sum(1.0 / log2(rank + 1) for rank, d in enumerate(ranked[:k], 1) if d in gold_set)
    ideal = sum(1.0 / log2(rank + 1) for rank in range(1, min(len(gold_set), k) + 1))
    return dcg / ideal if ideal else 0.0


def full_coverage(ranked: Sequence[str], gold: Sequence[str], k: int) -> float:
    gold_set = set(gold)
    return 1.0 if gold_set and gold_set <= set(ranked[:k]) else 0.0


def evaluate_sample(
    ranked: Sequence[str], gold: Sequence[str], ks: Sequence[int] = DEFAULT_KS
) -> dict[str, float]:
    metrics: dict[str, float] = {
        "mrr": mrr(ranked, gold),
        "retrieval_f1": retrieval_f1(ranked, gold),
    }
    for k in ks:
        metrics[f"precision@{k}"] = precision_at_k(ranked, gold, k)
        metrics[f"recall@{k}"] = recall_at_k(ranked, gold, k)
        metrics[f"ndcg@{k}"] = ndcg_at_k(ranked, gold, k)
        metrics[f"hit@{k}"] = hit_at_k(ranked, gold, k)
        metrics[f"full_coverage@{k}"] = full_coverage(ranked, gold, k)
    return metrics
