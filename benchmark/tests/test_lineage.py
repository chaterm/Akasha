from __future__ import annotations

import pytest

from akasha_benchmark.lineage import (
    COMPILED_SOURCE_PAGES,
    SPACE_EMBEDDING_GENERATIONS,
    SPACE_REBUILD_BATCHES,
    BadPageId,
    LineageReader,
    active_coverage,
)

SPACE = "00000000-0000-0000-0000-00000000000a"


def fake_reader(monkeypatch, rows, columns=()):
    seen: dict = {}

    class Database:
        read_only = False
        description = [type("Column", (), {"name": name}) for name in columns]

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def cursor(self):
            return self

        def execute(self, sql, params):
            seen.update({"sql": sql, "params": params})

        def fetchall(self):
            return rows

    reader = LineageReader("postgresql://configured")
    monkeypatch.setattr(reader, "_connect", Database)
    return reader, seen


def test_compiled_source_pages_are_queried_in_one_batch(monkeypatch):
    page_a = "00000000-0000-0000-0000-000000000001"
    page_b = "00000000-0000-0000-0000-000000000002"
    reader, seen = fake_reader(monkeypatch, [(page_a,), (page_a,), (page_b,)])

    assert reader.compiled_source_page_ids([page_a, page_a, "invalid", page_b]) == {page_a, page_b}
    assert seen["sql"] == COMPILED_SOURCE_PAGES
    assert [str(page) for page in seen["params"]["pages"]] == [page_a, page_b]


def test_space_embedding_generations_groups_by_model_and_liveness(monkeypatch):
    columns = (
        "embedding_model", "embedding_dimensions", "active", "chunks", "embedded",
        "total_tokens", "duration_ms_sum", "duration_ms_mean", "first_created_at", "last_created_at",
    )
    rows = [
        ("e2", 1024, True, 4, 4, 800, 2400, 600.0, None, None),
        ("e1", 768, False, 4, 4, None, None, None, None, None),
    ]
    reader, seen = fake_reader(monkeypatch, rows, columns)

    active, stale = reader.space_embedding_generations(SPACE)["generations"]

    assert (seen["sql"], seen["params"]) == (SPACE_EMBEDDING_GENERATIONS, {"space": SPACE})
    assert (active["model"], active["active"], active["total_tokens"]) == ("e2", True, 800)
    assert (stale["model"], stale["active"], stale["total_tokens"]) == ("e1", False, None)


def test_space_rebuild_usage_aggregates_batches(monkeypatch):
    columns = (
        "embedding_model", "batches", "chunks", "failed",
        "total_tokens", "duration_ms_sum", "first_batch_at", "last_batch_at",
    )
    rows = [("e2", 2, 80, 1, 1600, 9000, None, None), ("e1", 1, 40, 0, None, 5000, None, None)]
    reader, seen = fake_reader(monkeypatch, rows, columns)
    since = "2026-10-14T00:00:00+00:00"

    usage = reader.space_rebuild_usage(SPACE, since=since)

    assert (seen["sql"], seen["params"]) == (SPACE_REBUILD_BATCHES, {"space": SPACE, "since": since})
    assert (usage["batches"], usage["chunks"], usage["failed"]) == (3, 120, 1)
    assert usage["models"][0]["duration_ms_sum"] == 9000
    assert usage["models"][1]["total_tokens"] is None


@pytest.mark.parametrize("method", ["space_embedding_generations", "space_rebuild_usage"])
def test_space_queries_reject_non_uuid(method):
    with pytest.raises(BadPageId, match="space id"):
        getattr(LineageReader("postgresql://configured"), method)("space-1")


def test_active_coverage_ignores_stale_generations():
    generations = [
        {"model": "e2", "active": True, "chunks": 3},
        {"model": "e1", "active": True, "chunks": 1},
        {"model": "e1", "active": False, "chunks": 4},
    ]
    assert active_coverage(generations, "e2") == {
        "total": 4,
        "matched": 3,
        "ready": False,
        "models": ["e1", "e2"],
    }
    assert active_coverage([{"model": "e2", "active": True, "chunks": 4}], "e2")["ready"] is True
    assert active_coverage([], "e2")["ready"] is False
