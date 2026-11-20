from __future__ import annotations

from pathlib import Path
from typing import Any

from ..io_utils import load_json
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

MAX_LOCAL_NAME_LENGTH = 63
_CORPUS_SUFFIX = "_corpus.json"


def dataset_dir() -> Path:
    return DATASET_DIR


def is_local_name(name: str) -> bool:
    return (
        isinstance(name, str)
        and 1 <= len(name) <= MAX_LOCAL_NAME_LENGTH
        and name[0].isalnum()
        and all(char.isalnum() or char == "-" for char in name)
        and name not in _LOOKUP
    )


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


def source_space(name: str) -> dict[str, Any] | None:
    if not is_local_name(name):
        return None
    path = DATASET_DIR / LocalAdapter(name).space_filename
    return load_json(path) if path.is_file() else None


def all_adapters() -> tuple[DatasetAdapter, ...]:
    return (*(cls() for cls in _LOOKUP.values()), *(LocalAdapter(n) for n in local_names()))
