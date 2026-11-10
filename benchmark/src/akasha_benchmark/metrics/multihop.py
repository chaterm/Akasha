from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from typing import Any

ORIGIN_GRAPH = "graph"


def snippet_doc_ids(snippet: dict[str, Any], page_to_doc: dict[str, str]) -> set[str]:
    return {
        page_to_doc[window["sourcePageId"]]
        for window in snippet.get("sourceWindows") or []
        if window.get("sourcePageId") in page_to_doc
    }


def is_graph(snippet: dict[str, Any]) -> bool:
    return snippet.get("origin") == ORIGIN_GRAPH


def knowledge_page_of(snippet: dict[str, Any]) -> str:
    return str(snippet.get("knowledgePageId") or snippet.get("id") or "")


def chunk_of(snippet: dict[str, Any]) -> str:
    return str(snippet.get("id") or snippet.get("knowledgePageId") or "")


def evaluate_sample(
    snippets: Sequence[dict[str, Any]], gold: Sequence[str], page_to_doc: dict[str, str]
) -> dict[str, Any]:
    gold_set = set(gold)
    origin_counts: Counter[str] = Counter()
    origin_docs: dict[str, set[str]] = {}

    graph_gold_snippets = 0
    graph_docs: set[str] = set()
    gold_only_from_graph: set[tuple[str, str]] = set()
    gold_from_other: set[tuple[str, str]] = set()

    for snippet in snippets:
        docs = snippet_doc_ids(snippet, page_to_doc)
        hits = docs & gold_set
        pairs = {(chunk_of(snippet), doc) for doc in hits}
        origin = str(snippet.get("origin") or "unknown")
        origin_counts[origin] += 1
        origin_docs.setdefault(origin, set()).update(docs)

        if is_graph(snippet):
            graph_docs |= docs
            if hits:
                graph_gold_snippets += 1
            gold_only_from_graph |= pairs
        else:
            gold_from_other |= pairs

    graph_exclusive_gold = {doc for _, doc in gold_only_from_graph - gold_from_other}

    return {
        "graph_neighbor_gold_snippets": graph_gold_snippets,
        "graph_neighbor_precision": (
            len(graph_docs & gold_set) / len(graph_docs) if graph_docs else 0.0
        ),
        "origin_counts": dict(origin_counts),
        "origin_doc_counts": {o: len(d) for o, d in sorted(origin_docs.items())},
        "graph_exclusive_gold_share": (
            len(graph_exclusive_gold) / len(gold_set) if gold_set else 0.0
        ),
    }
