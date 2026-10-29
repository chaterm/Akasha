from __future__ import annotations

import base64
import json
import threading
import time
from typing import Any

import pytest
from conftest import make_compile_run
from conftest import make_context as context

from akasha_benchmark import akasha_client, model_configs
from akasha_benchmark.akasha_client import AkashaClient, Response, unwrap_envelope
from akasha_benchmark.config import AkashaConfig
from akasha_benchmark.lineage import LineageUnavailable
from akasha_benchmark.stages import compile, embed, query
from akasha_benchmark.store import (
    compile_store,
    config_store,
    dumps,
    loads,
    query_store,
    run_store,
    task_store,
)
from akasha_benchmark.task import Paused, execute

CONFIGS = {
    "configs": [
        {"feature": feature, "provider": "p", "model": model, "baseUrl": "u", "parameters": {}}
        for feature, model in (
            ("compiler", "c1"),
            ("embedding", "e1"),
            ("answer", "a1"),
            ("image", "i1"),
        )
    ]
}
COMPILE = {"datasets": ["hotpotqa"], "qa_limit": 2}
CLEAN_QUALITY = {
    "summary": {
        "missingChunkPageCount": 0,
        "missingEmbeddingPageCount": 0,
        "missingSourcePageCount": 0,
        "stalePageCount": 0,
    }
}


def with_model(feature: str, model: str) -> dict[str, Any]:
    return {
        "configs": [
            {**entry, "model": model} if entry["feature"] == feature else entry
            for entry in CONFIGS["configs"]
        ]
    }


def run_item(run_id="remote-run-1", status="succeeded", expected=4, succeeded=None, **extra):
    if succeeded is None:
        succeeded = expected if status == "succeeded" else 0
    text = {"expected": expected, "succeeded": succeeded, "failed": extra.pop("failed", 0)}
    return {"runId": run_id, "status": status, "progress": {"text": text}, **extra}


class FakeClient:
    retryable_run_page_ids = AkashaClient.retryable_run_page_ids

    def __init__(
        self,
        config=None,
        *,
        role="owner",
        configs=None,
        retrieved=None,
        accepted_runs=1,
        page_log_items=None,
        run_items=None,
        quality=None,
    ) -> None:
        self.config = config
        self.role = role
        self.accepted_runs = accepted_runs
        self.compile_submitted = False
        self.page_log_items = page_log_items or []
        self.run_items = (
            run_items if run_items is not None else [run_item(runDurationMs=8000)]
        )
        self.configs = configs if configs is not None else CONFIGS
        self.retrieved = retrieved or []
        self.quality = quality if quality is not None else CLEAN_QUALITY
        self.imported: list[str] = []
        self.queries: list[str] = []
        self.rebuilt: list[dict[str, Any]] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return None

    def close(self):
        pass

    def login(self):
        pass

    def current_user(self):
        return {"user": {"id": "u", "role": self.role}, "workspace": {"id": "w", "name": "W"}}

    def get_model_configs(self):
        return self.configs

    def put_model_config(self, feature, payload):
        pytest.fail("不应修改远端模型配置")

    def create_space(self, name, slug, description=""):
        return {"id": "space-1", "slug": slug}

    def import_page_text(self, filename, markdown, space_id):
        self.imported.append(filename)
        return {"id": f"page-{len(self.imported)}"}

    def compile_spaces(self, space_ids):
        self.compile_submitted = True
        runs = [{"runId": "remote-run-1", "disposition": "created"}] if self.accepted_runs else []
        return {"acceptedRunCount": self.accepted_runs, "coalescedRunCount": 0, "runs": runs}

    def rebuild_space_embeddings(self, space_ids, *, embedding_concurrency=None):
        self.rebuilt.append({"spaces": list(space_ids), "concurrency": embedding_concurrency})
        return {
            "action": "rebuild_embeddings",
            "queuedSpaceCount": len(space_ids),
            "jobIds": [f"rebuild-{index}" for index, _ in enumerate(space_ids)],
        }

    def run_diagnostics(self, space_ids, *, limit=50):
        return {"items": list(self.run_items) if self.compile_submitted else []}

    def quality_diagnostics(self, space_ids):
        return self.quality

    def page_log(self, space_ids, *, limit=100):
        return {"items": list(self.page_log_items)}

    def run_pages(self, run_id, *, page=1, limit=100):
        return {"items": [], "total": 0, "page": page, "limit": limit}

    def retry_pages(self, page_ids):
        return {"queuedPageCount": len(page_ids), "jobIds": ["retry-run-1"]}

    def query(self, question, space_ids):
        self.queries.append(question)
        return Response(
            status=200,
            body={
                "answerMode": "knowledge",
                "answer": "a",
                "retrievedSources": [{"sourcePageId": page} for page in self.retrieved],
                "citations": [{"sourcePageId": page} for page in self.retrieved],
                "citationEvidence": [{"excerpts": ["x"]} for _ in self.retrieved],
                "snippets": [],
            },
            latency_ms=10,
        )


def patch_clients(monkeypatch, module, cls=FakeClient, **kwargs) -> list[FakeClient]:
    clients: list[FakeClient] = []

    def factory(config):
        clients.append(cls(config, **kwargs))
        return clients[-1]

    monkeypatch.setattr(module, "AkashaClient", factory)
    return clients


def patch_client(monkeypatch, module, client: FakeClient) -> FakeClient:
    monkeypatch.setattr(module, "AkashaClient", lambda config: client)
    return client


class OtherWorkspace(FakeClient):
    def current_user(self):
        return {"user": {"id": "u", "role": "owner"}, "workspace": {"id": "w-other", "name": "O"}}


@pytest.fixture
def client():
    connection = AkashaClient(AkashaConfig())
    yield connection
    connection.close()


@pytest.fixture
def ready_connection(normalized):
    config_store.update_connection(normalized, base_url="http://x", email="e@x", password="p")
    normalized.commit()
    return normalized


@pytest.fixture
def compiled(ready_connection, monkeypatch) -> int:
    patch_clients(monkeypatch, compile)
    execute(compile.run, context(ready_connection, {**COMPILE, "run_id": "r1"}))
    return int(compile_store.compile_run_by_run_id(ready_connection, "r1")["id"])


def test_envelope_is_unwrapped_only_when_it_is_an_envelope():
    assert unwrap_envelope({"data": {"id": 1}, "success": True, "status": 200}) == {"id": 1}
    assert unwrap_envelope({"success": True, "status": 201}) is None
    payload = {"data": 1, "success": True, "status": 200, "extra": "x"}
    assert unwrap_envelope(payload) == payload
    assert unwrap_envelope([1, 2]) == [1, 2]


def _jwt(expiry: float) -> str:
    def encode(value: dict[str, Any]) -> str:
        raw = json.dumps(value, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    return f"{encode({'alg': 'none'})}.{encode({'exp': expiry})}.signature"


@pytest.fixture
def auth(tmp_path, monkeypatch):
    cache_path = tmp_path / "auth.json"
    monkeypatch.setattr(akasha_client, "_AUTH_CACHE_PATH", cache_path)
    akasha_client._AUTH_TOKENS.clear()
    calls = {"login": 0}
    lock = threading.Lock()
    config = AkashaConfig(base_url="http://akasha", email="e@x", password="pw")

    def make(token: str) -> AkashaClient:
        class FakeHTTP:
            def __init__(self):
                self.cookies = akasha_client.httpx.Cookies()
                self.request_calls = 0

            def request(self, method, url, **kwargs):
                if url.endswith("/auth/login"):
                    with lock:
                        calls["login"] += 1
                    self.cookies.set(akasha_client.AUTH_TOKEN_COOKIE, token)
                    return akasha_client.httpx.Response(201, json={"success": True, "status": 201})
                self.request_calls += 1
                status = 401 if self.request_calls == 1 else 200
                return akasha_client.httpx.Response(
                    status, json={"data": {}, "success": status == 200, "status": status}
                )

            def close(self):
                pass

        client = AkashaClient(config)
        client._client.close()
        client._client = FakeHTTP()
        return client

    yield make, calls, config, cache_path
    akasha_client._AUTH_TOKENS.clear()


def _cookie(client: AkashaClient):
    return client._client.cookies.get(akasha_client.AUTH_TOKEN_COOKIE)


def test_clients_share_jwt_in_memory_and_from_local_cache(auth):
    make, calls, _, _ = auth
    token = _jwt(time.time() + 3600)
    clients = [make(token) for _ in range(4)]
    threads = [threading.Thread(target=client.login) for client in clients]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert calls["login"] == 1
    assert all(_cookie(client) == token for client in clients)

    akasha_client._AUTH_TOKENS.clear()
    restarted = make(token)
    restarted.login()
    assert calls["login"] == 1
    assert _cookie(restarted) == token


def test_unauthorized_client_reuses_jwt_refreshed_by_another_client(auth):
    make, calls, config, _ = auth
    stale, fresh = _jwt(time.time() + 3600), _jwt(time.time() + 7200)
    akasha_client._AUTH_TOKENS[akasha_client._auth_cache_key(config)] = stale
    clients = [make(fresh) for _ in range(2)]
    for client in clients:
        client._client.cookies.set(akasha_client.AUTH_TOKEN_COOKIE, stale)

    assert [client.get("users/me") for client in clients] == [{}, {}]
    assert calls["login"] == 1
    assert all(_cookie(client) == fresh for client in clients)


def test_unauthorized_without_cookie_logs_in_and_saves_new_jwt(auth):
    make, calls, config, cache_path = auth
    fresh = _jwt(time.time() + 7200)
    client = make(fresh)

    assert client.get("users/me") == {}
    assert calls["login"] == 1
    assert _cookie(client) == fresh
    cached = json.loads(cache_path.read_text(encoding="utf-8"))
    assert cached[akasha_client._auth_cache_key(config)] == fresh


def test_client_collects_failed_run_pages_across_pages(client, monkeypatch):
    calls: list[tuple[str, int, int]] = []
    pages = {
        1: [
            {"sourcePageId": "ok", "status": "succeeded"},
            {"sourcePageId": "text-failed", "status": "failed"},
            {"sourcePageId": "ordinary-skip", "status": "skipped"},
        ],
        2: [
            {"sourcePageId": "merge-failed", "status": "succeeded", "mergeStatus": "failed"},
            {"sourcePageId": "text-failed", "status": "failed"},
            {"sourcePageId": "cancelled", "status": "skipped", "errorCode": "manual_cancelled"},
        ],
    }

    def run_pages(run_id, *, page=1, limit=100):
        calls.append((run_id, page, limit))
        return {"items": pages[page], "total": 101, "limit": 100}

    monkeypatch.setattr(client, "run_pages", run_pages)
    assert client.retryable_run_page_ids(["run-1"]) == ["text-failed", "merge-failed", "cancelled"]
    assert calls == [("run-1", 1, 100), ("run-1", 2, 100)]


@pytest.mark.parametrize(
    ("pages", "run_ids", "expected"),
    [
        pytest.param(
            {
                "original": [
                    {"sourcePageId": "eventually-ok", "status": "failed"},
                    {"sourcePageId": "still-failed", "status": "failed"},
                    {"sourcePageId": "already-ok", "status": "succeeded"},
                ],
                "retry": [
                    {"sourcePageId": "eventually-ok", "status": "succeeded"},
                    {"sourcePageId": "still-failed", "status": "skipped", "errorCode": "manual_cancelled"},
                ],
            },
            ["original", "retry"],
            ["still-failed"],
            id="latest-status-across-runs",
        ),
        pytest.param(
            {
                "newer": [
                    {"sourcePageId": "page", "status": "succeeded", "updatedAt": "2026-09-24T10:00:00Z"}
                ],
                "older": [
                    {
                        "sourcePageId": "page",
                        "status": "skipped",
                        "errorCode": "manual_cancelled",
                        "updatedAt": "2026-09-24T09:00:00Z",
                    }
                ],
            },
            ["newer", "older"],
            [],
            id="remote-updated-at-beats-run-order",
        ),
    ],
)
def test_retryable_pages(client, monkeypatch, pages, run_ids, expected):
    monkeypatch.setattr(
        client,
        "run_pages",
        lambda run_id, **_: {"items": pages[run_id], "total": len(pages[run_id]), "limit": 100},
    )
    assert client.retryable_run_page_ids(run_ids) == expected


def test_client_requires_retry_batches_of_at_most_100(client, monkeypatch):
    batches: list[list[str]] = []

    def post(path, body):
        assert path == "llm-wiki/admin/retry-pages"
        batches.append(body["pageIds"])
        return {"queuedPageCount": 1, "jobIds": [f"run-{len(batches)}"]}

    monkeypatch.setattr(client, "post", post)
    with pytest.raises(ValueError, match="最多 100"):
        client.retry_pages([f"page-{index}" for index in range(101)])
    result = client.retry_pages([f"page-{index}" for index in range(100)])
    assert [len(batch) for batch in batches] == [100]
    assert result == {"queuedPageCount": 1, "jobIds": ["run-1"]}


def test_embedding_drift_is_detected_and_order_stable():
    changed = with_model("embedding", "e2")
    assert model_configs.matches(CONFIGS, changed, "compiler") is True
    assert model_configs.matches(CONFIGS, changed, "embedding") is False
    assert model_configs.drift(changed, CONFIGS) == {
        "compiler": False,
        "embedding": True,
        "answer": False,
        "image": False,
    }
    reversed_configs = {"configs": list(reversed(CONFIGS["configs"]))}
    assert model_configs.normalize(CONFIGS) == model_configs.normalize(reversed_configs)


@pytest.mark.parametrize(
    ("kwargs", "match"),
    [
        ({"role": "member"}, "owner"),
        ({"quality": {}}, "质量闸门"),
        ({"accepted_runs": 0, "run_items": []}, "编译没有启动"),
    ],
    ids=["not-owner", "quality-unreported", "no-run-accepted"],
)
def test_compile_failure_marks_run_failed(ready_connection, monkeypatch, kwargs, match):
    patch_clients(monkeypatch, compile, **kwargs)
    with pytest.raises(RuntimeError, match=match):
        execute(compile.run, context(ready_connection, COMPILE))
    assert compile_store.list_compile_runs(ready_connection)[0]["status"] == run_store.STATUS_FAILED


def test_compile_reports_page_failure_reason(ready_connection, monkeypatch):
    pages = [
        {
            "status": "failed",
            "errorCode": "provider_error",
            "errorSummary": "Knowledge compiler provider request failed.",
            "title": f"Doc {index}",
        }
        for index in range(8)
    ]
    quality = {"summary": {"missingChunkPageCount": 8, "missingSourcePageCount": 8}}
    patch_clients(monkeypatch, compile, page_log_items=pages, quality=quality)
    with pytest.raises(RuntimeError, match="provider_error") as caught:
        execute(compile.run, context(ready_connection, COMPILE))
    assert "8 篇" in str(caught.value)


def test_query_can_use_partially_successful_compile(ready_connection, monkeypatch):
    missing = {"missingChunkPageCount": 1, "missingEmbeddingPageCount": 1, "missingSourcePageCount": 1}
    patch_clients(
        monkeypatch,
        compile,
        quality={"summary": {**CLEAN_QUALITY["summary"], **missing}},
        run_items=[run_item(status="failed", succeeded=3, failed=1, runDurationMs=8000)],
    )
    with pytest.raises(RuntimeError, match="质量闸门"):
        execute(compile.run, context(ready_connection, {**COMPILE, "run_id": "partial"}))

    run = compile_store.compile_run_by_run_id(ready_connection, "partial")
    assert run["status"] == run_store.STATUS_FAILED
    assert compile_store.compile_ready(ready_connection, int(run["id"]))["ready"] is True
    query_client = patch_client(monkeypatch, query, FakeClient())
    execute(query.run, context(ready_connection, {"compile_id": int(run["id"])}))
    assert query_client.queries


def test_compile_waits_when_runs_are_still_active(ready_connection, monkeypatch):
    polls: list[int] = []

    class Slow(FakeClient):
        def run_diagnostics(self, space_ids, *, limit=50):
            polls.append(1)
            return {"items": [run_item(status="compiling" if len(polls) == 1 else "succeeded", expected=1)]}

    patch_clients(monkeypatch, compile, Slow)
    monkeypatch.setattr(compile.time, "sleep", lambda _seconds: None)
    execute(compile.run, context(ready_connection, {**COMPILE, "run_id": "r0"}))

    assert len(polls) == 2
    run = compile_store.compile_run_by_run_id(ready_connection, "r0")
    assert run["status"] == run_store.STATUS_SUCCEEDED


@pytest.mark.parametrize(
    ("current_at", "polls"),
    [
        (
            lambda n: [
                run_item(
                    "current",
                    "compiling" if n < 3 else "succeeded",
                    succeeded=2 if n < 3 else None,
                    spaceJobSequence=2,
                )
            ],
            3,
        ),
        (lambda n: [run_item("current", spaceJobSequence=2)] if n > 1 else [], 2),
    ],
    ids=["progress-from-current-run", "waits-for-new-run"],
)
def test_wait_for_compile_ignores_historical_runs(ready_connection, monkeypatch, current_at, polls):
    monkeypatch.setattr(compile, "POLL_INTERVAL_SECONDS", 0)

    class Runs(FakeClient):
        polls = 0

        def run_diagnostics(self, space_ids, *, limit=50):
            self.polls += 1
            old = run_item("old", expected=100, spaceJobSequence=1, runDurationMs=999999)
            return {"items": [old, *current_at(self.polls)]}

    client = Runs()
    result = compile._wait_for_compile(
        context(ready_connection),
        client,
        "space-1",
        expect_runs=1,
        baseline_run_ids={"old"},
        baseline_sequence=1,
    )
    assert client.polls == polls
    assert result["status_counts"] == {"succeeded": 1}
    assert [run["runId"] for run in result["runs"]] == ["current"]


def bind_compile_task(connection, params: dict[str, Any] | None = None) -> tuple[int, int]:
    compile_id = make_compile_run(connection, "bound", ["hotpotqa"], qa_limit=1)
    task_id = task_store.create_task(connection, stage="compile", params=params or {})
    task_store.set_task_target(connection, task_id, "compile", compile_id)
    connection.commit()
    return compile_id, task_id


class PagesClient(FakeClient):
    def __init__(self, items_by_run):
        super().__init__()
        self.items_by_run = items_by_run

    def run_pages(self, run_id, *, page=1, limit=100):
        items = self.items_by_run.get(run_id, [])
        return {"items": items, "total": len(items), "limit": limit}


@pytest.mark.parametrize(
    ("page_ids", "items_by_run", "expected"),
    [
        pytest.param(
            ["target-0", "target-1"],
            {
                "run-1": [
                    {"sourcePageId": "target-0", "status": "succeeded"},
                    {"sourcePageId": "target-1", "status": "succeeded"},
                    {"sourcePageId": "unrelated", "status": "succeeded"},
                ]
            },
            {"expected": 2, "succeeded": 2, "failed": 0, "skipped": 0},
            id="ignores-pages-outside-this-compile",
        ),
        pytest.param(
            ["retry-0", "retry-1"],
            {
                "original": [
                    {"sourcePageId": "retry-0", "status": "succeeded"},
                    {"sourcePageId": "retry-1", "status": "failed"},
                ],
                "retry": [{"sourcePageId": "retry-1", "status": "succeeded"}],
            },
            {"expected": 2, "succeeded": 2, "failed": 0, "skipped": 0},
            id="latest-status-wins-across-retry-runs",
        ),
        pytest.param(
            ["merge-page"],
            {"run": [{"sourcePageId": "merge-page", "status": "succeeded", "mergeStatus": "failed"}]},
            {"expected": 1, "succeeded": 0, "failed": 1, "skipped": 0},
            id="merge-failure-counts-as-failed",
        ),
    ],
)
def test_compile_progress(ready_connection, page_ids, items_by_run, expected):
    compile_id, task_id = bind_compile_task(ready_connection)
    compile.build_subset(
        ready_connection, compile_id, "hotpotqa", seed=1, qa_limit=1, negatives_ratio=1.0
    )
    for doc, page_id in zip(compile_store.compile_docs(ready_connection, compile_id), page_ids):
        compile_store.record_page(
            ready_connection, compile_id, doc["dataset"], doc["doc_id"], page_id=page_id, error=None
        )
    runs = [{"runId": run_id} for run_id in items_by_run]
    progress = compile._target_run_progress(
        context(ready_connection, task_id=task_id), PagesClient(items_by_run), runs
    )
    assert progress == expected


def test_compile_progress_uses_remote_total_when_retrying(ready_connection, monkeypatch):
    _, task_id = bind_compile_task(ready_connection)
    page_ids = [f"page-{index}" for index in range(244)]
    monkeypatch.setattr(
        compile.compile_store,
        "compile_docs",
        lambda *_args, **_kwargs: [{"page_id": page_id} for page_id in page_ids],
    )
    client = PagesClient(
        {
            "original": [{"sourcePageId": page_id, "status": "succeeded"} for page_id in page_ids[:105]],
            "retry": [{"sourcePageId": page_id, "status": "succeeded"} for page_id in page_ids[105:108]],
        }
    )
    progress = compile._target_run_progress(
        context(ready_connection, task_id=task_id),
        client,
        [
            {"runId": "original", "progress": {"text": {"expected": 244}}},
            {"runId": "retry", "progress": {"text": {"expected": 3}}},
        ],
    )
    assert progress == {"expected": 244, "succeeded": 108, "failed": 0, "skipped": 0}


def test_retry_batches_resume_current_run_before_submitting_pending(ready_connection, monkeypatch):
    pending = [f"pending-{index}" for index in range(6)]
    retry_state = {
        "retry_current_page_ids": [f"current-{index}" for index in range(100)],
        "retry_pending_page_ids": pending,
        "retry_current_run_ids": ["run-current"],
        "remote_compile_run_ids": ["run-current"],
        "retry_completed": 0,
        "retry_total": 106,
        "retry_progress": {"expected": 106, "succeeded": 0, "failed": 0, "skipped": 0},
    }
    _, task_id = bind_compile_task(ready_connection, retry_state)
    submitted: list[list[str]] = []

    class RetryClient(FakeClient):
        def retry_pages(self, page_ids):
            submitted.append(list(page_ids))
            return {"jobIds": ["run-pending"], "queuedPageCount": 1}

    def wait(_ctx, _client, _space, **kwargs):
        count = len(kwargs["progress_page_ids"])
        return {
            "status_counts": {"succeeded": 1},
            "no_runs": False,
            "runs": [],
            "progress": {"expected": count, "succeeded": count, "failed": 0, "skipped": 0},
        }

    monkeypatch.setattr(compile, "_wait_for_compile", wait)
    ctx = context(ready_connection, retry_state, task_id=task_id)
    result, run_count = compile._retry_batches(ctx, RetryClient(), "space")

    assert submitted == [pending]
    assert run_count == 2
    assert result["progress"] == {"expected": 106, "succeeded": 106, "failed": 0, "skipped": 0}


def test_retry_batches_reject_inconsistent_remote_run_count(ready_connection):
    _, task_id = bind_compile_task(ready_connection)

    class BadCount(FakeClient):
        def retry_pages(self, page_ids):
            return {"queuedPageCount": 2, "jobIds": ["one-run"]}

    with pytest.raises(RuntimeError, match="重试响应计数不一致"):
        compile._retry_batches(
            context(ready_connection, task_id=task_id), BadCount(), "space", ["page-1"]
        )


def test_compile_succeeds_and_records_pages(ready_connection, monkeypatch):
    clients = patch_clients(monkeypatch, compile)
    ctx = context(ready_connection, {**COMPILE, "run_id": "r1"})
    execute(compile.run, ctx)

    run = compile_store.compile_run_by_run_id(ready_connection, "r1")
    assert run["status"] == run_store.STATUS_SUCCEEDED
    assert run["space_id"] == "space-1"
    assert loads(run["model_configs_json"]) == CONFIGS
    pace = loads(run["pace_json"])
    assert (pace["pages"], pace["total_ms"], pace["per_page_ms"]) == (4, 8000, 2000)
    assert compile_store.compile_ready(ready_connection, int(run["id"]))["ready"] is True
    docs = compile_store.compile_docs(ready_connection, int(run["id"]))
    assert docs and all(doc["page_id"] for doc in docs)
    assert sum(len(client.imported) for client in clients) == len(docs)
    task = task_store.get_task(ready_connection, ctx.task_id)
    assert task["params"]["remote_compile_run_ids"] == ["remote-run-1"]
    assert (task["progress_done"], task["progress_total"], task["progress_note"]) == (
        len(docs),
        len(docs),
        "编译完成",
    )
    logs = task_store.task_logs(ready_connection, ctx.task_id)
    assert all("编译进度" not in entry["message"] for entry in logs)


def test_compile_resume_retries_only_failed_remote_pages(ready_connection, monkeypatch):
    failed_page_id = "00000000-0000-0000-0000-000000000004"
    state = {"compiles": 0, "quality_checks": 0, "retried": []}

    class Resumable(FakeClient):
        def compile_spaces(self, space_ids):
            state["compiles"] += 1
            if state["compiles"] > 1:
                pytest.fail("继续任务不应再次触发全空间编译")
            return super().compile_spaces(space_ids)

        def run_diagnostics(self, space_ids, *, limit=50):
            items = [run_item(status="partial", succeeded=3, failed=1)]
            if state["retried"]:
                items.append(run_item("retry-run-1", expected=1))
            return {"items": items}

        def quality_diagnostics(self, space_ids):
            state["quality_checks"] += 1
            missing = int(state["quality_checks"] == 1)
            summary = {"missingChunkPageCount": missing, "missingSourcePageCount": missing}
            return {"summary": {**CLEAN_QUALITY["summary"], **summary}}

        def run_pages(self, run_id, *, page=1, limit=100):
            if run_id == "retry-run-1":
                items = [{"sourcePageId": failed_page_id, "status": "succeeded"}]
            else:
                assert run_id == "remote-run-1"
                items = [
                    {"sourcePageId": "00000000-0000-0000-0000-000000000001", "status": "succeeded"},
                    {"sourcePageId": failed_page_id, "status": "failed"},
                ]
            return {"items": items, "total": len(items), "page": page, "limit": limit}

        def retry_pages(self, page_ids):
            state["retried"].append(list(page_ids))
            return {"queuedPageCount": 1, "jobIds": ["retry-run-1"]}

    clients = patch_clients(monkeypatch, compile, Resumable)
    ctx = context(ready_connection, {**COMPILE, "run_id": "r1"})
    with pytest.raises(RuntimeError, match="质量闸门"):
        execute(compile.run, ctx)
    first_run_clients = len(clients)
    assert sum(len(client.imported) for client in clients) > 0

    execute(compile.run, context(ready_connection, task_id=ctx.task_id))

    assert all(client.imported == [] for client in clients[first_run_clients:])
    assert state["compiles"] == 1
    assert state["retried"] == [[failed_page_id]]
    params = task_store.get_task(ready_connection, ctx.task_id)["params"]
    assert params["remote_compile_run_ids"] == ["remote-run-1", "retry-run-1"]


def test_compile_resume_adopts_active_remote_run(ready_connection, monkeypatch):
    params = {
        "datasets": ["hotpotqa"],
        "seed": 1,
        "qa_limit": 1,
        "negatives_ratio": 1.0,
        "full_corpus": False,
        "import_concurrency": 1,
        "run_id": "bound",
        "remote_compile_run_ids": ["active-run"],
    }
    compile_id, task_id = bind_compile_task(ready_connection, params)
    compile.build_subset(
        ready_connection, compile_id, "hotpotqa", seed=1, qa_limit=1, negatives_ratio=1.0
    )
    compile_store.update_compile_run(
        ready_connection,
        compile_id,
        space_id="space-1",
        workspace_id="w",
        model_configs_json=dumps(CONFIGS),
    )
    for index, doc in enumerate(compile_store.compile_docs(ready_connection, compile_id)):
        compile_store.record_page(
            ready_connection, compile_id, doc["dataset"], doc["doc_id"], page_id=f"page-{index}", error=None
        )
    ready_connection.commit()
    polls: list[int] = []

    class Recovering(FakeClient):
        def run_diagnostics(self, space_ids, *, limit=50):
            polls.append(1)
            status = "compiling" if len(polls) == 1 else "succeeded"
            return {"items": [run_item("active-run", status, expected=1)]}

        def compile_spaces(self, space_ids):
            pytest.fail("接管活动 Run 时不应新建全空间编译")

        def retry_pages(self, page_ids):
            pytest.fail("接管活动 Run 时不应提交页面重试")

    patch_clients(monkeypatch, compile, Recovering)
    monkeypatch.setattr(compile.time, "sleep", lambda _seconds: None)
    execute(compile.run, context(ready_connection, task_id=task_id))

    assert len(polls) == 2
    assert task_store.get_task(ready_connection, task_id)["status"] == task_store.SUCCEEDED


def test_compile_resume_retries_target_pages_when_cancelled_before_page_initialization(
    ready_connection, monkeypatch
):
    patch_clients(monkeypatch, compile)
    ctx = context(ready_connection, {"datasets": ["hotpotqa"], "qa_limit": 1, "run_id": "early"})
    execute(compile.run, ctx)
    task_store.transition(ready_connection, ctx.task_id, task_store.PAUSED)
    ready_connection.commit()
    retried: list[list[str]] = []

    class CancelledBeforeInit(FakeClient):
        def run_diagnostics(self, space_ids, *, limit=50):
            cancelled = run_item(status="cancelled", expected=0)
            return {"items": [cancelled, run_item("new-run", expected=1)] if retried else [cancelled]}

        def compile_spaces(self, space_ids):
            pytest.fail("继续未初始化 Run 不应扫描整个 Space")

        def retry_pages(self, page_ids):
            retried.append(list(page_ids))
            return {"queuedPageCount": len(page_ids), "jobIds": ["new-run"]}

        def run_pages(self, run_id, *, page=1, limit=100):
            items = [{"sourcePageId": page_id, "status": "succeeded"} for page_id in retried[0]] if retried else []
            return {"items": items, "total": len(items), "limit": limit}

    patch_clients(monkeypatch, compile, CancelledBeforeInit)
    execute(compile.run, context(ready_connection, task_id=ctx.task_id))

    docs = compile_store.compile_docs(ready_connection, int(ctx.target("compile")))
    assert retried == [list(dict.fromkeys(str(row["page_id"]) for row in docs if row.get("page_id")))]
    params = task_store.get_task(ready_connection, ctx.task_id)["params"]
    assert params["remote_compile_run_ids"] == ["remote-run-1", "new-run"]


def test_compile_imports_concurrently(ready_connection, monkeypatch):
    lock = threading.Lock()
    state = {"active": 0, "peak": 0, "imported": 0}

    class Concurrent(FakeClient):
        def import_page_text(self, filename, markdown, space_id):
            with lock:
                state["active"] += 1
                state["peak"] = max(state["peak"], state["active"])
            time.sleep(0.02)
            with lock:
                state["active"] -= 1
                state["imported"] += 1
                return {"id": f"page-{state['imported']}"}

    patch_clients(monkeypatch, compile, Concurrent)
    ctx = context(ready_connection, {**COMPILE, "run_id": "concurrent", "import_concurrency": 3})
    execute(compile.run, ctx)

    run = compile_store.compile_run_by_run_id(ready_connection, "concurrent")
    assert state["peak"] > 1
    assert state["imported"] == len(compile_store.compile_docs(ready_connection, int(run["id"])))
    assert task_store.get_task(ready_connection, ctx.task_id)["params"]["import_concurrency"] == 3


def test_compile_retries_then_pauses_and_resume_only_imports_pending(ready_connection, monkeypatch):
    attempts: dict[str, int] = {}
    state = {"imported": 0, "compiles": 0, "failing": True, "failed": None}
    lock = threading.Lock()

    class Retryable(FakeClient):
        def import_page_text(self, filename, markdown, space_id):
            with lock:
                state["failed"] = state["failed"] or filename
                attempts[filename] = attempts.get(filename, 0) + 1
                if state["failing"] and filename == state["failed"]:
                    return {}
                state["imported"] += 1
                return {"id": f"page-{state['imported']}"}

        def compile_spaces(self, space_ids):
            state["compiles"] += 1
            return super().compile_spaces(space_ids)

    patch_clients(monkeypatch, compile, Retryable)
    ctx = context(ready_connection, {**COMPILE, "run_id": "retry", "import_concurrency": 3})
    with pytest.raises(Paused, match="重试后仍未导入"):
        execute(compile.run, ctx)

    run = compile_store.compile_run_by_run_id(ready_connection, "retry")
    compile_id = int(run["id"])
    docs = compile_store.compile_docs(ready_connection, compile_id)
    succeeded = {f"{doc['doc_id']}.md" for doc in docs if doc["page_id"]}
    assert attempts[state["failed"]] == 2
    assert all(attempts[name] == 1 for name in succeeded)
    assert len(succeeded) == len(docs) - 1
    assert task_store.get_task(ready_connection, ctx.task_id)["status"] == task_store.PAUSED
    assert run["status"] == run_store.STATUS_PAUSED
    assert state["compiles"] == 0

    state["failing"] = False
    execute(compile.run, context(ready_connection, task_id=ctx.task_id))

    assert all(doc["page_id"] for doc in compile_store.compile_docs(ready_connection, compile_id))
    assert attempts[state["failed"]] == 3
    assert all(attempts[name] == 1 for name in succeeded)
    assert state["compiles"] == 1


def test_query_blocks_embedding_change_without_lineage(ready_connection, compiled, monkeypatch):
    patch_clients(monkeypatch, query, configs=with_model("embedding", "e2"))
    with pytest.raises(RuntimeError, match="无法用 PostgreSQL 确认"):
        execute(query.run, context(ready_connection, {"compile_id": compiled, "name": "changed"}))
    assert query_store.query_run_by_name(ready_connection, "changed") is None


def test_query_allows_other_config_changes_and_snapshots_them(ready_connection, compiled, monkeypatch):
    changed = {
        "configs": [
            entry if entry["feature"] == "embedding" else {**entry, "model": f"other-{entry['feature']}"}
            for entry in CONFIGS["configs"]
        ]
    }
    patch_clients(monkeypatch, query, configs=changed)
    params = {"compile_id": compiled, "name": "compatible", "concurrency": 2}
    execute(query.run, context(ready_connection, params))

    run = query_store.query_run_by_name(ready_connection, "compatible")
    assert run["status"] == run_store.STATUS_SUCCEEDED
    assert run["concurrency"] == 2
    assert loads(run["model_configs_json"]) == changed


def test_query_refuses_on_workspace_mismatch(ready_connection, compiled, monkeypatch):
    patch_clients(monkeypatch, query, OtherWorkspace)
    with pytest.raises(RuntimeError, match="workspace"):
        execute(query.run, context(ready_connection, {"compile_id": compiled}))
    assert query_store.list_query_runs(ready_connection, compiled) == []


def test_compile_resume_refuses_on_workspace_mismatch(ready_connection, compiled, monkeypatch):
    ready_connection.execute("UPDATE compile_doc SET page_id = NULL WHERE compile_id = ?", (compiled,))
    ready_connection.commit()
    clients = patch_clients(monkeypatch, compile, OtherWorkspace)
    with pytest.raises(RuntimeError, match="workspace"):
        execute(compile.run, context(ready_connection, task_id=1))
    assert clients[-1].imported == []


def test_workspace_mismatch_rejects_missing_record(ready_connection, compiled):
    ready_connection.execute("UPDATE compile_run SET workspace_id = NULL WHERE id = ?", (compiled,))
    ready_connection.commit()
    message = compile_store.workspace_mismatch(ready_connection, compiled, "w-other")
    assert "没有记录 workspace" in message


def test_query_refuses_unready_compile(ready_connection, monkeypatch):
    compile_id = make_compile_run(ready_connection, "half", ["hotpotqa"], qa_limit=1)
    patch_clients(monkeypatch, query)
    with pytest.raises(ValueError, match="不能用于查询"):
        execute(query.run, context(ready_connection, {"compile_id": compile_id}))


def test_query_records_responses_and_resumes(ready_connection, compiled, monkeypatch):
    clients = patch_clients(monkeypatch, query)
    ctx = context(ready_connection, {"compile_id": compiled, "name": "q1"})
    execute(query.run, ctx)

    run = query_store.query_run_by_name(ready_connection, "q1")
    assert run["status"] == run_store.STATUS_SUCCEEDED
    responses = query_store.responses_of(ready_connection, int(run["id"]))
    assert len(responses) == 2
    assert all(r["answer_mode"] == "knowledge" for r in responses)

    execute(query.run, ctx)
    assert clients[-1].queries == []


def test_query_quality_gate_rejects_generation_unavailable_answer(ready_connection, compiled, monkeypatch):
    class EmptyAnswer(FakeClient):
        def query(self, question, space_ids):
            body = {
                "answerMode": "knowledge",
                "answer": query_store.ANSWER_GENERATION_UNAVAILABLE,
                "retrievedSources": [{"sourcePageId": "p1"}],
            }
            return Response(status=200, body=body, latency_ms=10)

    patch_clients(monkeypatch, query, EmptyAnswer)
    with pytest.raises(RuntimeError, match="质量阀门"):
        execute(query.run, context(ready_connection, {"compile_id": compiled, "name": "empty"}))

    run = query_store.query_run_by_name(ready_connection, "empty")
    assert run["status"] == run_store.STATUS_FAILED
    assert query_store.retryable_response_count(ready_connection, int(run["id"])) == 2


def test_query_resume_refuses_remote_answer_config_drift(ready_connection, compiled, monkeypatch):
    patch_clients(monkeypatch, query)
    ctx = context(ready_connection, {"compile_id": compiled, "name": "drift-query"})
    execute(query.run, ctx)

    patch_clients(monkeypatch, query, configs=with_model("answer", "changed-answer"))
    with pytest.raises(RuntimeError, match="不能继续原查询.*answer"):
        execute(query.run, context(ready_connection, task_id=ctx.task_id))


def test_query_uses_frozen_selection(ready_connection, compiled, monkeypatch):
    patch_clients(monkeypatch, query)
    params = {"compile_id": compiled, "name": "q1", "sample_limit": 1}
    execute(query.run, context(ready_connection, params))
    run = query_store.query_run_by_name(ready_connection, "q1")
    assert len(query_store.query_samples(ready_connection, int(run["id"]))) == 1


def test_query_rejects_name_from_another_compile(ready_connection, compiled, monkeypatch):
    other = make_compile_run(ready_connection, "other", [], qa_limit=1)
    query_store.create_query_run(
        ready_connection, name="taken", compile_id=other, concurrency=1, model_configs=CONFIGS
    )
    patch_clients(monkeypatch, query)
    with pytest.raises(ValueError, match="已存在"):
        execute(query.run, context(ready_connection, {"compile_id": compiled, "name": "taken"}))


def test_unnamed_queries_create_independent_runs(ready_connection, compiled, monkeypatch):
    patch_clients(monkeypatch, query)
    for _ in range(2):
        execute(query.run, context(ready_connection, {"compile_id": compiled}))
    runs = query_store.list_query_runs(ready_connection, compiled)
    assert len(runs) == 2
    assert len({run["name"] for run in runs}) == 2


def test_same_name_does_not_resume_another_task(ready_connection, compiled):
    with pytest.raises(ValueError, match="已存在"):
        execute(compile.run, context(ready_connection, {**COMPILE, "run_id": "r1"}))
    assert len(compile_store.list_compile_runs(ready_connection)) == 1


def test_compile_resume_keeps_resolved_defaults(ready_connection, monkeypatch):
    clients = patch_clients(monkeypatch, compile)
    monkeypatch.setattr(compile, "default_seed", lambda: 7)
    ctx = context(ready_connection, COMPILE)
    execute(compile.run, ctx)
    original = task_store.get_task(ready_connection, ctx.task_id)

    monkeypatch.setattr(compile, "default_seed", lambda: 99)
    execute(compile.run, context(ready_connection, {"seed": 99, "qa_limit": 1}, task_id=ctx.task_id))
    task = task_store.get_task(ready_connection, ctx.task_id)
    assert task["target_id"] == original["target_id"]
    assert task["params"] == original["params"]
    assert task["params"]["seed"] == 7
    assert clients[-1].imported == []


def test_deleted_run_cannot_be_recreated_by_resume(ready_connection, compiled):
    compile_store.delete_compile_run(ready_connection, compiled)
    ready_connection.commit()
    with pytest.raises(ValueError, match="已被清理"):
        execute(compile.run, context(ready_connection, task_id=1))
    assert compile_store.list_compile_runs(ready_connection) == []


def _active(model, chunks):
    return {"model": model, "dimensions": 1024, "active": True, "chunks": chunks}


def stub_lineage(monkeypatch, module, generation_steps, batch_steps=(0,)):
    generation_steps, batch_steps = list(generation_steps), list(batch_steps)

    def advance(steps):
        return steps.pop(0) if len(steps) > 1 else steps[0]

    class Reader:
        def __init__(self, database_url):
            self.database_url = database_url

        def space_embedding_generations(self, space_id):
            return {"space_id": space_id, "generations": advance(generation_steps)}

        def server_now(self):
            return "2026-10-14T00:00:00+00:00"

        def space_rebuild_usage(self, space_id, *, since=None):
            chunks = advance(batch_steps)
            model = {
                "model": "e1",
                "batches": 1,
                "chunks": chunks,
                "failed": 0,
                "total_tokens": chunks * 10,
                "duration_ms_sum": chunks * 100,
                "first_batch_at": None,
                "last_batch_at": None,
            }
            return {
                "space_id": space_id,
                "models": [model] if chunks else [],
                "batches": 1 if chunks else 0,
                "chunks": chunks,
                "failed": 0,
                "last_batch_at": None,
            }

        def query_audits(self, questions, *, since=None):
            raise LineageUnavailable("stubbed")

    monkeypatch.setattr(module, "LineageReader", Reader)


@pytest.mark.parametrize(
    ("generations", "match"),
    [
        ([_active("changed-embedding", 4)], None),
        ([_active("changed-embedding", 3), _active("e1", 1)], "已重建 3 / 共 4"),
        ([_active("e1", 4)], "重建嵌入"),
    ],
    ids=["fully-rebuilt", "half-rebuilt", "not-rebuilt"],
)
def test_query_after_embedding_change_requires_full_rebuild(
    ready_connection, compiled, monkeypatch, generations, match
):
    patch_clients(monkeypatch, query, configs=with_model("embedding", "changed-embedding"))
    stub_lineage(monkeypatch, query, [generations])
    ctx = context(ready_connection, {"compile_id": compiled, "name": "rebuilt"})
    if match is None:
        execute(query.run, ctx)
        run = query_store.query_run_by_name(ready_connection, "rebuilt")
        assert run["status"] == run_store.STATUS_SUCCEEDED
    else:
        with pytest.raises(RuntimeError, match=match):
            execute(query.run, ctx)


@pytest.fixture
def embed_client(monkeypatch):
    monkeypatch.setattr(embed.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(embed, "MAX_IDLE_POLLS", 3)
    return patch_client(monkeypatch, embed, FakeClient())


@pytest.mark.parametrize(
    ("target", "generations", "batches", "params", "concurrency"),
    [
        ("e1", [[_active("e1", 4)]], [0, 2, 4], {}, None),
        ("e1-new", [[_active("e1", 4)], [_active("e1-new", 4)]], [0, 2, 4], {"embedding_concurrency": 16}, 16),
    ],
    ids=["same-model-by-batches", "new-model-by-coverage"],
)
def test_embed_rebuilds_until_complete(
    ready_connection, compiled, monkeypatch, embed_client, target, generations, batches, params, concurrency
):
    embed_client.configs = with_model("embedding", target)
    stub_lineage(monkeypatch, embed, generations, batches)
    execute(embed.run, context(ready_connection, {"compile_id": compiled, **params}))
    assert embed_client.rebuilt == [{"spaces": ["space-1"], "concurrency": concurrency}]


@pytest.mark.parametrize(
    ("target", "generations", "batches", "match"),
    [
        ("e1", [[_active("e1", 4)]], [0], "没有产生任何重建批次"),
        ("e1-new", [[_active("e1", 4)], [_active("e1-new", 3), _active("e1", 1)]], [0, 4], "只有 3 / 4"),
        ("e1-new", [[_active("e1", 4)]], [0, 2], "进度停在 2 / 4"),
    ],
    ids=["no-batch", "coverage-incomplete", "stalled"],
)
def test_embed_fails_when_rebuild_does_not_finish(
    ready_connection, compiled, monkeypatch, embed_client, target, generations, batches, match
):
    embed_client.configs = with_model("embedding", target)
    stub_lineage(monkeypatch, embed, generations, batches)
    with pytest.raises(RuntimeError, match=match):
        execute(embed.run, context(ready_connection, {"compile_id": compiled}))


def test_embed_resume_reuses_frozen_rebuild_start(ready_connection, compiled, monkeypatch, embed_client):
    stub_lineage(monkeypatch, embed, [[_active("e1", 4)]], [4])
    seen: list[str | None] = []

    class Recording(embed.LineageReader):
        def server_now(self):
            pytest.fail("续跑不应重取起点")

        def space_rebuild_usage(self, space_id, *, since=None):
            seen.append(since)
            return super().space_rebuild_usage(space_id, since=since)

    monkeypatch.setattr(embed, "LineageReader", Recording)
    since = "2026-10-13T00:00:00+00:00"
    execute(embed.run, context(ready_connection, {"compile_id": compiled, "rebuild_since": since}))
    assert seen == [since]


def test_embed_skips_when_space_has_no_active_chunks(ready_connection, compiled, monkeypatch, embed_client):
    stub_lineage(monkeypatch, embed, [[]])
    execute(embed.run, context(ready_connection, {"compile_id": compiled}))
    assert embed_client.rebuilt == []


@pytest.mark.parametrize("value", [0, 51])
def test_embed_rejects_concurrency_outside_remote_limit(ready_connection, compiled, embed_client, value):
    with pytest.raises(ValueError, match="1 到 50"):
        params = {"compile_id": compiled, "embedding_concurrency": value}
        execute(embed.run, context(ready_connection, params))


def test_embed_requires_database_url(ready_connection, compiled, embed_client):
    config_store.update_connection(ready_connection, database_url="")
    with pytest.raises(RuntimeError, match="PostgreSQL"):
        execute(embed.run, context(ready_connection, {"compile_id": compiled}))
