from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager

import httpx
import pytest
from conftest import make_compile_run
from fastapi.testclient import TestClient

from akasha_benchmark.akasha_client import Response
from akasha_benchmark.datasets import DATASET_NAMES
from akasha_benchmark.datasets import registry as dataset_registry
from akasha_benchmark.judge.client import JudgeReply
from akasha_benchmark.lineage import LineageUnavailable
from akasha_benchmark.stages import STAGES, StageDefinition
from akasha_benchmark.store import (
    attribution_store,
    compile_store,
    config_store,
    connect,
    dumps,
    eval_store,
    query_store,
    run_store,
    task_store,
)
from akasha_benchmark.task import Paused
from akasha_platform.api import config as config_api
from akasha_platform.api import datasets as datasets_api
from akasha_platform.api import runs as runs_api
from akasha_platform.main import create_app
from akasha_platform.settings import Settings
from akasha_platform.tasks import TaskRejected, TaskRunner

JUDGE = {"label": "d", "base_url": "https://x/v1", "model": "m"}


@pytest.fixture
def settings(db_path) -> Settings:
    return Settings(db_path=db_path)


@pytest.fixture
def client(settings) -> TestClient:
    return TestClient(create_app(settings))


class _AkashaStub:
    def __init__(self, *_args, **_kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def login(self):
        pass

    def get_model_configs(self):
        return {"configs": []}

    def put_model_config(self, feature, payload):
        return {"feature": feature}


def _register(monkeypatch, name: str, run) -> None:
    monkeypatch.setitem(STAGES, name, StageDefinition(label=name, run=run, params={"marker": str}))


def _wait(settings, task_id: int, statuses: set[str], timeout: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with closing(connect(settings.db_path, read_only=True)) as connection:
            task = task_store.get_task(connection, task_id)
        if task and task["status"] in statuses:
            return task
        time.sleep(0.02)
    raise AssertionError(f"任务 #{task_id} 未在 {timeout}s 内进入 {statuses}，当前 {task}")


def _task(db, stage: str, status: str | None = None, params=None, target=None) -> int:
    task_id = task_store.create_task(db, stage=stage, params=params or {})
    if target:
        task_store.set_task_target(db, task_id, *target)
    if status:
        task_store.transition(db, task_id, status)
    db.commit()
    return task_id


def _stage_params(stage: str) -> dict:
    return {"datasets": ["hotpotqa"]} if stage == "compile" else {"compile_id": 1}


def _patch_cancel(monkeypatch, target, calls=None, active_runs=(), **response):
    class FakeAkasha(_AkashaStub):
        def run_diagnostics(self, space_ids, *, limit=50):
            return {"items": [{"runId": run_id, "status": "compiling"} for run_id in active_runs]}

        def cancel_compile_run(self, run_id, reason):
            if calls is not None:
                calls.append((run_id, reason))
            defaults = {"disposition": "cancelled", "status": "cancelled", "removedJobCount": 2}
            return {**defaults, "runId": run_id, **response}

    monkeypatch.setattr(target, FakeAkasha)


def test_task_succeeds_and_logs_are_kept_after_cleanup(settings, monkeypatch):
    def stage(ctx):
        ctx.log("干了点事")
        ctx.progress(1, 1, "完成")

    _register(monkeypatch, "unit", stage)
    runner = TaskRunner(settings)
    task_id = int(runner.start("unit", {"marker": "x"})["id"])
    _wait(settings, task_id, {task_store.SUCCEEDED})

    runner.cleanup(task_id)
    with closing(connect(settings.db_path, read_only=True)) as connection:
        assert task_store.get_task(connection, task_id) is None
        messages = [entry["message"] for entry in task_store.audit_logs(connection)]
    assert any("干了点事" in message for message in messages)


def test_failure_is_recorded_on_the_task(settings, monkeypatch):
    def stage(ctx):
        raise RuntimeError("炸了")

    _register(monkeypatch, "unit", stage)
    task = TaskRunner(settings).start("unit", {})
    failed = _wait(settings, int(task["id"]), {task_store.FAILED})
    assert "炸了" in (failed["error"] or "")


def test_running_task_blocks_cleanup_and_same_stage(settings, monkeypatch):
    entered, release = threading.Event(), threading.Event()

    def stage(ctx):
        entered.set()
        release.wait(5)

    _register(monkeypatch, "unit", stage)
    runner = TaskRunner(settings)
    task_id = int(runner.start("unit", {})["id"])
    assert entered.wait(5)
    with pytest.raises(TaskRejected):
        runner.cleanup(task_id)
    with pytest.raises(TaskRejected, match="正在运行"):
        runner.start("unit", {})
    release.set()
    _wait(settings, task_id, {task_store.SUCCEEDED})


def test_pause_stops_at_checkpoint_and_resume_continues(settings, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    calls: list[int] = []

    def stage(ctx):
        calls.append(1)
        if len(calls) == 1:
            entered.set()
            release.wait(5)
            ctx.checkpoint()
            raise AssertionError("checkpoint 没有拦住暂停")

    _register(monkeypatch, "unit", stage)
    runner = TaskRunner(settings)
    task_id = int(runner.start("unit", {})["id"])
    assert entered.wait(5)

    runner.pause(task_id)
    release.set()
    _wait(settings, task_id, {task_store.PAUSED})
    runner.resume(task_id)
    _wait(settings, task_id, {task_store.SUCCEEDED})
    assert len(calls) == 2


def test_unknown_stage_and_bad_params_are_rejected(settings):
    runner = TaskRunner(settings)
    with pytest.raises(TaskRejected, match="未知阶段"):
        runner.start("nope", {})
    with pytest.raises(TaskRejected):
        runner.start("query", {"compile_id": "abc"})


def test_concurrent_starts_admit_only_one_task(settings, monkeypatch):
    _register(monkeypatch, "unit", lambda ctx: None)
    runner = TaskRunner(settings)
    monkeypatch.setattr(runner, "_spawn", lambda *args: None)
    barrier = threading.Barrier(2)

    def start(_):
        barrier.wait()
        try:
            return runner.start("unit", {})["id"]
        except TaskRejected:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(start, range(2)))
    assert sum(task_id is not None for task_id in results) == 1


@pytest.mark.parametrize(
    ("running", "incoming", "allowed"),
    [
        ("embed", "compile", False),
        ("embed", "query", False),
        ("compile", "embed", False),
        ("query", "embed", False),
        ("compile", "query", True),
        ("compile", "compile", True),
        ("query", "query", True),
    ],
)
def test_stage_admission(settings, db, monkeypatch, running, incoming, allowed):
    monkeypatch.setattr("akasha_platform.tasks.AkashaClient", _AkashaStub)
    monkeypatch.setattr(TaskRunner, "_spawn", lambda *args: None)
    _task(db, running, task_store.RUNNING, _stage_params(running))
    runner = TaskRunner(settings)
    if allowed:
        assert runner.start(incoming, _stage_params(incoming))["status"] == task_store.QUEUED
    else:
        with pytest.raises(TaskRejected, match="请先等它结束或暂停"):
            runner.start(incoming, _stage_params(incoming))


def test_compile_resume_allows_same_stage_concurrency(settings, db, monkeypatch):
    configs = {"model_configs": {"configs": []}}
    paused_id = _task(db, "compile", task_store.PAUSED, configs)
    _task(db, "compile", task_store.RUNNING, configs)
    runner = TaskRunner(settings)
    monkeypatch.setattr(runner, "_spawn", lambda *args: None)
    runner.resume(paused_id)
    assert task_store.get_task(db, paused_id)["status"] == task_store.QUEUED


def _scheduled_task(db, schedule_at="2020-01-01T00:00:00Z"):
    params = {"datasets": ["hotpotqa"], "schedule_at": schedule_at}
    return task_store.get_task(db, _task(db, "compile", params=params))


def test_scheduled_compile_is_stored_in_beijing_time_without_starting(settings, monkeypatch):
    runner = TaskRunner(settings)
    spawned: list[tuple] = []
    monkeypatch.setattr(runner, "_spawn", lambda *args: spawned.append(args))
    monkeypatch.setattr(runner, "_arm_schedule", lambda *args: None)

    task = runner.start("compile", {"datasets": ["hotpotqa"], "schedule_at": "2099-01-02T08:30"})

    assert task["status"] == task_store.QUEUED
    assert task["params"]["schedule_at"] == "2099-01-02T08:30:00+08:00"
    assert spawned == []
    with pytest.raises(TaskRejected, match="compile"):
        runner.start("query", {"compile_id": 1, "schedule_at": "2099-01-02T08:30"})


def test_due_scheduled_compile_is_claimed_once(settings, db, monkeypatch):
    runner = TaskRunner(settings)
    spawned: list[tuple] = []
    monkeypatch.setattr(runner, "_spawn", lambda *args: spawned.append(args))
    monkeypatch.setattr(runner, "_require_free", lambda *args, **kwargs: None)
    task = _scheduled_task(db)

    runner._start_scheduled(task)
    runner._start_scheduled(task)

    assert task_store.get_task(db, int(task["id"]))["status"] == task_store.RUNNING
    assert len(spawned) == 1


def test_due_scheduled_compile_is_failed_when_it_cannot_start(settings, db, monkeypatch):
    runner = TaskRunner(settings)

    def reject(*args, **kwargs):
        raise TaskRejected("capacity unavailable")

    monkeypatch.setattr(runner, "_require_free", reject)
    task = _scheduled_task(db)
    runner._start_scheduled(task)

    failed = task_store.get_task(db, int(task["id"]))
    assert (failed["status"], failed["error"]) == (task_store.FAILED, "capacity unavailable")


def test_recover_pauses_orphans_and_bound_runs_but_rearms_schedules(
    settings, db, query_id, monkeypatch
):
    orphan = _task(db, "compile", task_store.RUNNING)
    bound = _task(db, "query", task_store.RUNNING, target=("query", query_id))
    scheduled = int(_scheduled_task(db, "2099-01-01T08:00:00+08:00")["id"])
    runner = TaskRunner(settings)
    armed: list[int] = []
    monkeypatch.setattr(runner, "_arm_schedule", lambda task_id, scheduled_at: armed.append(task_id))

    assert runner.recover() == 2
    assert task_store.get_task(db, orphan)["status"] == task_store.PAUSED
    assert task_store.get_task(db, bound)["status"] == task_store.PAUSED
    assert query_store.get_query_run(db, query_id)["status"] == "paused"
    assert task_store.get_task(db, scheduled)["status"] == task_store.QUEUED
    assert armed == [scheduled]


@pytest.mark.parametrize("outcome", ["succeeded", "failed", "paused", "invalid_result"])
def test_task_and_run_finish_together(settings, db, query_id, monkeypatch, outcome):
    db.commit()

    def stage(ctx):
        ctx.bind("query", query_id)
        if outcome == "failed":
            raise RuntimeError("stage failed")
        if outcome == "paused":
            raise Paused("checkpoint")

    _register(monkeypatch, "unit", stage)
    runner = TaskRunner(settings)
    if outcome == "invalid_result":
        def reject_result(*args):
            raise ValueError("invalid result")

        monkeypatch.setattr(runner, "_verify", reject_result)
    task = runner.start("unit", {})
    expected = "failed" if outcome == "invalid_result" else outcome
    finished = _wait(settings, task["id"], {expected})
    run = query_store.get_query_run(db, query_id)
    assert run["status"] == finished["status"]
    assert run["finished_at"] is not None


def test_failed_query_can_create_retry_task_without_original_task(settings, db, monkeypatch):
    compile_id = make_compile_run(db, run_id="retry-query-compile")
    query_id = query_store.create_query_run(
        db, name="retry-query", compile_id=compile_id, concurrency=3, model_configs={}
    )
    query_store.record_response(
        db, query_id, sample_id="failed", dataset="hotpotqa", question="q",
        http_status=500, latency_ms=1, error="failed", response=None,
    )
    db.commit()
    runner = TaskRunner(settings)
    monkeypatch.setattr(runner, "_spawn", lambda *args: None)

    task = runner.retry_failed_query(query_id)

    assert (task["target_kind"], task["target_id"]) == ("query", query_id)
    assert task["params"]["retry_failed"] is True
    assert task["params"]["concurrency"] == 3
    assert task["progress_total"] == 1
    assert query_store.get_query_run(db, query_id)["status"] == "paused"


@pytest.mark.parametrize("action", ["pause", "cleanup"])
def test_compile_task_action_cancels_remote_bullmq_run(settings, db, monkeypatch, action):
    calls: list[tuple[str, str]] = []
    _patch_cancel(monkeypatch, "akasha_platform.tasks.AkashaClient", calls)
    status = task_store.RUNNING if action == "pause" else task_store.PAUSED
    task_id = _task(db, "compile", status, {"remote_compile_run_ids": ["run-1"]})

    getattr(TaskRunner(settings), action)(task_id)

    assert [run_id for run_id, _ in calls] == ["run-1"]
    assert calls[0][1].startswith("Akasha-Benchmark task")


@pytest.mark.parametrize(
    ("response", "expected"),
    [
        ({"disposition": "already_terminal", "status": "cancelled"}, task_store.PAUSED),
        ({"disposition": "already_terminal", "status": "succeeded"}, task_store.RUNNING),
        ({"disposition": "not_found", "status": None}, None),
    ],
    ids=["terminal-cancelled", "terminal-succeeded", "invalid"],
)
def test_pause_interprets_remote_cancel_result(settings, db, monkeypatch, response, expected):
    _patch_cancel(monkeypatch, "akasha_platform.tasks.AkashaClient", **response)
    task_id = _task(db, "compile", task_store.RUNNING, {"remote_compile_run_ids": ["run-1"]})
    runner = TaskRunner(settings)
    if expected is None:
        with pytest.raises(TaskRejected, match="取消.*无效结果"):
            runner.pause(task_id)
        assert task_store.get_task(db, task_id)["status"] == task_store.RUNNING
    else:
        assert runner.pause(task_id)["status"] == expected


def test_pause_discovers_and_cancels_active_run_before_id_is_saved(
    settings, db, compile_id, monkeypatch
):
    calls: list[tuple[str, str]] = []
    _patch_cancel(monkeypatch, "akasha_platform.tasks.AkashaClient", calls, active_runs=["active-run"])
    compile_store.update_compile_run(db, compile_id, space_id="benchmark-space")
    task_id = _task(db, "compile", task_store.RUNNING, target=("compile", compile_id))

    TaskRunner(settings).pause(task_id)
    assert [run_id for run_id, _ in calls] == ["active-run"]
    assert task_store.get_task(db, task_id)["status"] == task_store.PAUSED


def test_cors_preflight_is_allowed(client):
    response = client.options(
        "/api/health",
        headers={"Origin": "http://127.0.0.1:5173", "Access-Control-Request-Method": "GET"},
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"


def test_non_loopback_refuses_to_start(db_path):
    with pytest.raises(RuntimeError, match="拒绝绑定"):
        create_app(Settings(db_path=db_path, host="0.0.0.0"))


def test_connection_put_only_updates_given_fields(client):
    client.put("/api/connection", json={"base_url": "http://x", "email": "a@b", "password": ""})
    body = client.get("/api/connection").json()
    assert (body["base_url"], body["password"]) == ("http://x", "")

    client.put("/api/connection", json={"password": "p"})
    body = client.get("/api/connection").json()
    assert (body["base_url"], body["password"]) == ("http://x", "p")

    assert client.put("/api/connection", json={"timeout_seconds": "many"}).status_code == 422


def test_connection_test_flags_compiles_in_another_workspace(client, db, monkeypatch):
    compile_id = make_compile_run(db, run_id="r1")
    compile_store.update_compile_run(db, compile_id, space_id="s1", workspace_id="w-original")
    db.commit()
    client.put("/api/connection", json={"base_url": "http://x", "email": "e@x", "password": "p"})

    class Fake(_AkashaStub):
        def current_user(self):
            return {
                "user": {"id": "u", "email": "e@x", "role": "owner"},
                "workspace": {"id": "w-other", "name": "Other"},
            }

    monkeypatch.setattr(config_api, "AkashaClient", Fake)
    body = client.post("/api/connection/test").json()
    assert body["ok"] is True
    assert [entry["run_id"] for entry in body["blocked_compiles"]] == ["r1"]
    assert "w-original" in body["blocked_compiles"][0]["reason"]


def _provider(client, role="judge", **fields) -> dict:
    return client.put(f"/api/providers/{role}", json={**JUDGE, **fields}).json()


def _stored_provider(client, provider_id) -> dict:
    with closing(connect(client.app.state.settings.db_path, read_only=True)) as connection:
        return config_store.get_model_provider(connection, provider_id)


def test_provider_api_key_never_leaves_the_backend(client):
    created = _provider(client, api_key="secret")
    providers = client.get("/api/providers?role=judge").json()
    assert providers[0]["api_key_set"] is True
    assert "api_key" not in providers[0]

    _provider(client, model="m2", api_key="")
    stored = _stored_provider(client, created["id"])
    assert (stored["api_key"], stored["model"]) == ("secret", "m2")


def test_provider_ignores_sampling_and_concurrency_fields(client):
    _provider(client, temperature=0.9, concurrency=4)
    stored = client.get("/api/providers?role=judge").json()[0]
    assert not {"temperature", "max_tokens", "concurrency"} & set(stored)


def test_provider_rename_updates_the_same_row(client):
    created = _provider(client, label="default", api_key="secret")
    body = _provider(client, id=created["id"], label="gpt4", base_url="https://y/v1", model="m2")
    assert body["id"] == created["id"]

    providers = client.get("/api/providers?role=judge").json()
    assert [(p["id"], p["label"], p["base_url"], p["model"]) for p in providers] == [
        (created["id"], "gpt4", "https://y/v1", "m2")
    ]
    assert providers[0]["api_key_set"] is True


def test_provider_rename_onto_a_taken_label_is_rejected(client):
    first = _provider(client, label="a")
    _provider(client, label="b")
    conflict = client.put("/api/providers/judge", json={**JUDGE, "id": first["id"], "label": "b"})
    assert conflict.status_code == 409
    assert len(client.get("/api/providers?role=judge").json()) == 2
    missing = client.put("/api/providers/judge", json={**JUDGE, "id": 999, "label": "c"})
    assert missing.status_code == 404


def test_bad_role_is_rejected(client):
    assert client.put("/api/providers/bogus", json={"base_url": "u", "model": "m"}).status_code == 422
    assert client.get("/api/providers?role=bogus").status_code == 422
    payload = {"models": [{"purpose": "nonsense", "label": "d", "base_url": "u", "model": "m"}]}
    assert client.post("/api/config/import", json=payload).status_code == 422


def test_provider_probe_reports_failure_as_data(client, monkeypatch):
    provider_id = _provider(client, api_key="k")["id"]
    monkeypatch.setattr(
        "akasha_benchmark.judge.client.JudgeClient.complete",
        lambda self, system, user: JudgeReply(
            content=None, failure_kind="http:401", raw='{"error":"bad key"}', status=401
        ),
    )
    response = client.post(f"/api/providers/{provider_id}/probe")
    assert response.status_code == 200
    payload = response.json()
    assert (payload["ok"], payload["failure"], payload["status"]) == (False, "http:401", 401)
    assert "bad key" in payload["detail"]
    assert payload["provider"]["api_key_set"] is True
    assert "api_key" not in payload["provider"]


def test_provider_probe_returns_the_reply(client, monkeypatch):
    provider_id = _provider(client, role="attribution", api_key="k")["id"]
    sent: list[tuple[str, str]] = []

    def fake(self, system, user):
        sent.append((system, user))
        return JudgeReply(content="Hi there", failure_kind=None, raw=None, status=200)

    monkeypatch.setattr("akasha_benchmark.judge.client.JudgeClient.complete", fake)
    payload = client.post(f"/api/providers/{provider_id}/probe").json()
    assert (payload["ok"], payload["reply"]) == (True, "Hi there")
    assert len(sent) == 1
    assert sent[0][1].startswith("hi")
    assert "json" in sent[0][1].lower()


def test_provider_probe_reports_missing_key_and_unknown_endpoint(client, db):
    provider_id = config_store.upsert_model_provider(
        db, purpose="judge", label="nokey", base_url="https://x/v1", model="m", api_key=""
    )
    db.commit()
    payload = client.post(f"/api/providers/{provider_id}/probe").json()
    assert (payload["ok"], payload["failure"]) == (False, "config")
    assert "api key" in payload["detail"]
    assert client.post("/api/providers/9999/probe").status_code == 404


def _model(client, feature="embedding", **fields):
    payload = {
        "feature": feature,
        "label": f"{feature}-a",
        "base_url": f"https://{feature}.example/v1",
        "model": f"{feature}-model",
    }
    return client.put("/api/akasha-models", json={**payload, **fields})


def _listed_model(client, feature, model_id) -> dict:
    models = client.get(f"/api/akasha-models?feature={feature}").json()["models"]
    return next(item for item in models if item["id"] == model_id)


def test_akasha_models_are_independent_and_hide_keys(client):
    created = _model(client, "answer", api_key="secret").json()
    row = _listed_model(client, "answer", created["id"])
    assert row["feature"] == "answer"
    assert row["api_key_set"] is True
    assert "api_key" not in row

    _model(client, "answer", id=created["id"], model="answer-model-2", api_key="")
    stored = _stored_provider(client, created["id"])
    assert (stored["model"], stored["api_key"]) == ("answer-model-2", "secret")


def test_embedding_model_dimension_roundtrip_and_validation(client):
    created = _model(client, parameters={"dimension": 1024})
    assert created.status_code == 200
    row = _listed_model(client, "embedding", created.json()["id"])
    assert row["parameters"]["dimension"] == 1024

    invalid = _model(client, label="bad-dimension", parameters={"dimension": 0})
    assert invalid.status_code == 422
    assert "dimension" in invalid.json()["detail"]


def test_akasha_embedding_probe_uses_minimal_request(client, monkeypatch):
    model = _model(client, api_key="secret", parameters={"dimension": 3}).json()

    class FakeHTTP(_AkashaStub):
        def post(self, url, *, json, headers):
            assert url == "https://embedding.example/v1/embeddings"
            assert json == {"model": "embedding-model", "input": "hi"}
            assert headers == {"Authorization": "Bearer secret"}
            return httpx.Response(200, json={"data": [{"embedding": [0.1, 0.2, 0.3]}]})

    monkeypatch.setattr(config_api.httpx, "Client", FakeHTTP)
    result = client.post(f"/api/akasha-models/{model['id']}/probe")
    assert result.status_code == 200
    assert result.json()["ok"] is True
    assert result.json()["reply"] == "embedding 成功，维度 3"


def _pushing_akasha(monkeypatch) -> list[tuple[str, dict]]:
    pushed: list[tuple[str, dict]] = []

    class Fake(_AkashaStub):
        def put_model_config(self, feature, payload):
            pushed.append((feature, payload))
            return {}

    monkeypatch.setattr(config_api, "AkashaClient", Fake)
    return pushed


def test_embedding_model_apply_sends_dimension(client, monkeypatch):
    client.put("/api/connection", json={"base_url": "http://x", "email": "e@x", "password": "p"})
    created = _model(client, parameters={"dimension": 1536}).json()
    pushed = _pushing_akasha(monkeypatch)

    assert client.post(f"/api/akasha-models/{created['id']}/apply").status_code == 200
    assert pushed == [
        (
            "embedding",
            {
                "provider": "openai-compatible",
                "model": "embedding-model",
                "baseUrl": "https://embedding.example/v1",
                "apiKey": "",
                "parameters": {"dimension": 1536},
            },
        )
    ]


def test_model_config_put_fills_the_only_legal_provider(client, monkeypatch):
    client.put("/api/connection", json={"base_url": "http://x", "email": "e@x", "password": "p"})
    pushed = _pushing_akasha(monkeypatch)
    body = client.put("/api/model-configs/answer", json={"model": "m", "baseUrl": "u"}).json()
    assert body["requires_new_compile"] is False
    assert pushed == [("answer", {"provider": "openai-compatible", "model": "m", "baseUrl": "u"})]


@pytest.mark.parametrize(
    "stage,feature,allowed",
    [
        ("compile", "compiler", False),
        ("compile", "embedding", False),
        ("compile", "image", False),
        ("compile", "answer", True),
        ("query", "embedding", False),
        ("query", "answer", False),
        ("query", "compiler", True),
        ("query", "image", True),
    ],
)
def test_remote_model_config_lock_is_feature_scoped(client, db, monkeypatch, stage, feature, allowed):
    monkeypatch.setattr(config_api, "AkashaClient", _AkashaStub)
    _task(db, stage, task_store.RUNNING)
    response = client.put(f"/api/model-configs/{feature}", json={"model": "m", "baseUrl": "https://x/v1"})
    assert response.status_code == (200 if allowed else 409)


@pytest.mark.parametrize("feature,expected", [("answer", 200), ("embedding", 409)])
def test_saved_model_apply_uses_the_same_feature_lock(client, db, monkeypatch, feature, expected):
    model_id = config_store.upsert_model_provider(
        db, purpose=feature, label=f"{feature}-lock", base_url="https://x/v1", model="m", api_key=""
    )
    _task(db, "compile", task_store.RUNNING)
    monkeypatch.setattr(config_api, "AkashaClient", _AkashaStub)
    assert client.post(f"/api/akasha-models/{model_id}/apply").status_code == expected


def test_config_import_round_trips_export(client):
    client.put("/api/connection", json={"password": "pw", "email": "e@x", "base_url": "http://y"})
    judge = _provider(client, api_key="sk")
    model = _model(
        client,
        "answer",
        model="a",
        api_key="gk",
        parameters={"temperature": 0},
    ).json()
    exported = client.get("/api/config/export").json()
    assert exported["connection"]["password"] == "pw"
    assert set(exported) == {"connection", "models"}
    assert exported["models"] == [
        {
            "purpose": "answer",
            "label": "answer-a",
            "base_url": "https://answer.example/v1",
            "model": "a",
            "api_key": "gk",
            "parameters": {"temperature": 0},
        },
        {
            "purpose": "judge",
            "label": "d",
            "base_url": "https://x/v1",
            "model": "m",
            "api_key": "sk",
            "parameters": {},
        },
    ]

    client.put("/api/connection", json={"password": "", "email": "", "base_url": ""})
    client.delete(f"/api/akasha-models/{model['id']}")
    client.delete(f"/api/providers/{judge['id']}")
    imported = client.post("/api/config/import", json=exported)
    assert imported.status_code == 200
    assert imported.json()["models"] == 2
    assert set(imported.json()) == {"connection", "models"}

    back = client.get("/api/config/export").json()
    assert (back["connection"]["password"], back["connection"]["base_url"]) == ("pw", "http://y")
    assert back["models"] == exported["models"]


def test_datasets_route_reports_missing_files(client):
    body = client.get("/api/datasets").json()
    assert set(DATASET_NAMES) <= {d["name"] for d in body["datasets"]}
    entry = next(d for d in body["datasets"] if d["name"] == "hotpotqa")
    assert entry["normalized"] is False
    assert "sample_id" in entry["identity_rules"]


def test_metrics_route_narrows_by_dataset(client):
    body = client.get("/api/metrics?datasets=narrativeqa").json()
    assert "recall" not in body["computable_for_all"]
    assert "faithfulness" in body["computable_for_all"]

    both = client.get("/api/metrics?datasets=hotpotqa,narrativeqa").json()
    assert "recall" in both["computable_for_some"]
    assert "recall" not in both["computable_for_all"]


def test_raw_samples_serves_qa_and_corpus_separately(client, dataset_dir, monkeypatch):
    monkeypatch.setattr(dataset_registry, "DATASET_DIR", dataset_dir)
    rows = {}
    for kind, source in (("qa", "hotpotqa.json"), ("corpus", "hotpotqa_corpus.json")):
        body = client.get(f"/api/datasets/hotpotqa/raw?kind={kind}&limit=1").json()
        assert (body["source_file"], body["kind"], len(body["rows"])) == (source, kind, 1)
        rows[kind] = body["rows"]
    assert rows["qa"] != rows["corpus"]
    assert client.get("/api/datasets/hotpotqa/raw").json()["kind"] == "qa"
    assert client.get("/api/datasets/hotpotqa/raw?kind=bogus").status_code == 422


@pytest.mark.parametrize(
    ("kind", "q", "field", "expected"),
    [("qa", "venice", "_id", ["q2"]), ("corpus", "film festival", "title", ["Venice"]), ("corpus", "not-found", "title", [])],
)
def test_raw_samples_search(client, dataset_dir, monkeypatch, kind, q, field, expected):
    monkeypatch.setattr(dataset_registry, "DATASET_DIR", dataset_dir)
    body = client.get("/api/datasets/hotpotqa/raw", params={"kind": kind, "q": q, "limit": 1}).json()
    assert body["total"] == len(expected)
    assert [row[field] for row in body["rows"]] == expected


@pytest.mark.parametrize(
    "path", ["/api/datasets/hotpotqa/raw?limit=0", "/api/tasks/1?after_id=-1"]
)
def test_paged_routes_reject_invalid_bounds(client, path):
    assert client.get(path).status_code == 422


def test_normalized_browsing_searches_and_pages_in_sqlite(client, normalized, monkeypatch):
    def reject_full_load(*args, **kwargs):
        raise AssertionError("full dataset load is forbidden for paged routes")

    monkeypatch.setattr(datasets_api.data_store, "samples_of", reject_full_load)
    monkeypatch.setattr(datasets_api.data_store, "corpus_of", reject_full_load)

    for q in ("Venice", "venice", "film festival"):
        body = client.get("/api/datasets/hotpotqa/samples", params={"q": q, "limit": 1}).json()
        assert body["total"] == 1
        sample = body["samples"][0]
        assert (sample["sample_id"], sample["dataset_sample_id"]) == ("hotpotqa:q2", "q2")
        assert sample["gold_titles"] == ["Venice"]

    corpus = client.get("/api/datasets/hotpotqa/corpus", params={"limit": 1, "offset": 1}).json()
    assert corpus["total"] == 4
    assert [doc["doc_id"] for doc in corpus["docs"]] == ["1"]


def test_normalized_corpus_returns_full_text(client, normalized):
    long_text = "x" * 800
    normalized.execute(
        "UPDATE corpus_doc SET text = ? WHERE dataset = 'hotpotqa' AND doc_id = '0'", (long_text,)
    )
    normalized.commit()

    body = client.get("/api/datasets/hotpotqa/corpus", params={"q": "Rita Moreno", "limit": 1}).json()
    assert body["total"] == 1
    assert body["docs"][0]["text"] == long_text
    assert "truncated" not in body["docs"][0]


def test_task_tree_route(client):
    response = client.get("/api/task-tree")
    assert response.status_code == 200
    assert set(response.json()) == {"total_tasks", "inactive_total", "compiles", "unlinked_tasks"}


def test_missing_records_return_404(client):
    for path in ("/api/evals/9", "/api/attributions/9", "/api/compiles/9/docs"):
        assert client.get(path).status_code == 404, path


def test_compile_query_and_eval_records_are_searchable(client, normalized):
    compile_id = make_compile_run(normalized, run_id="searchable", datasets=["hotpotqa"])
    compile_store.replace_compile_subset(
        normalized, compile_id, "hotpotqa", [], [{"doc_id": "0", "is_gold": True}, {"doc_id": "2", "is_gold": False}]
    )
    for doc_id, page_id in (("0", "page-rita"), ("2", "page-venice")):
        compile_store.record_page(normalized, compile_id, "hotpotqa", doc_id, page_id=page_id, error=None)
    query_id = query_store.create_query_run(
        normalized,
        name="search-query",
        compile_id=compile_id,
        concurrency=1,
        model_configs={"configs": [{"feature": "answer", "model": "answer-model"}]},
    )
    eval_id = eval_store.create_eval_run(
        normalized, name="search-eval", query_id=query_id, ks=[2], metrics=["em"], judge_provider_id=None
    )
    for sample_id, question, answer, mode in (
        ("sample-rita", "Who won the award?", "Rita Moreno", "knowledge"),
        ("sample-venice", "Which city hosts the festival?", "Venice", "general"),
    ):
        query_store.record_response(
            normalized, query_id, sample_id=sample_id, dataset="hotpotqa", question=question,
            http_status=200, latency_ms=1, error=None, response={"answerMode": mode, "answer": answer},
        )
        eval_store.record_sample_eval(
            normalized, eval_id, sample_id=sample_id, dataset="hotpotqa", answer_mode=mode,
            http_status=200, answer=answer, detail={"question": question}, metrics={"em": 1.0},
        )
    attribution_id = attribution_store.create_attribution_run(
        normalized, name="search-attribution", eval_id=eval_id, report_provider_id=None
    )
    attribution_store.record_attribution(
        normalized, attribution_id, sample_id="sample-venice", root_cause="answer_correct", evidence={}
    )
    normalized.commit()

    docs = client.get(f"/api/compiles/{compile_id}/docs", params={"q": "venice", "limit": 1}).json()
    assert (docs["total"], docs["docs"][0]["doc_id"]) == (1, "2")
    responses = client.get(
        f"/api/queries/{query_id}/responses", params={"q": "city hosts", "limit": 1}
    ).json()
    assert (responses["total"], responses["responses"][0]["sample_id"]) == (1, "sample-venice")
    samples = client.get(
        f"/api/evals/{eval_id}/samples", params={"answer_mode": "general", "limit": 1}
    ).json()
    assert (samples["total"], samples["samples"][0]["sample_id"]) == (1, "sample-venice")
    assert samples["count_by_answer_mode"] == {"general": 1, "knowledge": 1}

    tree = client.get("/api/compiles").json()["compiles"]
    compile_run = next(run for run in tree if run["id"] == compile_id)
    query_run = next(run for run in compile_run["queries"] if run["id"] == query_id)
    eval_run = next(run for run in query_run["evals"] if run["id"] == eval_id)
    attribution_run = next(run for run in eval_run["attributions"] if run["id"] == attribution_id)
    summary = ("model_label", "sample_count", "success_count")
    assert tuple(query_run[key] for key in summary) == ("answer-model", 2, 2)
    assert tuple(eval_run[key] for key in summary) == ("确定性指标", 2, 2)
    assert tuple(attribution_run[key] for key in summary) == ("规则归因", 2, 1)


def test_compile_tree_uses_constant_queries_and_no_postgres(client, normalized, monkeypatch):
    for index in range(4):
        compile_id = make_compile_run(normalized, run_id=f"tree-{index}")
        query_id = query_store.create_query_run(
            normalized, name=f"tree-query-{index}", compile_id=compile_id, concurrency=1, model_configs={}
        )
        eval_id = eval_store.create_eval_run(
            normalized, name=f"tree-eval-{index}", query_id=query_id, ks=[2],
            metrics=["em"], judge_provider_id=None, concurrency=3,
        )
        attribution_store.create_attribution_run(
            normalized, name=f"tree-attribution-{index}", eval_id=eval_id, report_provider_id=None
        )
    normalized.commit()
    selects: list[str] = []

    @contextmanager
    def traced_db(_request):
        connection = connect(client.app.state.settings.db_path, read_only=True)
        connection.set_trace_callback(
            lambda sql: selects.append(sql) if sql.lstrip().upper().startswith("SELECT") else None
        )
        try:
            yield connection
        finally:
            connection.close()

    monkeypatch.setattr(runs_api, "db", traced_db)
    response = client.get("/api/compiles")

    assert response.status_code == 200
    assert len(response.json()["compiles"]) == 4
    assert response.json()["compiles"][0]["queries"][0]["evals"][0]["concurrency"] == 3
    assert len(selects) <= 15


def test_query_view_reports_embed_concurrency_in_effect_when_it_started(client, normalized):
    compile_id = make_compile_run(normalized, run_id="embed-concurrency")
    queries = {}
    for name, created_at in (("before", "2026-10-14T06:00:00Z"), ("after", "2026-10-14T08:00:00Z")):
        queries[name] = query_store.create_query_run(
            normalized, name=name, compile_id=compile_id, concurrency=4, model_configs={}
        )
        normalized.execute("UPDATE query_run SET created_at = ? WHERE id = ?", (created_at, queries[name]))
    for status, finished_at, concurrency in (
        (task_store.SUCCEEDED, "2026-10-14T07:00:00Z", 16),
        (task_store.FAILED, "2026-10-14T07:30:00Z", 32),
    ):
        params = {"compile_id": compile_id, "embedding_concurrency": concurrency}
        task_id = _task(normalized, "embed", status, params)
        normalized.execute("UPDATE task SET finished_at = ? WHERE id = ?", (finished_at, task_id))
    normalized.commit()

    compile_run = next(c for c in client.get("/api/compiles").json()["compiles"] if c["id"] == compile_id)
    runs = {run["id"]: run for run in compile_run["queries"]}
    assert runs[queries["before"]]["embedding_concurrency"] is None
    assert runs[queries["after"]]["embedding_concurrency"] == 16


@pytest.fixture
def spaced_compile(db) -> int:
    compile_id = make_compile_run(db)
    compile_store.update_compile_run(db, compile_id, space_id="space-1")
    db.commit()
    return compile_id


def test_compile_cleanup_cancels_remote_run_and_keeps_space(client, spaced_compile, monkeypatch):
    calls: list[tuple[str, str]] = []
    _patch_cancel(monkeypatch, "akasha_platform.api.runs.AkashaClient", calls, active_runs=["run-1"])

    body = client.delete(f"/api/compiles/{spaced_compile}").json()
    assert (body["deleted"], body["space_id"]) == (1, "space-1")
    assert (body["cancelled_runs"], body["removed_bullmq_jobs"]) == (1, 2)
    assert [run_id for run_id, _ in calls] == ["run-1"]
    assert "空间没有删除" in body["note"]


def _embedding_akasha(monkeypatch, generations=(), rebuilds=()):
    class FakeAkasha(_AkashaStub):
        def get_model_configs(self):
            embedding = {"feature": "embedding", "model": "e2", "baseUrl": "http://x/v1", "parameters": {"dimension": 1024}}
            return {"configs": [embedding]}

    class Reader:
        def __init__(self, database_url):
            if not database_url:
                raise LineageUnavailable("no database_url configured")

        def space_embedding_generations(self, space_id):
            return {"space_id": space_id, "generations": list(generations)}

        def space_rebuild_usage(self, space_id, *, since=None):
            totals = {key: sum(entry[key] for entry in rebuilds) for key in ("batches", "chunks", "failed")}
            return {"space_id": space_id, "models": list(rebuilds), "last_batch_at": None, **totals}

    monkeypatch.setattr(runs_api, "AkashaClient", FakeAkasha)
    monkeypatch.setattr(runs_api, "LineageReader", Reader)


def _generation(model, dimensions, active, tokens=None):
    return {
        "model": model, "dimensions": dimensions, "active": active, "chunks": 3, "embedded": 3,
        "total_tokens": tokens, "duration_ms_sum": None, "duration_ms_mean": None,
        "first_created_at": None, "last_created_at": None,
    }


def test_compile_embedding_reports_coverage_and_usage(client, spaced_compile, monkeypatch):
    rebuild = {
        "model": "e2", "batches": 1, "chunks": 3, "failed": 0, "total_tokens": 900,
        "duration_ms_sum": 1200, "first_batch_at": None, "last_batch_at": None,
    }
    _embedding_akasha(
        monkeypatch, [_generation("e2", 1024, True, 600), _generation("e1", 768, False)], [rebuild]
    )

    body = client.get(f"/api/compiles/{spaced_compile}/embedding").json()

    assert body["target"] == {"model": "e2", "dimensions": 1024}
    assert body["coverage"] == {"total": 3, "matched": 3, "ready": True, "models": ["e2"]}
    assert [entry["active"] for entry in body["generations"]] == [True, False]
    assert body["rebuilds"][0]["duration_ms_sum"] == 1200


class _Unreachable(_AkashaStub):
    def get_model_configs(self):
        raise httpx.ConnectError("connection refused")


@pytest.mark.parametrize("case", ["unreachable", "no-postgres", "no-space"])
def test_compile_embedding_errors(client, db, spaced_compile, monkeypatch, case):
    _embedding_akasha(monkeypatch)
    compile_id = spaced_compile
    if case == "unreachable":
        monkeypatch.setattr(runs_api, "AkashaClient", _Unreachable)
    elif case == "no-postgres":
        config_store.update_connection(db, database_url="")
    else:
        compile_id = make_compile_run(db, run_id="no-space")
    db.commit()
    expected = {"unreachable": 502, "no-postgres": 503, "no-space": 409}[case]
    assert client.get(f"/api/compiles/{compile_id}/embedding").status_code == expected


def test_query_preview_returns_response_without_creating_query_run(client, db, monkeypatch):
    class FakeAkasha(_AkashaStub):
        def current_user(self):
            return {"workspace": {"id": "workspace-1"}}

        def query(self, question, space_ids):
            assert (question, space_ids) == ("什么是测试？", ["space-1"])
            body = {
                "answerMode": "knowledge",
                "answer": "这是测试答案。",
                "snippets": [{"title": "测试文档", "text": "测试证据"}],
                "citations": [{"sourcePageId": "page-1"}],
            }
            return Response(status=200, body=body, latency_ms=12)

    monkeypatch.setattr(runs_api, "AkashaClient", FakeAkasha)
    compile_id = make_compile_run(db, run_id="preview")
    compile_store.update_compile_run(
        db, compile_id, space_id="space-1", workspace_id="workspace-1",
        status="succeeded", quality_json=dumps({"passed": True}),
    )
    db.commit()

    response = client.post(f"/api/compiles/{compile_id}/query-preview", json={"question": "什么是测试？"})

    assert response.status_code == 200
    result = response.json()
    assert (result["run_id"], result["answer"], result["latency_ms"]) == ("preview", "这是测试答案。", 12)
    assert query_store.list_query_runs(db, compile_id) == []


def test_query_preview_rejects_unready_compile(client, db, monkeypatch):
    monkeypatch.setattr(runs_api, "AkashaClient", _AkashaStub)
    compile_id = make_compile_run(db, run_id="not-ready")
    db.commit()
    response = client.post(f"/api/compiles/{compile_id}/query-preview", json={"question": "测试"})
    assert response.status_code == 409
    assert "编译状态" in response.json()["detail"]


def test_cleanup_refused_while_a_task_writes_the_record(client, db, compile_id):
    _task(db, "compile", task_store.RUNNING, target=("compile", compile_id))
    assert client.delete(f"/api/compiles/{compile_id}").status_code == 409


@pytest.mark.parametrize("bound", [False, True], ids=["queued-input", "bound-output"])
@pytest.mark.parametrize(
    "parent,stage",
    [("compile", "query"), ("compile", "evaluate"), ("query", "attribute"), ("eval", "attribute")],
)
def test_cleanup_protects_active_descendants(client, db, compile_id, query_id, eval_id, parent, stage, bound):
    attribution_id = attribution_store.create_attribution_run(
        db, name="a", eval_id=eval_id, report_provider_id=None
    )
    ids = {"compile": compile_id, "query": query_id, "eval": eval_id, "attribution": attribution_id}
    kind = {"query": "query", "evaluate": "eval", "attribute": "attribution"}[stage]
    input_kind, param = run_store.stage_input(stage)
    task_id = _task(
        db,
        stage,
        task_store.RUNNING if bound else None,
        {param: ids[input_kind]},
        (kind, ids[kind]) if bound else None,
    )

    route = {"compile": "compiles", "query": "queries", "eval": "evals"}[parent]
    assert client.delete(f"/api/{route}/{ids[parent]}").status_code == 409
    assert run_store.get_run(db, parent, ids[parent]) is not None
    task_store.transition(db, task_id, task_store.PAUSED)
    db.commit()
    assert client.delete(f"/api/{route}/{ids[parent]}").status_code == 200
    assert attribution_store.get_attribution_run(db, attribution_id) is None
