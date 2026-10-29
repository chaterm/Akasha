from __future__ import annotations

import threading
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

from akasha_benchmark import model_configs
from akasha_benchmark.akasha_client import AkashaClient, AkashaError
from akasha_benchmark.config import load_config
from akasha_benchmark.stages import STAGES, chain, clean_params
from akasha_benchmark.store import connect, query_store, task_store
from akasha_benchmark.task import Paused, TaskContext, execute

from .compile_control import CompileRemoteService
from .settings import Settings

EXCLUSIVE = frozenset({"download", "normalize", "embed", "generate"})

STAGE_CONCURRENCY: dict[str, int] = {"compile": 16, "query": 16}
UNLIMITED_CONCURRENCY = frozenset({"attribute"})
TASK_MODEL_FEATURES: dict[str, tuple[str, ...]] = {
    "compile": ("compiler", "embedding", "image"),
    "embed": ("embedding",),
    "query": ("embedding", "answer"),
}
BEIJING = timezone(timedelta(hours=8), name="Asia/Shanghai")
MAX_TIMER_DELAY_SECONDS = 24 * 60 * 60


class TaskRejected(RuntimeError):
    pass


class TaskRunner:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._pauses: dict[int, threading.Event] = {}
        self._timers: dict[int, threading.Timer] = {}
        self._lock = threading.Lock()
        self._compile_remote = CompileRemoteService()

    def recover(self) -> int:
        connection = connect(self.settings.db_path)
        try:
            active = task_store.active_tasks(connection)
            recovered = 0
            for task in active:
                scheduled_at = self._scheduled_at(task)
                if (
                    task["stage"] == "compile"
                    and task["status"] == task_store.QUEUED
                    and scheduled_at is not None
                ):
                    self._arm_schedule(int(task["id"]), scheduled_at)
                    continue
                recovered += 1
                try:
                    self._cancel_remote_compile(
                        connection, task, "Akasha-Benchmark backend restarted"
                    )
                except TaskRejected as exc:
                    task_store.transition(
                        connection, int(task["id"]), task_store.FAILED, error=str(exc)
                    )
                    task_store.log(
                        connection,
                        task_id=int(task["id"]),
                        stage=task["stage"],
                        level="error",
                        message=f"后端重启后无法确认远端已停止：{exc}",
                    )
                    continue
                task_store.transition(connection, int(task["id"]), task_store.PAUSED)
                task_store.log(
                    connection,
                    task_id=int(task["id"]),
                    stage=task["stage"],
                    level="warn",
                    message="后端重启，任务已标为暂停；点击继续可接着跑",
                )
            connection.commit()
            return recovered
        finally:
            connection.close()

    def start(self, stage: str, args: dict[str, Any]) -> dict[str, Any]:
        if stage not in STAGES:
            raise TaskRejected(f"未知阶段 {stage!r}；可用：{sorted(STAGES)}")
        try:
            params = clean_params(stage, args)
        except ValueError as exc:
            raise TaskRejected(str(exc)) from exc
        if stage != "compile" and args.get("schedule_at") not in (None, ""):
            raise TaskRejected("只有 compile 任务支持定时启动")
        if stage == "compile" and args.get("schedule_at") not in (None, ""):
            try:
                params["schedule_at"] = self._normalize_schedule(args["schedule_at"])
            except ValueError as exc:
                raise TaskRejected(str(exc)) from exc
        scheduled_at = self._scheduled_at({"params": params})

        connection = connect(self.settings.db_path)
        try:
            connection.execute("BEGIN IMMEDIATE")
            if scheduled_at is None:
                self._require_free(connection, stage, params)
            task_id = task_store.create_task(connection, stage=stage, params=params)
            if params.get("follow_up"):
                task_store.set_task_chain(
                    connection,
                    task_id,
                    chain=chain.follow_up_steps(),
                    chain_id=task_id,
                    verify=False,
                )
            if scheduled_at is not None:
                task_store.update_progress(
                    connection,
                    task_id,
                    done=0,
                    total=None,
                    note=f"计划于 {params['schedule_at']} 启动（北京时间）",
                )
                task_store.log(
                    connection,
                    task_id=task_id,
                    stage=stage,
                    level="info",
                    message=f"已创建单次定时任务：{params['schedule_at']}（北京时间）",
                )
            connection.commit()
            record = task_store.get_task(connection, task_id) or {}
        finally:
            connection.close()

        if scheduled_at is None:
            self._spawn(task_id, stage, params)
        else:
            self._arm_schedule(task_id, scheduled_at)
        return record

    def start_chain(self, args: dict[str, Any]) -> dict[str, Any]:
        connection = connect(self.settings.db_path)
        try:
            try:
                steps = chain.build(args, connection)
            except ValueError as exc:
                raise TaskRejected(str(exc)) from exc
            head, rest = steps[0], steps[1:]
            params = clean_params(head["stage"], head["params"])
            connection.execute("BEGIN IMMEDIATE")
            self._require_free(connection, head["stage"], params)
            task_id = task_store.create_task(connection, stage=head["stage"], params=params)

            task_store.set_task_chain(connection, task_id, chain=rest, chain_id=task_id)
            connection.commit()
            record = task_store.get_task(connection, task_id) or {}
        finally:
            connection.close()

        self._spawn(task_id, head["stage"], params)
        return record

    def retry_failed_query(self, query_id: int) -> dict[str, Any]:
        connection = connect(self.settings.db_path)
        try:
            connection.execute("BEGIN IMMEDIATE")
            self._require_free(connection, "query")
            query_run = query_store.get_query_run(connection, query_id)
            if query_run is None:
                raise TaskRejected(f"查询 #{query_id} 不存在")
            failures = query_store.retryable_response_count(connection, query_id)
            if failures == 0:
                raise TaskRejected(f"查询 #{query_id} 没有可重试的失败或空回答响应")
            datasets = sorted(
                {row["dataset"] for row in query_store.query_samples(connection, query_id)}
            )
            if not datasets:
                datasets = query_store.response_datasets(connection, query_id)
            params = {
                "compile_id": int(query_run["compile_id"]),
                "datasets": datasets,
                "concurrency": int(query_run["concurrency"]),
                "name": query_run["name"],
                "sample_limit": None,
                "retry_failed": True,
            }
            task_id = task_store.create_task(connection, stage="query", params=params)
            task_store.set_task_target(connection, task_id, "query", query_id)
            task_store.update_progress(
                connection, task_id, done=0, total=failures, note="等待重试失败响应"
            )
            connection.execute(
                "UPDATE query_run SET status=?, finished_at=NULL WHERE id=?",
                (task_store.PAUSED, query_id),
            )
            connection.commit()
            record = task_store.get_task(connection, task_id) or {}
        finally:
            connection.close()
        self._spawn(task_id, "query", params)
        return record

    def resume(self, task_id: int) -> dict[str, Any]:
        connection = connect(self.settings.db_path)
        try:
            connection.execute("BEGIN IMMEDIATE")
            task = task_store.get_task(connection, task_id)
            if task is None:
                raise TaskRejected(f"任务 #{task_id} 不存在")
            if task["status"] not in (task_store.PAUSED, task_store.FAILED):
                raise TaskRejected(f"任务 #{task_id} 当前是 {task['status']}，无需继续")
            self._require_free(connection, task["stage"], task.get("params") or {})
            task_store.transition(connection, task_id, task_store.QUEUED)
            connection.commit()
        finally:
            connection.close()

        scheduled_at = self._scheduled_at(task)
        if scheduled_at is None or scheduled_at <= datetime.now(UTC):
            self._spawn(task_id, task["stage"], task["params"])
        else:
            self._arm_schedule(task_id, scheduled_at)
        connection = connect(self.settings.db_path)
        try:
            return task_store.get_task(connection, task_id) or {}
        finally:
            connection.close()

    def pause(self, task_id: int) -> dict[str, Any]:
        connection = connect(self.settings.db_path)
        try:
            task = task_store.get_task(connection, task_id)
            if task is None:
                raise TaskRejected(f"任务 #{task_id} 不存在")
            if task["status"] not in task_store.ACTIVE:
                raise TaskRejected(f"任务 #{task_id} 当前是 {task['status']}，不在运行")
            self._cancel_schedule(task_id)
            remote_results = self._cancel_remote_compile(
                connection, task, "Akasha-Benchmark task paused"
            )
            task = task_store.get_task(connection, task_id) or task
            if task["status"] not in task_store.ACTIVE:
                return task
            if task["stage"] == "compile" and remote_results and all(
                result["disposition"] == "already_terminal"
                and result["status"] != "cancelled"
                for result in remote_results
            ):
                task_store.log(
                    connection,
                    task_id=task_id,
                    stage=task["stage"],
                    level="info",
                    message="远端编译已终态，本地继续同步最终状态",
                )
                connection.commit()
                return task
            with self._lock:
                event = self._pauses.get(task_id)
            if event is None:
                task_store.transition(connection, task_id, task_store.PAUSED)
                connection.commit()
            else:
                event.set()
                task_store.log(
                    connection,
                    task_id=task_id,
                    stage=task["stage"],
                    level="info",
                    message="已请求暂停，等待当前步骤收尾",
                )
                connection.commit()
            return task_store.get_task(connection, task_id) or {}
        finally:
            connection.close()

    def cleanup(self, task_id: int | None) -> dict[str, int]:
        connection = connect(self.settings.db_path)
        try:
            try:
                targets = (
                    [task_store.get_task(connection, task_id)]
                    if task_id is not None
                    else task_store.list_tasks(connection, limit=500)
                )
                for task in targets:
                    if task and task["status"] not in task_store.ACTIVE:
                        self._cancel_remote_compile(
                            connection, task, "Akasha-Benchmark task cleaned up"
                        )
                deleted = (
                    task_store.delete_task(connection, task_id)
                    if task_id is not None
                    else task_store.delete_inactive_tasks(connection)
                )
            except ValueError as exc:
                raise TaskRejected(str(exc)) from exc
            connection.commit()
            return {"deleted": deleted}
        finally:
            connection.close()

    def _cancel_remote_compile(
        self, connection, task: dict[str, Any], reason: str
    ) -> list[dict[str, str]]:
        try:
            return self._compile_remote.cancel_task(
                connection, task, reason, client_factory=AkashaClient
            )
        except (AkashaError, ValueError) as exc:
            connection.rollback()
            raise TaskRejected(f"远端编译 Run 取消失败，本地状态未变：{exc}") from exc

    def _require_free(
        self,
        connection,
        stage: str,
        params: dict[str, Any] | None = None,
        *,
        exclude_task_id: int | None = None,
    ) -> None:
        active = [
            task
            for task in task_store.active_tasks(connection)
            if int(task["id"]) != exclude_task_id
            and not (
                task["stage"] == "compile"
                and task["status"] == task_store.QUEUED
                and self._scheduled_at(task) is not None
            )
        ]
        for task in active:
            if stage in EXCLUSIVE or task["stage"] in EXCLUSIVE:
                raise TaskRejected(
                    f"{task['stage']} 任务 #{task['id']} 正在运行，请先等它结束或暂停"
                )
        same_stage = [task for task in active if task["stage"] == stage]
        if stage in UNLIMITED_CONCURRENCY:
            return
        limit = STAGE_CONCURRENCY.get(stage, 1)
        features = TASK_MODEL_FEATURES.get(stage, ())
        incoming_configs = (params or {}).get("model_configs")
        if features and not incoming_configs and same_stage:
            incoming_configs = self._fetch_model_configs(connection)
            if incoming_configs and isinstance(params, dict):
                params["model_configs"] = incoming_configs

        for task in same_stage:
            running_configs = (task.get("params") or {}).get("model_configs")

            if incoming_configs and running_configs and any(
                not model_configs.matches(incoming_configs, running_configs, feature)
                for feature in features
            ):
                raise TaskRejected(
                    f"{stage} 任务 #{task['id']} 使用了不同的远端模型配置；"
                    "请等待该任务结束/暂停后再运行"
                )
        if len(same_stage) >= limit:
            if limit == 1:
                task = same_stage[0]
                raise TaskRejected(
                    f"{task['stage']} 任务 #{task['id']} 正在运行，请先等它结束或暂停"
                )
            raise TaskRejected(
                f"{stage} 任务已达到并发上限 {limit}，请先等其中一个结束或暂停"
            )

    @staticmethod
    def _fetch_model_configs(connection) -> dict[str, Any] | None:
        try:
            config = load_config(connection)
            config.require_credentials()
            with AkashaClient(config) as client:
                client.login()
                return client.get_model_configs()
        except (AkashaError, OSError, ValueError):
            return None

    @staticmethod
    def _normalize_schedule(value: Any) -> str:
        text = str(value).strip()
        if not text:
            raise ValueError("schedule_at 不能为空")
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError as exc:
            raise ValueError("schedule_at 需要使用有效的 ISO 时间") from exc
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=BEIJING)
        return parsed.astimezone(BEIJING).isoformat(timespec="seconds")

    @staticmethod
    def _scheduled_at(task: dict[str, Any]) -> datetime | None:
        value = (task.get("params") or {}).get("schedule_at")
        return datetime.fromisoformat(value).astimezone(UTC) if value else None

    def _arm_schedule(self, task_id: int, scheduled_at: datetime | None) -> None:
        if scheduled_at is None:
            return
        delay = min(
            MAX_TIMER_DELAY_SECONDS,
            max(0.0, (scheduled_at - datetime.now(UTC)).total_seconds()),
        )
        timer = threading.Timer(delay, self._fire_schedule, args=(task_id,))
        timer.daemon = True
        with self._lock:
            previous = self._timers.pop(task_id, None)
            if previous is not None:
                previous.cancel()
            self._timers[task_id] = timer
        timer.start()

    def _cancel_schedule(self, task_id: int) -> None:
        with self._lock:
            timer = self._timers.pop(task_id, None)
        if timer is not None:
            timer.cancel()

    def _fire_schedule(self, task_id: int) -> None:
        try:
            connection = connect(self.settings.db_path)
            try:
                task = task_store.get_task(connection, task_id)
            finally:
                connection.close()
            scheduled_at = self._scheduled_at(task or {})
            if (
                task is not None
                and task["stage"] == "compile"
                and task["status"] == task_store.QUEUED
            ):
                if scheduled_at is not None and scheduled_at > datetime.now(UTC):
                    self._arm_schedule(task_id, scheduled_at)
                else:
                    self._start_scheduled(task)
        finally:
            with self._lock:
                if self._timers.get(task_id) is threading.current_thread():
                    self._timers.pop(task_id, None)

    def _start_scheduled(self, task: dict[str, Any]) -> None:
        task_id = int(task["id"])
        connection = connect(self.settings.db_path)
        try:
            connection.execute("BEGIN IMMEDIATE")
            current = task_store.get_task(connection, task_id)
            if not current or current["status"] != task_store.QUEUED:
                connection.rollback()
                return
            params = current.get("params") or {}
            try:
                self._require_free(
                    connection,
                    "compile",
                    params,
                    exclude_task_id=task_id,
                )
            except TaskRejected as exc:
                task_store.transition(connection, task_id, task_store.FAILED, error=str(exc))
                task_store.log(
                    connection,
                    task_id=task_id,
                    stage="compile",
                    level="error",
                    message=f"定时启动失败：{exc}",
                )
                connection.commit()
                return
            task_store.update_progress(
                connection,
                task_id,
                done=0,
                total=None,
                note="定时时间已到，正在启动",
            )
            task_store.transition(connection, task_id, task_store.RUNNING)
            connection.commit()
        except Exception as exc:
            connection.rollback()
            try:
                task_store.transition(connection, task_id, task_store.FAILED, error=str(exc))
                task_store.log(
                    connection,
                    task_id=task_id,
                    stage="compile",
                    level="error",
                    message=f"定时启动失败：{type(exc).__name__}: {exc}",
                )
                connection.commit()
            except Exception:
                connection.rollback()
            return
        finally:
            connection.close()
        try:
            self._spawn(task_id, "compile", params, True)
        except Exception as exc:
            connection = connect(self.settings.db_path)
            try:
                task_store.transition(connection, task_id, task_store.FAILED, error=str(exc))
                task_store.log(
                    connection,
                    task_id=task_id,
                    stage="compile",
                    level="error",
                    message=f"定时启动失败：{type(exc).__name__}: {exc}",
                )
                connection.commit()
            finally:
                connection.close()

    def _verify(self, connection, task_id: int, stage: str) -> None:
        chain_id, _, verify = task_store.task_chain(connection, task_id)
        definition = STAGES.get(stage)
        check = definition.verify if definition else None
        if chain_id is None or check is None or not verify:
            return
        task = task_store.get_task(connection, task_id) or {}
        target_id = task.get("target_id")
        if target_id is None:
            raise RuntimeError(f"{stage} 没有产出可校验的记录")
        check(connection, int(target_id))
        task_store.log(
            connection,
            task_id=task_id,
            stage=stage,
            level="info",
            message="链路契约：通过",
        )
        connection.commit()

    def _advance_chain(self, connection, task_id: int, stage: str) -> None:
        chain_id, remaining, verify = task_store.task_chain(connection, task_id)
        if chain_id is None or not remaining:
            return
        task = task_store.get_task(connection, task_id) or {}
        target_id = task.get("target_id")
        if target_id is None:
            task_store.log(
                connection,
                task_id=task_id,
                stage=stage,
                level="error",
                message="没有产物记录，链路中断",
            )
            connection.commit()
            return

        step, rest = remaining[0], remaining[1:]
        params = {k: v for k, v in step["params"].items() if v is not None}
        if link := step.get("link"):
            params[link] = int(target_id)
        try:
            params = clean_params(step["stage"], params)
            connection.execute("BEGIN IMMEDIATE")
            self._require_free(connection, step["stage"], params)
        except (ValueError, TaskRejected) as exc:
            task_store.log(
                connection,
                task_id=task_id,
                stage=stage,
                level="error",
                message=f"链路中断，下一步 {step['stage']} 起不来：{exc}",
            )
            connection.commit()
            return

        next_id = task_store.create_task(connection, stage=step["stage"], params=params)
        task_store.set_task_chain(
            connection, next_id, chain=rest, chain_id=chain_id, verify=verify
        )
        task_store.log(
            connection,
            task_id=task_id,
            stage=stage,
            level="info",
            message=f"链路继续：{STAGES[step['stage']].label} #{next_id}",
        )
        connection.commit()
        self._spawn(next_id, step["stage"], params)

    def _spawn(
        self,
        task_id: int,
        stage: str,
        params: dict[str, Any],
        already_running: bool = False,
    ) -> None:
        event = threading.Event()
        with self._lock:
            self._pauses[task_id] = event
        threading.Thread(
            target=self._run,
            args=(task_id, stage, params, event, already_running),
            daemon=True,
        ).start()

    def _run(
        self,
        task_id: int,
        stage: str,
        params: dict[str, Any],
        event: threading.Event,
        already_running: bool = False,
    ) -> None:
        connection = connect(self.settings.db_path)
        try:
            task = task_store.get_task(connection, task_id)
            expected_status = task_store.RUNNING if already_running else task_store.QUEUED
            if task is None or task["status"] != expected_status:
                return
            ctx = TaskContext(
                task_id=task_id,
                stage=stage,
                params=params,
                connection=connection,
                pause_event=event,
            )
            ctx.log(f"开始 {STAGES[stage].label}：{params}")
            try:
                execute(STAGES[stage].run, ctx, lambda: self._verify(connection, task_id, stage))
            except Paused as exc:
                task_store.log(
                    connection,
                    task_id=task_id,
                    stage=stage,
                    level="warn",
                    message=f"已暂停：{exc}",
                )
                connection.commit()
                return
            except Exception as exc:
                task_store.log(
                    connection,
                    task_id=task_id,
                    stage=stage,
                    level="error",
                    message=f"{type(exc).__name__}: {exc}",
                )
                connection.commit()
                return
            task_store.log(
                connection, task_id=task_id, stage=stage, level="info", message="任务完成"
            )
            connection.commit()
            self._advance_chain(connection, task_id, stage)
        finally:
            connection.close()
            with self._lock:
                if self._pauses.get(task_id) is event:
                    self._pauses.pop(task_id, None)
