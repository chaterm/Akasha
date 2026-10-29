from __future__ import annotations

import sqlite3
from typing import Any

from akasha_benchmark.akasha_client import (
    ACTIVE_RUN_STATUSES,
    AkashaClient,
    validate_cancel_result,
)
from akasha_benchmark.config import load_config
from akasha_benchmark.store import compile_store, task_store


class CompileRemoteService:
    def cancel_task(
        self,
        connection: sqlite3.Connection,
        task: dict[str, Any],
        reason: str,
        *,
        client_factory=None,
    ) -> list[dict[str, str]]:
        if task.get("stage") != "compile":
            return []
        run_ids = list(task.get("params", {}).get("remote_compile_run_ids") or [])
        space_id = None
        if not run_ids:
            if task.get("target_kind") != "compile":
                return []
            compile_run = compile_store.get_compile_run(connection, int(task["target_id"] or 0))
            space_id = (compile_run or {}).get("space_id")
            if not space_id:
                return []
        return self.cancel_runs(
            connection,
            run_ids,
            space_id=space_id,
            reason=reason,
            task_id=int(task["id"]),
            client_factory=client_factory,
        )

    def cancel_compile(
        self,
        connection: sqlite3.Connection,
        compile_id: int,
        reason: str,
        *,
        client_factory=None,
    ) -> dict[str, int]:
        compile_run = compile_store.get_compile_run(connection, compile_id)
        if not compile_run or not compile_run.get("space_id"):
            return {"cancelled": 0, "removed_jobs": 0}
        results = self.cancel_runs(
            connection,
            [],
            space_id=str(compile_run["space_id"]),
            reason=reason,
            client_factory=client_factory,
        )
        return {
            "cancelled": sum(item["disposition"] == "cancelled" for item in results),
            "removed_jobs": sum(int(item.get("removed_jobs", 0)) for item in results),
        }

    def cancel_runs(
        self,
        connection: sqlite3.Connection,
        run_ids: list[str],
        *,
        space_id: str | None,
        reason: str,
        task_id: int | None = None,
        client_factory=None,
    ) -> list[dict[str, str]]:
        factory = client_factory or AkashaClient
        with factory(load_config(connection)) as client:
            client.login()
            if not run_ids and space_id:
                diagnostics = client.run_diagnostics([space_id], limit=50)
                run_ids = [
                    str(run["runId"])
                    for run in diagnostics.get("items") or []
                    if run.get("runId")
                    and str(run.get("status")) in ACTIVE_RUN_STATUSES
                ]
            results = []
            for run_id in dict.fromkeys(str(value) for value in run_ids):
                response = client.cancel_compile_run(run_id, reason)
                result = validate_cancel_result(run_id, response)
                result["removed_jobs"] = str(response.get("removedJobCount", 0))
                results.append(result)
                if task_id is not None:
                    task_store.log(
                        connection,
                        task_id=task_id,
                        stage="compile",
                        level="info",
                        message=(
                            f"远端编译 Run {run_id} 已处理：{result['disposition']} / "
                            f"{result['status']}，清理 BullMQ job {result['removed_jobs']} 个"
                        ),
                    )
            connection.commit()
            return results
