from __future__ import annotations

from collections import Counter
from typing import Any

SYSTEM = """You are a strict evaluator of grounding in retrieval-augmented answers.

You will receive a QUESTION, the CONTEXT that was retrieved, and an ANSWER.

Do this:
1. Split the ANSWER into atomic factual claims. A claim is one verifiable
   assertion. Ignore hedges, restatements of the question, and pure connectives.
2. For each claim decide whether the CONTEXT supports it:
   - "supported": the context states or directly entails the claim.
   - "unsupported": the context does not contain it. This includes claims that
     are true in the world but absent from the context.
   - "contradicted": the context states the opposite.
3. Judge only against the CONTEXT. Your own knowledge does not count as support.

Return JSON only, no prose, in exactly this shape:
{"claims": [{"claim": "<text>", "verdict": "supported|unsupported|contradicted",
             "evidence": "<short quote from context, or empty>"}]}

If the ANSWER contains no factual claims (a refusal, or "I could not find this"),
return {"claims": []}."""

USER_TEMPLATE = """QUESTION:
{question}

CONTEXT:
{context}

ANSWER:
{answer}"""


MAX_SNIPPET_CHARS = 1200
MAX_SNIPPETS = 20
VERDICTS = ("supported", "unsupported", "contradicted")


def build_context(response: dict[str, Any]) -> str:
    parts: list[str] = []
    for snippet in (response.get("snippets") or [])[:MAX_SNIPPETS]:
        title = snippet.get("title") or ""
        text = (snippet.get("text") or "")[:MAX_SNIPPET_CHARS]
        if text:
            parts.append(f"[{title}]\n{text}")
    return "\n\n".join(parts)


def score_claims(claims: list[dict[str, Any]]) -> float | None:
    if not claims:
        return None
    supported = sum(1 for c in claims if c.get("verdict") == "supported")
    return supported / len(claims)


def parse_verdict(payload: dict[str, Any]) -> tuple[float | None, dict[str, Any]]:
    claims = payload.get("claims")
    if not isinstance(claims, list):
        raise ValueError(f"expected a list under 'claims', got {type(claims).__name__}")

    cleaned: list[dict[str, Any]] = []
    for claim in claims:
        if not isinstance(claim, dict):
            raise ValueError(f"claim entries must be objects, got {type(claim).__name__}")
        verdict = claim.get("verdict")
        if verdict not in VERDICTS:
            raise ValueError(f"unknown verdict {verdict!r}; expected one of {sorted(VERDICTS)}")
        cleaned.append(
            {
                "claim": str(claim.get("claim") or "")[:500],
                "verdict": verdict,
                "evidence": str(claim.get("evidence") or "")[:500],
            }
        )

    counts = Counter(c["verdict"] for c in cleaned)
    return score_claims(cleaned), {
        "claims": cleaned,
        "claim_count": len(cleaned),
        **{verdict: counts[verdict] for verdict in VERDICTS},
    }


def build_prompt(question: str, answer: str, response: dict[str, Any]) -> tuple[str, str] | None:
    context = build_context(response)
    if not context:
        return None
    return SYSTEM, USER_TEMPLATE.format(question=question, context=context, answer=answer)
