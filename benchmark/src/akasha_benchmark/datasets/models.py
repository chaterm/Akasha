from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator

CORPUS_ID_RULES: dict[str, str] = {
    "hotpotqa": "idx",
    "2wikimultihopqa": "row_idx",
    "musique": "row_idx",
    "narrativeqa": "idx",
}


SAMPLE_ID_RULES: dict[str, str] = {
    "hotpotqa": "native_id",
    "2wikimultihopqa": "native_id",
    "musique": "native_id",
    "narrativeqa": "row_idx",
}

LOCAL_CORPUS_ID_RULE = "id"
LOCAL_SAMPLE_ID_RULE = "native_id"


def corpus_id_rule(dataset: str) -> str:
    return CORPUS_ID_RULES.get(dataset, LOCAL_CORPUS_ID_RULE)


def sample_id_rule(dataset: str) -> str:
    return SAMPLE_ID_RULES.get(dataset, LOCAL_SAMPLE_ID_RULE)


class DependencyError(RuntimeError):
    pass


class SubsetStrategy(StrEnum):
    QA_THEN_GOLD = "uniform_qa_then_gold_corpus"

    STRATIFIED_HOP = "stratified_by_hop"

    WHOLE_DOCS = "whole_documents"


class DataDependency(StrEnum):
    GOLD_DOCS = "gold_docs"

    REFERENCE_ANSWERS = "reference_answers"


class CanonicalSample(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    dataset: str
    sample_id: str
    dataset_sample_id: str
    question: str
    answers: tuple[str, ...]
    gold_doc_ids: tuple[str, ...]
    metadata: dict[str, Any]

    @field_validator("answers")
    @classmethod
    def _answers_nonempty(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if not value:
            raise ValueError("answers must hold at least one reference answer")
        return value

    @field_validator("sample_id", "dataset_sample_id", "question", "dataset")
    @classmethod
    def _no_blanks(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value


class CorpusDoc(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    doc_id: str
    title: str
    text: str

    def to_markdown(self) -> str:
        first = self.text.lstrip().splitlines()[0] if self.text.strip() else ""
        if first == f"# {self.title}":
            return f"{self.text.strip()}\n"
        return f"# {self.title}\n\n{self.text}\n"


def make_sample_id(dataset: str, dataset_sample_id: str) -> str:
    return f"{dataset}:{dataset_sample_id}"
