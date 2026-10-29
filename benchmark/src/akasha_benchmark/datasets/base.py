from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, ClassVar

from .corpus import CorpusIndex
from .models import (
    CanonicalSample,
    DataDependency,
    SubsetStrategy,
    corpus_id_rule,
    sample_id_rule,
)


class DatasetAdapter(ABC):
    name: ClassVar[str]
    qa_filename: ClassVar[str]
    corpus_filename: ClassVar[str]
    provides: ClassVar[frozenset[DataDependency]]
    subset_strategy: ClassVar[SubsetStrategy]
    downloadable: ClassVar[bool] = True

    def has(self, dependency: DataDependency) -> bool:
        return dependency in self.provides

    def identity_rules(self) -> dict[str, str]:
        return {
            "sample_id": sample_id_rule(self.name),
            "corpus_doc_id": corpus_id_rule(self.name),
        }

    @abstractmethod
    def parse_row(
        self, row: dict[str, Any], row_index: int, corpus: CorpusIndex
    ) -> CanonicalSample:
        pass

    def expected_qa_rows(self) -> int | None:
        return None
