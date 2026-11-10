from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from ..datasets import (
    CanonicalSample,
    dataset_names,
    load_corpus,
    resolve,
)
from ..io_utils import load_json, sha256_file
from ..store import data_store, transaction
from ..task import TaskContext


def normalize_dataset(
    connection: sqlite3.Connection,
    name: str,
    ctx: TaskContext | None = None,
    dataset_dir: Path | None = None,
) -> dict[str, Any]:
    resolved = resolve(name, dataset_dir)
    adapter = resolved.adapter

    corpus = load_corpus(adapter.name, resolved.corpus_path)
    rows = load_json(resolved.qa_path)
    if not isinstance(rows, list):
        raise ValueError(f"{resolved.qa_path.name}: expected a JSON array")

    expected = adapter.expected_qa_rows()
    if expected is not None and len(rows) != expected:
        raise ValueError(
            f"{adapter.name}: QA 文件有 {len(rows)} 行，适配器预期 {expected} 行。"
            "数据快照变了，先重新核对身份规则。"
        )

    samples: list[CanonicalSample] = []
    seen: dict[str, int] = {}
    for index, row in enumerate(rows):
        sample = adapter.parse_row(row, index, corpus)
        if sample.sample_id in seen:
            raise ValueError(
                f"{adapter.name}: sample_id {sample.sample_id!r} 在第 "
                f"{seen[sample.sample_id]} 与第 {index} 行重复"
            )
        seen[sample.sample_id] = index
        samples.append(sample)
        if ctx and (index + 1) % 200 == 0:
            ctx.progress(index + 1, len(rows), f"{name} 解析 {index + 1}/{len(rows)}")

    with transaction(connection):
        data_store.upsert_dataset(
            connection,
            name=adapter.name,
            qa_sha256=sha256_file(resolved.qa_path),
            qa_rows=len(rows),
            corpus_sha256=sha256_file(resolved.corpus_path),
            corpus_rows=len(corpus.docs),
        )
        sample_count = data_store.replace_samples(
            connection, adapter.name, (s.model_dump(mode="json") for s in samples)
        )
        corpus_count = data_store.replace_corpus(
            connection, adapter.name, (d.model_dump(mode="json") for d in corpus.docs)
        )

    return {
        "dataset": adapter.name,
        "samples": sample_count,
        "corpus": corpus_count,
        "provides": sorted(d.value for d in adapter.provides),
    }


def validate_dataset(connection: sqlite3.Connection, name: str) -> list[str]:
    problems: list[str] = []
    record = data_store.get_dataset(connection, name)
    if record is None:
        return [f"{name}: 没有归一化记录"]

    samples = data_store.samples_of(connection, name)
    if len(samples) != record["qa_rows"]:
        problems.append(f"{name}: 样本数 {len(samples)} 与 QA 行数 {record['qa_rows']} 不一致")

    doc_ids = {d["doc_id"] for d in data_store.corpus_of(connection, name)}
    if len(doc_ids) != record["corpus_rows"]:
        problems.append(
            f"{name}: 语料条数 {len(doc_ids)} 与文件行数 {record['corpus_rows']} 不一致"
        )

    dangling = {
        sample["sample_id"]: sorted(set(sample["gold_doc_ids"]) - doc_ids)
        for sample in samples
        if set(sample["gold_doc_ids"]) - doc_ids
    }
    if dangling:
        first = next(iter(dangling.items()))
        problems.append(f"{name}: {len(dangling)} 条样本的 gold 不在语料里，例如 {first}")

    blank = [s["sample_id"] for s in samples if not s["question"].strip()]
    if blank:
        problems.append(f"{name}: {len(blank)} 条样本问题为空")
    return problems


def run(ctx: TaskContext) -> None:
    selected = list(ctx.params.get("datasets") or dataset_names())
    unknown = sorted(set(selected) - set(dataset_names()))
    if unknown:
        raise ValueError(f"未知数据集：{unknown}")

    total = len(selected) * 2
    for index, name in enumerate(selected):
        ctx.checkpoint()
        ctx.progress(index * 2, total, f"{name} 归一化")
        result = normalize_dataset(ctx.db, name, ctx)
        ctx.log(
            f"{name}: 样本 {result['samples']}，语料 {result['corpus']}，"
            f"标注 {','.join(result['provides'])}"
        )

        ctx.progress(index * 2 + 1, total, f"{name} 验收")
        problems = validate_dataset(ctx.db, name)
        for problem in problems:
            ctx.log(problem, "error")
        if problems:
            raise RuntimeError(f"{name} 归一化验收失败")
        ctx.log(f"{name}: 验收通过")

    ctx.progress(total, total, "归一化完成")
