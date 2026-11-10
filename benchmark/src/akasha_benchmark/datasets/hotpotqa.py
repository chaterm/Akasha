from __future__ import annotations

from typing import Any, ClassVar

from .base import DatasetAdapter
from .common import supporting_facts_sample
from .corpus import CorpusIndex
from .models import CanonicalSample, DataDependency, SubsetStrategy


class HotpotQAAdapter(DatasetAdapter):
    name: ClassVar[str] = "hotpotqa"
    qa_filename: ClassVar[str] = "hotpotqa.json"
    corpus_filename: ClassVar[str] = "hotpotqa_corpus.json"
    provides: ClassVar[frozenset[DataDependency]] = frozenset(
        {DataDependency.GOLD_DOCS, DataDependency.REFERENCE_ANSWERS}
    )
    subset_strategy: ClassVar[SubsetStrategy] = SubsetStrategy.QA_THEN_GOLD

    def expected_qa_rows(self) -> int:
        return 1000

    def parse_row(
        self, row: dict[str, Any], row_index: int, corpus: CorpusIndex
    ) -> CanonicalSample:
        return supporting_facts_sample(
            self.name,
            row,
            row_index,
            corpus,
            {"type": row.get("type"), "level": row.get("level")},
        )
