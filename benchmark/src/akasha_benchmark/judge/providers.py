import sqlite3

from ..store import config_store
from .client import JudgeConfigError, JudgeProvider


def resolve_provider(
    connection: sqlite3.Connection, provider_id: int | None, purpose: str
) -> JudgeProvider:
    if provider_id is not None:
        record = config_store.get_model_provider(connection, provider_id)
        if record is None:
            raise JudgeConfigError(f"模型端点 #{provider_id} 已不存在")
    else:
        candidates = config_store.list_model_providers(connection, purpose)
        if not candidates:
            raise JudgeConfigError(f"没有配置 {purpose} 模型端点，请在配置页填写。")
        record = candidates[0]
    if record["purpose"] != purpose:
        raise JudgeConfigError(f"模型端点 {record['label']!r} 的用途不是 {purpose}")
    if not (record["api_key"] or "").strip():
        raise JudgeConfigError(f"模型端点 {record['label']!r} 没有 api key。")
    return JudgeProvider(
        provider_id=record["id"],
        base_url=record["base_url"],
        model=record["model"],
        api_key=record["api_key"],
    )
