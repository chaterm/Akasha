from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query, Request

from akasha_benchmark.store import task_store

from ._common import db, runner_of

router = APIRouter(prefix="/api")

_INTERNAL_TASK_PARAMS = {
    "run_id",
    "model_configs",
    "remote_compile_run_ids",
    "retry_pending_page_ids",
    "retry_current_page_ids",
    "retry_current_run_ids",
    "retry_completed",
    "retry_total",
    "retry_progress",
}


def _public_task(task: dict[str, Any]) -> dict[str, Any]:
    note = task.get("progress_note")
    if isinstance(note, str):
        note = re.sub(r"（成功 \d+，失败 \d+，跳过 \d+）$", "", note)
    return {
        **task,
        "progress_note": note,
        "params": {
            key: value
            for key, value in (task.get("params") or {}).items()
            if key not in _INTERNAL_TASK_PARAMS
        },
    }


def _public_tree(tree: dict[str, Any]) -> dict[str, Any]:
    def visit(node: dict[str, Any]) -> dict[str, Any]:
        return {
            **node,
            "tasks": [_public_task(task) for task in node["tasks"]],
            "pending_tasks": [_public_task(task) for task in node["pending_tasks"]],
            "children": [visit(child) for child in node["children"]],
        }

    return {
        **tree,
        "compiles": [visit(node) for node in tree["compiles"]],
        "unlinked_tasks": [_public_task(task) for task in tree["unlinked_tasks"]],
    }


@router.get("/task-tree")
def task_tree(request: Request) -> dict[str, Any]:
    with db(request) as connection:
        return _public_tree(task_store.task_tree(connection))


@router.get("/tasks/{task_id}")
def task_detail(
    request: Request, task_id: int, after_id: int = Query(0, ge=0)
) -> dict[str, Any]:
    with db(request) as connection:
        task = task_store.get_task(connection, task_id)
        if task is None:
            raise HTTPException(404, f"任务 #{task_id} 不存在")
        return {
            **_public_task(task),
            "logs": task_store.task_logs(connection, task_id, after_id=after_id),
        }


@router.post("/chain")
def start_chain(request: Request, args: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    return runner_of(request).start_chain(args)


@router.post("/tasks/{stage}")
def start_task(
    request: Request, stage: str, args: dict[str, Any] = Body(default={})
) -> dict[str, Any]:
    return runner_of(request).start(stage, args)


@router.post("/tasks/{task_id}/pause")
def pause_task(request: Request, task_id: int) -> dict[str, Any]:
    return runner_of(request).pause(task_id)


@router.post("/tasks/{task_id}/resume")
def resume_task(request: Request, task_id: int) -> dict[str, Any]:
    return runner_of(request).resume(task_id)


@router.delete("/tasks/{task_id}")
def cleanup_task(request: Request, task_id: int) -> dict[str, Any]:
    return runner_of(request).cleanup(task_id)


@router.post("/tasks/cleanup/inactive")
def cleanup_inactive(request: Request) -> dict[str, Any]:
    return runner_of(request).cleanup(None)


@router.get("/audit")
def audit(
    request: Request, stage: str | None = None, limit: int = Query(200, ge=1, le=2000)
) -> list[dict[str, Any]]:
    with db(request) as connection:
        return task_store.audit_logs(connection, stage=stage, limit=limit)
