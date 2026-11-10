from __future__ import annotations

import base64
import hashlib
import json
import os
import queue
import random
import sys
import tempfile
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from .config import AkashaConfig

ACTIVE_RUN_STATUSES = frozenset(
    {"queued", "compiling", "aggregate_pending", "aggregating"}
)
TERMINAL_RUN_STATUSES = frozenset(
    {"succeeded", "partial", "failed", "superseded", "cancelled"}
)


def validate_cancel_result(run_id: str, result: dict[str, Any]) -> dict[str, str]:
    disposition = str(result.get("disposition") or "")
    returned_run_id = str(result.get("runId") or "")
    status = str(result.get("status") or "")
    if (
        returned_run_id != str(run_id)
        or disposition not in {"cancelled", "already_terminal"}
        or status not in TERMINAL_RUN_STATUSES
        or (disposition == "cancelled" and status != "cancelled")
    ):
        raise ValueError(
            f"取消 Run {run_id} 返回无效结果：runId={returned_run_id!r}, "
            f"disposition={disposition!r}, status={status!r}"
        )
    return {"run_id": returned_run_id, "disposition": disposition, "status": status}


RETRYABLE_STATUSES = frozenset({429, 502, 503, 504})
RETRYABLE_EXCEPTIONS = (httpx.TransportError,)
MAX_RETRIES = 2
RETRY_BASE_DELAY = 2.0
RETRY_MAX_DELAY = 30.0
AUTH_TOKEN_COOKIE = "authToken"
AUTH_EXPIRY_SKEW_SECONDS = 30.0
_AUTH_CACHE_PATH = Path(tempfile.gettempdir()) / "akasha-benchmark" / "auth-tokens.json"
_AUTH_LOCK = threading.Lock()
_AUTH_TOKENS: dict[str, str] = {}


def _auth_cache_key(config: AkashaConfig) -> str:
    identity = "\0".join(
        (config.base_url.rstrip("/").lower(), config.email.lower(), config.password)
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _jwt_expiry(token: str) -> float | None:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(payload).decode("utf-8"))
        expiry = decoded.get("exp")
        return float(expiry) if isinstance(expiry, (int, float)) else None
    except (IndexError, ValueError, TypeError, json.JSONDecodeError):
        return None


def _usable_auth_token(token: str | None) -> bool:
    if not token:
        return False
    expiry = _jwt_expiry(token)
    return expiry is not None and expiry > time.time() + AUTH_EXPIRY_SKEW_SECONDS


def _read_auth_cache() -> dict[str, str]:
    try:
        body = json.loads(_AUTH_CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(body, dict):
        return {}
    return {
        key: value
        for key, value in body.items()
        if isinstance(key, str) and isinstance(value, str)
    }


def _write_auth_cache(tokens: dict[str, str]) -> None:
    temporary: Path | None = None
    try:
        _AUTH_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary = _AUTH_CACHE_PATH.with_name(
            f".{_AUTH_CACHE_PATH.name}.{os.getpid()}.{threading.get_ident()}.tmp"
        )
        temporary.write_text(json.dumps(tokens), encoding="utf-8")
        if os.name != "nt":
            temporary.chmod(0o600)
        temporary.replace(_AUTH_CACHE_PATH)
    except OSError:
        if temporary is not None:
            with suppress(OSError):
                temporary.unlink(missing_ok=True)


def backoff(attempt: int, max_retries: int, reason: str) -> None:
    delay = min(RETRY_BASE_DELAY * (2**attempt), RETRY_MAX_DELAY) * (0.75 + random.random() * 0.5)
    print(f"  retry {attempt + 1}/{max_retries} after {reason} in {delay:.1f}s", file=sys.stderr)
    time.sleep(delay)


def _rewind_files(files: Any) -> None:
    values = files.values() if isinstance(files, dict) else [v for _, v in files]
    for value in values:
        handle = value[1] if isinstance(value, (tuple, list)) and len(value) > 1 else value
        seek = getattr(handle, "seek", None)
        if callable(seek):
            with suppress(OSError, ValueError):
                seek(0)


def latest_run_pages(client: Any, run_ids: list[str]) -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for run_id in dict.fromkeys(run_ids):
        page = 1
        while True:
            result = client.run_pages(run_id, page=page, limit=100)
            items = result.get("items") or []
            for item in items:
                page_id = str(item.get("sourcePageId") or "")
                previous = latest.get(page_id)
                if page_id and (
                    previous is None
                    or str(item.get("updatedAt") or "") >= str(previous.get("updatedAt") or "")
                ):
                    latest[page_id] = item
            if not items or page * int(result.get("limit") or 100) >= int(result.get("total") or 0):
                break
            page += 1
    return latest


@contextmanager
def client_pool(
    client: Any, size: int, factory: Callable[[AkashaConfig], Any]
) -> Iterator[Callable[..., Any]]:
    extras = [factory(client.config) for _ in range(size - 1)]
    try:
        for extra in extras:
            extra.login()
        idle: queue.Queue[Any] = queue.Queue()
        for worker in (client, *extras):
            idle.put(worker)

        def call(fn: Callable[..., Any], *args: Any) -> Any:
            borrowed = idle.get()
            try:
                return fn(borrowed, *args)
            finally:
                idle.put(borrowed)

        yield call
    finally:
        for extra in extras:
            extra.close()


def unwrap_envelope(body: Any) -> Any:
    if not isinstance(body, dict):
        return body
    if not isinstance(body.get("success"), bool) or not isinstance(body.get("status"), int):
        return body
    if not set(body) <= {"data", "success", "status"}:
        return body
    return body.get("data")


class AkashaError(RuntimeError):
    def __init__(self, method: str, url: str, status: int, body: str) -> None:
        super().__init__(f"{method} {url} -> HTTP {status}: {body[:500]}")
        self.method = method
        self.url = url
        self.status = status
        self.body = body


@dataclass
class Response:
    status: int
    body: Any
    latency_ms: int


class AkashaClient:
    def __init__(self, config: AkashaConfig) -> None:
        self.config = config
        self._client = httpx.Client(
            timeout=httpx.Timeout(config.timeout_seconds),
            follow_redirects=False,
        )
        self._last_request_at = 0.0

    def __enter__(self) -> AkashaClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    def _throttle(self) -> None:
        gap = self.config.request_interval_seconds
        if gap <= 0:
            return
        elapsed = time.monotonic() - self._last_request_at
        if elapsed < gap:
            time.sleep(gap - elapsed)

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: Any | None = None,
        files: Any | None = None,
        data: Any | None = None,
        raise_for_status: bool = True,
        retry: bool = True,
    ) -> Response:
        url = self.config.api(path)
        response, latency_ms = self._request_with_retry(
            method, url, json_body, files, data, retry
        )
        if response.status_code == 401 and path.strip("/") != "auth/login":
            rejected = self._client.cookies.get(AUTH_TOKEN_COOKIE)
            self._refresh_auth(rejected)
            if files:
                _rewind_files(files)
            response, latency_ms = self._request_with_retry(
                method, url, json_body, files, data, retry
            )

        try:
            body: Any = response.json() if response.content else None
        except ValueError:
            body = response.text
        body = unwrap_envelope(body)

        if raise_for_status and not response.is_success:
            raise AkashaError(method, url, response.status_code, response.text)
        return Response(status=response.status_code, body=body, latency_ms=latency_ms)

    def _request_with_retry(
        self,
        method: str,
        url: str,
        json_body: Any | None,
        files: Any | None,
        data: Any | None,
        retry: bool = True,
    ) -> tuple[httpx.Response, int]:
        max_retries = MAX_RETRIES if retry else 0
        attempt = 0
        while True:
            if files and attempt:
                _rewind_files(files)
            self._throttle()
            started = time.perf_counter()
            try:
                response = self._client.request(
                    method, url, json=json_body, files=files, data=data
                )
            except RETRYABLE_EXCEPTIONS as exc:
                if attempt >= max_retries:
                    raise
                reason = type(exc).__name__
            else:
                latency_ms = int((time.perf_counter() - started) * 1000)
                if response.status_code not in RETRYABLE_STATUSES or attempt >= max_retries:
                    return response, latency_ms
                reason = f"HTTP {response.status_code}"
            finally:
                self._last_request_at = time.monotonic()
            backoff(attempt, max_retries, f"{reason} on {method} {url}")
            attempt += 1

    def post(self, path: str, json_body: Any | None = None, **kwargs: Any) -> Any:
        return self.request("POST", path, json_body=json_body, **kwargs).body

    def get(self, path: str, **kwargs: Any) -> Any:
        return self.request("GET", path, **kwargs).body

    def login(self) -> None:
        self.config.require_credentials()
        key = _auth_cache_key(self.config)
        with _AUTH_LOCK:
            token = _AUTH_TOKENS.get(key)
            if not _usable_auth_token(token):
                token = _read_auth_cache().get(key)
            if _usable_auth_token(token):
                _AUTH_TOKENS[key] = token
                self._client.cookies.set(AUTH_TOKEN_COOKIE, token)
                return
            self._perform_login(key)

    def _perform_login(self, key: str) -> None:
        self._client.cookies.delete(AUTH_TOKEN_COOKIE)
        self.request(
            "POST",
            "auth/login",
            json_body={"email": self.config.email, "password": self.config.password},
        )
        token = self._client.cookies.get(AUTH_TOKEN_COOKIE)
        if not token:
            raise AkashaError(
                "POST", self.config.api("auth/login"), 200,
                "login returned success but set no authToken cookie; "
                "MFA may be enabled for this account",
            )
        _AUTH_TOKENS[key] = token
        cached = _read_auth_cache()
        cached[key] = token
        _write_auth_cache(cached)

    def _refresh_auth(self, rejected: str | None) -> None:
        key = _auth_cache_key(self.config)
        with _AUTH_LOCK:
            current = _AUTH_TOKENS.get(key)
            if current != rejected and _usable_auth_token(current):
                self._client.cookies.set(AUTH_TOKEN_COOKIE, current)
                return
            _AUTH_TOKENS.pop(key, None)
            self._perform_login(key)

    def current_user(self) -> dict[str, Any]:
        return self.post("users/me")

    def create_space(self, name: str, slug: str, description: str = "") -> dict[str, Any]:
        return self.post(
            "spaces/create",
            {"name": name, "slug": slug, "description": description},
            retry=False,
        )

    def import_page_text(
        self, filename: str, markdown: str, space_id: str
    ) -> dict[str, Any]:
        return self.post(
            "pages/import",
            files={"file": (filename, markdown.encode("utf-8"), "text/markdown")},
            data={"spaceId": space_id},
            retry=False,
        )

    def compile_spaces(self, space_ids: list[str]) -> dict[str, Any]:
        return self.post("llm-wiki/admin/compile-spaces", {"spaceIds": space_ids})

    def rebuild_space_embeddings(
        self, space_ids: list[str], *, embedding_concurrency: int | None = None
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"action": "rebuild_embeddings", "spaceIds": space_ids}
        if embedding_concurrency is not None:
            payload["embeddingConcurrency"] = embedding_concurrency
        return self.post("llm-wiki/admin/space-action", payload, retry=False)

    def run_pages(
        self, run_id: str, *, page: int = 1, limit: int = 100
    ) -> dict[str, Any]:
        return self.get(
            f"llm-wiki/admin/diagnostics/runs/{run_id}/pages?page={page}&limit={limit}"
        )

    def retryable_run_page_ids(self, run_ids: list[str]) -> list[str]:
        return [
            page_id
            for page_id, item in latest_run_pages(self, run_ids).items()
            if item.get("status") == "failed"
            or item.get("mergeStatus") == "failed"
            or (
                item.get("status") == "skipped"
                and item.get("errorCode") == "manual_cancelled"
            )
        ]

    def retry_pages(self, page_ids: list[str]) -> dict[str, Any]:
        unique = list(dict.fromkeys(page_ids))
        if len(unique) > 100:
            raise ValueError("retry_pages 每次最多 100 篇；调用方必须串行分批")
        return self.post("llm-wiki/admin/retry-pages", {"pageIds": unique})

    def cancel_compile_run(self, run_id: str, reason: str) -> dict[str, Any]:
        return self.post(
            f"llm-wiki/admin/compilation-runs/{run_id}/cancel",
            {"reason": reason},
        )

    def quality_diagnostics(self, space_ids: list[str]) -> dict[str, Any]:
        return self.post("llm-wiki/admin/diagnostics/quality", {"spaceIds": space_ids})

    def run_diagnostics(self, space_ids: list[str], *, limit: int = 50) -> dict[str, Any]:
        return self.post(
            "llm-wiki/admin/diagnostics/runs", {"spaceIds": space_ids, "limit": limit}
        )

    def page_log(self, space_ids: list[str], *, limit: int = 100) -> dict[str, Any]:
        return self.post(
            "llm-wiki/admin/diagnostics/page-log",
            {"spaceIds": space_ids, "limit": limit},
        )

    def get_model_configs(self) -> dict[str, Any]:
        return self.get("llm-wiki/admin/model-configs")

    def put_model_config(self, feature: str, payload: dict[str, Any]) -> Any:
        return self.request(
            "PUT", f"llm-wiki/admin/model-configs/{feature}", json_body=payload
        ).body

    def query(
        self,
        query: str,
        space_ids: list[str],
        *,
        query_type: str = "user",
        chat_context: list[str] | None = None,
    ) -> Response:
        payload: dict[str, Any] = {"query": query, "spaceIds": space_ids, "type": query_type}
        if chat_context:
            payload["chatContext"] = chat_context
        return self.request("POST", "llm-wiki/query", json_body=payload, raise_for_status=False)
