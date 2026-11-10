from __future__ import annotations

import re
import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from .model_configs import feature_of
from .store import (
    attribution_store,
    compile_store,
    config_store,
    eval_store,
    query_store,
)

_CHILD_LOOKUPS: dict[str, Callable[[sqlite3.Connection, str], dict[str, Any] | None]] = {
    "q": query_store.query_run_by_name,
    "e": eval_store.eval_run_by_name,
    "a": attribution_store.attribution_run_by_name,
}

_UNSAFE = re.compile(r"[^0-9a-z一-鿿]+")


def _today() -> str:
    return datetime.now(UTC).strftime("%m%d")


def _slug(value: str) -> str:
    return _UNSAFE.sub("", value.lower())


def model_slug(
    connection: sqlite3.Connection, configs: dict[str, Any], feature: str
) -> str:
    config = feature_of(configs, feature) or {}
    model = str(config.get("model") or "")
    if not model:
        return "unknown"
    label = config_store.remote_label_map(connection).get(
        (feature, model, str(config.get("baseUrl") or "")), model
    )
    return _slug(label) or _slug(model) or "unknown"


def query_slug(connection: sqlite3.Connection, configs: dict[str, Any]) -> str:
    return "-".join(
        model_slug(connection, configs, feature) for feature in ("embedding", "answer")
    )


def _pick(candidate: Callable[[int], str], taken: Callable[[str], bool]) -> str:
    index = 1
    while taken(name := candidate(index)):
        index += 1
    return name


def _unique_compile(connection: sqlite3.Connection, stem: str) -> str:
    return _pick(
        lambda index: stem if index == 1 else f"{stem}-{index}",
        lambda name: compile_store.compile_run_by_run_id(connection, name) is not None,
    )


def compile_name(
    connection: sqlite3.Connection, *, datasets: list[str], model: str
) -> str:
    return _unique_compile(connection, f"{'+'.join(datasets)}-{model}-{_today()}")


def smoke_name(connection: sqlite3.Connection, dataset: str) -> str:
    return _unique_compile(connection, f"smoke-{dataset}-{_today()}")


def child_name(
    connection: sqlite3.Connection, parent: str, tag: str, model: str = ""
) -> str:
    lookup = _CHILD_LOOKUPS[tag]
    suffix = f"-{model}" if model else ""
    return _pick(
        lambda index: f"{parent}-{tag}{index}{suffix}",
        lambda name: lookup(connection, name) is not None,
    )


def space_slug(run_id: str) -> str:
    return f"bench{''.join(c for c in run_id if c.isascii() and c.isalnum())}"[:64]
