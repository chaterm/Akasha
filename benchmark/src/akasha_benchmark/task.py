from __future__ import annotations

import sqlite3
import threading
from collections.abc import Callable
from typing import Any, Protocol

from .store import dumps, run_store, task_store


class Paused(BaseException):
    pass


class TaskContext:
    def __init__(
        self,
        *,
        task_id: int,
        stage: str,
        params: dict[str, Any],
        connection: sqlite3.Connection,
        pause_event: threading.Event,
    ) -> None:
        self.task_id = task_id
        self.stage = stage
        self.params = params
        self.db = connection
        self._pause = pause_event

    def freeze(self, **params: Any) -> None:
        self.params.update(params)
        self.db.execute(
            "UPDATE task SET params_json = ? WHERE id = ?", (dumps(self.params), self.task_id)
        )
        self.db.commit()

    def target(self, kind: str) -> int | None:
        task = task_store.get_task(self.db, self.task_id)
        if task is None:
            raise ValueError(f"任务 #{self.task_id} 不存在")
        if task["target_id"] is None:
            return None
        if task["target_kind"] != kind:
            raise ValueError("任务绑定的产物类型不匹配")
        target_id = int(task["target_id"])
        if run_store.get_run(self.db, kind, target_id) is None:
            raise ValueError("任务产物已被清理，请新建任务")
        return target_id

    @property
    def pause_requested(self) -> bool:
        return self._pause.is_set()

    def checkpoint(self) -> None:
        if self._pause.is_set():
            raise Paused(f"任务 #{self.task_id} 已暂停")

    def log(self, message: str, level: str = "info") -> None:
        task_store.log(
            self.db, task_id=self.task_id, stage=self.stage, level=level, message=message
        )
        self.db.commit()

    def progress(self, done: int, total: int | None, note: str | None = None) -> None:
        task_store.update_progress(self.db, self.task_id, done=done, total=total, note=note)
        self.db.commit()

    def bind(self, kind: str, target_id: int) -> None:
        task_store.set_task_target(self.db, self.task_id, kind, target_id)
        self.db.commit()


class Stage(Protocol):
    def __call__(self, ctx: TaskContext) -> None: ...


def execute(stage: Stage, ctx: TaskContext, verify: Callable[[], None] | None = None) -> None:
    task = task_store.get_task(ctx.db, ctx.task_id)
    if task is None:
        raise ValueError(f"任务 #{ctx.task_id} 不存在")
    ctx.params = task["params"]
    task_store.transition(ctx.db, ctx.task_id, task_store.RUNNING)
    ctx.db.commit()
    try:
        ctx.checkpoint()
        stage(ctx)
        if verify is not None:
            verify()
    except BaseException as exc:
        ctx.db.rollback()
        paused = isinstance(exc, Paused)
        task_store.transition(
            ctx.db,
            ctx.task_id,
            task_store.PAUSED if paused else task_store.FAILED,
            error=None if paused else f"{type(exc).__name__}: {exc}"[:2000],
        )
        ctx.db.commit()
        raise
    task_store.transition(ctx.db, ctx.task_id, task_store.SUCCEEDED)
    ctx.db.commit()
