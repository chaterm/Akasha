from __future__ import annotations

import json
import queue
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

import httpx

from ..akasha_client import MAX_RETRIES, RETRYABLE_STATUSES, backoff

FAILURE_RATE_LIMIT = "rate_limit"
FAILURE_TIMEOUT = "timeout"
FAILURE_PARSE = "parse_error"
FAILURE_REFUSAL = "refusal"


TEMPERATURE = 0.0
MAX_TOKENS = 1024
REPORT_MAX_TOKENS = 4096


class JudgeConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class JudgeProvider:
    base_url: str
    model: str
    api_key: str = ""
    timeout_seconds: float = 120.0
    provider_id: int | None = None

    def resolve_key(self) -> str:
        key = (self.api_key or "").strip()
        if not key:
            raise JudgeConfigError("模型端点没有 api key，请在配置页填写。")
        return key

    def redacted(self) -> dict[str, Any]:
        return {
            "base_url": self.base_url,
            "model": self.model,
            "api_key_set": bool((self.api_key or "").strip()),
        }


@dataclass
class JudgeReply:
    content: str | None
    failure_kind: str | None
    raw: str | None
    status: int | None

    latency_ms: int | None = None


class JudgeClient:
    def __init__(self, provider: JudgeProvider, client: httpx.Client | None = None) -> None:
        self.provider = provider
        self._client = client or httpx.Client(
            timeout=httpx.Timeout(provider.timeout_seconds), follow_redirects=False
        )

    def __enter__(self) -> JudgeClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    def complete(self, system: str, user: str, *, max_tokens: int = MAX_TOKENS) -> JudgeReply:
        started = time.monotonic()
        reply = self._complete(system, user, max_tokens=max_tokens)
        reply.latency_ms = int((time.monotonic() - started) * 1000)
        return reply

    def _complete(self, system: str, user: str, *, max_tokens: int) -> JudgeReply:
        url = f"{self.provider.base_url.rstrip('/')}/chat/completions"
        payload = {
            "model": self.provider.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": TEMPERATURE,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
        }
        headers = {"Authorization": f"Bearer {self.provider.resolve_key()}"}

        attempt = 0
        while True:
            try:
                response = self._client.post(url, json=payload, headers=headers)
            except httpx.RequestError as exc:
                if attempt >= MAX_RETRIES:
                    return JudgeReply(None, FAILURE_TIMEOUT, f"{type(exc).__name__}: {exc}", None)
                backoff(attempt, MAX_RETRIES, f"judge {type(exc).__name__}")
                attempt += 1
                continue

            if response.status_code in RETRYABLE_STATUSES and attempt < MAX_RETRIES:
                backoff(attempt, MAX_RETRIES, f"judge HTTP {response.status_code}")
                attempt += 1
                continue

            if response.status_code == 429:
                return JudgeReply(None, FAILURE_RATE_LIMIT, response.text[:500], 429)
            if not response.is_success:
                return JudgeReply(None, FAILURE_PARSE, response.text[:500], response.status_code)

            try:
                body = response.json()
                choice = (body.get("choices") or [{}])[0]
                message = choice.get("message") or {}
                content = message.get("content")

                if choice.get("finish_reason") == "content_filter" or message.get("refusal"):
                    return JudgeReply(None, FAILURE_REFUSAL, response.text[:500], 200)
                if not content:
                    return JudgeReply(None, FAILURE_PARSE, response.text[:500], 200)
            except (ValueError, KeyError, IndexError, TypeError):
                return JudgeReply(None, FAILURE_PARSE, response.text[:500], response.status_code)

            return JudgeReply(content, None, response.text[:2000], 200)


def complete_many(
    provider: JudgeProvider,
    prompts: list[tuple[str, str]],
    concurrency: int,
    *,
    max_tokens: int = MAX_TOKENS,
) -> list[JudgeReply]:
    if concurrency <= 1 or len(prompts) <= 1:
        with JudgeClient(provider) as client:
            return [
                client.complete(system, user, max_tokens=max_tokens) for system, user in prompts
            ]

    workers = min(concurrency, len(prompts))
    clients = [JudgeClient(provider) for _ in range(workers)]
    try:
        pool: queue.Queue[JudgeClient] = queue.Queue()
        for client in clients:
            pool.put(client)

        def task(prompt: tuple[str, str]) -> JudgeReply:
            borrowed = pool.get()
            try:
                return borrowed.complete(*prompt, max_tokens=max_tokens)
            finally:
                pool.put(borrowed)

        with ThreadPoolExecutor(max_workers=workers) as executor:
            return list(executor.map(task, prompts))
    finally:
        for client in clients:
            client.close()


def parse_json_object(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        lines = [line for line in text.splitlines() if not line.strip().startswith("```")]
        text = "\n".join(lines).strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise ValueError(f"no JSON object in judge output: {content[:200]!r}") from None
        parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError(f"judge returned {type(parsed).__name__}, expected an object")
    return parsed
