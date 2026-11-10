from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from akasha_benchmark.store import DEFAULT_DB_PATH

ENV_PREFIX = "AKASHA_PLATFORM_"
LOOPBACK = {"127.0.0.1", "::1", "localhost"}


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 8848
    db_path: Path = DEFAULT_DB_PATH

    dev_origins: tuple[str, ...] = ("http://127.0.0.1:5173", "http://localhost:5173")

    def is_loopback(self) -> bool:
        return self.host in LOOPBACK

    def validate_binding(self) -> None:
        if not self.is_loopback():
            raise RuntimeError(
                f"拒绝绑定 {self.host}：该服务持有 Akasha 管理员凭据并能启动长任务。"
                "请绑定 127.0.0.1，并通过受保护的隧道远程访问。"
            )

    def redacted(self) -> dict[str, object]:
        return {
            "host": self.host,
            "port": self.port,
            "db_path": str(self.db_path),
            "loopback_only": self.is_loopback(),
        }


def load_settings() -> Settings:
    def env(name: str, default: str = "") -> str:
        return os.environ.get(f"{ENV_PREFIX}{name}", default)

    return Settings(
        host=env("HOST", "127.0.0.1"),
        port=int(env("PORT", "8848")),
        db_path=Path(env("DB", str(DEFAULT_DB_PATH))),
    )
