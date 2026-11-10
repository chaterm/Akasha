from __future__ import annotations

from typing import Any

from .base import DatasetAdapter
from .common import require_native_id
from .corpus import CorpusIndex
from .models import CanonicalSample, DataDependency, SubsetStrategy, make_sample_id


class LocalAdapter(DatasetAdapter):
    provides = frozenset({DataDependency.GOLD_DOCS, DataDependency.REFERENCE_ANSWERS})
    subset_strategy = SubsetStrategy.QA_THEN_GOLD
    downloadable = False

    def __init__(self, name: str) -> None:
        self.name = name
        self.qa_filename = f"{name}.json"
        self.corpus_filename = f"{name}_corpus.json"

    def parse_row(
        self, row: dict[str, Any], row_index: int, corpus: CorpusIndex
    ) -> CanonicalSample:
        native_id = require_native_id(row, row_index, self.name, "id")
        for key in ("question", "answer"):
            value = row.get(key)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{self.name}: row {row_index} {key} is not a non-empty string")

        evidence = row.get("evidence")
        if not isinstance(evidence, list) or not evidence:
            raise ValueError(
                f"{self.name}: row {row_index} 没有 evidence，请在数据集页用样本生成模型重新生成"
            )
        gold: dict[str, None] = {}
        for item in evidence:
            doc_id = item.get("doc_id") if isinstance(item, dict) else None
            if not isinstance(doc_id, str) or doc_id not in corpus.by_id:
                raise ValueError(f"{self.name}: row {row_index} evidence doc_id {doc_id!r} 不在语料里")
            gold.setdefault(doc_id, None)

        return CanonicalSample(
            dataset=self.name,
            sample_id=make_sample_id(self.name, native_id),
            dataset_sample_id=native_id,
            question=row["question"],
            answers=(row["answer"],),
            gold_doc_ids=tuple(gold),
            metadata={
                "evidence": evidence,
                "gold_count": len(gold),
                "answer_chars": len(row["answer"]),
            },
        )
