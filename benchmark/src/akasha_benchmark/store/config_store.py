from __future__ import annotations

import sqlite3
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from ..model_configs import FEATURES as AKASHA_FEATURES
from .db import dumps, utc_now

CONNECTION_FIELDS = (
    "base_url",
    "email",
    "password",
    "database_url",
    "timeout_seconds",
    "request_interval_seconds",
)

_FLOATS = {
    "timeout_seconds",
    "request_interval_seconds",
}

MODEL_ROLES = ("judge", "attribution", "generation")
MODEL_PURPOSES = (*MODEL_ROLES, *AKASHA_FEATURES)


_HOST_URLS = {"base_url", "database_url"}


def _prefer_ipv4(url: str) -> str:
    parts = urlsplit(url)
    if parts.hostname != "localhost":
        return url
    port = f":{parts.port}" if parts.port else ""
    credentials = parts.netloc.rpartition("@")[0]
    netloc = f"{credentials}@127.0.0.1{port}" if credentials else f"127.0.0.1{port}"
    return urlunsplit(parts._replace(netloc=netloc))


def get_connection_row(connection: sqlite3.Connection) -> dict[str, Any]:
    row = connection.execute("SELECT * FROM akasha_connection WHERE id = 1").fetchone()
    return dict(row) if row is not None else {}


def sanitize_connection(payload: dict[str, Any]) -> dict[str, Any]:
    cleaned: dict[str, Any] = {}
    for key, value in payload.items():
        if key not in CONNECTION_FIELDS:
            continue
        try:
            if key in _FLOATS:
                cleaned[key] = float(value)
            elif key in _HOST_URLS:
                cleaned[key] = _prefer_ipv4(str(value).strip())
            else:
                cleaned[key] = str(value)
        except (TypeError, ValueError) as exc:
            kind = "number" if key in _FLOATS else "string"
            raise ValueError(f"{key}: expected a {kind}, got {value!r}") from exc
    return cleaned


def update_connection(connection: sqlite3.Connection, **fields: Any) -> None:
    unknown = set(fields) - set(CONNECTION_FIELDS)
    if unknown:
        raise ValueError(f"unknown connection fields: {sorted(unknown)}")
    if not fields:
        return
    assignments = ", ".join(f"{name} = ?" for name in fields)
    connection.execute(
        f"UPDATE akasha_connection SET {assignments}, updated_at = ? WHERE id = 1",
        (*fields.values(), utc_now()),
    )


def upsert_model_provider(
    connection: sqlite3.Connection,
    *,
    purpose: str,
    label: str,
    base_url: str,
    model: str,
    api_key: str,
    parameters: dict[str, Any] | None = None,
    model_id: int | None = None,
) -> int:
    if purpose not in MODEL_PURPOSES:
        raise ValueError(f"purpose must be one of {MODEL_PURPOSES}")
    values = (
        purpose,
        label,
        base_url,
        model,
        api_key,
        dumps(parameters or {}),
        utc_now(),
    )
    if model_id is not None:
        connection.execute(
            """
            UPDATE model_provider
               SET purpose = ?, label = ?, base_url = ?, model = ?, api_key = ?,
                   parameters_json = ?, updated_at = ?
             WHERE id = ?
            """,
            (*values, model_id),
        )
        return model_id
    connection.execute(
        """
        INSERT INTO model_provider
            (purpose, label, base_url, model, api_key, parameters_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(purpose, label) DO UPDATE SET
            base_url = excluded.base_url,
            model = excluded.model,
            api_key = excluded.api_key,
            parameters_json = excluded.parameters_json,
            updated_at = excluded.updated_at
        """,
        values,
    )
    row = connection.execute(
        "SELECT id FROM model_provider WHERE purpose = ? AND label = ?",
        (purpose, label),
    ).fetchone()
    return int(row["id"])


def list_model_providers(
    connection: sqlite3.Connection, purpose: str | None = None
) -> list[dict[str, Any]]:
    sql = "SELECT * FROM model_provider"
    params: tuple[Any, ...] = ()
    if purpose is not None:
        sql += " WHERE purpose = ?"
        params = (purpose,)
    return [
        dict(row)
        for row in connection.execute(
            sql + " ORDER BY purpose, updated_at DESC, id DESC", params
        )
    ]


def remote_label_map(connection: sqlite3.Connection) -> dict[tuple[str, str, str], str]:
    return {
        (row["purpose"], row["model"], row["base_url"]): row["label"]
        for row in connection.execute("SELECT purpose, label, model, base_url FROM model_provider")
    }


def get_model_provider(connection: sqlite3.Connection, model_id: int) -> dict[str, Any] | None:
    row = connection.execute("SELECT * FROM model_provider WHERE id = ?", (model_id,)).fetchone()
    return dict(row) if row else None


def delete_model_provider(connection: sqlite3.Connection, model_id: int) -> int:
    return connection.execute(
        "DELETE FROM model_provider WHERE id=?", (model_id,)
    ).rowcount
