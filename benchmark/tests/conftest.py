from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest

from akasha_benchmark.store import (
    compile_store,
    connect,
    data_store,
    eval_store,
    init_db,
    query_store,
    task_store,
)
from akasha_benchmark.task import TaskContext

QA_ROWS = [
    {
        "_id": "q1",
        "question": "Who won the Grammy and the Emmy?",
        "answer": "Rita Moreno",
        "type": "bridge",
        "supporting_facts": [["Rita Moreno", 0], ["EGOT", 0]],
        "context": [["Rita Moreno", ["a"]], ["EGOT", ["b"]]],
    },
    {
        "_id": "q2",
        "question": "Which city hosts the festival?",
        "answer": "Venice",
        "type": "comparison",
        "supporting_facts": [["Venice", 0]],
        "context": [["Venice", ["c"]]],
    },
]

CORPUS_ROWS = [
    {"idx": 0, "title": "Rita Moreno", "text": "Rita Moreno won a Grammy and an Emmy award."},
    {"idx": 1, "title": "EGOT", "text": "EGOT means Emmy, Grammy, Oscar and Tony."},
    {"idx": 2, "title": "Venice", "text": "Venice hosts the film festival each year."},
    {"idx": 3, "title": "Distractor", "text": "Unrelated filler content for negatives."},
]


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    path = tmp_path / "bench.db"
    init_db(path)
    return path


@pytest.fixture
def db(db_path: Path):
    connection = connect(db_path)
    yield connection
    connection.close()


@pytest.fixture
def dataset_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "dataset"
    directory.mkdir()
    (directory / "hotpotqa.json").write_text(json.dumps(QA_ROWS), encoding="utf-8")
    (directory / "hotpotqa_corpus.json").write_text(json.dumps(CORPUS_ROWS), encoding="utf-8")
    return directory


LOCAL_QA_ROWS = [
    {
        "id": "doc_001-q1",
        "question": "怎么申请设备？",
        "answer": "填写申请单。",
        "evidence": [{"doc_id": "doc_001", "quote": "填写申请单即可。"}],
    },
    {
        "id": "doc_002-q1",
        "question": "IMAP 用哪个端口？",
        "answer": "993",
        "evidence": [{"doc_id": "doc_002", "quote": "IMAP 用 993 端口。"}],
    },
]

LOCAL_CORPUS_ROWS = [
    {"id": "doc_001", "title": "设备申请说明", "text": "# 设备申请说明\n\n填写申请单即可。"},
    {"id": "doc_002", "title": "邮箱配置说明", "text": "# 邮箱配置说明\n\nIMAP 用 993 端口。"},
    {"id": "doc_003", "title": "打印机", "text": "# 打印机\n\n三楼有彩色打印机。"},
]


@pytest.fixture
def local_dataset_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "local"
    directory.mkdir()
    (directory / "kb.json").write_text(
        json.dumps(LOCAL_QA_ROWS, ensure_ascii=False), encoding="utf-8"
    )
    (directory / "kb_corpus.json").write_text(
        json.dumps(LOCAL_CORPUS_ROWS, ensure_ascii=False), encoding="utf-8"
    )
    return directory


def _normalize(db, name: str, directory: Path, monkeypatch):
    from akasha_benchmark.datasets.registry import get_adapter
    from akasha_benchmark.stages import normalize

    monkeypatch.setattr(type(get_adapter(name)), "expected_qa_rows", lambda self: None)
    normalize.normalize_dataset(db, name, None, directory)
    assert data_store.get_dataset(db, name) is not None
    return db


@pytest.fixture
def local_normalized(db, local_dataset_dir: Path, monkeypatch):
    return _normalize(db, "kb", local_dataset_dir, monkeypatch)


@pytest.fixture
def normalized(db, dataset_dir: Path, monkeypatch):
    return _normalize(db, "hotpotqa", dataset_dir, monkeypatch)


def make_context(connection, params=None, task_id=None, stage="test") -> TaskContext:
    params = params or {}
    if task_id is None:
        task_id = task_store.create_task(connection, stage=stage, params=params)
    connection.commit()
    return TaskContext(
        task_id=task_id,
        stage=stage,
        params=params,
        connection=connection,
        pause_event=threading.Event(),
    )


def make_compile_run(connection, run_id="r", datasets=("d",), **overrides) -> int:
    params = {"seed": 1, "qa_limit": 2, "negatives_ratio": 1.0} | overrides
    return compile_store.create_compile_run(
        connection, run_id=run_id, datasets=list(datasets), **params
    )


@pytest.fixture
def compile_id(db):
    return make_compile_run(db)


@pytest.fixture
def query_id(db, compile_id):
    return query_store.create_query_run(
        db, name="q", compile_id=compile_id, concurrency=1, model_configs={}
    )


@pytest.fixture
def eval_id(db, query_id):
    return eval_store.create_eval_run(
        db, name="e", query_id=query_id, ks=[2], metrics=["faithfulness"], judge_provider_id=None
    )
