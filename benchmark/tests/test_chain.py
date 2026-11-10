from __future__ import annotations

import time
from contextlib import closing

import pytest
from test_akasha import FakeClient

from akasha_benchmark.datasets import get_adapter
from akasha_benchmark.metrics import registry
from akasha_benchmark.stages import STAGES, chain, compile, query
from akasha_benchmark.store import compile_store, config_store, connect, task_store
from akasha_platform import tasks as platform_tasks
from akasha_platform.settings import Settings
from akasha_platform.tasks import TaskRunner


@pytest.mark.parametrize("with_judge", [False, True])
def test_build_lays_out_four_steps(normalized, monkeypatch, with_judge):
    monkeypatch.setattr(chain, "DATASETS", ("hotpotqa",))
    sample_id = "hotpotqa:q1"
    steps = chain.build(
        {"dataset": "hotpotqa", "sample_id": sample_id, "with_judge": with_judge}, normalized
    )

    assert [s["stage"] for s in steps] == ["compile", "query", "evaluate", "attribute"]
    assert "link" not in steps[0]
    assert [s["link"] for s in steps[1:]] == ["compile_id", "query_id", "eval_id"]
    assert all(s["stage"] in STAGES for s in steps)
    assert steps[0]["params"]["sample_ids"] == [sample_id]
    assert steps[0]["params"]["negatives_ratio"] == 1.5
    assert steps[2]["params"]["ks"] == [2]
    expected = {
        definition.name
        for definition in registry.available(get_adapter("hotpotqa").provides)
        if with_judge or definition.kind == registry.KIND_DETERMINISTIC
    }
    assert set(steps[2]["params"]["metrics"]) == expected


@pytest.mark.parametrize(
    ("fixture", "params", "match"),
    [
        ("normalized", {"dataset": "narrativeqa"}, "仅支持"),
        ("db", {"dataset": "hotpotqa"}, "归一化"),
        ("normalized", {"dataset": "hotpotqa", "sample_id": "missing"}, "样本"),
    ],
    ids=["no-gold-dataset", "not-normalized", "unknown-sample"],
)
def test_build_rejects_invalid_requests(request, monkeypatch, fixture, params, match):
    connection = request.getfixturevalue(fixture)
    if params.get("sample_id"):
        monkeypatch.setattr(chain, "DATASETS", ("hotpotqa",))
    with pytest.raises(ValueError, match=match):
        chain.build(params, connection)


def _settle(db_path, timeout: float = 120.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with closing(connect(db_path)) as probe:
            if not task_store.active_tasks(probe):
                return
        time.sleep(0.2)
    raise AssertionError("任务没跑完")


def _tasks(db_path) -> list[dict]:
    with closing(connect(db_path)) as probe:
        tasks = task_store.list_tasks(probe, limit=50)
    failed = [(t["stage"], t["error"]) for t in tasks if t["status"] == task_store.FAILED]
    assert not failed, f"链上有任务失败：{failed}"
    assert [t["stage"] for t in tasks][::-1] == ["compile", "query", "evaluate", "attribute"]
    return tasks


@pytest.fixture
def runner(db_path, normalized, monkeypatch) -> TaskRunner:
    config_store.update_connection(normalized, base_url="http://x", email="e@x", password="p")
    normalized.commit()

    def query_client(config):
        with closing(connect(db_path)) as probe:
            runs = compile_store.list_compile_runs(probe)
            docs = compile_store.compile_docs(probe, int(runs[0]["id"])) if runs else []
        return FakeClient(config, retrieved=[d["page_id"] for d in docs if d["page_id"] and d["is_gold"]])

    monkeypatch.setattr(compile, "AkashaClient", FakeClient)
    monkeypatch.setattr(platform_tasks, "AkashaClient", FakeClient)
    monkeypatch.setattr(query, "AkashaClient", query_client)
    return TaskRunner(Settings(db_path=db_path))


def test_runner_advances_the_chain(db_path, runner, monkeypatch):
    monkeypatch.setattr(chain, "DATASETS", ("hotpotqa",))
    head = runner.start_chain({"dataset": "hotpotqa", "sample_id": "hotpotqa:q1", "use_model": False})
    _settle(db_path)

    tasks = _tasks(db_path)
    assert all(t["status"] == task_store.SUCCEEDED for t in tasks)
    assert {t["chain_id"] for t in tasks} == {int(head["id"])}
    with closing(connect(db_path)) as probe:
        assert task_store.task_chain(probe, max(int(t["id"]) for t in tasks))[1] == []


def test_query_follow_up_runs_evaluate_and_attribute(db_path, runner):
    runner.start("compile", {"datasets": ["hotpotqa"], "qa_limit": 2})
    _settle(db_path)
    with closing(connect(db_path)) as probe:
        compile_id = int(compile_store.list_compile_runs(probe)[0]["id"])
    head = runner.start("query", {"compile_id": compile_id, "follow_up": True})
    _settle(db_path)

    followed = [t for t in _tasks(db_path) if t["stage"] != "compile"]
    assert {t["chain_id"] for t in followed} == {int(head["id"])}
