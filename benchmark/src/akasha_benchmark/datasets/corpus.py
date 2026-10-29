from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Any

from ..io_utils import load_json
from .models import CorpusDoc, corpus_id_rule


class CorpusIndex:
    def __init__(self, dataset: str, docs: list[CorpusDoc]) -> None:
        self.dataset = dataset
        self.docs = docs

        self.by_id: dict[str, CorpusDoc] = {}
        for doc in docs:
            if doc.doc_id in self.by_id:
                raise ValueError(
                    f"{dataset}: duplicate doc_id {doc.doc_id!r}; "
                    f"corpus identity rule {corpus_id_rule(dataset)!r} is not unique"
                )
            self.by_id[doc.doc_id] = doc

        self.title_to_ids: dict[str, list[str]] = defaultdict(list)
        self.pair_to_id: dict[tuple[str, str], str] = {}
        collisions: list[tuple[str, str]] = []
        for doc in docs:
            self.title_to_ids[doc.title].append(doc.doc_id)
            key = (doc.title, doc.text)
            if key in self.pair_to_id:
                collisions.append(key)
            else:
                self.pair_to_id[key] = doc.doc_id

        if collisions:
            title, text = collisions[0]
            raise ValueError(
                f"{dataset}: {len(collisions)} duplicate (title, text) pairs, "
                f"e.g. title={title!r} text[:80]={text[:80]!r}. "
                "No unique corpus key remains; refusing to guess."
            )

    def __len__(self) -> int:
        return len(self.docs)

    def id_for_title(self, title: str) -> str:
        ids = self.title_to_ids.get(title)
        if not ids:
            raise KeyError(f"{self.dataset}: title not in corpus: {title!r}")
        if len(ids) > 1:
            raise KeyError(
                f"{self.dataset}: title maps to {len(ids)} corpus rows: {title!r}; "
                "use id_for_pair to disambiguate"
            )
        return ids[0]

    def id_for_pair(self, title: str, text: str) -> str:
        try:
            return self.pair_to_id[(title, text)]
        except KeyError:
            raise KeyError(
                f"{self.dataset}: (title, text) not in corpus: title={title!r} "
                f"text[:80]={text[:80]!r}"
            ) from None


def assign_doc_id(dataset: str, row: dict[str, Any], row_index: int) -> str:
    field = corpus_id_rule(dataset)
    if field == "row_idx":
        present = sorted({"idx", "id"} & row.keys())
        if present:
            raise ValueError(
                f"{dataset}: corpus row {row_index} unexpectedly has {present} "
                "while its identity rule is 'row_idx'; re-check the data version"
            )
        return str(row_index)
    if field not in row:
        raise ValueError(
            f"{dataset}: corpus row {row_index} has no {field!r} but that is its "
            "declared identity field; upstream data shape changed"
        )
    return str(row[field])


def load_corpus(dataset: str, path: Path) -> CorpusIndex:
    rows = load_json(path)
    if not isinstance(rows, list):
        raise ValueError(f"{path}: expected a JSON array, got {type(rows).__name__}")

    docs: list[CorpusDoc] = []
    for row_index, row in enumerate(rows):
        missing = {"title", "text"} - row.keys()
        if missing:
            raise ValueError(f"{path}: row {row_index} missing {sorted(missing)}")
        docs.append(
            CorpusDoc(
                doc_id=assign_doc_id(dataset, row, row_index),
                title=row["title"],
                text=row["text"],
            )
        )
    return CorpusIndex(dataset, docs)
