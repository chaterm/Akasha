from __future__ import annotations

import random
import re
from typing import Any

from ..datasets import LocalAdapter, dataset_dir, is_local_name, load_corpus
from ..io_utils import load_json, write_json
from ..judge.client import complete_many, parse_json_object
from ..judge.providers import resolve_provider
from ..task import TaskContext

DEFAULT_CONCURRENCY = 4
MAX_CONCURRENCY = 16
MAX_DOC_CHARS = 12000
MAX_TOKENS = 8192

SYSTEM = (
    "You write evaluation questions for a retrieval-augmented QA benchmark. "
    "Reply with a single JSON object only."
)

FIXED = "Write up to {count} question-answer pairs about the most important facts."
ADAPTIVE = (
    "Write as many question-answer pairs as the document deserves: cover every fact worth "
    "asking about, one pair per fact, skip trivia and do not repeat the same fact."
)

USER = """Read the document below. {task}

Rules:
- Each question must be answerable from this document alone and must not mention "the document" or "the text".
- Answers are short and factual.
- Every pair cites evidence: one or more quotes copied verbatim from the document that support the answer.
- Write questions and answers in the same language as the document.

Reply as JSON: {{"items": [{{"question": "...", "answer": "...", "evidence": ["verbatim quote", ...]}}]}}

Document title: {title}
<document>
{text}
</document>"""

_SPACES = re.compile(r"\s+")


def _squash(text: str) -> str:
    return _SPACES.sub(" ", text).strip()


def prompt(doc: dict[str, Any], per_doc: int | None) -> tuple[str, str]:
    task = FIXED.format(count=per_doc) if per_doc else ADAPTIVE
    return SYSTEM, USER.format(task=task, title=doc["title"], text=doc["text"][:MAX_DOC_CHARS])


def parse_items(content: str, doc: dict[str, Any]) -> tuple[list[dict[str, Any]], int]:
    items = parse_json_object(content).get("items")
    if not isinstance(items, list):
        raise ValueError("模型输出缺少 items 数组")

    source = _squash(doc["text"])
    rows: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        question = str(item.get("question") or "").strip()
        answer = str(item.get("answer") or "").strip()
        quotes = [_squash(q) for q in item.get("evidence") or [] if isinstance(q, str) and _squash(q)]
        if question and answer and quotes and all(q in source for q in quotes):
            rows.append(
                {
                    "id": f"{doc['doc_id']}-q{len(rows) + 1}",
                    "question": question,
                    "answer": answer,
                    "evidence": [{"doc_id": doc["doc_id"], "quote": q} for q in quotes],
                }
            )
    return rows, len(items) - len(rows)


def run(ctx: TaskContext) -> None:
    params = ctx.params
    name = str(params.get("dataset") or "")
    if not is_local_name(name):
        raise ValueError(f"{name!r} 不是导入的本地数据集")
    per_doc = int(params["per_doc"]) if params.get("per_doc") else None
    doc_limit = int(params.get("doc_limit") or 0)
    concurrency = int(params.get("concurrency") or DEFAULT_CONCURRENCY)
    if per_doc is not None and per_doc < 1:
        raise ValueError("每篇问题数必须大于 0")
    if not 1 <= concurrency <= MAX_CONCURRENCY:
        raise ValueError(f"并发必须在 1 到 {MAX_CONCURRENCY} 之间")

    adapter = LocalAdapter(name)
    corpus_path = dataset_dir() / adapter.corpus_filename
    qa_path = dataset_dir() / adapter.qa_filename
    if not corpus_path.is_file():
        raise FileNotFoundError(f"{name}: 缺少 {corpus_path.name}，请先导入空间")
    provider = resolve_provider(ctx.db, params.get("provider_id"), "generation")

    if not params.get("started"):
        qa_path.unlink(missing_ok=True)
        ctx.freeze(started=True)
    rows: list[dict[str, Any]] = load_json(qa_path) if qa_path.is_file() else []
    done = {e["doc_id"] for row in rows for e in row["evidence"]}

    docs = sorted((d.model_dump() for d in load_corpus(name, corpus_path).docs), key=lambda d: d["doc_id"])
    if doc_limit and doc_limit < len(docs):
        docs = sorted(random.Random(params.get("seed") or 0).sample(docs, doc_limit), key=lambda d: d["doc_id"])
    todo = [d for d in docs if d["doc_id"] not in done]
    if done:
        ctx.log(f"续跑：已完成 {len(docs) - len(todo)} 篇，待生成 {len(todo)} 篇")
    ctx.log(f"生成模型 {provider.model}，每篇{f'最多 {per_doc} 条' if per_doc else '自适应'}")

    dropped = failed = 0
    batch = concurrency * 2
    for offset in range(0, len(todo), batch):
        ctx.checkpoint()
        ctx.progress(len(docs) - len(todo) + offset, len(docs), f"生成 {offset}/{len(todo)}")
        chunk = todo[offset : offset + batch]
        prompts = [prompt(d, per_doc) for d in chunk]
        replies = complete_many(provider, prompts, concurrency, max_tokens=MAX_TOKENS)
        for doc, reply in zip(chunk, replies):
            try:
                if reply.content is None:
                    raise ValueError(f"{reply.failure_kind}: {(reply.raw or '')[:200]}")
                items, lost = parse_items(reply.content, doc)
            except ValueError as exc:
                failed += 1
                ctx.log(f"{doc['doc_id']}: {exc}", "warn")
                continue
            rows.extend(items[:per_doc])
            dropped += lost
        write_json(qa_path, rows)

    if not rows:
        raise RuntimeError("没有生成任何有效样本")
    ctx.progress(len(docs), len(docs), "生成完成")
    ctx.log(
        f"{name}: 共 {len(rows)} 条样本，丢弃证据不符 {dropped} 条，失败 {failed} 篇。"
        "下一步去归一化页归一化。"
    )
