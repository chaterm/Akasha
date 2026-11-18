from __future__ import annotations

import json
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
        return (self.api_key or "").strip()

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
        return self.systemone(
            {"input": user},
            {"response": {"type": "noul", "instructions": system}},
            max_tokens=max_tokens,
        )

    def systemone(
        self,
        state: dict[str, Any],
        questions: dict[str, Any],
        *,
        max_tokens: int = MAX_TOKENS,
    ) -> JudgeReply:
        started = time.monotonic()
        reply = self._complete(state, questions, max_tokens=max_tokens)
        reply.latency_ms = int((time.monotonic() - started) * 1000)
        return reply

    def _complete(
        self,
        state: dict[str, Any],
        questions: dict[str, Any],
        *,
        max_tokens: int,
    ) -> JudgeReply:
        base = self.provider.base_url.rstrip("/")
        # JEV providers store the OpenAI-style base (usually ending in /v1).
        # The protocol endpoint is appended directly to that base.
        url = base if base.endswith("/systemone") else f"{base}/systemone"
        payload = {
            "model": self.provider.model,
            "state": state,
            "questions": questions,
        }
        headers = {"Content-Type": "application/json"}
        if key := self.provider.resolve_key():
            headers["Authorization"] = f"Bearer {key}"

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
                content = _systemone_content(body)
                if content is None:
                    return JudgeReply(None, FAILURE_PARSE, response.text[:500], 200)
            except (ValueError, KeyError, IndexError, TypeError):
                return JudgeReply(None, FAILURE_PARSE, response.text[:500], response.status_code)

            return JudgeReply(content, None, response.text[:2000], 200)


def _systemone_content(body: Any) -> str | None:
    if not isinstance(body, dict) or body.get("refusal"):
        return None
    choices = body.get("choices")
    if isinstance(choices, list) and choices:
        message = choices[0].get("message") or {}
        legacy = message.get("content")
        return legacy if isinstance(legacy, str) and legacy else None
    value: Any = body.get("result")
    if value is None:
        value = body.get("output")
    answers = body.get("answers")
    if isinstance(answers, dict):
        # Keep all named answers. A single systemone request may score several
        # metrics, and callers need the answer name to associate each score.
        return json.dumps(body, ensure_ascii=False)
    if value is None:
        value = body.get("response")
    if value is None and any(key in body for key in ("root_cause", "score", "verdict")):
        value = body
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def openai_complete_many(
    provider: JudgeProvider,
    prompts: list[tuple[str, str]],
    concurrency: int,
    *,
    max_tokens: int = MAX_TOKENS,
    register_canceller: Any = None,
) -> list[JudgeReply]:
    """Call a generation endpoint using the OpenAI-compatible chat protocol.

    Generation is intentionally separate from JEV. Evaluation and attribution
    use ``systemone_many`` below, while sample generation and answer-relevancy
    question generation still need free-form text output.
    """

    def complete(prompt: tuple[str, str]) -> JudgeReply:
        system, user = prompt
        started = time.monotonic()
        url = f"{provider.base_url.rstrip('/')}/chat/completions"
        headers = {"Content-Type": "application/json"}
        if key := provider.resolve_key():
            headers["Authorization"] = f"Bearer {key}"
        payload = {
            "model": provider.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": TEMPERATURE,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
        }
        client = httpx.Client(timeout=httpx.Timeout(provider.timeout_seconds))
        unregister = register_canceller(client.close) if register_canceller else lambda: None
        attempt = 0
        try:
            while True:
                try:
                    response = client.post(
                        url,
                        json=payload,
                        headers=headers,
                    )
                except httpx.RequestError as exc:
                    if attempt >= MAX_RETRIES:
                        return JudgeReply(None, FAILURE_TIMEOUT, f"{type(exc).__name__}: {exc}", None)
                    backoff(attempt, MAX_RETRIES, f"generation {type(exc).__name__}")
                    attempt += 1
                    continue
                if response.status_code in RETRYABLE_STATUSES and attempt < MAX_RETRIES:
                    backoff(attempt, MAX_RETRIES, f"generation HTTP {response.status_code}")
                    attempt += 1
                    continue
                if response.status_code == 429:
                    return JudgeReply(None, FAILURE_RATE_LIMIT, response.text[:500], 429)
                if not response.is_success:
                    return JudgeReply(None, FAILURE_PARSE, response.text[:500], response.status_code)
                try:
                    body = response.json()
                    content = (body.get("choices") or [{}])[0].get("message", {}).get("content")
                    if not isinstance(content, str) or not content:
                        return JudgeReply(None, FAILURE_PARSE, response.text[:500], response.status_code)
                except (ValueError, TypeError, KeyError, IndexError):
                    return JudgeReply(None, FAILURE_PARSE, response.text[:500], response.status_code)
                reply = JudgeReply(content, None, response.text[:2000], response.status_code)
                reply.latency_ms = int((time.monotonic() - started) * 1000)
                return reply
        finally:
            unregister()
            client.close()

    if concurrency <= 1 or len(prompts) <= 1:
        return [complete(prompt) for prompt in prompts]
    with ThreadPoolExecutor(max_workers=min(concurrency, len(prompts))) as executor:
        return list(executor.map(complete, prompts))


# ``complete_many`` was the historical free-form generation helper. Keep the
# name for integrations while routing it to the explicit OpenAI-compatible
# implementation. JEV callers use ``systemone_many``.
complete_many = openai_complete_many


def systemone_many(
    provider: JudgeProvider,
    requests: list[tuple[dict[str, Any], dict[str, Any]]],
    concurrency: int,
    *,
    max_tokens: int = MAX_TOKENS,
    register_canceller: Any = None,
) -> list[JudgeReply]:
    """Submit independent JEV systemone requests with bounded concurrency."""

    def request(item: tuple[dict[str, Any], dict[str, Any]]) -> JudgeReply:
        state, questions = item
        client = JudgeClient(provider)
        unregister = register_canceller(client.close) if register_canceller else lambda: None
        try:
            return client.systemone(state, questions, max_tokens=max_tokens)
        finally:
            unregister()
            client.close()

    if concurrency <= 1 or len(requests) <= 1:
        return [request(item) for item in requests]
    with ThreadPoolExecutor(max_workers=min(concurrency, len(requests))) as executor:
        return list(executor.map(request, requests))


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
