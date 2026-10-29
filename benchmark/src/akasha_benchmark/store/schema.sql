CREATE TABLE IF NOT EXISTS akasha_connection (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    base_url TEXT NOT NULL DEFAULT 'http://127.0.0.1:8080',
    email TEXT NOT NULL DEFAULT 'test@example.com',
    password TEXT NOT NULL DEFAULT '12345678',
    database_url TEXT NOT NULL DEFAULT 'postgresql://akasha:STRONG_DB_PASSWORD@127.0.0.1:5432/akasha',
    timeout_seconds REAL NOT NULL DEFAULT 120.0,
    request_interval_seconds REAL NOT NULL DEFAULT 0.5,
    updated_at TEXT NOT NULL
);

INSERT
OR IGNORE INTO akasha_connection (id, updated_at)
VALUES (1, '1970-01-01T00:00:00Z');

CREATE TABLE IF NOT EXISTS model_provider (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purpose TEXT NOT NULL CHECK (
        purpose IN (
            'judge',
            'attribution',
            'generation',
            'compiler',
            'embedding',
            'answer',
            'image'
        )
    ),
    label TEXT NOT NULL,
    base_url TEXT NOT NULL,
    model TEXT NOT NULL,
    api_key TEXT NOT NULL DEFAULT '',
    parameters_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    UNIQUE (purpose, label)
);

CREATE TABLE IF NOT EXISTS dataset (
    name TEXT PRIMARY KEY,
    qa_sha256 TEXT NOT NULL,
    qa_rows INTEGER NOT NULL,
    corpus_sha256 TEXT NOT NULL,
    corpus_rows INTEGER NOT NULL,
    normalized_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sample (
    sample_id TEXT PRIMARY KEY,
    dataset TEXT NOT NULL REFERENCES dataset (name) ON DELETE CASCADE,
    dataset_sample_id TEXT NOT NULL,
    question TEXT NOT NULL,
    answers_json TEXT NOT NULL,
    gold_doc_ids_json TEXT NOT NULL,
    metadata_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sample_dataset_idx ON sample (dataset);

CREATE TABLE IF NOT EXISTS corpus_doc (
    dataset TEXT NOT NULL REFERENCES dataset (name) ON DELETE CASCADE,
    doc_id TEXT NOT NULL,
    title TEXT NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (dataset, doc_id)
);

CREATE TABLE IF NOT EXISTS compile_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL UNIQUE,
    datasets_json TEXT NOT NULL,
    seed INTEGER NOT NULL,
    qa_limit INTEGER NOT NULL,
    negatives_ratio REAL NOT NULL,
    space_id TEXT,
    space_name TEXT,
    workspace_id TEXT,
    model_configs_json TEXT,
    quality_json TEXT,
    pace_json TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS compile_sample (
    compile_id INTEGER NOT NULL REFERENCES compile_run (id) ON DELETE CASCADE,
    sample_id TEXT NOT NULL REFERENCES sample (sample_id) ON DELETE CASCADE,
    PRIMARY KEY (compile_id, sample_id)
);

CREATE TABLE IF NOT EXISTS compile_doc (
    compile_id INTEGER NOT NULL REFERENCES compile_run (id) ON DELETE CASCADE,
    dataset TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    is_gold INTEGER NOT NULL,
    page_id TEXT,
    error TEXT,
    PRIMARY KEY (compile_id, dataset, doc_id)
);

CREATE INDEX IF NOT EXISTS compile_doc_page_idx ON compile_doc (compile_id, page_id);

CREATE TABLE IF NOT EXISTS query_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    compile_id INTEGER NOT NULL REFERENCES compile_run (id) ON DELETE CASCADE,
    concurrency INTEGER NOT NULL,
    model_configs_json TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finished_at TEXT
);

CREATE INDEX IF NOT EXISTS query_run_compile_idx ON query_run (compile_id, id);

CREATE TABLE IF NOT EXISTS query_sample (
    query_id INTEGER NOT NULL REFERENCES query_run (id) ON DELETE CASCADE,
    sample_id TEXT NOT NULL REFERENCES sample (sample_id) ON DELETE CASCADE,
    PRIMARY KEY (query_id, sample_id)
);

CREATE TABLE IF NOT EXISTS query_response (
    query_id INTEGER NOT NULL REFERENCES query_run (id) ON DELETE CASCADE,
    sample_id TEXT NOT NULL,
    dataset TEXT NOT NULL,
    question TEXT NOT NULL,
    http_status INTEGER NOT NULL,
    latency_ms INTEGER,
    error TEXT,
    response_json TEXT,
    timings_json TEXT,
    requested_at TEXT NOT NULL,
    PRIMARY KEY (query_id, sample_id)
);

CREATE INDEX IF NOT EXISTS query_response_mode_idx ON query_response (
    query_id,
    json_extract (response_json, '$.answerMode')
);

CREATE TABLE IF NOT EXISTS eval_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    query_id INTEGER NOT NULL REFERENCES query_run (id) ON DELETE CASCADE,
    ks_json TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    judge_provider_id INTEGER REFERENCES model_provider (id) ON DELETE SET NULL,
    concurrency INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finished_at TEXT
);

CREATE INDEX IF NOT EXISTS eval_run_query_idx ON eval_run (query_id, id);

CREATE TABLE IF NOT EXISTS sample_eval (
    eval_id INTEGER NOT NULL REFERENCES eval_run (id) ON DELETE CASCADE,
    sample_id TEXT NOT NULL,
    dataset TEXT NOT NULL,
    answer_mode TEXT,
    http_status INTEGER NOT NULL,
    answer TEXT,
    detail_json TEXT NOT NULL,
    PRIMARY KEY (eval_id, sample_id)
);

CREATE TABLE IF NOT EXISTS sample_metric (
    eval_id INTEGER NOT NULL,
    sample_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY (eval_id, sample_id, metric),
    FOREIGN KEY (eval_id, sample_id) REFERENCES sample_eval (eval_id, sample_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS sample_metric_lookup_idx ON sample_metric (eval_id, metric, value);

CREATE TABLE IF NOT EXISTS metric_summary (
    eval_id INTEGER NOT NULL REFERENCES eval_run (id) ON DELETE CASCADE,
    dataset TEXT NOT NULL,
    scope TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL,
    sample_count INTEGER NOT NULL,
    PRIMARY KEY (
        eval_id,
        dataset,
        scope,
        metric
    )
);

CREATE TABLE IF NOT EXISTS dataset_eval (
    eval_id INTEGER NOT NULL REFERENCES eval_run (id) ON DELETE CASCADE,
    dataset TEXT NOT NULL,
    responses_evaluated INTEGER NOT NULL,
    http_failures INTEGER NOT NULL,
    omitted_metrics_json TEXT NOT NULL,
    answer_modes_json TEXT NOT NULL,
    PRIMARY KEY (eval_id, dataset)
);

CREATE TABLE IF NOT EXISTS judge_verdict (
    eval_id INTEGER NOT NULL REFERENCES eval_run (id) ON DELETE CASCADE,
    sample_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    score REAL,
    failure_kind TEXT,
    latency_ms INTEGER,
    detail_json TEXT,
    PRIMARY KEY (eval_id, sample_id, metric)
);

CREATE TABLE IF NOT EXISTS attribution_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    eval_id INTEGER NOT NULL REFERENCES eval_run (id) ON DELETE CASCADE,
    report_provider_id INTEGER REFERENCES model_provider (id) ON DELETE SET NULL,
    report TEXT,
    report_error TEXT,
    report_latency_ms INTEGER,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finished_at TEXT
);

CREATE INDEX IF NOT EXISTS attribution_run_eval_idx ON attribution_run (eval_id, id);

CREATE TABLE IF NOT EXISTS attribution_result (
    attribution_id INTEGER NOT NULL REFERENCES attribution_run (id) ON DELETE CASCADE,
    sample_id TEXT NOT NULL,
    root_cause TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    PRIMARY KEY (attribution_id, sample_id)
);

CREATE INDEX IF NOT EXISTS attribution_cause_idx ON attribution_result (attribution_id, root_cause);

CREATE TABLE IF NOT EXISTS task (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    params_json TEXT NOT NULL,
    target_kind TEXT,
    target_id INTEGER,
    progress_done INTEGER NOT NULL DEFAULT 0,
    progress_total INTEGER,
    progress_note TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    chain_id INTEGER,
    chain_json TEXT
);

CREATE INDEX IF NOT EXISTS task_status_idx ON task (status, id);

CREATE INDEX IF NOT EXISTS task_chain_idx ON task (chain_id, id);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    stage TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_log_task_idx ON audit_log (task_id, id);