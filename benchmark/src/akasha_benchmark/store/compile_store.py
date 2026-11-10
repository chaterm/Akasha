from __future__ import annotations

import sqlite3
from typing import Any

from .data_store import sample_from_row
from .db import dumps, loads, utc_now
from .run_store import STATUS_FAILED, STATUS_RUNNING, STATUS_SUCCEEDED, get_run


def create_compile_run(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    datasets: list[str],
    seed: int,
    qa_limit: int,
    negatives_ratio: float,
) -> int:
    cursor = connection.execute(
        """
        INSERT INTO compile_run
            (run_id, datasets_json, seed, qa_limit, negatives_ratio, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (run_id, dumps(datasets), seed, qa_limit, negatives_ratio, STATUS_RUNNING, utc_now()),
    )
    return int(cursor.lastrowid or 0)


def update_compile_run(connection: sqlite3.Connection, compile_id: int, **fields: Any) -> None:
    allowed = {
        "space_id",
        "space_name",
        "workspace_id",
        "model_configs_json",
        "quality_json",
        "pace_json",
        "status",
        "finished_at",
    }
    unknown = set(fields) - allowed
    if unknown:
        raise ValueError(f"unknown compile_run fields: {sorted(unknown)}")
    if not fields:
        return
    assignments = ", ".join(f"{name} = ?" for name in fields)
    connection.execute(
        f"UPDATE compile_run SET {assignments} WHERE id = ?", (*fields.values(), compile_id)
    )


def get_compile_run(connection: sqlite3.Connection, compile_id: int) -> dict[str, Any] | None:
    return get_run(connection, "compile", compile_id)


def compile_run_by_run_id(connection: sqlite3.Connection, run_id: str) -> dict[str, Any] | None:
    row = connection.execute("SELECT * FROM compile_run WHERE run_id = ?", (run_id,)).fetchone()
    return dict(row) if row else None


def list_compile_runs(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    return [dict(r) for r in connection.execute("SELECT * FROM compile_run ORDER BY id DESC")]


def delete_compile_run(connection: sqlite3.Connection, compile_id: int) -> int:
    return connection.execute("DELETE FROM compile_run WHERE id = ?", (compile_id,)).rowcount


def replace_compile_subset(
    connection: sqlite3.Connection,
    compile_id: int,
    dataset: str,
    sample_ids: list[str],
    docs: list[dict[str, Any]],
) -> None:
    connection.execute(
        "DELETE FROM compile_sample WHERE compile_id = ? "
        "AND sample_id IN (SELECT sample_id FROM sample WHERE dataset = ?)",
        (compile_id, dataset),
    )
    connection.execute(
        "DELETE FROM compile_doc WHERE compile_id = ? AND dataset = ?", (compile_id, dataset)
    )
    connection.executemany(
        "INSERT INTO compile_sample (compile_id, sample_id) VALUES (?, ?)",
        [(compile_id, sample_id) for sample_id in sample_ids],
    )
    connection.executemany(
        "INSERT INTO compile_doc (compile_id, dataset, doc_id, is_gold) VALUES (?, ?, ?, ?)",
        [(compile_id, dataset, doc["doc_id"], int(doc["is_gold"])) for doc in docs],
    )


def compile_samples(
    connection: sqlite3.Connection, compile_id: int, dataset: str | None = None
) -> list[dict[str, Any]]:
    sql = """
        SELECT s.*
        FROM compile_sample cs JOIN sample s ON s.sample_id = cs.sample_id
        WHERE cs.compile_id = ?
    """
    params: list[Any] = [compile_id]
    if dataset:
        sql += " AND s.dataset = ?"
        params.append(dataset)
    return [
        sample_from_row(row)
        for row in connection.execute(sql + " ORDER BY s.sample_id", params)
    ]


_DOCS_FROM = (
    "FROM compile_doc cd "
    "LEFT JOIN corpus_doc ON corpus_doc.dataset = cd.dataset AND corpus_doc.doc_id = cd.doc_id"
)
_DOC_COLUMNS = "cd.*, COALESCE(corpus_doc.title, '') AS title"


def compile_docs(
    connection: sqlite3.Connection,
    compile_id: int,
    dataset: str | None = None,
    *,
    pending_only: bool = False,
) -> list[dict[str, Any]]:
    sql = f"SELECT {_DOC_COLUMNS} {_DOCS_FROM} WHERE cd.compile_id = ?"
    params: list[Any] = [compile_id]
    if dataset:
        sql += " AND cd.dataset = ?"
        params.append(dataset)
    if pending_only:
        sql += " AND page_id IS NULL"
    return [dict(r) for r in connection.execute(sql + " ORDER BY cd.dataset, cd.doc_id", params)]


def compile_doc_page(
    connection: sqlite3.Connection,
    compile_id: int,
    dataset: str | None = None,
    *,
    gold_only: bool = False,
    search: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> tuple[int, int, list[dict[str, Any]]]:
    where = ["cd.compile_id = ?"]
    params: list[Any] = [compile_id]
    if dataset:
        where.append("cd.dataset = ?")
        params.append(dataset)
    if gold_only:
        where.append("cd.is_gold = 1")
    if search:
        needle = f"%{search.lower()}%"
        where.append(
            "(LOWER(cd.doc_id) LIKE ? OR LOWER(COALESCE(corpus_doc.title, '')) LIKE ? "
            "OR LOWER(COALESCE(cd.page_id, '')) LIKE ?)"
        )
        params.extend((needle, needle, needle))
    scope = " AND ".join(where)
    summary = connection.execute(
        f"SELECT COUNT(*) AS total, SUM(cd.page_id IS NOT NULL) AS imported "
        f"{_DOCS_FROM} WHERE {scope}",
        params,
    ).fetchone()
    rows = connection.execute(
        f"SELECT {_DOC_COLUMNS} {_DOCS_FROM} WHERE {scope} "
        "ORDER BY cd.dataset, cd.doc_id LIMIT ? OFFSET ?",
        (*params, limit, offset),
    )
    return int(summary["total"]), int(summary["imported"] or 0), [dict(row) for row in rows]


def record_page(
    connection: sqlite3.Connection,
    compile_id: int,
    dataset: str,
    doc_id: str,
    *,
    page_id: str | None,
    error: str | None,
) -> None:
    connection.execute(
        "UPDATE compile_doc SET page_id = ?, error = ? WHERE compile_id = ? AND dataset = ? AND doc_id = ?",
        (page_id, error, compile_id, dataset, doc_id),
    )


def page_to_doc(connection: sqlite3.Connection, compile_id: int, dataset: str) -> dict[str, str]:
    return {
        row["page_id"]: row["doc_id"]
        for row in connection.execute(
            "SELECT page_id, doc_id FROM compile_doc "
            "WHERE compile_id = ? AND dataset = ? AND page_id IS NOT NULL",
            (compile_id, dataset),
        )
    }


def compile_stats(connection: sqlite3.Connection, compile_id: int) -> dict[str, Any]:
    rows = connection.execute(
        """
        SELECT dataset,
               COUNT(*) AS docs,
               SUM(CASE WHEN page_id IS NOT NULL THEN 1 ELSE 0 END) AS imported,
               SUM(is_gold) AS gold
        FROM compile_doc WHERE compile_id = ? GROUP BY dataset ORDER BY dataset
        """,
        (compile_id,),
    )
    per_dataset = {row["dataset"]: dict(row) for row in rows}
    samples = connection.execute(
        "SELECT s.dataset, COUNT(*) AS n FROM compile_sample cs "
        "JOIN sample s ON s.sample_id = cs.sample_id WHERE cs.compile_id = ? GROUP BY s.dataset",
        (compile_id,),
    )
    for row in samples:
        per_dataset.setdefault(row["dataset"], {"dataset": row["dataset"]})["samples"] = row["n"]
    return per_dataset


def workspace_mismatch(
    connection: sqlite3.Connection, compile_id: int, resolved_workspace_id: str | None
) -> str | None:
    run = get_compile_run(connection, compile_id)
    if run is None:
        return f"编译 #{compile_id} 不存在"
    recorded = run["workspace_id"]

    if not recorded:
        return f"编译 {run['run_id']!r} 没有记录 workspace，不能确认远端空间归属"
    if not resolved_workspace_id:
        return "当前连接没有解析出 workspace，不能确认远端空间归属"
    if recorded == resolved_workspace_id:
        return None
    return (
        f"编译 {run['run_id']!r} 的空间 {run['space_id']} 属于 workspace {recorded}，"
        f"而当前连接解析出的是 {resolved_workspace_id}。这些 page_id 在这里解析不到，"
        "查询不会报错但每条都召回不到。请把连接指回原来的部署/账号，"
        "或清理这次编译重新编。"
    )


def compile_ready(connection: sqlite3.Connection, compile_id: int) -> dict[str, Any]:
    run = get_compile_run(connection, compile_id)
    if run is None:
        return {"ready": False, "reasons": ["编译记录不存在"], "warnings": []}
    doc_counts = connection.execute(
        "SELECT COUNT(*) AS total, "
        "SUM(CASE WHEN page_id IS NULL THEN 1 ELSE 0 END) AS missing "
        "FROM compile_doc WHERE compile_id = ?",
        (compile_id,),
    ).fetchone()
    return compile_readiness(run, missing=int(doc_counts["missing"] or 0))


def _count(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def compile_readiness(run: dict[str, Any], *, missing: int) -> dict[str, Any]:
    reasons: list[str] = []
    warnings: list[str] = []
    quality = loads(run["quality_json"]) or {}
    progress = quality.get("progress") or {}
    succeeded = _count(progress.get("succeeded"))
    unsuccessful = _count(progress.get("failed")) + _count(progress.get("skipped"))
    partial = run["status"] == STATUS_FAILED and succeeded > 0 and unsuccessful > 0
    if run["status"] != STATUS_SUCCEEDED and not partial:
        reasons.append(f"编译状态为 {run['status']}，未成功结束")
    elif partial:
        warnings.append(
            f"编译仅部分成功：{succeeded} 篇可用，{unsuccessful} 篇失败或跳过；"
            "查询结果可能不完整"
        )
    if not run["space_id"]:
        reasons.append("没有 Akasha 空间")
    if missing:
        reasons.append(f"{missing} 篇语料没有导入成功")
    if quality.get("passed") is not True and not partial:
        reasons.append("编译质量闸门未通过")
    return {"ready": not reasons, "reasons": reasons, "warnings": warnings}
