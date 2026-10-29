from __future__ import annotations

from typing import Any

FEATURES = ("compiler", "embedding", "answer", "image")


_FIELDS = ("feature", "model", "baseUrl", "parameters")


def normalize(model_configs: dict[str, Any]) -> list[dict[str, Any]]:
    entries = model_configs.get("configs") or []
    cleaned = [
        {field: entry.get(field) for field in _FIELDS}
        for entry in entries
        if isinstance(entry, dict)
    ]
    return sorted(cleaned, key=lambda e: str(e.get("feature")))


def feature_of(model_configs: dict[str, Any], feature: str) -> dict[str, Any] | None:
    for entry in normalize(model_configs):
        if entry.get("feature") == feature:
            return entry
    return None


def matches(left: dict[str, Any], right: dict[str, Any], feature: str) -> bool:
    return feature_of(left, feature) == feature_of(right, feature)


def drift(current: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, bool]:
    return {feature: not matches(current, snapshot, feature) for feature in FEATURES}
