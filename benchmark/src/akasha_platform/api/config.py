from __future__ import annotations

import sqlite3
from collections.abc import Collection, Iterator
from contextlib import contextmanager
from typing import Any

import httpx
from fastapi import APIRouter, Body, HTTPException, Request

from akasha_benchmark.akasha_client import AkashaClient, AkashaError
from akasha_benchmark.config import AkashaConfig
from akasha_benchmark.judge import JudgeClient, JudgeConfigError, JudgeProvider
from akasha_benchmark.model_configs import FEATURES, drift
from akasha_benchmark.store import compile_store, config_store, loads, task_store

from ._common import config_of, db, writable

router = APIRouter(prefix="/api")


def _require_credentials(config: AkashaConfig) -> None:
    try:
        config.require_credentials()
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@contextmanager
def _akasha(config: AkashaConfig, rejected: str = "") -> Iterator[AkashaClient]:
    try:
        with AkashaClient(config) as client:
            client.login()
            yield client
    except AkashaError as exc:
        raise HTTPException(502, f"{rejected}{exc}") from exc
    except (httpx.RequestError, OSError) as exc:
        raise HTTPException(502, f"连不上 {config.base_url}：{exc}") from exc


MODEL_FEATURE_STAGES = {
    "compiler": frozenset({"compile"}),
    "embedding": frozenset({"compile", "embed", "query"}),
    "answer": frozenset({"query"}),
    "image": frozenset({"compile"}),
}


def _reject_model_change_while_running(
    connection: sqlite3.Connection, feature: str
) -> None:
    locked_by = MODEL_FEATURE_STAGES.get(feature, frozenset())
    task = next(
        (
            task
            for task in task_store.active_tasks(connection)
            if task["stage"] in locked_by
        ),
        None,
    )
    if task is not None:
        raise HTTPException(
            409,
            f"{task['stage']} 任务 #{task['id']} 正在使用远端 {feature} 配置，不能修改",
        )


@router.get("/connection")
def get_connection(request: Request) -> dict[str, Any]:
    with db(request) as connection:
        row = config_store.get_connection_row(connection)
        compiles = [
            {
                "id": int(r["id"]),
                "run_id": r["run_id"],
                "workspace_id": r["workspace_id"],
                "space_id": r["space_id"],
            }
            for r in compile_store.list_compile_runs(connection)
            if r["space_id"]
        ]
    visible = {
        key: row[key]
        for key in (*config_store.CONNECTION_FIELDS, "updated_at")
        if key in row
    }
    return {**visible, "compiles": compiles}


@router.put("/connection")
def put_connection(request: Request, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        fields = config_store.sanitize_connection(payload)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    with writable(request) as connection:
        config_store.update_connection(connection, **fields)
    return {"updated": sorted(fields), "connection": get_connection(request)}


@router.post("/connection/test")
def test_connection(request: Request) -> dict[str, Any]:
    config = config_of(request)
    _require_credentials(config)
    with _akasha(config, "Akasha 拒绝了请求：") as client:
        me = client.current_user()
        model_configs = client.get_model_configs()

    user = (me or {}).get("user") or {}
    workspace = (me or {}).get("workspace") or {}
    role = user.get("role")

    with db(request) as connection:
        blocked = []
        for row in compile_store.list_compile_runs(connection):
            reason = compile_store.workspace_mismatch(
                connection, int(row["id"]), workspace.get("id")
            )
            if reason:
                blocked.append({"id": int(row["id"]), "run_id": row["run_id"], "reason": reason})

    return {
        "ok": True,
        "user": {"id": user.get("id"), "email": user.get("email"), "role": role},

        "workspace": {"id": workspace.get("id"), "name": workspace.get("name")},
        "is_owner": role == "owner",

        "blocked_compiles": blocked,
        "owner_warning": (
            None
            if role == "owner"
            else f"这个账号的角色是 {role!r}，不是 owner。非 owner 会在授权闸门静默"
            "丢弃 chunk，症状看起来像召回质量差。编译前请提权。"
        ),
        "model_configs": model_configs,
    }


@router.get("/model-configs")
def get_model_configs(request: Request) -> dict[str, Any]:
    config = config_of(request)
    _require_credentials(config)
    with _akasha(config) as client:
        live = client.get_model_configs()

    with db(request) as connection:
        compiles = [
            {
                "id": int(row["id"]),
                "run_id": row["run_id"],
                "drift": drift(live, loads(row["model_configs_json"])),
            }
            for row in compile_store.list_compile_runs(connection)
            if row["model_configs_json"]
        ]
    return {"features": list(FEATURES), "live": live, "compiles": compiles}


@router.put("/model-configs/{feature}")
def put_model_config(
    request: Request, feature: str, payload: dict[str, Any] = Body(...)
) -> dict[str, Any]:
    if feature not in FEATURES:
        raise HTTPException(422, f"未知配置项 {feature!r}；可用：{list(FEATURES)}")
    payload = {"provider": "openai-compatible", **payload}
    config = config_of(request)
    _require_credentials(config)
    with writable(request) as connection:
        connection.execute("BEGIN IMMEDIATE")
        _reject_model_change_while_running(connection, feature)
        with _akasha(config) as client:
            result = client.put_model_config(feature, payload)

    impact = {
        "compiler": "需要重新编译",
        "embedding": "已有编译可用「重建嵌入」复用，不必重新编译",
    }.get(feature, "不影响已有编译")
    return {
        "feature": feature,
        "result": result,
        "requires_new_compile": feature == "compiler",
        "requires_embedding_rebuild": feature == "embedding",
        "impact": impact,
    }


@router.get("/providers")
def list_providers(request: Request, role: str | None = None) -> list[dict[str, Any]]:
    if role is not None and role not in config_store.MODEL_ROLES:
        raise HTTPException(422, f"role 必须是 {list(config_store.MODEL_ROLES)} 之一")
    with db(request) as connection:
        rows = config_store.list_model_providers(connection, role)
    return [
        {
            **{
                k: v
                for k, v in row.items()
                if k not in ("purpose", "api_key", "parameters_json")
            },
            "role": row["purpose"],
            "api_key_set": bool((row["api_key"] or "").strip()),
        }
        for row in rows
    ]


def _save_model(
    request: Request,
    purpose: str,
    payload: dict[str, Any],
    *,
    label: str,
    base_url: str,
    model: str,
    not_found: str,
    parameters: dict[str, Any] | None = None,
) -> tuple[int, str]:
    try:
        model_id = None if payload.get("id") is None else int(payload["id"])
    except (TypeError, ValueError) as exc:
        raise HTTPException(422, f"id 必须是整数，收到 {payload['id']!r}") from exc

    with writable(request) as connection:
        rows = config_store.list_model_providers(connection, purpose)
        by_id = {int(row["id"]): row for row in rows}
        if model_id is not None and model_id not in by_id:
            raise HTTPException(404, not_found.format(id=model_id))
        clash = next((r for r in rows if r["label"] == label and int(r["id"]) != model_id), None)
        if clash is not None and model_id is not None:
            raise HTTPException(409, f"{purpose} 下已经有一个叫 {label!r} 的端点")

        existing = (by_id.get(model_id) if model_id is not None else clash) or {}
        api_key = str(payload.get("api_key") or "") or str(existing.get("api_key") or "")
        if parameters is None:
            parameters = loads(existing.get("parameters_json"), {})
        model_id = config_store.upsert_model_provider(
            connection,
            purpose=purpose,
            label=label,
            base_url=base_url,
            model=model,
            api_key=api_key,
            parameters=parameters,
            model_id=model_id,
        )
    return model_id, api_key


def _model_record(
    request: Request, model_id: int, purposes: Collection[str], not_found: str
) -> dict[str, Any]:
    with db(request) as connection:
        record = config_store.get_model_provider(connection, model_id)
    if record is None or record["purpose"] not in purposes:
        raise HTTPException(404, not_found.format(id=model_id))
    return record


def _probe(request: Request, record: dict[str, Any]) -> dict[str, Any]:
    provider = JudgeProvider(
        provider_id=int(record["id"]),
        base_url=str(record["base_url"]),
        model=str(record["model"]),
        api_key=str(record["api_key"] or ""),
        timeout_seconds=config_of(request).timeout_seconds,
    )

    def result(ok: bool, failure: str | None, status: int | None, reply: str, detail: str | None):
        return {
            "ok": ok,
            "failure": failure,
            "status": status,
            "reply": reply,
            "detail": detail,
            "provider": provider.redacted(),
        }

    try:
        key = provider.resolve_key()
    except JudgeConfigError as exc:
        return result(False, "config", None, "", str(exc))

    if record["purpose"] != "embedding":
        with JudgeClient(provider) as client:
            reply = client.complete(
                "You reply with a single JSON object.",
                'hi — reply as JSON: {"reply": "<your greeting>"}',
            )
        failed = reply.failure_kind is not None
        detail = (reply.raw or "")[:600] if failed else None
        return result(not failed, reply.failure_kind, reply.status, (reply.content or "")[:400], detail)

    try:
        with httpx.Client(timeout=httpx.Timeout(provider.timeout_seconds)) as client:
            response = client.post(
                f"{provider.base_url.rstrip('/')}/embeddings",
                json={"model": provider.model, "input": "hi"},
                headers={"Authorization": f"Bearer {key}"},
            )
        if not response.is_success:
            return result(False, "http_error", response.status_code, "", response.text[:600])
        vector = ((response.json().get("data") or [{}])[0]).get("embedding")
    except httpx.TimeoutException as exc:
        return result(False, "timeout", None, "", f"{type(exc).__name__}: {exc}")
    except (httpx.RequestError, ValueError, TypeError, KeyError, IndexError, AttributeError) as exc:
        return result(False, "request_error", None, "", f"{type(exc).__name__}: {exc}")
    if not isinstance(vector, list) or not vector:
        return result(False, "invalid_response", response.status_code, "", "响应没有返回 embedding 向量")
    return result(True, None, response.status_code, f"embedding 成功，维度 {len(vector)}", None)


@router.put("/providers/{role}")
def put_provider(
    request: Request, role: str, payload: dict[str, Any] = Body(...)
) -> dict[str, Any]:
    if role not in config_store.MODEL_ROLES:
        raise HTTPException(422, f"role 必须是 {list(config_store.MODEL_ROLES)} 之一")
    label = str(payload.get("label") or "default").strip()
    base_url = str(payload.get("base_url") or "").strip()
    model = str(payload.get("model") or "").strip()
    if not base_url or not model:
        raise HTTPException(422, "base_url 与 model 必填")
    provider_id, api_key = _save_model(
        request,
        role,
        payload,
        label=label,
        base_url=base_url,
        model=model,
        not_found=f"{role} 端点 #{{id}} 不存在",
    )
    return {
        "id": provider_id,
        "role": role,
        "label": label,
        "api_key_set": bool(api_key),
    }


@router.post("/providers/{provider_id}/probe")
def probe_provider(request: Request, provider_id: int) -> dict[str, Any]:
    record = _model_record(request, provider_id, config_store.MODEL_PURPOSES, "端点 #{id} 不存在")
    return _probe(request, record)


@router.delete("/providers/{provider_id}")
def delete_provider(request: Request, provider_id: int) -> dict[str, Any]:
    with writable(request) as connection:
        removed = config_store.delete_model_provider(connection, provider_id)
    if not removed:
        raise HTTPException(404, f"端点 #{provider_id} 不存在")
    return {"deleted": removed}


@router.get("/config/export")
def export_config(request: Request) -> dict[str, Any]:
    with db(request) as connection:
        row = config_store.get_connection_row(connection)
        connection_data = {
            key: row[key] for key in config_store.CONNECTION_FIELDS if key in row
        }
        models = config_store.list_model_providers(connection)
    return {
        "connection": connection_data,
        "models": [
            {
                "purpose": row["purpose"],
                "label": row["label"],
                "base_url": row["base_url"],
                "model": row["model"],
                "api_key": row["api_key"],
                "parameters": loads(row["parameters_json"], {}),
            }
            for row in models
        ],
    }


@router.post("/config/import")
def import_config(request: Request, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    connection_data = payload.get("connection") or {}
    models = payload.get("models") or []
    try:
        fields = config_store.sanitize_connection(connection_data)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    try:
        with writable(request) as connection:
            config_store.update_connection(connection, **fields)
            for model in models:
                config_store.upsert_model_provider(
                    connection,
                    purpose=str(model.get("purpose") or ""),
                    label=str(model.get("label") or "default"),
                    base_url=str(model.get("base_url") or ""),
                    model=str(model.get("model") or ""),
                    api_key=str(model.get("api_key") or ""),
                    parameters=model.get("parameters") if isinstance(model.get("parameters"), dict) else {},
                )
    except (TypeError, ValueError) as exc:
        raise HTTPException(422, str(exc)) from exc
    return {
        "connection": sorted(fields),
        "models": len(models),
    }


def _akasha_model_view(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "feature": row["purpose"],
        "label": row["label"],
        "base_url": row["base_url"],
        "model": row["model"],
        "parameters": loads(row["parameters_json"], {}),
        "api_key_set": bool((row["api_key"] or "").strip()),
        "updated_at": row["updated_at"],
    }


@router.get("/akasha-models")
def list_akasha_models(request: Request, feature: str | None = None) -> dict[str, Any]:
    if feature is not None and feature not in FEATURES:
        raise HTTPException(422, f"未知配置项 {feature!r}")
    with db(request) as connection:
        rows = config_store.list_model_providers(connection, feature)
    return {"features": list(FEATURES), "models": [_akasha_model_view(row) for row in rows]}


@router.put("/akasha-models")
def put_akasha_model(request: Request, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    feature = str(payload.get("feature") or "")
    label = str(payload.get("label") or "").strip()
    base_url = str(payload.get("base_url") or "").strip()
    model = str(payload.get("model") or "").strip()
    if feature not in FEATURES or not label or not base_url or not model:
        raise HTTPException(422, "feature、label、base_url 与 model 必填")
    parameters = payload.get("parameters") if isinstance(payload.get("parameters"), dict) else None
    dimension = (parameters or {}).get("dimension") if feature == "embedding" else None
    if dimension is not None and (
        isinstance(dimension, bool) or not isinstance(dimension, int) or dimension <= 0
    ):
        raise HTTPException(422, "embedding parameters.dimension 必须是正整数")
    model_id, _ = _save_model(
        request,
        feature,
        payload,
        label=label,
        base_url=base_url,
        model=model,
        not_found="Akasha 模型配置 #{id} 不存在",
        parameters=parameters,
    )
    return {"id": model_id, "feature": feature, "label": label}


@router.delete("/akasha-models/{model_id}")
def delete_akasha_model(request: Request, model_id: int) -> dict[str, Any]:
    with writable(request) as connection:
        removed = config_store.delete_model_provider(connection, model_id)
    if not removed:
        raise HTTPException(404, f"Akasha 模型配置 #{model_id} 不存在")
    return {"deleted": removed}


@router.post("/akasha-models/{model_id}/probe")
def probe_akasha_model(request: Request, model_id: int) -> dict[str, Any]:
    record = _model_record(request, model_id, FEATURES, "Akasha 模型配置 #{id} 不存在")
    return _probe(request, record)


@router.post("/akasha-models/{model_id}/apply")
def apply_akasha_model(request: Request, model_id: int) -> dict[str, Any]:
    config = config_of(request)
    _require_credentials(config)
    with writable(request) as connection:
        connection.execute("BEGIN IMMEDIATE")
        record = config_store.get_model_provider(connection, model_id)
        if record is None:
            raise HTTPException(404, f"Akasha 模型配置 #{model_id} 不存在")
        feature = str(record["purpose"])
        if feature not in FEATURES:
            raise HTTPException(422, f"模型配置 #{model_id} 不能应用到 Akasha")
        _reject_model_change_while_running(connection, feature)
        with _akasha(config) as client:
            client.put_model_config(
                feature,
                {
                    "provider": "openai-compatible",
                    "model": record["model"],
                    "baseUrl": record["base_url"],
                    "apiKey": record["api_key"],
                    "parameters": loads(record["parameters_json"], {}),
                },
            )
    return {"applied": feature}
