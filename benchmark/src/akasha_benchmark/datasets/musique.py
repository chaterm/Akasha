from __future__ import annotations

from typing import Any, ClassVar

from .base import DatasetAdapter
from .common import require_answer, require_native_id
from .corpus import CorpusIndex
from .models import CanonicalSample, DataDependency, SubsetStrategy, make_sample_id

HOP_PREFIXES = ("2hop", "3hop1", "3hop2", "4hop1", "4hop2", "4hop3")


def hop_prefix(dataset_sample_id: str) -> str:
    prefix = dataset_sample_id.split("__", 1)[0]
    if prefix not in HOP_PREFIXES:
        raise ValueError(f"musique: unrecognized hop prefix {prefix!r} in id {dataset_sample_id!r}")
    return prefix


def hop_count(prefix: str) -> int:
    return int(prefix[0])


class MusiqueAdapter(DatasetAdapter):
    name: ClassVar[str] = "musique"
    qa_filename: ClassVar[str] = "musique.json"
    corpus_filename: ClassVar[str] = "musique_corpus.json"
    provides: ClassVar[frozenset[DataDependency]] = frozenset(
        {DataDependency.GOLD_DOCS, DataDependency.REFERENCE_ANSWERS}
    )
    subset_strategy: ClassVar[SubsetStrategy] = SubsetStrategy.STRATIFIED_HOP

    def expected_qa_rows(self) -> int:
        return 1000

    def parse_row(
        self, row: dict[str, Any], row_index: int, corpus: CorpusIndex
    ) -> CanonicalSample:
        native_id = require_native_id(row, row_index, self.name, "id")
        answer = require_answer(row, row_index, self.name)

        paragraphs = row.get("paragraphs")
        if not isinstance(paragraphs, list) or not paragraphs:
            raise ValueError(f"{self.name}: row {row_index} has empty or non-list paragraphs")

        gold_ids: dict[str, None] = {}
        ambiguous_titles = 0
        support_doc_ids: dict[int, str] = {}
        for para in paragraphs:
            if not para.get("is_supporting"):
                continue
            title, text = para["title"], para["paragraph_text"]
            try:
                doc_id = corpus.id_for_pair(title, text)
            except KeyError as exc:
                raise ValueError(f"{self.name}: row {row_index} gold unresolvable: {exc}") from None

            if len(corpus.title_to_ids.get(title, ())) > 1:
                ambiguous_titles += 1
            gold_ids.setdefault(doc_id, None)
            support_doc_ids[int(para["idx"])] = doc_id

        if not gold_ids:
            raise ValueError(f"{self.name}: row {row_index} has no is_supporting paragraph")

        answers: dict[str, None] = {answer: None}
        for alias in row.get("answer_aliases") or []:
            if isinstance(alias, str) and alias:
                answers.setdefault(alias, None)

        prefix = hop_prefix(native_id)
        steps = row.get("question_decomposition") or []
        decomposition = []
        for step in steps:
            support_idx = step.get("paragraph_support_idx")
            support = (
                paragraphs[support_idx]
                if isinstance(support_idx, int) and 0 <= support_idx < len(paragraphs)
                else None
            )
            decomposition.append(
                {
                    "id": step.get("id"),
                    "question": step.get("question"),
                    "answer": step.get("answer"),
                    "support_doc_id": support_doc_ids.get(support_idx),
                    "support_title": support.get("title") if support else None,
                }
            )
        return CanonicalSample(
            dataset=self.name,
            sample_id=make_sample_id(self.name, native_id),
            dataset_sample_id=native_id,
            question=row["question"],
            answers=tuple(answers),
            gold_doc_ids=tuple(gold_ids),
            metadata={
                "hop_prefix": prefix,
                "hop_count": hop_count(prefix),
                "gold_count": len(gold_ids),
                "answerable": row.get("answerable"),
                "alias_count": len(answers) - 1,
                "decomposition_steps": len(steps),
                "gold_with_ambiguous_title": ambiguous_titles,
                "question_decomposition": decomposition,
            },
        )
