from __future__ import annotations

import re
import string
from collections import Counter
from collections.abc import Sequence

_ARTICLES = re.compile(r"\b(a|an|the)\b", re.UNICODE)
_WHITESPACE = re.compile(r"\s+")
_PUNCT_TABLE = str.maketrans("", "", string.punctuation)

GENERAL_DISCLAIMERS = (
    "> 以下回答基于通用模型知识，未引用企业知识库。",
    (
        "> This answer uses general model knowledge and does not cite the "
        "workspace knowledge base."
    ),
)


def strip_general_disclaimer(text: str) -> str:
    stripped = text.lstrip()
    for disclaimer in GENERAL_DISCLAIMERS:
        if stripped.startswith(disclaimer):
            return stripped[len(disclaimer) :].lstrip()
    return text


def normalize_answer(text: str) -> str:
    lowered = text.lower()
    without_punct = lowered.translate(_PUNCT_TABLE)
    without_articles = _ARTICLES.sub(" ", without_punct)
    return _WHITESPACE.sub(" ", without_articles).strip()


def tokenize(text: str) -> list[str]:
    return normalize_answer(text).split()


def exact_match(prediction: str, reference: str) -> float:
    return float(normalize_answer(prediction) == normalize_answer(reference))


def token_f1(prediction: str, reference: str) -> float:
    pred_tokens = tokenize(prediction)
    ref_tokens = tokenize(reference)

    if not pred_tokens or not ref_tokens:
        return float(pred_tokens == ref_tokens)

    overlap = Counter(pred_tokens) & Counter(ref_tokens)
    shared = sum(overlap.values())
    if shared == 0:
        return 0.0
    precision = shared / len(pred_tokens)
    recall = shared / len(ref_tokens)
    return 2 * precision * recall / (precision + recall)


def score_answer(prediction: str, references: Sequence[str]) -> dict[str, float]:
    if not references:
        raise ValueError("score_answer requires at least one reference")
    prediction = strip_general_disclaimer(prediction or "")
    return {
        "em": max(exact_match(prediction, r) for r in references),
        "f1": max(token_f1(prediction, r) for r in references),
    }


def answer_mode_distribution(modes: Sequence[str | None]) -> dict[str, float]:
    total = len(modes)
    if not total:
        return {}
    counts = Counter(mode or "missing" for mode in modes)
    return {mode: count / total for mode, count in sorted(counts.items())}
