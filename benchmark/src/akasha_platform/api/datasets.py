from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from akasha_benchmark.datasets import (
    LocalAdapter,
    all_adapters,
    dataset_dir,
    get_adapter,
    is_local_name,
    source_space,
)
from akasha_benchmark.datasets.space_export import parse_space_export, space_page_ids
from akasha_benchmark.io_utils import load_json, write_json
from akasha_benchmark.metrics import registry
from akasha_benchmark.stages import download
from akasha_benchmark.store import data_store

from ._common import akasha_session, config_of, db, require_credentials, writable

router = APIRouter(prefix="/api")

DEFAULT_PAGE = 20
MAX_PAGE = 200


def _contains_text(value: Any, needle: str) -> bool:
    if isinstance(value, dict):
        return any(_contains_text(item, needle) for item in value.values())
    if isinstance(value, list):
        return any(_contains_text(item, needle) for item in value)
    return value is not None and needle in str(value).lower()


def _space_label(space: dict[str, Any] | None) -> str | None:
    return space and (space.get("space_name") or space.get("space_id"))


def _imported_at(adapter: Any) -> float:
    if not isinstance(adapter, LocalAdapter):
        return 0.0
    path = dataset_dir() / adapter.corpus_filename
    return path.stat().st_mtime if path.is_file() else 0.0


@router.get("/datasets")
def datasets(request: Request) -> dict[str, Any]:
    with db(request) as connection:
        normalized = {row["name"]: row for row in data_store.list_datasets(connection)}

    files: dict[str, list[dict[str, Any]]] = {}
    for entry in download.file_status():
        files.setdefault(str(entry["dataset"]), []).append(entry)

    entries = []
    for adapter in sorted(all_adapters(), key=_imported_at, reverse=True):
        record = normalized.get(adapter.name)
        space = source_space(adapter.name)
        present = all(f["present"] and not f["error"] for f in files[adapter.name])
        entries.append(
            {
                "name": adapter.name,
                "adapter": type(adapter).__name__,
                "provides": sorted(d.value for d in adapter.provides),
                "identity_rules": adapter.identity_rules(),
                "subset_strategy": adapter.subset_strategy.value,

                "downloadable": adapter.downloadable,
                "source_space": _space_label(space),
                "space_id": (space or {}).get("space_id"),
                "expected_qa_rows": adapter.expected_qa_rows(),
                "files": files[adapter.name],
                "files_ready": present,
                "normalized": record is not None,
                "normalized_at": (record or {}).get("normalized_at"),
                "qa_rows": (record or {}).get("qa_rows"),
                "corpus_rows": (record or {}).get("corpus_rows"),
            }
        )
    return {"datasets": entries, "dataset_dir": str(dataset_dir())}


def _corpus_target(name: str, overwrite: bool) -> LocalAdapter:
    if not is_local_name(name):
        raise HTTPException(422, "名称只能包含 UTF-8 字母、数字和连字符，且不能与内置数据集同名")
    adapter = LocalAdapter(name)
    if (dataset_dir() / adapter.corpus_filename).exists() and not overwrite:
        raise HTTPException(409, f"{name} 已存在")
    return adapter


def _write_corpus(
    adapter: LocalAdapter, archive: bytes, space: dict[str, Any] | None = None
) -> dict[str, Any]:
    try:
        rows = parse_space_export(archive)
        if space is not None:
            space = {**space, "page_ids": space_page_ids(archive)}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    write_json(dataset_dir() / adapter.corpus_filename, rows)
    (dataset_dir() / adapter.qa_filename).unlink(missing_ok=True)
    space_path = dataset_dir() / adapter.space_filename
    if space is None:
        space_path.unlink(missing_ok=True)
    else:
        write_json(space_path, space)
    return {"dataset": adapter.name, "docs": len(rows)}


@router.post("/datasets/import")
async def import_space(request: Request, name: str, overwrite: bool = False) -> dict[str, Any]:
    adapter = _corpus_target(name, overwrite)
    return _write_corpus(adapter, await request.body())


@router.get("/akasha/spaces")
def akasha_spaces(request: Request) -> dict[str, Any]:
    config = config_of(request)
    require_credentials(config)
    with akasha_session(config) as client:
        spaces = client.list_spaces()
    return {
        "spaces": [
            {"id": s.get("id"), "name": s.get("name"), "slug": s.get("slug")} for s in spaces
        ]
    }


@router.post("/datasets/import-akasha")
def import_akasha_space(
    request: Request, name: str, space_id: str, overwrite: bool = False
) -> dict[str, Any]:
    adapter = _corpus_target(name, overwrite)
    config = config_of(request)
    require_credentials(config)
    with akasha_session(config, "Akasha 拒绝导出：") as client:
        info = client.space_info(space_id)
        archive = client.export_space(space_id)
    space = {
        "space_id": space_id,
        "space_name": info.get("slug") or info.get("name"),
        "workspace_id": info.get("workspaceId"),
    }
    return _write_corpus(adapter, archive, space)


@router.delete("/datasets/{name}")
def delete_dataset(
    request: Request, name: str, remove_files: bool = False
) -> dict[str, Any]:
    with writable(request) as connection:
        try:
            deleted = data_store.delete_dataset(connection, name)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
    removed = 0
    if remove_files:
        try:
            adapter = get_adapter(name)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        for filename in (adapter.qa_filename, adapter.corpus_filename, adapter.space_filename):
            path = dataset_dir() / filename
            if path.is_file():
                path.unlink()
                removed += 1
    if not deleted and not removed:
        raise HTTPException(404, f"{name} 没有可删除的数据")
    return {"deleted": deleted, "dataset": name, "files_removed": removed}


@router.get("/datasets/{name}/raw")
def raw_samples(
    name: str,
    kind: str = "qa",
    q: str | None = None,
    limit: int = Query(DEFAULT_PAGE, ge=1, le=MAX_PAGE),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    if kind not in ("qa", "corpus"):
        raise HTTPException(422, "kind 必须是 qa 或 corpus")
    try:
        adapter = get_adapter(name)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc

    filename = adapter.qa_filename if kind == "qa" else adapter.corpus_filename
    path = dataset_dir() / filename
    if not path.is_file():
        raise HTTPException(404, f"{path.name} 缺失，请先在数据集页下载。")
    rows = load_json(path)
    if not isinstance(rows, list):
        raise HTTPException(500, f"{path.name}: 期望一个 JSON 数组")
    needle = (q or "").strip().lower()
    if needle:
        rows = [row for row in rows if _contains_text(row, needle)]

    return {
        "dataset": adapter.name,
        "kind": kind,
        "source_file": filename,
        "total": len(rows),
        "offset": offset,
        "limit": limit,

        "rows": rows[offset : offset + limit],
    }


@router.get("/datasets/{name}/samples")
def normalized_samples(
    request: Request,
    name: str,
    q: str | None = None,
    limit: int = Query(DEFAULT_PAGE, ge=1, le=MAX_PAGE),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    with db(request) as connection:
        if data_store.get_dataset(connection, name) is None:
            raise HTTPException(404, f"{name} 还没归一化")
        total, rows = data_store.sample_page(
            connection,
            name,
            search=(q or "").strip() or None,
            limit=limit,
            offset=offset,
        )
    return {
        "dataset": name,
        "total": total,
        "offset": offset,
        "limit": limit,
        "samples": rows,
    }


@router.get("/datasets/{name}/samples/{sample_id}")
def normalized_sample(request: Request, name: str, sample_id: str) -> dict[str, Any]:
    with db(request) as connection:
        sample = data_store.get_sample(connection, sample_id)
        if sample is None or sample["dataset"] != name:
            raise HTTPException(404, f"{name} 里没有样本 {sample_id!r}")
        gold, missing = [], []
        for doc_id in sample["gold_doc_ids"]:
            doc = data_store.corpus_doc(connection, name, doc_id)
            if doc is None:
                missing.append(doc_id)
            else:
                gold.append({**doc, "text": doc["text"][:4000]})
    return {
        **sample,
        "gold_docs": gold,

        "missing_gold_doc_ids": missing,
    }


@router.get("/datasets/{name}/corpus")
def normalized_corpus(
    request: Request,
    name: str,
    q: str | None = None,
    limit: int = Query(10, ge=1, le=50),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    with db(request) as connection:
        if data_store.get_dataset(connection, name) is None:
            raise HTTPException(404, f"{name} 还没归一化")
        total, rows = data_store.corpus_page(
            connection,
            name,
            search=(q or "").strip() or None,
            limit=limit,
            offset=offset,
        )
    return {
        "dataset": name,
        "total": total,
        "offset": offset,
        "limit": limit,
        "docs": rows,
    }


@router.get("/metrics")
def metrics(datasets: str | None = None) -> dict[str, Any]:
    definitions = [
        {
            "name": d.name,
            "family": d.family,
            "requires": sorted(r.value for r in d.requires),
            "kind": d.kind,
            "higher_is_better": d.higher_is_better,
            "per_k": d.per_k,
            "description": d.description,
        }
        for d in registry.METRIC_DEFINITIONS
    ]

    names = [n.strip() for n in (datasets or "").split(",") if n.strip()]
    per_dataset: dict[str, list[str]] = {}
    for name in names:
        try:
            adapter = get_adapter(name)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        per_dataset[adapter.name] = [d.name for d in registry.available(adapter.provides)]

    sets = [set(v) for v in per_dataset.values()]
    return {
        "definitions": definitions,
        "per_dataset": per_dataset,

        "computable_for_all": sorted(set.intersection(*sets)) if sets else [],
        "computable_for_some": sorted(set.union(*sets)) if sets else [],
    }
