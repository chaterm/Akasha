from __future__ import annotations

import re
from pathlib import Path

from .base import DatasetAdapter
from .hotpotqa import HotpotQAAdapter
from .local import LocalAdapter
from .musique import MusiqueAdapter
from .narrativeqa import NarrativeQAAdapter
from .two_wiki import TwoWikiMultihopQAAdapter

REPO_ROOT = Path(__file__).resolve().parents[3]
DATASET_DIR = REPO_ROOT / "dataset"

_LOOKUP: dict[str, type[DatasetAdapter]] = {
    cls.name: cls
    for cls in (HotpotQAAdapter, TwoWikiMultihopQAAdapter, MusiqueAdapter, NarrativeQAAdapter)
}
DATASET_NAMES: tuple[str, ...] = tuple(_LOOKUP)

LOCAL_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")
_CORPUS_SUFFIX = "_corpus.json"


def dataset_dir() -> Path:
    return DATASET_DIR


def is_local_name(name: str) -> bool:
    return bool(LOCAL_NAME.fullmatch(name)) and name not in _LOOKUP


def local_names(directory: Path | None = None) -> tuple[str, ...]:
    root = directory or DATASET_DIR
    if not root.is_dir():
        return ()
    stems = (p.name.removesuffix(_CORPUS_SUFFIX) for p in root.glob(f"*{_CORPUS_SUFFIX}"))
    return tuple(sorted(s for s in stems if is_local_name(s)))


def dataset_names() -> tuple[str, ...]:
    return (*DATASET_NAMES, *local_names())


def get_adapter(name: str) -> DatasetAdapter:
    if name in _LOOKUP:
        return _LOOKUP[name]()
    if is_local_name(name):
        return LocalAdapter(name)
    raise KeyError(f"unknown dataset {name!r}. Known: {', '.join(dataset_names())}")


def all_adapters() -> tuple[DatasetAdapter, ...]:
    return (*(cls() for cls in _LOOKUP.values()), *(LocalAdapter(n) for n in local_names()))
