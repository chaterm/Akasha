from __future__ import annotations

from typing import Any

from .corpus import CorpusIndex
from .models import CanonicalSample, make_sample_id


def require_native_id(row: dict[str, Any], row_index: int, dataset: str, key: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{dataset}: row {row_index} has no usable {key!r}")
    return value


def require_answer(row: dict[str, Any], row_index: int, dataset: str) -> str:
    answer = row.get("answer")
    if not isinstance(answer, str) or not answer:
        raise ValueError(f"{dataset}: row {row_index} answer is not a non-empty string")
    return answer


def gold_titles_from_supporting_facts(
    row: dict[str, Any], row_index: int, dataset: str
) -> tuple[str, ...]:
    facts = row.get("supporting_facts")
    if not isinstance(facts, list) or not facts:
        raise ValueError(f"{dataset}: row {row_index} has empty or non-list supporting_facts")

    seen: dict[str, None] = {}
    for fact in facts:
        if not isinstance(fact, (list, tuple)) or len(fact) != 2:
            raise ValueError(
                f"{dataset}: row {row_index} supporting_facts entry is not "
                f"[title, sentence_index]: {fact!r}"
            )
        title = fact[0]
        if not isinstance(title, str) or not title:
            raise ValueError(f"{dataset}: row {row_index} supporting_facts title is not a string")
        seen.setdefault(title, None)
    return tuple(seen)


def resolve_gold_doc_ids(
    titles: tuple[str, ...], corpus: CorpusIndex, row_index: int, dataset: str
) -> tuple[str, ...]:
    resolved: list[str] = []
    for title in titles:
        try:
            resolved.append(corpus.id_for_title(title))
        except KeyError as exc:
            raise ValueError(f"{dataset}: row {row_index} gold unresolvable: {exc}") from None
    return tuple(resolved)


def supporting_facts_sample(
    dataset: str,
    row: dict[str, Any],
    row_index: int,
    corpus: CorpusIndex,
    metadata: dict[str, Any],
) -> CanonicalSample:
    native_id = require_native_id(row, row_index, dataset, "_id")
    answer = require_answer(row, row_index, dataset)
    titles = gold_titles_from_supporting_facts(row, row_index, dataset)
    gold_doc_ids = resolve_gold_doc_ids(titles, corpus, row_index, dataset)
    return CanonicalSample(
        dataset=dataset,
        sample_id=make_sample_id(dataset, native_id),
        dataset_sample_id=native_id,
        question=row["question"],
        answers=(answer,),
        gold_doc_ids=gold_doc_ids,
        metadata={
            **metadata,
            "gold_count": len(gold_doc_ids),
            "supporting_fact_count": len(row["supporting_facts"]),
        },
    )
