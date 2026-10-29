from __future__ import annotations

import sqlite3
from dataclasses import dataclass, fields
from typing import Any

from .store import config_store

API_PREFIX = "/api"


@dataclass(frozen=True)
class AkashaConfig:
    base_url: str = "http://127.0.0.1:3000"
    email: str = ""
    password: str = ""

    database_url: str = ""
    timeout_seconds: float = 120.0
    request_interval_seconds: float = 0.5

    def api(self, path: str) -> str:
        return f"{self.base_url.rstrip('/')}{API_PREFIX}/{path.lstrip('/')}"

    def require_credentials(self) -> None:
        missing = [n for n in ("base_url", "email", "password") if not getattr(self, n)]
        if missing:
            raise ValueError(f"Akasha 连接缺少 {missing}，请在配置页填写。")

    def redacted(self) -> dict[str, Any]:
        return {
            "base_url": self.base_url,
            "email": self.email,
            "password_set": bool(self.password),
            "database_url_set": bool(self.database_url),
        }


_FIELDS = frozenset(f.name for f in fields(AkashaConfig))


def load_config(connection: sqlite3.Connection | None) -> AkashaConfig:
    if connection is None:
        return AkashaConfig()
    row = config_store.get_connection_row(connection)
    return AkashaConfig(**{name: row[name] for name in _FIELDS if name in row})
