from __future__ import annotations

import re
from typing import Any

STOPWORDS = frozenset(
    """a an the of and or but in on at to for with by from as is are was were be been
    being have has had do does did will would could should may might must can this that
    these those it its his her their our your my he she they we you i not no nor so than
    then there here when where which who whom whose what how why all any both each few
    more most other some such only own same too very s t just don now""".split()
)

_WORD = re.compile(r"[A-Za-z][A-Za-z0-9'\-]*")


def content_words(text: str) -> list[str]:
    return [w.lower() for w in _WORD.findall(text or "") if w.lower() not in STOPWORDS]


def diff_vocabulary(source_text: str, compiled_text: str) -> dict[str, Any]:
    source_words = content_words(source_text)
    compiled_words = content_words(compiled_text)
    source_set, compiled_set = set(source_words), set(compiled_words)

    source_chars = len(source_text or "")
    compiled_chars = len(compiled_text or "")
    return {
        "source_chars": source_chars,
        "compiled_chars": compiled_chars,
        "expansion_ratio": (compiled_chars / source_chars) if source_chars else None,
        "source_word_count": len(source_words),
        "compiled_word_count": len(compiled_words),
        "dropped": sorted(source_set - compiled_set),
        "added": sorted(compiled_set - source_set),
        "kept": len(source_set & compiled_set),
        "retention": (len(source_set & compiled_set) / len(source_set)) if source_set else None,
    }


def question_terms_lost(question: str, diff: dict[str, Any]) -> list[str]:
    dropped = set(diff.get("dropped") or [])
    return sorted({w for w in content_words(question) if w in dropped})


def build(
    lineage: dict[str, Any], question: str = "", *, top_terms: int = 40
) -> dict[str, Any]:
    source_text = "\n\n".join(c["text"] or "" for c in lineage.get("source_chunks") or [])
    compiled_text = "\n\n".join(
        part
        for part in (
            *(a.get("title") or "" for a in lineage.get("artifacts") or []),
            *(c["text"] or "" for c in lineage.get("chunks") or []),
        )
        if part
    )
    diff = diff_vocabulary(source_text, compiled_text)
    lost = question_terms_lost(question, diff) if question else []

    return {
        "source_page_id": lineage.get("source_page_id"),
        "source": {
            "text": source_text,
            "chunk_count": len(lineage.get("source_chunks") or []),
            "note": "knowledge_source_chunks — 原文，**不参与召回**",
        },
        "compiled": {
            "text": compiled_text,
            "chunk_count": len(lineage.get("chunks") or []),
            "artifact_count": len(lineage.get("artifacts") or []),
            "note": "knowledge_chunks — 编译产物，**这才是被检索的文本**",
        },
        "diff": {
            **diff,

            "dropped": diff["dropped"][:top_terms],
            "dropped_total": len(diff["dropped"]),
            "added": diff["added"][:top_terms],
            "added_total": len(diff["added"]),
        },
        "question_terms_lost": lost,
        "verdict": (
            "编译产物里缺少问题中的实词，词法召回在这条样本上必然断"
            if lost
            else "问题中的实词都还在编译产物里"
        ),
    }
