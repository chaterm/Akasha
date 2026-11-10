from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import closing, contextmanager

from fastapi import HTTPException, Request

from akasha_benchmark.config import AkashaConfig, load_config
from akasha_benchmark.store import connect, run_store, task_store

from ..settings import Settings
from ..tasks import TaskRunner


def settings_of(request: Request) -> Settings:
    return request.app.state.settings


def runner_of(request: Request) -> TaskRunner:
    return request.app.state.runner


@contextmanager
def db(request: Request) -> Iterator[sqlite3.Connection]:
    with closing(connect(settings_of(request).db_path, read_only=True)) as connection:
        yield connection


@contextmanager
def writable(request: Request) -> Iterator[sqlite3.Connection]:
    with closing(connect(settings_of(request).db_path)) as connection, connection:
        yield connection


def config_of(request: Request) -> AkashaConfig:
    with db(request) as connection:
        return load_config(connection)


def reject_if_busy(connection: sqlite3.Connection, kind: str, target_id: int) -> None:
    if not connection.in_transaction:
        connection.execute("BEGIN IMMEDIATE")
    affected = run_store.descendants(connection, kind, target_id)
    for task in task_store.active_tasks(connection):
        references = {(task["target_kind"], task["target_id"])}
        if source := run_store.stage_input(task["stage"]):
            parent, param = source
            references.add((parent, task["params"].get(param)))
        if references & affected:
            raise HTTPException(409, f"任务 #{task['id']} 正在使用这条记录或其下游，请先暂停再清理")
