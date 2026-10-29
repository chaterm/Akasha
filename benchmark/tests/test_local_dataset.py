from __future__ import annotations

import io
import json
import zipfile

import pytest
from conftest import make_compile_run, make_context
from fastapi.testclient import TestClient

from akasha_benchmark.datasets import (
    DataDependency,
    LocalAdapter,
    get_adapter,
    load_corpus,
    local_names,
    registry,
)
from akasha_benchmark.datasets.space_export import parse_space_export
from akasha_benchmark.judge.client import JudgeProvider, JudgeReply
from akasha_benchmark.metrics import registry as metric_registry
from akasha_benchmark.stages import compile, download, generate
from akasha_benchmark.store import compile_store, config_store, data_store
from akasha_platform.main import create_app
from akasha_platform.settings import Settings


def _zip(files: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, text in files.items():
            archive.writestr(name, text)
    return buffer.getvalue()


def test_samples_carry_evidence_as_gold(local_normalized):
    samples = data_store.samples_of(local_normalized, "kb")
    assert [s["sample_id"] for s in samples] == ["kb:doc_001-q1", "kb:doc_002-q1"]
    assert samples[0]["gold_doc_ids"] == ["doc_001"]
    assert samples[0]["metadata"]["evidence"][0]["quote"] == "填写申请单即可。"
    docs = data_store.corpus_of(local_normalized, "kb")
    assert [d["doc_id"] for d in docs] == ["doc_001", "doc_002", "doc_003"]


@pytest.mark.parametrize(
    "row,match",
    [
        ({"id": "a", "question": "q", "answer": " ", "evidence": [{"doc_id": "d"}]}, "answer"),
        ({"question": "q", "answer": "a", "evidence": [{"doc_id": "d"}]}, "id"),
        ({"id": "a", "question": "q", "answer": "a"}, "evidence"),
        ({"id": "a", "question": "q", "answer": "a", "evidence": [{"doc_id": "x"}]}, "不在语料"),
    ],
)
def test_parse_row_rejects_bad_rows(row, match, local_dataset_dir):
    corpus = load_corpus("kb", local_dataset_dir / "kb_corpus.json")
    with pytest.raises(ValueError, match=match):
        LocalAdapter("kb").parse_row(row, 0, corpus)


def test_local_adapter_enables_retrieval_metrics():
    adapter = get_adapter("kb")
    assert isinstance(adapter, LocalAdapter)
    assert adapter.downloadable is False
    assert DataDependency.GOLD_DOCS in adapter.provides
    omitted = {d.name for d in metric_registry.omitted(adapter.provides)}
    assert not ({"recall", "ndcg", "em", "faithfulness"} & omitted)


def test_full_corpus_marks_gold(local_normalized):
    compile_id = make_compile_run(local_normalized, datasets=["kb"], seed=7, qa_limit=1)
    local_normalized.commit()
    stats = compile.build_subset(
        local_normalized, compile_id, "kb", seed=7, qa_limit=1, negatives_ratio=1.0,
        full_corpus=True,
    )
    assert stats["samples"] == 1 and stats["docs"] == 3
    assert stats["gold"] == 1 and stats["negatives"] == 2
    docs = compile_store.compile_docs(local_normalized, compile_id)
    assert sum(d["is_gold"] for d in docs) == 1


def test_markdown_does_not_repeat_existing_heading(local_normalized):
    markdown = compile.markdown_of(local_normalized, "kb", "doc_001")
    assert markdown.count("# 设备申请说明") == 1


def test_local_names_skip_builtin_and_bad_names(tmp_path):
    for stem in ("kb", "hotpotqa", "Bad_Name", "my-space"):
        (tmp_path / f"{stem}_corpus.json").write_text("[]", encoding="utf-8")
    assert local_names(tmp_path) == ("kb", "my-space")
    with pytest.raises(KeyError):
        get_adapter("Bad_Name")


def test_parse_space_export_reads_md_pages():
    rows = parse_space_export(
        _zip(
            {
                "akasha-metadata.json": "{}",
                "Yellow fever.md": "# Yellow fever\n\nAn acute viral disease.",
                "dir/无标题.md": "正文没有标题",
                "empty.md": "  ",
                "image.png": "x",
            }
        )
    )
    assert rows == [
        {"id": "Yellow fever", "title": "Yellow fever", "text": "# Yellow fever\n\nAn acute viral disease."},
        {"id": "dir_无标题", "title": "无标题", "text": "正文没有标题"},
    ]
    with pytest.raises(ValueError, match="zip"):
        parse_space_export(b"not a zip")


def test_import_route_writes_corpus_and_clears_samples(db_path, tmp_path, monkeypatch):
    monkeypatch.setattr(registry, "DATASET_DIR", tmp_path)
    client = TestClient(create_app(Settings(db_path=db_path)))
    body = _zip({"A.md": "# A\n\nalpha", "B.md": "# B\n\nbeta"})

    response = client.post("/api/datasets/import?name=space-1", content=body)
    assert response.json() == {"dataset": "space-1", "docs": 2}
    assert [r["id"] for r in json.loads((tmp_path / "space-1_corpus.json").read_text("utf-8"))] == ["A", "B"]

    (tmp_path / "space-1.json").write_text("[]", encoding="utf-8")
    assert client.post("/api/datasets/import?name=space-1", content=body).status_code == 409
    assert client.post("/api/datasets/import?name=space-1&overwrite=true", content=body).status_code == 200
    assert not (tmp_path / "space-1.json").exists()

    assert client.post("/api/datasets/import?name=hotpotqa", content=body).status_code == 422
    entry = next(d for d in client.get("/api/datasets").json()["datasets"] if d["name"] == "space-1")
    assert entry["downloadable"] is False and entry["files_ready"] is False


def test_parse_items_drops_unverified_evidence():
    doc = {"doc_id": "d1", "title": "T", "text": "Alpha   is\nthe first letter."}
    content = json.dumps(
        {
            "items": [
                {"question": "What is first?", "answer": "Alpha", "evidence": ["Alpha is the first letter."]},
                {"question": "Made up?", "answer": "x", "evidence": ["not in text"]},
                {"question": "No evidence", "answer": "y", "evidence": []},
            ]
        }
    )
    rows, dropped = generate.parse_items(content, doc)
    assert dropped == 2
    assert rows == [
        {
            "id": "d1-q1",
            "question": "What is first?",
            "answer": "Alpha",
            "evidence": [{"doc_id": "d1", "quote": "Alpha is the first letter."}],
        }
    ]


def test_generate_writes_normalizable_qa(db, local_dataset_dir, monkeypatch):
    (local_dataset_dir / "kb.json").unlink()
    monkeypatch.setattr(registry, "DATASET_DIR", local_dataset_dir)
    config_store.upsert_model_provider(
        db, purpose="generation", label="g", base_url="http://x/v1", model="m", api_key="k"
    )
    db.commit()

    def fake(provider: JudgeProvider, prompts, concurrency, **_):
        replies = []
        for _system, user in prompts:
            line = user.split("<document>\n", 1)[1].split("\n</document>")[0].splitlines()[-1]
            item = {"question": f"Q about {line}?", "answer": line, "evidence": [line]}
            replies.append(JudgeReply(json.dumps({"items": [item, item]}), None, None, 200))
        return replies

    monkeypatch.setattr(generate, "complete_many", fake)
    generate.run(make_context(db, {"dataset": "kb", "per_doc": 1}, stage="generate"))

    rows = json.loads((local_dataset_dir / "kb.json").read_text("utf-8"))
    assert [r["id"] for r in rows] == ["doc_001-q1", "doc_002-q1", "doc_003-q1"]
    corpus = load_corpus("kb", local_dataset_dir / "kb_corpus.json")
    samples = [LocalAdapter("kb").parse_row(r, i, corpus) for i, r in enumerate(rows)]
    assert [s.gold_doc_ids for s in samples] == [("doc_001",), ("doc_002",), ("doc_003",)]


def test_download_only_verifies_local_dataset(db, local_dataset_dir, monkeypatch):
    def boom(_ctx):
        raise AssertionError("本地数据集不该连下载源")

    monkeypatch.setattr(download, "_resolve_endpoint", boom)
    monkeypatch.setattr(registry, "DATASET_DIR", local_dataset_dir)
    ctx = make_context(db, {"datasets": ["kb"]}, stage="download")
    download.run(ctx)

    (local_dataset_dir / "kb.json").unlink()
    with pytest.raises(RuntimeError, match="校验失败"):
        download.run(ctx)
