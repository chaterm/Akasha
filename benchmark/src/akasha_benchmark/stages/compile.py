from __future__ import annotations

import random
import re
import sqlite3
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any

import httpx

from .. import naming
from ..akasha_client import (
    ACTIVE_RUN_STATUSES,
    AkashaClient,
    AkashaError,
    client_pool,
    latest_run_pages,
    validate_cancel_result,
)
from ..config import AkashaConfig, load_config
from ..datasets import (
    CorpusDoc,
    DataDependency,
    SubsetStrategy,
    dataset_names,
    get_adapter,
)
from ..model_configs import matches
from ..store import compile_store, data_store, dumps, loads, transaction
from ..task import Paused, TaskContext

DEFAULT_QA_LIMIT = 20
DEFAULT_NEGATIVES_RATIO = 1.0
DEFAULT_NARRATIVEQA_DOCS = 2
DEFAULT_IMPORT_CONCURRENCY = 4
MAX_IMPORT_CONCURRENCY = 16


@dataclass(frozen=True)
class CompileOptions:
    run_id: str
    datasets: list[str]
    seed: int
    qa_limit: int
    sample_ids: list[str]
    negatives_ratio: float
    full_corpus: bool
    import_concurrency: int


POLL_INTERVAL_SECONDS = 30.0
COMPILE_FEATURES = ("compiler", "embedding", "image")
_MARKDOWN_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_MARKDOWN_HEADING = re.compile(r"^\s*#+\s*.*$", re.MULTILINE)


def default_seed() -> int:
    return int(datetime.now(UTC).strftime("%Y%m%d"))


def _run_id(run: dict[str, Any]) -> str:
    return str(run.get("runId") or run.get("id") or "")


def _text_count(run: dict[str, Any], key: str) -> int:
    return int((run.get("progress") or {}).get("text", {}).get(key) or 0)


def _progress_of(runs: list[dict[str, Any]]) -> dict[str, int]:
    return {
        key: sum(_text_count(run, key) for run in runs)
        for key in ("expected", "succeeded", "failed", "skipped")
    }


def _status_counts(runs: list[dict[str, Any]]) -> dict[str, int]:
    return dict(Counter(str(run.get("status") or "unknown") for run in runs))


def _drifted(left: Any, right: Any) -> list[str]:
    return [feature for feature in COMPILE_FEATURES if not matches(left, right, feature)]


def _sorted_samples(samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(samples, key=lambda s: s["sample_id"])


def _sample(samples: list[dict[str, Any]], limit: int, rng: random.Random) -> list[dict[str, Any]]:
    return _sorted_samples(rng.sample(_sorted_samples(samples), min(limit, len(samples))))


def _with_negatives(
    picked: list[dict[str, Any]], usable_doc_ids: set[str], ratio: float, rng: random.Random
) -> tuple[list[str], list[str], list[str]]:
    gold_ids = sorted({doc_id for sample in picked for doc_id in sample["gold_doc_ids"]})
    pool = sorted(usable_doc_ids - set(gold_ids))
    negatives = sorted(rng.sample(pool, min(round(len(gold_ids) * ratio), len(pool))))
    return gold_ids, negatives, sorted(set(gold_ids) | set(negatives))


def _largest_remainder(weights: dict[str, int], total: int) -> dict[str, int]:
    pool = sum(weights.values())
    if pool == 0:
        return dict.fromkeys(weights, 0)
    exact = {k: total * v / pool for k, v in weights.items()}
    floors = {k: int(v) for k, v in exact.items()}
    order = sorted(weights, key=lambda k: (-(exact[k] - floors[k]), k))
    for key in order[: total - sum(floors.values())]:
        floors[key] += 1
    return floors


def _stratified(
    samples: list[dict[str, Any]], limit: int, key: str, rng: random.Random
) -> list[dict[str, Any]]:
    strata: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for sample in samples:
        strata[str(sample["metadata"][key])].append(sample)

    quotas = _largest_remainder({k: len(v) for k, v in strata.items()}, limit)
    picked: list[dict[str, Any]] = []
    for name in sorted(strata):
        available = sorted(strata[name], key=lambda s: s["sample_id"])
        picked.extend(rng.sample(available, min(quotas[name], len(available))))

    if len(picked) < limit:
        chosen = {s["sample_id"] for s in picked}
        rest = sorted(
            (s for s in samples if s["sample_id"] not in chosen), key=lambda s: s["sample_id"]
        )
        picked.extend(rng.sample(rest, min(limit - len(picked), len(rest))))
    return sorted(picked, key=lambda s: s["sample_id"])


def _safe_doc_id(doc_id: str) -> str:
    if not doc_id or doc_id in {".", ".."} or set(doc_id) & set('/\\:*?"<>|'):
        raise ValueError(f"doc_id {doc_id!r} 不能作为文件名")
    return doc_id


def _has_indexable_text(text: str) -> bool:
    body = _MARKDOWN_IMAGE.sub("", text or "")
    body = _MARKDOWN_HEADING.sub("", body)
    return bool(body.strip())


def build_subset(
    connection: sqlite3.Connection,
    compile_id: int,
    dataset: str,
    *,
    seed: int,
    qa_limit: int,
    negatives_ratio: float,
    sample_ids: list[str] | None = None,
    full_corpus: bool = False,
    narrativeqa_docs: int = DEFAULT_NARRATIVEQA_DOCS,
) -> dict[str, Any]:
    adapter = get_adapter(dataset)
    if data_store.get_dataset(connection, adapter.name) is None:
        raise ValueError(f"{adapter.name} 还没归一化")

    samples = data_store.samples_of(connection, adapter.name)
    if sample_ids:
        requested = list(dict.fromkeys(sample_ids))
        by_sample_id = {sample["sample_id"]: sample for sample in samples}
        missing = [sample_id for sample_id in requested if sample_id not in by_sample_id]
        if missing:
            raise ValueError(f"{adapter.name}: 找不到指定样本 {missing}")
        samples = [by_sample_id[sample_id] for sample_id in requested]
        qa_limit = len(samples)
    corpus = data_store.corpus_of(connection, adapter.name)
    by_id = {doc["doc_id"]: doc for doc in corpus}
    usable_doc_ids = {
        doc_id for doc_id, doc in by_id.items() if _has_indexable_text(doc["text"])
    }
    if not samples:
        raise ValueError(f"{adapter.name} 没有样本")

    rng = random.Random(f"{adapter.name}:{seed}")

    strategy = adapter.subset_strategy
    gold_strategies = (SubsetStrategy.QA_THEN_GOLD, SubsetStrategy.STRATIFIED_HOP)

    if strategy in gold_strategies and not adapter.has(DataDependency.GOLD_DOCS):
        raise ValueError(f"{adapter.name}: 策略 {strategy.value!r} 需要 gold 标注，但本组没有")

    if sample_ids and strategy in gold_strategies:
        picked = samples
        gold_ids, negatives, doc_ids = _with_negatives(picked, usable_doc_ids, negatives_ratio, rng)
    elif full_corpus:
        doc_ids = sorted(usable_doc_ids)
        picked = _sample(samples, qa_limit, rng)
        gold_ids = sorted({d for s in picked for d in s["gold_doc_ids"]})
        negatives = (
            sorted(set(doc_ids) - set(gold_ids))
            if adapter.has(DataDependency.GOLD_DOCS)
            else []
        )
    elif strategy is SubsetStrategy.WHOLE_DOCS:
        chunks: dict[str, list[str]] = defaultdict(list)
        for doc in corpus:
            chunks[doc["doc_id"].rsplit("_", 1)[0]].append(doc["doc_id"])
        ranked = sorted(chunks, key=lambda d: (len(chunks[d]), d))
        chosen = sorted(ranked[:narrativeqa_docs])
        doc_ids = sorted(
            (c for d in chosen for c in chunks[d]),
            key=lambda c: (c.rsplit("_", 1)[0], int(c.rsplit("_", 1)[1])),
        )
        chosen_set = set(chosen)
        picked = _sorted_samples([s for s in samples if s["metadata"]["document_id"] in chosen_set])
        if qa_limit and len(picked) > qa_limit:
            picked = _sorted_samples(rng.sample(picked, qa_limit))
        gold_ids, negatives = [], []
    else:
        if strategy is SubsetStrategy.STRATIFIED_HOP:
            picked = _stratified(samples, min(qa_limit, len(samples)), "hop_prefix", rng)
        else:
            picked = _sample(samples, qa_limit, rng)
        gold_ids, negatives, doc_ids = _with_negatives(picked, usable_doc_ids, negatives_ratio, rng)

    subset_ids = set(doc_ids)
    uncovered = {
        s["sample_id"]: sorted(set(s["gold_doc_ids"]) - subset_ids)
        for s in picked
        if set(s["gold_doc_ids"]) - subset_ids
    }
    if uncovered:
        raise RuntimeError(
            f"{adapter.name}: {len(uncovered)} 条样本的 gold 落在子集语料之外，"
            f"例如 {next(iter(uncovered.items()))}"
        )

    gold_set = set(gold_ids)
    docs = [{"doc_id": _safe_doc_id(doc_id), "is_gold": doc_id in gold_set} for doc_id in doc_ids]
    with transaction(connection):
        compile_store.replace_compile_subset(
            connection, compile_id, adapter.name, [s["sample_id"] for s in picked], docs
        )

    return {
        "dataset": adapter.name,
        "strategy": strategy.value,
        "samples": len(picked),
        "docs": len(doc_ids),
        "empty_docs": len(by_id) - len(usable_doc_ids),
        "gold": len(gold_ids),
        "negatives": len(negatives),
    }


def markdown_of(connection: sqlite3.Connection, dataset: str, doc_id: str) -> str:
    doc = data_store.corpus_doc(connection, dataset, doc_id)
    if doc is None:
        raise ValueError(f"{dataset}/{doc_id} 不在语料里")
    return CorpusDoc(doc_id=doc_id, title=doc["title"], text=doc["text"]).to_markdown()


def _wait_for_compile(
    ctx: TaskContext,
    client: AkashaClient,
    space_id: str,
    *,
    expect_runs: int = 0,
    coalesced_runs: int = 0,
    expected_run_ids: set[str] | None = None,
    baseline_run_ids: set[str] | None = None,
    baseline_sequence: int = 0,
    progress_page_ids: set[str] | None = None,
    progress_run_ids: list[str] | None = None,
    progress_note: str = "编译语料",
) -> dict[str, Any]:
    baseline_run_ids = baseline_run_ids or set()
    expected_run_ids = expected_run_ids or set()

    def is_current(run: dict[str, Any]) -> bool:
        run_id = _run_id(run)
        if run_id in expected_run_ids:
            return True
        if run_id:
            return run_id not in baseline_run_ids
        return int(run.get("spaceJobSequence") or 0) > baseline_sequence

    while True:
        ctx.checkpoint()
        try:
            runs = list(client.run_diagnostics([space_id], limit=50).get("items") or [])
        except AkashaError:
            runs = []
        current = [run for run in runs if is_current(run)]
        if (
            not current
            and coalesced_runs
            and any(_run_id(run) or run.get("spaceJobSequence") for run in runs)
        ):
            current = [max(runs, key=lambda r: int(r.get("spaceJobSequence") or 0))]

        if not current:
            if not expect_runs:
                return {"status_counts": {}, "no_runs": True}
            ctx.progress(0, None, "等待远端编译")
            time.sleep(POLL_INTERVAL_SECONDS)
            continue

        counts = _status_counts(current)
        if progress_run_ids:
            runs_by_id = {_run_id(run): run for run in runs if _run_id(run)}
            progress_runs = [runs_by_id.get(run_id, {"runId": run_id}) for run_id in progress_run_ids]
            target_progress = _target_run_progress(ctx, client, progress_runs)
        else:
            target_progress = _target_run_progress(ctx, client, current, progress_page_ids)
        shown_progress = target_progress or _progress_of(current)
        if shown_progress.get("expected"):
            ctx.progress(shown_progress["succeeded"], shown_progress["expected"], progress_note)
        else:
            ctx.progress(0, None, "等待远端编译")
        if not any(status in ACTIVE_RUN_STATUSES for status in counts):
            return {
                "status_counts": counts,
                "no_runs": False,
                "runs": current,
                "progress": shown_progress,
            }
        time.sleep(POLL_INTERVAL_SECONDS)


def _target_run_progress(
    ctx: TaskContext,
    client: AkashaClient,
    runs: list[dict[str, Any]],
    progress_page_ids: set[str] | None = None,
) -> dict[str, int] | None:
    compile_id = ctx.target("compile")
    if compile_id is None:
        return None
    target_ids = progress_page_ids or {
        str(row["page_id"])
        for row in compile_store.compile_docs(ctx.db, compile_id)
        if row.get("page_id")
    }
    if not target_ids:
        return None

    try:
        latest = latest_run_pages(client, [run_id for run in runs if (run_id := _run_id(run))])
    except (AkashaError, OSError):
        return None
    statuses = [
        "failed" if item.get("mergeStatus") == "failed" else str(item.get("status") or "pending")
        for page_id, item in latest.items()
        if page_id in target_ids
    ]
    if not statuses:
        return None
    return {
        "expected": max((_text_count(run, "expected") for run in runs), default=0) or len(target_ids),
        "succeeded": statuses.count("succeeded"),
        "failed": statuses.count("failed"),
        "skipped": sum(status in {"skipped", "cancelled"} for status in statuses),
    }


def _page_failures(client: AkashaClient, space_id: str) -> list[str]:
    try:
        log = client.page_log([space_id])
    except AkashaError as exc:
        return [f"读逐页日志失败：HTTP {exc.status}"]

    entries = log.get("items") or []
    failed = [e for e in entries if e.get("status") in {"failed", "skipped"}]
    grouped: dict[tuple[str, str], list[str]] = defaultdict(list)
    for entry in failed:
        key = (
            str(entry.get("errorCode") or "unknown"),
            str(entry.get("errorSummary") or ""),
        )
        grouped[key].append(str(entry.get("title") or entry.get("sourcePageId") or "?"))

    lines = []
    for (code, summary), titles in sorted(grouped.items()):
        sample = "、".join(titles[:3]) + ("…" if len(titles) > 3 else "")
        lines.append(f"{len(titles)} 篇 {code}：{summary}（例如 {sample}）")
    return lines


def _compile_pace(
    client: AkashaClient, space_id: str, runs: list[dict[str, Any]] | None = None
) -> dict[str, Any] | None:
    if runs is None:
        try:
            report = client.run_diagnostics([space_id])
        except AkashaError:
            return None
        runs = report.get("items") or []
    if not runs:
        return None
    total_ms = sum(int(r.get("runDurationMs") or 0) for r in runs)
    pages = sum(_text_count(r, "expected") for r in runs)
    if not pages or not total_ms:
        return None
    return {
        "runs": len(runs),
        "pages": pages,
        "total_ms": total_ms,
        "per_page_ms": round(total_ms / pages),
    }


def _quality_gate(client: AkashaClient, space_id: str) -> dict[str, Any]:
    report = client.quality_diagnostics([space_id])
    summary = report.get("summary") or {}
    gates = {
        name: summary.get(name)
        for name in (
            "missingChunkPageCount",
            "missingEmbeddingPageCount",
            "missingSourcePageCount",
            "stalePageCount",
        )
    }
    passed = all(isinstance(v, int) and v == 0 for v in gates.values())
    return {"passed": passed, "gates": gates}


def _retry_batches(
    ctx: TaskContext,
    client: AkashaClient,
    space_id: str,
    failed_page_ids: list[str] | None = None,
) -> tuple[dict[str, Any], int]:
    if failed_page_ids is not None:
        pending = list(dict.fromkeys(failed_page_ids))
        current: list[str] = []
        current_run_ids: list[str] = []
        all_run_ids = [
            str(value) for value in ctx.params.get("remote_compile_run_ids") or []
        ]
        total = len(pending)
        completed = 0
        aggregate = {"expected": total, "succeeded": 0, "failed": 0, "skipped": 0}
    else:
        pending = [str(value) for value in ctx.params["retry_pending_page_ids"]]
        current = [str(value) for value in ctx.params["retry_current_page_ids"]]
        current_run_ids = [str(value) for value in ctx.params["retry_current_run_ids"]]
        all_run_ids = [str(value) for value in ctx.params["remote_compile_run_ids"]]
        completed = int(ctx.params["retry_completed"])
        total = int(ctx.params["retry_total"])
        aggregate = dict(ctx.params["retry_progress"])

    def save_state(**overrides: Any) -> None:
        ctx.freeze(
            **{
                "remote_compile_run_ids": all_run_ids,
                "retry_pending_page_ids": pending,
                "retry_current_page_ids": current,
                "retry_current_run_ids": current_run_ids,
                "retry_completed": completed,
                "retry_total": total,
                "retry_progress": aggregate,
                **overrides,
            }
        )

    wait: dict[str, Any] = {
        "status_counts": {},
        "no_runs": False,
        "runs": [],
        "progress": aggregate,
    }
    while current or pending:
        ctx.checkpoint()
        if not current:
            current = pending[:100]
            pending = pending[100:]
            result = client.retry_pages(current)
            current_run_ids = [str(value) for value in result.get("jobIds") or []]
            if not current_run_ids:
                raise RuntimeError(
                    f"Akasha 已接收 {len(current)} 篇失败页面，但没有返回重试 Run ID"
                )
            queued_runs = int(result.get("queuedPageCount") or 0)
            if queued_runs != len(current_run_ids):
                raise RuntimeError(
                    "Akasha 重试响应计数不一致："
                    f"queuedPageCount={queued_runs}，jobIds={len(current_run_ids)}"
                )
            all_run_ids.extend(
                run_id for run_id in current_run_ids if run_id not in all_run_ids
            )
            ctx.log(
                f"批量重试 {completed + 1}-{completed + len(current)} / {total}，"
                f"远端 Run {', '.join(current_run_ids)}"
            )
            save_state()

        wait = _wait_for_compile(
            ctx,
            client,
            space_id,
            expect_runs=len(current_run_ids),
            expected_run_ids=set(current_run_ids),
            progress_page_ids=set(current),
            progress_run_ids=all_run_ids,
            progress_note="重试失败语料",
        )
        if wait["no_runs"]:
            return wait, len(all_run_ids)

        batch_progress = _target_run_progress(
            ctx,
            client,
            [{"runId": run_id} for run_id in current_run_ids],
            set(current),
        ) or wait.get("progress") or {}
        for key in ("succeeded", "failed", "skipped"):
            aggregate[key] = int(aggregate.get(key) or 0) + int(batch_progress.get(key) or 0)
        completed += len(current)
        current = []
        current_run_ids = []
        aggregate["expected"] = total
        wait["progress"] = dict(aggregate)
        save_state()

    wait["runs"] = [{"runId": run_id} for run_id in all_run_ids]
    save_state(retry_completed=0, retry_total=0, retry_progress={})
    return wait, len(all_run_ids)


def _compiler_slug(ctx: TaskContext, config: AkashaConfig) -> str:
    with AkashaClient(config) as client:
        client.login()
        return naming.model_slug(ctx.db, client.get_model_configs(), "compiler")


def run(ctx: TaskContext) -> None:
    params = ctx.params
    datasets = list(params.get("datasets") or [])
    if not datasets:
        raise ValueError("请至少选择一个数据集")
    unknown = sorted(set(datasets) - set(dataset_names()))
    if unknown:
        raise ValueError(f"未知数据集：{unknown}")

    seed = int(params["seed"]) if params.get("seed") is not None else default_seed()
    qa_limit = int(params.get("qa_limit") or DEFAULT_QA_LIMIT)
    sample_ids = [str(value) for value in params.get("sample_ids") or []]
    negatives_ratio = float(params.get("negatives_ratio", DEFAULT_NEGATIVES_RATIO))
    full_corpus = bool(params.get("full_corpus", False))
    import_concurrency = int(params.get("import_concurrency") or DEFAULT_IMPORT_CONCURRENCY)
    if qa_limit < 1:
        raise ValueError("每个数据集的 QA 数必须大于 0")
    if negatives_ratio < 0:
        raise ValueError("负样本比例不能为负")
    if not 1 <= import_concurrency <= MAX_IMPORT_CONCURRENCY:
        raise ValueError(f"导入并发必须在 1 到 {MAX_IMPORT_CONCURRENCY} 之间")

    config = load_config(ctx.db)
    config.require_credentials()

    compile_id = ctx.target("compile")
    resuming = compile_id is not None
    options = CompileOptions(
        run_id=str(params.get("run_id") or "").strip()
        or naming.compile_name(
            ctx.db, datasets=datasets, model=_compiler_slug(ctx, config)
        ),
        datasets=datasets,
        seed=seed,
        qa_limit=qa_limit,
        sample_ids=sample_ids,
        negatives_ratio=negatives_ratio,
        full_corpus=full_corpus,
        import_concurrency=import_concurrency,
    )
    ctx.freeze(
        **asdict(options),
    )
    if compile_id is None:
        if compile_store.compile_run_by_run_id(ctx.db, options.run_id):
            raise ValueError(f"编译名称 {options.run_id!r} 已存在，请换个名称或继续原任务")
        compile_id = compile_store.create_compile_run(
            ctx.db,
            run_id=options.run_id,
            datasets=options.datasets,
            seed=options.seed,
            qa_limit=options.qa_limit,
            negatives_ratio=options.negatives_ratio,
        )
        ctx.bind("compile", compile_id)
    ctx.log(f"编译 {options.run_id}（#{compile_id}），数据集 {', '.join(options.datasets)}")

    _execute(ctx, compile_id, options, config, resuming)


def _execute(
    ctx: TaskContext,
    compile_id: int,
    options: CompileOptions,
    config: AkashaConfig,
    resuming: bool,
) -> None:
    _prepare_subset(ctx, compile_id, options)

    with AkashaClient(config) as client:
        client.login()
        me = client.current_user()
        user = (me or {}).get("user") or {}
        workspace = (me or {}).get("workspace") or {}

        if user.get("role") != "owner":
            raise RuntimeError(
                f"当前账号角色是 {user.get('role')!r}，不是 owner。"
                "非 owner 会在授权闸门静默丢弃 chunk，入库前请提权。"
            )

        record = compile_store.get_compile_run(ctx.db, compile_id) or {}
        space_id = record.get("space_id")
        current_configs = client.get_model_configs()
        ctx.freeze(model_configs=current_configs)
        saved_configs = loads(record.get("model_configs_json"))
        if resuming and saved_configs:
            changed = _drifted(current_configs, saved_configs)
            if changed:
                raise RuntimeError(
                    "远端模型配置已变化，不能继续原编译：" + ", ".join(changed)
                )
        compile_store.update_compile_run(
            ctx.db, compile_id, model_configs_json=dumps(current_configs)
        )
        ctx.db.commit()
        if not space_id:
            slug = naming.space_slug(options.run_id)
            space = client.create_space(
                name=f"bench {options.run_id}"[:100],
                slug=slug,
                description=f"Akasha-Benchmark {options.run_id}. 自动生成，可安全删除。",
            )
            space_id = space.get("id")
            if not space_id:
                raise RuntimeError(f"创建空间未返回 id：{space!r}")
            compile_store.update_compile_run(
                ctx.db,
                compile_id,
                space_id=space_id,
                space_name=slug,
                workspace_id=workspace.get("id"),
            )
            ctx.db.commit()
            ctx.log(f"创建空间 {slug}（{space_id}）")
        else:
            mismatch = compile_store.workspace_mismatch(ctx.db, compile_id, workspace.get("id"))
            if mismatch:
                raise RuntimeError(mismatch)
            ctx.log(f"复用本次编译的空间 {space_id}")

        _run_remote_compile(
            ctx, client, compile_id, space_id, options.import_concurrency, current_configs
        )


def _prepare_subset(ctx: TaskContext, compile_id: int, options: CompileOptions) -> None:
    if compile_store.compile_docs(ctx.db, compile_id):
        ctx.log("子集已存在，跳过抽样")
        return
    for dataset in options.datasets:
        ctx.checkpoint()
        ctx.progress(0, None, f"抽子集 {dataset}")
        stats = build_subset(
            ctx.db,
            compile_id,
            dataset,
            seed=options.seed,
            qa_limit=options.qa_limit,
            sample_ids=options.sample_ids,
            negatives_ratio=options.negatives_ratio,
            full_corpus=options.full_corpus,
        )
        ctx.log(
            f"{dataset}: QA {stats['samples']}，语料 {stats['docs']} "
            f"(gold {stats['gold']} / 负样本 {stats['negatives']})，策略 {stats['strategy']}"
            + (f"，跳过无正文 {stats['empty_docs']} 篇" if stats["empty_docs"] else "")
        )


def _run_remote_compile(
    ctx: TaskContext,
    client: AkashaClient,
    compile_id: int,
    space_id: str,
    import_concurrency: int,
    current_configs: Any,
) -> None:
    _import_docs(ctx, client, compile_id, space_id, import_concurrency)

    total_docs = len(compile_store.compile_docs(ctx.db, compile_id))
    ctx.progress(0, total_docs, "等待编译")
    try:
        before = client.run_diagnostics([space_id], limit=50).get("items") or []
    except AkashaError:
        before = []
    baseline_run_ids = {_run_id(run) for run in before if _run_id(run)}
    baseline_sequence = max((int(run.get("spaceJobSequence") or 0) for run in before), default=0)
    previous_run_ids = [str(value) for value in ctx.params.get("remote_compile_run_ids") or []]
    previous_runs = [run for run in before if _run_id(run) in set(previous_run_ids)]
    active_previous = [
        run for run in previous_runs if str(run.get("status") or "") in ACTIVE_RUN_STATUSES
    ]
    retry_in_progress = bool(
        ctx.params.get("retry_current_page_ids")
        or ctx.params.get("retry_pending_page_ids")
    )

    ctx.checkpoint()
    accepted = coalesced = 0
    if retry_in_progress:
        wait, accepted = _retry_batches(ctx, client, space_id)
    elif active_previous:
        remote_run_ids = {_run_id(run) for run in active_previous}
        accepted = len(remote_run_ids)
        ctx.log(f"接管仍在运行的远端编译：{', '.join(sorted(remote_run_ids))}")
        wait = _wait_for_compile(
            ctx,
            client,
            space_id,
            expect_runs=len(remote_run_ids),
            expected_run_ids=remote_run_ids,
        )
    elif previous_run_ids:
        failed_page_ids = client.retryable_run_page_ids(previous_run_ids)
        if failed_page_ids:
            wait, accepted = _retry_batches(ctx, client, space_id, failed_page_ids)
        elif previous_runs and all(
            str(run.get("status") or "") == "cancelled" and not _text_count(run, "expected")
            for run in previous_runs
        ):
            target_page_ids = list(
                dict.fromkeys(
                    str(row["page_id"])
                    for row in compile_store.compile_docs(ctx.db, compile_id)
                    if row.get("page_id")
                )
            )
            if not target_page_ids:
                raise RuntimeError("上次远端 Run 在逐页初始化前取消，且没有可重试页面")
            ctx.progress(0, len(target_page_ids), "重试未初始化语料")
            wait, accepted = _retry_batches(ctx, client, space_id, target_page_ids)
        else:
            ctx.log("已保存的远端编译没有失败页面，只刷新质量闸门")
            wait = {
                "status_counts": _status_counts(previous_runs),
                "no_runs": False,
                "runs": previous_runs,
                "progress": _progress_of(previous_runs),
            }
    else:
        result = client.compile_spaces([space_id])
        accepted = int(result.get("acceptedRunCount") or 0)
        coalesced = int(result.get("coalescedRunCount") or 0)
        remote_run_ids = {
            str(run["runId"])
            for run in result.get("runs") or []
            if isinstance(run, dict) and run.get("runId")
        }
        if remote_run_ids:
            ctx.freeze(remote_compile_run_ids=sorted(remote_run_ids))
        if ctx.pause_requested:
            for remote_run_id in remote_run_ids:
                result = client.cancel_compile_run(
                    remote_run_id, "Akasha-Benchmark task paused during compile submission"
                )
                validate_cancel_result(remote_run_id, result)
            ctx.checkpoint()
        ctx.log(f"已请求编译：accepted={accepted} coalesced={coalesced}")
        wait = _wait_for_compile(
            ctx,
            client,
            space_id,
            expect_runs=accepted + coalesced,
            coalesced_runs=coalesced,
            expected_run_ids=remote_run_ids,
            baseline_run_ids=baseline_run_ids,
            baseline_sequence=baseline_sequence,
        )
    if wait["no_runs"]:
        raise RuntimeError(
            f"编译没有启动：Akasha 一个编译 Run 都没有（accepted={accepted} "
            f"coalesced={coalesced}）。{total_docs} "
            "篇语料已上传但没被编译，请检查 Akasha 的编译 worker 是否在跑。"
        )
    ctx.log(f"编译终态：{wait['status_counts']}")

    pace = _compile_pace(client, space_id, wait.get("runs") or None)
    if pace:
        compile_store.update_compile_run(ctx.db, compile_id, pace_json=dumps(pace))
        ctx.log(
            f"编译节奏（估算）：{pace['pages']} 篇用 "
            f"{pace['total_ms'] / 1000:.1f}s，约 {pace['per_page_ms'] / 1000:.1f}s/篇"
        )

    quality = _quality_gate(client, space_id)

    ordered_run_ids = list(
        dict.fromkeys(
            [str(value) for value in ctx.params.get("remote_compile_run_ids") or []]
            + [_run_id(run) for run in wait.get("runs") or [] if _run_id(run)]
        )
    )
    quality["progress"] = (
        _target_run_progress(
            ctx, client, [{"runId": run_id} for run_id in ordered_run_ids]
        )
        or wait.get("progress")
        or {}
    )
    compile_store.update_compile_run(ctx.db, compile_id, quality_json=dumps(quality))
    ctx.db.commit()
    ctx.log(f"质量闸门 {quality['gates']} -> {'通过' if quality['passed'] else '未通过'}")
    if not quality["passed"]:
        reasons = _page_failures(client, space_id)
        for line in reasons:
            ctx.log(f"编译失败原因：{line}", "error")
        detail = f"；{reasons[0]}" if reasons else ""
        raise RuntimeError(
            f"编译质量闸门未通过：整批结果不完整；成功页面仍可供查询层使用{detail}"
        )
    changed_during_run = _drifted(client.get_model_configs(), current_configs)
    if changed_during_run:
        raise RuntimeError(
            "编译期间远端模型配置发生变化，结果可能混合："
            + ", ".join(changed_during_run)
        )

    ctx.progress(total_docs, total_docs, "编译完成")
    ctx.log("编译完成，可以进入查询层")


def _import_one(
    client: AkashaClient, doc: dict[str, Any], markdown: str, space_id: str
) -> dict[str, Any]:
    try:
        page = client.import_page_text(f"{doc['doc_id']}.md", markdown, space_id)
        page_id = page.get("id") if isinstance(page, dict) else None
        error = None if page_id else f"响应里没有 page id: {page!r}"[:300]
    except (AkashaError, httpx.RequestError, OSError) as exc:
        page_id, error = None, f"{type(exc).__name__}: {exc}"[:300]
    return {"doc": doc, "page_id": page_id, "error": error}


def _import_docs(
    ctx: TaskContext,
    client: AkashaClient,
    compile_id: int,
    space_id: str,
    concurrency: int,
) -> None:
    pending = compile_store.compile_docs(ctx.db, compile_id, pending_only=True)
    total = len(compile_store.compile_docs(ctx.db, compile_id))
    done = total - len(pending)
    if not pending:
        ctx.log(f"{total} 篇语料均已导入，跳过")
        return

    worker_count = min(concurrency, len(pending))
    ctx.log(f"导入语料：待导入 {len(pending)} / 共 {total}，并发 {worker_count}")

    with client_pool(client, worker_count, AkashaClient) as call:

        def task(item: tuple[dict[str, Any], str]) -> dict[str, Any]:
            doc, markdown = item
            return call(_import_one, doc, markdown, space_id)

        def run_pass(
            executor: ThreadPoolExecutor, docs: list[dict[str, Any]], *, retry: bool
        ) -> list[dict[str, Any]]:
            nonlocal done
            failures: list[dict[str, Any]] = []
            for start in range(0, len(docs), worker_count):
                ctx.checkpoint()
                batch = docs[start : start + worker_count]
                work = [
                    (doc, markdown_of(ctx.db, doc["dataset"], doc["doc_id"]))
                    for doc in batch
                ]
                for row in executor.map(task, work):
                    doc = row["doc"]
                    compile_store.record_page(
                        ctx.db,
                        compile_id,
                        doc["dataset"],
                        doc["doc_id"],
                        page_id=row["page_id"],
                        error=row["error"],
                    )
                    ctx.db.commit()
                    if row["error"]:
                        failures.append(doc)
                        prefix = "重试仍失败" if retry else "导入失败"
                        ctx.log(
                            f"{prefix} {doc['dataset']}/{doc['doc_id']}: {row['error']}",
                            "warn",
                        )
                    else:
                        done += 1
                ctx.progress(done, total, "导入语料")
            return failures

        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            failures = run_pass(executor, pending, retry=False)
            if failures:
                ctx.checkpoint()
                ctx.log(f"首轮有 {len(failures)} 篇失败，移到末尾重试一次", "warn")
                failures = run_pass(executor, failures, retry=True)

    if failures:
        raise Paused(
            f"{len(failures)} 篇语料重试后仍未导入，任务已暂停；"
            "继续任务将从未导入文档接着执行"
        )
