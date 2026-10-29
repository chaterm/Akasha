from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path

from huggingface_hub import HfApi, hf_hub_download
from huggingface_hub.utils import HfHubHTTPError

from ..datasets import (
    DATASET_NAMES,
    all_adapters,
    dataset_dir,
    dataset_names,
    get_adapter,
)
from ..task import TaskContext

REPO_ID = "osunlp/HippoRAG_2"
REPO_TYPE = "dataset"

ENDPOINTS = ("https://hf-mirror.com", "https://huggingface.co")


REMOTE_NAMES = {
    "narrativeqa.json": "narrativeqa_dev_10_doc.json",
    "narrativeqa_corpus.json": "narrativeqa_dev_10_doc_corpus.json",
}

MAX_ATTEMPTS = 3


_ROW_CACHE: dict[tuple[str, int, int], tuple[int | None, str | None]] = {}


def _count_rows(path: Path, stat: os.stat_result) -> tuple[int | None, str | None]:
    key = (str(path), stat.st_mtime_ns, stat.st_size)
    if key not in _ROW_CACHE:
        try:
            rows = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(rows, list) or not rows:
                raise ValueError("expected a non-empty JSON array")
            _ROW_CACHE[key] = (len(rows), None)
        except (ValueError, UnicodeDecodeError, OSError) as exc:
            _ROW_CACHE[key] = (None, str(exc)[:200])
    return _ROW_CACHE[key]


def file_status() -> list[dict[str, object]]:
    root = dataset_dir()
    entries: list[dict[str, object]] = []
    for adapter in all_adapters():
        for kind, name in (("qa", adapter.qa_filename), ("corpus", adapter.corpus_filename)):
            path = root / name
            stat = path.stat() if path.is_file() else None
            rows, error = _count_rows(path, stat) if stat else (None, None)
            entries.append(
                {
                    "dataset": adapter.name,
                    "kind": kind,
                    "file": name,
                    "present": stat is not None,
                    "size_bytes": stat.st_size if stat else None,
                    "rows": rows,
                    "error": error,
                }
            )
    return entries


def _resolve_endpoint(ctx: TaskContext) -> tuple[str, dict[str, int]]:
    errors: list[str] = []
    for endpoint in ENDPOINTS:
        try:
            info = HfApi(endpoint=endpoint).repo_info(
                REPO_ID, repo_type=REPO_TYPE, files_metadata=True
            )
        except Exception as exc:
            errors.append(f"{endpoint}: {type(exc).__name__}: {str(exc)[:120]}")
            ctx.log(f"下载源不可用：{endpoint}", "warn")
            continue
        sizes = {s.rfilename: s.size for s in (info.siblings or []) if s.size is not None}
        ctx.log(f"使用下载源 {endpoint}")
        return endpoint, sizes
    raise RuntimeError("没有可用的 Hugging Face 站点：" + "; ".join(errors))


def _fetch(local: str, endpoint: str, expected: int | None, dest: Path) -> str:
    target = dest / local
    if target.is_file() and (expected is None or target.stat().st_size == expected):
        return "skipped"

    remote = REMOTE_NAMES.get(local, local)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            cached = hf_hub_download(
                repo_id=REPO_ID,
                repo_type=REPO_TYPE,
                filename=remote,
                endpoint=endpoint,
                cache_dir=dest / ".hf_cache",
            )
            break
        except (HfHubHTTPError, OSError):
            if attempt == MAX_ATTEMPTS:
                raise
            time.sleep(2**attempt)
    shutil.copyfile(cached, target)
    return "downloaded"


def run(ctx: TaskContext) -> None:
    selected = list(ctx.params.get("datasets") or DATASET_NAMES)
    unknown = sorted(set(selected) - set(dataset_names()))
    if unknown:
        raise ValueError(f"未知数据集：{unknown}")

    dest = dataset_dir()
    dest.mkdir(parents=True, exist_ok=True)
    chosen = [get_adapter(name) for name in selected]
    wanted = [n for a in chosen for n in (a.qa_filename, a.corpus_filename)]
    remote = [
        n for a in chosen if a.downloadable for n in (a.qa_filename, a.corpus_filename)
    ]
    for adapter in chosen:
        if not adapter.downloadable:
            ctx.log(f"{adapter.name}: 本地数据集，只校验不下载")

    if remote:
        ctx.progress(0, len(remote) + 1, "连接下载源")
        endpoint, sizes = _resolve_endpoint(ctx)
        for index, local in enumerate(remote):
            ctx.checkpoint()
            ctx.progress(index, len(remote) + 1, f"下载 {local}")
            outcome = _fetch(local, endpoint, sizes.get(REMOTE_NAMES.get(local, local)), dest)
            ctx.log(f"{local}: {'已存在，跳过' if outcome == 'skipped' else '下载完成'}")

        shutil.rmtree(dest / ".hf_cache", ignore_errors=True)

    ctx.progress(len(remote), len(remote) + 1, "校验原始文件")
    broken = [
        entry
        for entry in file_status()
        if entry["file"] in wanted and (not entry["present"] or entry["error"])
    ]
    for entry in broken:
        ctx.log(f"{entry['file']}: {entry['error'] or '缺失'}", "error")
    if broken:
        raise RuntimeError(f"{len(broken)} 个原始文件校验失败")

    ctx.progress(len(remote) + 1, len(remote) + 1, "下载与校验完成")
    ctx.log(f"{len(wanted)} 个原始文件就绪")
