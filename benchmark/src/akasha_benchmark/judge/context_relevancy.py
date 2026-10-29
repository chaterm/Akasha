from __future__ import annotations

from typing import Any

SYSTEM = """You judge which retrieved CONTEXT passages are useful for answering
a QUESTION.

For each numbered passage decide:
- "useful": it contains information that helps answer the question, even
  partially.
- "useless": it is off-topic, or only shares surface keywords with the question.

Judge each passage on its own. Do not assume a passage is useful just because it
was retrieved.

Return JSON only, no prose, in exactly this shape:
{"passages": [{"index": <number>, "verdict": "useful|useless"}]}

Include exactly one entry per passage you were given."""

USER_TEMPLATE = """QUESTION:
{question}

CONTEXT:
{context}"""

MAX_SNIPPET_CHARS = 800
MAX_SNIPPETS = 20
VERDICTS = ("useful", "useless")


def build_context(response: dict[str, Any]) -> tuple[str, int]:
    parts: list[str] = []
    for snippet in (response.get("snippets") or [])[:MAX_SNIPPETS]:
        title = snippet.get("title") or ""
        text = (snippet.get("text") or "")[:MAX_SNIPPET_CHARS]
        if text:
            parts.append(f"[{len(parts) + 1}] {title}\n{text}")
    return "\n\n".join(parts), len(parts)


def parse_verdict(
    payload: dict[str, Any], expected: int
) -> tuple[float | None, dict[str, Any]]:
    passages = payload.get("passages")
    if not isinstance(passages, list):
        raise ValueError(f"expected a list under 'passages', got {type(passages).__name__}")
    if len(passages) != expected:
        raise ValueError(f"expected {expected} verdicts, got {len(passages)}")

    useful = 0
    cleaned: list[dict[str, Any]] = []
    for entry in passages:
        if not isinstance(entry, dict):
            raise ValueError(f"passage entries must be objects, got {type(entry).__name__}")
        verdict = entry.get("verdict")
        if verdict not in VERDICTS:
            raise ValueError(f"unknown verdict {verdict!r}; expected one of {list(VERDICTS)}")
        useful += verdict == "useful"
        cleaned.append({"index": entry.get("index"), "verdict": verdict})

    return useful / expected, {
        "passages": cleaned,
        "passage_count": expected,
        "useful": useful,
    }


def build_prompt(question: str, response: dict[str, Any]) -> tuple[str, str, int] | None:
    if not question.strip():
        return None
    context, count = build_context(response)
    if not count:
        return None
    return SYSTEM, USER_TEMPLATE.format(question=question, context=context), count
