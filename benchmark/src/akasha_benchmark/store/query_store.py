from __future__ import annotations

import sqlite3
from typing import Any

from .db import dumps, loads, utc_now
from .run_store import STATUS_RUNNING, get_run

ANSWER_GENERATION_UNAVAILABLE = (
    "Relevant knowledge was retrieved, but the answer model did not produce a response. "
    "Try again later or ask an administrator to check the AI model configuration."
)
ANSWER_GENERATION_UNAVAILABLE_ZH = (
    "已检索到相关知识，但回答模型当前未能生成内容。请稍后重试，"
    "或联系管理员检查 AI 模型配置。"
)
GENERATION_UNAVAILABLE_ANSWERS = {
    ANSWER_GENERATION_UNAVAILABLE,
    ANSWER_GENERATION_UNAVAILABLE_ZH,
}


def is_generation_unavailable_answer(answer: Any) -> bool:
    if not isinstance(answer, str):
        return True
    text = answer.strip()
    return not text or text in GENERATION_UNAVAILABLE_ANSWERS


def response_is_retryable(row: dict[str, Any]) -> bool:
    status = int(row.get("http_status") or 0)
    if not 200 <= status < 300:
        return True
    response = row.get("response")
    answer = response.get("answer") if isinstance(response, dict) else None
    return is_generation_unavailable_answer(answer)


def create_query_run(
    connection: sqlite3.Connection,
    *,
    name: str,
    compile_id: int,
    concurrency: int,
    model_configs: Any,
) -> int:
    cursor = connection.execute(
        """
        INSERT INTO query_run
            (name, compile_id, concurrency, model_configs_json, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            name,
            compile_id,
            concurrency,
            dumps(model_configs),
            STATUS_RUNNING,
            utc_now(),
        ),
    )
    return int(cursor.lastrowid or 0)


def get_query_run(connection: sqlite3.Connection, query_id: int) -> dict[str, Any] | None:
    return get_run(connection, "query", query_id)


def query_run_by_name(connection: sqlite3.Connection, name: str) -> dict[str, Any] | None:
    row = connection.execute("SELECT * FROM query_run WHERE name = ?", (name,)).fetchone()
    return dict(row) if row else None


def list_query_runs(
    connection: sqlite3.Connection, compile_id: int | None = None
) -> list[dict[str, Any]]:
    sql = "SELECT * FROM query_run"
    params: tuple[Any, ...] = ()
    if compile_id is not None:
        sql += " WHERE compile_id = ?"
        params = (compile_id,)
    return [dict(r) for r in connection.execute(sql + " ORDER BY id DESC", params)]


def delete_query_run(connection: sqlite3.Connection, query_id: int) -> int:
    return connection.execute("DELETE FROM query_run WHERE id = ?", (query_id,)).rowcount


def freeze_query_samples(
    connection: sqlite3.Connection, query_id: int, samples: list[dict[str, Any]]
) -> None:
    connection.executemany(
        "INSERT OR IGNORE INTO query_sample (query_id, sample_id) VALUES (?, ?)",
        [(query_id, s["sample_id"]) for s in samples],
    )


def query_samples(connection: sqlite3.Connection, query_id: int) -> list[dict[str, Any]]:
    return [
        dict(r)
        for r in connection.execute(
            "SELECT qs.*, s.dataset FROM query_sample qs "
            "JOIN sample s ON s.sample_id = qs.sample_id "
            "WHERE qs.query_id = ? ORDER BY qs.sample_id",
            (query_id,),
        )
    ]


def pending_query_samples(connection: sqlite3.Connection, query_id: int) -> list[dict[str, Any]]:
    return [
        dict(r)
        for r in connection.execute(
            """
            SELECT qs.sample_id, s.dataset, s.question
            FROM query_sample qs
            JOIN sample s ON s.sample_id = qs.sample_id
            LEFT JOIN query_response qr
                ON qr.query_id = qs.query_id AND qr.sample_id = qs.sample_id
            WHERE qs.query_id = ? AND qr.sample_id IS NULL
            ORDER BY qs.sample_id
            """,
            (query_id,),
        )
    ]


_AUDIT_TIMING_KEYS = {
    "ttft_ms": "ttftMs",
    "rewrite_ms": "rewriteMs",
    "retrieval_ms": "retrievalMs",
    "generation_ms": "generationMs",
    "server_total_ms": "totalMs",
}

TIMING_PHASES = tuple(_AUDIT_TIMING_KEYS)


def timings_from_audit(metadata: Any) -> dict[str, Any] | None:
    timings = metadata.get("timings") if isinstance(metadata, dict) else None
    if not isinstance(timings, dict):
        return None
    local = {}
    for local_key, remote_key in _AUDIT_TIMING_KEYS.items():
        value = timings.get(remote_key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            local[local_key] = value
    return local or None


def record_response(
    connection: sqlite3.Connection,
    query_id: int,
    *,
    sample_id: str,
    dataset: str,
    question: str,
    http_status: int,
    latency_ms: int | None,
    error: str | None,
    response: Any,
) -> None:
    connection.execute(
        """
        INSERT INTO query_response
            (query_id, sample_id, dataset, question, http_status,
             latency_ms, error, response_json, requested_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(query_id, sample_id) DO UPDATE SET
            http_status = excluded.http_status,
            latency_ms = excluded.latency_ms,
            error = excluded.error,
            response_json = excluded.response_json,
            requested_at = excluded.requested_at
        """,
        (
            query_id,
            sample_id,
            dataset,
            question,
            http_status,
            latency_ms,
            error,
            dumps(response) if response is not None else None,
            utc_now(),
        ),
    )


def record_timings(
    connection: sqlite3.Connection,
    query_id: int,
    timings_by_sample: dict[str, dict[str, Any]],
) -> int:
    if not timings_by_sample:
        return 0
    return connection.executemany(
        "UPDATE query_response SET timings_json = ? WHERE query_id = ? AND sample_id = ?",
        [
            (dumps(timings), query_id, sample_id)
            for sample_id, timings in timings_by_sample.items()
        ],
    ).rowcount


def _response(row: sqlite3.Row) -> dict[str, Any]:
    body = loads(row["response_json"])
    return {
        **{
            k: v
            for k, v in dict(row).items()
            if k not in ("response_json", "timings_json")
        },
        "response": body,
        "timings": loads(row["timings_json"]),
        "answer_mode": body.get("answerMode") if isinstance(body, dict) else None,
    }


def responses_of(
    connection: sqlite3.Connection, query_id: int, dataset: str | None = None
) -> list[dict[str, Any]]:
    sql = "SELECT * FROM query_response WHERE query_id = ?"
    params: list[Any] = [query_id]
    if dataset:
        sql += " AND dataset = ?"
        params.append(dataset)
    return [
        _response(row)
        for row in connection.execute(sql + " ORDER BY sample_id", params)
    ]


def response_page(
    connection: sqlite3.Connection,
    query_id: int,
    *,
    dataset: str | None = None,
    answer_mode: str | None = None,
    search: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> tuple[int, dict[str, int], list[dict[str, Any]]]:
    where = ["query_id = ?"]
    params: list[Any] = [query_id]
    if dataset:
        where.append("dataset = ?")
        params.append(dataset)
    if search:
        where.append(
            "(LOWER(sample_id) LIKE ? OR LOWER(question) LIKE ? "
            "OR LOWER(COALESCE(json_extract(response_json, '$.answer'), '')) LIKE ?)"
        )
        pattern = f"%{search.lower()}%"
        params.extend((pattern, pattern, pattern))
    scope = " AND ".join(where)
    counts = {
        (row["answer_mode"] or "missing"): int(row["n"])
        for row in connection.execute(
            f"""
            SELECT json_extract(response_json, '$.answerMode') AS answer_mode, COUNT(*) AS n
            FROM query_response WHERE {scope} GROUP BY answer_mode
            """,
            params,
        )
    }
    if answer_mode:
        where.append("COALESCE(json_extract(response_json, '$.answerMode'), 'missing') = ?")
        params.append(answer_mode)
    scope = " AND ".join(where)
    total = int(
        connection.execute(
            f"SELECT COUNT(*) FROM query_response WHERE {scope}", params
        ).fetchone()[0]
    )
    rows = [
        dict(row)
        for row in connection.execute(
            f"""
            SELECT query_id, sample_id, dataset, question, http_status, latency_ms, error,
                   requested_at,
                   json_extract(response_json, '$.answerMode') AS answer_mode,
                   SUBSTR(COALESCE(json_extract(response_json, '$.answer'), ''), 1, 600) AS answer,
                   COALESCE(json_array_length(response_json, '$.retrievedSources'), 0) AS retrieved_count,
                   COALESCE(json_array_length(response_json, '$.citations'), 0) AS citation_count
            FROM query_response WHERE {scope} ORDER BY sample_id LIMIT ? OFFSET ?
            """,
            (*params, limit, offset),
        )
    ]
    return total, counts, rows


def response_of(
    connection: sqlite3.Connection, query_id: int, sample_id: str
) -> dict[str, Any] | None:
    row = connection.execute(
        "SELECT * FROM query_response WHERE query_id = ? AND sample_id = ?",
        (query_id, sample_id),
    ).fetchone()
    return _response(row) if row else None


def retryable_responses(connection: sqlite3.Connection, query_id: int) -> list[dict[str, Any]]:
    return [row for row in responses_of(connection, query_id) if response_is_retryable(row)]


def retryable_response_count(connection: sqlite3.Connection, query_id: int) -> int:
    return len(retryable_responses(connection, query_id))


def delete_retryable_responses(connection: sqlite3.Connection, query_id: int) -> int:
    rows = retryable_responses(connection, query_id)
    if not rows:
        return 0
    return connection.executemany(
        "DELETE FROM query_response WHERE query_id = ? AND sample_id = ?",
        [(query_id, row["sample_id"]) for row in rows],
    ).rowcount


def query_stats(connection: sqlite3.Connection, query_id: int) -> dict[str, Any]:
    return {
        row["dataset"]: {key: value for key, value in row.items() if key != "query_id"}
        for row in all_query_stats(connection, query_id=query_id)
    }


def all_query_stats(
    connection: sqlite3.Connection, *, query_id: int | None = None
) -> list[dict[str, Any]]:
    where = "WHERE query_id = ?" if query_id is not None else ""
    params: tuple[Any, ...] = (
        ANSWER_GENERATION_UNAVAILABLE,
        ANSWER_GENERATION_UNAVAILABLE_ZH,
    )
    if query_id is not None:
        params += (query_id,)
    phases = ",\n".join(
        f"               AVG(json_extract(timings_json, '$.{phase}')) AS {phase}_mean"
        for phase in TIMING_PHASES
    )
    rows = connection.execute(
        f"""
        SELECT query_id, dataset, COUNT(*) AS responses,
               SUM(CASE
                   WHEN http_status NOT BETWEEN 200 AND 299 THEN 1
                   WHEN TRIM(COALESCE(json_extract(response_json, '$.answer'), '')) = '' THEN 1
                   WHEN TRIM(COALESCE(json_extract(response_json, '$.answer'), '')) IN (?, ?) THEN 1
                   ELSE 0
               END) AS failures,
               AVG(latency_ms) AS latency_mean,
               MAX(latency_ms) AS latency_max,
               SUM(timings_json IS NOT NULL) AS timed_responses,
{phases}
        FROM query_response {where}
        GROUP BY query_id, dataset ORDER BY query_id, dataset
        """,
        params,
    )
    return [dict(row) for row in rows]


def response_datasets(connection: sqlite3.Connection, query_id: int) -> list[str]:
    return [
        row["dataset"]
        for row in connection.execute(
            "SELECT DISTINCT dataset FROM query_response WHERE query_id = ? ORDER BY dataset",
            (query_id,),
        )
    ]
