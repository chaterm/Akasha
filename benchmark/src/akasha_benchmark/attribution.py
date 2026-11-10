from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter
from typing import Any

from .metrics import qa, registry
from .store import query_store

CAUSE_ANSWER_CORRECT = "answer_correct"
CAUSE_ANSWER_INCORRECT = "answer_incorrect"
CAUSE_GENERATION_IGNORED_RETRIEVAL = "generation_ignored_retrieval"
CAUSE_GENERATION_FALLBACK = "generation_fallback"
CAUSE_GENERATION_EMPTY = "generation_empty"
CAUSE_RETRIEVAL_EVIDENCE_INCOMPLETE = "retrieval_evidence_incomplete"
CAUSE_COMPILED_ANSWER_MISSING = "compiled_answer_missing"
CAUSE_COMPILED_AWAY = "compiled_away"
CAUSE_CITATION_DROPPED = "citation_dropped"
CAUSE_RETRIEVAL_MISS = "retrieval_miss"
CAUSE_GRAPH_EDGE_MISSING = "graph_edge_missing"
CAUSE_UNKNOWN = "unknown"

EVIDENCE_CHAIN_SUPPORTED_OVERLAP = 0.8
EVIDENCE_CHAIN_PARTIAL_OVERLAP = 0.35
COMPILED_ANSWER_TOKEN_RECALL = 0.5
REFERENCE_ANSWER_TOKEN_RECALL = 0.5
REFERENCE_STOPWORDS = {"a", "an", "and", "in", "of", "on", "the", "to"}
SMART_QUOTES = str.maketrans(
    "‘’‚‛′“”„‟″",
    "'''''" + '"""""',
)
TITLE_ABBREVIATIONS = {
    "gen": "general",
    "lt": "lieutenant",
    "col": "colonel",
    "sgt": "sergeant",
    "capt": "captain",
    "pres": "president",
    "gov": "governor",
    "sen": "senator",
    "rep": "representative",
    "mt": "mount",
    "st": "saint",
}


def _normalized_tokens(text: str) -> list[str]:
    normalized = unicodedata.normalize("NFKC", text or "").translate(SMART_QUOTES)
    normalized = re.sub(r"'s\b", "", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"(?<=s)'(?=\W|$)", "", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"[-–—_*`]+", " ", normalized)
    return [TITLE_ABBREVIATIONS.get(token, token) for token in qa.tokenize(normalized)]


def _contains_tokens(haystack: list[str], needle: list[str]) -> bool:
    width = len(needle)
    return bool(
        width
        and any(
            haystack[index : index + width] == needle
            for index in range(len(haystack) - width + 1)
        )
    )


def _token_recall(reference: str, context_tokens: list[str]) -> float:
    reference_tokens = set(_normalized_tokens(reference))
    if not reference_tokens:
        return 0.0
    return len(reference_tokens & set(context_tokens)) / len(reference_tokens)


def _response_evidence(response: dict[str, Any] | None) -> list[dict[str, str]]:
    if not isinstance(response, dict):
        return []
    rows: list[dict[str, str]] = []
    for snippet in response.get("snippets") or []:
        if not isinstance(snippet, dict):
            continue
        rows.append({
            "source_type": "context",
            "title": str(snippet.get("title") or ""),
            "text": str(snippet.get("text") or ""),
        })
        for window in snippet.get("sourceWindows") or []:
            if isinstance(window, dict):
                rows.append({
                    "source_type": "source_window",
                    "title": str(window.get("title") or snippet.get("title") or ""),
                    "text": str(window.get("text") or ""),
                })
    return [row for row in rows if row["title"] or row["text"]]


def _evidence_tokens(evidence: list[dict[str, str]]) -> list[str]:
    return _normalized_tokens(
        "\n".join(value for row in evidence for value in (row["title"], row["text"]) if value)
    )


def _matching_evidence(
    evidence: list[dict[str, str]], support_text: str, answer: str
) -> list[dict[str, Any]]:
    support_tokens = set(_normalized_tokens(support_text))
    answer_tokens = _normalized_tokens(answer)
    best_by_text: dict[tuple[str, str, str], dict[str, Any]] = {}
    for row in evidence:
        ordered_tokens = _normalized_tokens(f"{row['title']} {row['text']}")
        tokens = set(ordered_tokens)
        if not tokens:
            continue
        support_score = len(tokens & support_tokens) / len(support_tokens) if support_tokens else 0.0
        answer_hit = _contains_tokens(ordered_tokens, answer_tokens)
        if support_score >= EVIDENCE_CHAIN_PARTIAL_OVERLAP or answer_hit:
            scored = {
                **row,
                "support_overlap": round(support_score, 6),
                "answer_match": answer_hit,
            }
            key = (
                row["source_type"],
                " ".join(_normalized_tokens(row["title"])),
                " ".join(_normalized_tokens(row["text"])),
            )
            previous = best_by_text.get(key)
            if previous is None or (
                scored["support_overlap"], scored["answer_match"]
            ) > (previous["support_overlap"], previous["answer_match"]):
                best_by_text[key] = scored
    return sorted(
        best_by_text.values(),
        key=lambda row: (row["support_overlap"], row["answer_match"]),
        reverse=True,
    )


def analyze_evidence_chain(
    sample: dict[str, Any], response: dict[str, Any] | None
) -> dict[str, Any]:
    detail = sample.get("detail") or {}
    metadata = detail.get("metadata") or {}
    decomposition = metadata.get("question_decomposition") or []
    if sample.get("dataset") != "musique" or not decomposition:
        return {
            "status": "unavailable",
            "reason": "dataset_has_no_decomposition_supports",
            "steps": [],
        }

    response_evidence = _response_evidence(response)
    context_tokens = _evidence_tokens(response_evidence)
    steps: list[dict[str, Any]] = []
    for position, step in enumerate(decomposition, 1):
        answer = str(step.get("answer") or "")
        support_title = str(step.get("support_title") or "")
        support_text = str(step.get("support_text") or "")
        answer_present = _contains_tokens(context_tokens, _normalized_tokens(answer))
        title_present = _contains_tokens(context_tokens, _normalized_tokens(support_title))
        support_overlap = _token_recall(support_text, context_tokens)
        matched_evidence = _matching_evidence(response_evidence, support_text, answer)

        if answer_present and support_overlap >= EVIDENCE_CHAIN_SUPPORTED_OVERLAP:
            status = "supported"
        elif (
            answer_present
            or title_present
            or support_overlap >= EVIDENCE_CHAIN_PARTIAL_OVERLAP
        ):
            status = "partial"
        else:
            status = "missing"

        steps.append(
            {
                "position": position,
                "question": step.get("question"),
                "answer": answer,
                "support_doc_id": step.get("support_doc_id"),
                "support_title": support_title,
                "status": status,
                "answer_present": answer_present,
                "support_title_present": title_present,
                "support_token_recall": round(support_overlap, 6),
                "claim_retrieved": bool(matched_evidence),
                "retrieved_evidence": matched_evidence,
            }
        )

    counts = Counter(step["status"] for step in steps)
    if counts["missing"]:
        status = "incomplete"
    elif counts["partial"]:
        status = "partial"
    else:
        status = "complete"
    answer_mode = sample.get("answer_mode")
    return {
        "status": status,
        "step_count": len(steps),
        "supported_step_count": counts["supported"],
        "partial_step_count": counts["partial"],
        "missing_step_count": counts["missing"],
        "model_false_negative_candidate": answer_mode == "general" and status == "complete",
        "steps": steps,
        "thresholds": {
            "supported_token_recall": EVIDENCE_CHAIN_SUPPORTED_OVERLAP,
            "partial_token_recall": EVIDENCE_CHAIN_PARTIAL_OVERLAP,
        },
    }


def analyze_compiled_answers(
    sample: dict[str, Any], lineage: list[dict[str, Any]] | None
) -> dict[str, Any]:
    decomposition = ((sample.get("detail") or {}).get("metadata") or {}).get(
        "question_decomposition"
    ) or []
    if sample.get("dataset") != "musique" or not decomposition:
        return {"status": "unavailable", "reason": "no_decomposition", "steps": []}
    if lineage is None:
        return {"status": "unavailable", "reason": "no_lineage", "steps": []}

    lineage_by_doc = {str(row.get("doc_id")): row for row in lineage}
    steps: list[dict[str, Any]] = []
    for position, step in enumerate(decomposition, 1):
        answer = str(step.get("answer") or "")
        doc_id = str(step.get("support_doc_id") or "")
        entry = lineage_by_doc.get(doc_id) or {}
        source_recall = _token_recall(
            answer,
            _normalized_tokens(str(entry.get("source_text") or "")),
        )
        compiled_recall = _token_recall(
            answer,
            _normalized_tokens(str(entry.get("compiled_text") or "")),
        )
        source_present = source_recall >= COMPILED_ANSWER_TOKEN_RECALL
        compiled_present = compiled_recall >= COMPILED_ANSWER_TOKEN_RECALL
        if source_present and compiled_present:
            status = "preserved"
        elif source_present:
            status = "compiled_missing"
        elif compiled_present:
            status = "compiled_only"
        else:
            status = "source_missing"
        steps.append(
            {
                "position": position,
                "question": step.get("question"),
                "answer": answer,
                "support_doc_id": doc_id,
                "support_title": step.get("support_title"),
                "source_answer_present": source_present,
                "compiled_answer_present": compiled_present,
                "source_answer_token_recall": round(source_recall, 6),
                "compiled_answer_token_recall": round(compiled_recall, 6),
                "status": status,
            }
        )

    missing_count = sum(step["status"] == "compiled_missing" for step in steps)
    source_missing_count = sum(step["status"] == "source_missing" for step in steps)
    return {
        "status": "compiled_missing" if missing_count else "preserved",
        "step_count": len(steps),
        "compiled_missing_count": missing_count,
        "source_missing_count": source_missing_count,
        "answer_token_recall_threshold": COMPILED_ANSWER_TOKEN_RECALL,
        "steps": steps,
    }


def _usable_references(references: list[str]) -> list[list[str]]:
    usable: list[list[str]] = []
    for reference in references:
        tokens = _normalized_tokens(reference)
        if not tokens or (len(tokens) == 1 and tokens[0] in REFERENCE_STOPWORDS):
            continue
        usable.append(tokens)
    return usable


def _reference_covered(answer_tokens: list[str], reference_tokens: list[str]) -> bool:
    if not reference_tokens:
        return False
    answer_set = set(answer_tokens)
    hit = sum(1 for t in reference_tokens if t in answer_set)
    return hit / len(reference_tokens) >= REFERENCE_ANSWER_TOKEN_RECALL


def _contains_reference(answer: str, references: list[str]) -> bool:
    answer_tokens = _normalized_tokens(answer)
    return any(
        _reference_covered(answer_tokens, tokens)
        for tokens in _usable_references(references)
    )


def analyze_reference_grounding(
    sample: dict[str, Any], response: dict[str, Any] | None
) -> dict[str, Any]:
    references = [
        str(value) for value in (sample.get("detail") or {}).get("reference_answers") or []
    ]
    evidence = _response_evidence(response)
    usable = _usable_references(references)
    if not usable or not evidence:
        return {"status": "unavailable", "grounded": None}
    context_tokens = _evidence_tokens(evidence)
    matched = [
        " ".join(tokens)
        for tokens in usable
        if _reference_covered(context_tokens, tokens)
    ]
    return {
        "status": "grounded" if matched else "missing",
        "grounded": bool(matched),
        "matched_references": matched,
        "reference_count": len(usable),
    }


def _at_k(metrics: dict[str, float], prefix: str, pick=max) -> float | None:
    keys = [k for k in metrics if k.startswith(prefix)]
    return metrics[pick(keys, key=lambda k: int(k.split("@", 1)[1]))] if keys else None


def classify(
    sample: dict[str, Any],
    lineage: list[dict[str, Any]] | None,
    evidence_chain: dict[str, Any] | None = None,
    query_audit: dict[str, Any] | None = None,
    compiled_answers: dict[str, Any] | None = None,
    reference_grounding: dict[str, Any] | None = None,
) -> dict[str, Any]:
    detail = sample.get("detail") or {}
    metrics: dict[str, float] = {}
    for section in ("qa", "retrieval", "attribution", "multihop"):
        metrics.update(
            {
                name: float(value)
                for name, value in (detail.get(section) or {}).items()
                if isinstance(value, (int, float, bool))
            }
        )
    metrics.update(sample.get("metrics") or {})
    answer_mode = sample.get("answer_mode")
    hit = _at_k(metrics, "hit@")
    top_hit = _at_k(metrics, "hit@", min)
    recall = _at_k(metrics, "recall@")
    coverage = _at_k(metrics, "full_coverage@")
    gold_count = len(detail.get("gold_doc_ids") or [])
    uncited_gold = float(metrics.get("uncited_gold_count", 0.0) or 0.0)
    all_gold_uncited = gold_count > 0 and uncited_gold >= gold_count
    graph_exclusive = float(metrics.get("graph_exclusive_gold_share", 0.0) or 0.0) > 0
    has_retrieval = hit is not None and hit > 0
    decision_reason = str((query_audit or {}).get("decisionReason") or "")
    reference_contained = _contains_reference(
        str(sample.get("answer") or ""),
        [str(value) for value in detail.get("reference_answers") or []],
    )

    lost_terms: list[str] = []
    for entry in lineage or []:
        lost_terms.extend(entry.get("question_terms_lost") or [])
    lost_terms = sorted(set(lost_terms))

    answer_correct = reference_contained
    evidence: dict[str, Any] = {
        "answer_mode": answer_mode,
        "has_retrieval": has_retrieval,
        "hit": hit,
        "top_hit": top_hit,
        "recall": recall,
        "full_coverage": coverage,
        "uncited_gold_count": uncited_gold,
        "all_gold_uncited": all_gold_uncited,
        "question_terms_lost": lost_terms,
        "graph_exclusive_gold_share": metrics.get("graph_exclusive_gold_share"),
        "reference_answer_contained": reference_contained,
        "answer_correct": answer_correct,
        "gold_count": gold_count,
        "lineage_available": lineage is not None,
        "audit_decision_reason": decision_reason or None,
    }
    if reference_grounding is not None:
        evidence["reference_grounding"] = reference_grounding
    if evidence_chain is not None:
        evidence["evidence_chain"] = evidence_chain
    if query_audit is not None:
        evidence["query_audit"] = {
            key: query_audit.get(key)
            for key in (
                "answerMode",
                "decisionReason",
                "generalAnswerReason",
                "authorizedChunkCount",
                "finalAuthorizedSourceCount",
                "packContextLength",
                "answerContextLength",
                "contextBudget",
                "packContextBudget",
                "answerContextBudget",
                "truncatedCount",
                "budget",
                "graph",
                "retrieval",
            )
            if key in query_audit
        }
    if compiled_answers is not None:
        evidence["compiled_answers"] = compiled_answers

    chain = evidence.get("evidence_chain") or {}
    chain_broken = chain.get("status") in {"incomplete", "partial"}
    compilation_lost_answer = bool(
        (compiled_answers or {}).get("compiled_missing_count", 0)
    )
    answer_value = sample.get("answer")
    generation_empty = (
        decision_reason == "generation_empty"
        or query_store.is_generation_unavailable_answer(answer_value)
        or (
            isinstance(answer_value, str)
            and "did not produce a response" in answer_value.lower()
        )
    )
    reference_in_context = (reference_grounding or {}).get("grounded")
    retrieval_missed = hit is not None and hit == 0
    coverage_incomplete = coverage is not None and coverage < 1.0

    cause = _primary_cause(
        answer_mode=answer_mode,
        answer_correct=answer_correct,
        generation_empty=generation_empty,
        compilation_lost_answer=compilation_lost_answer,
        has_retrieval=has_retrieval,
        chain_broken=chain_broken,
        recall=recall,
        reference_in_context=reference_in_context,
        retrieval_missed=retrieval_missed,
        lost_terms=bool(lost_terms),
        coverage_incomplete=coverage_incomplete,
        graph_exclusive=graph_exclusive,
        all_gold_uncited=all_gold_uncited,
    )
    return {"root_cause": cause, "evidence": evidence}


def _primary_cause(
    *,
    answer_mode: str | None,
    answer_correct: bool,
    generation_empty: bool,
    compilation_lost_answer: bool,
    has_retrieval: bool,
    chain_broken: bool,
    recall: float | None,
    reference_in_context: bool | None,
    retrieval_missed: bool,
    lost_terms: bool,
    coverage_incomplete: bool,
    graph_exclusive: bool,
    all_gold_uncited: bool,
) -> str:
    if generation_empty and not answer_correct:
        return CAUSE_GENERATION_EMPTY
    if answer_correct:
        return CAUSE_GENERATION_FALLBACK if answer_mode == "general" else CAUSE_ANSWER_CORRECT
    if compilation_lost_answer:
        return CAUSE_COMPILED_ANSWER_MISSING
    if answer_mode == "general":
        if not has_retrieval:
            return CAUSE_GENERATION_FALLBACK
        if chain_broken or (recall is not None and recall < 1.0):
            return CAUSE_RETRIEVAL_EVIDENCE_INCOMPLETE

        if reference_in_context is False:
            return CAUSE_RETRIEVAL_EVIDENCE_INCOMPLETE
        return CAUSE_GENERATION_IGNORED_RETRIEVAL if recall is not None else CAUSE_UNKNOWN
    if chain_broken:
        return CAUSE_RETRIEVAL_EVIDENCE_INCOMPLETE
    if all_gold_uncited:
        return CAUSE_CITATION_DROPPED
    if retrieval_missed:
        return CAUSE_COMPILED_AWAY if lost_terms else CAUSE_RETRIEVAL_MISS
    if coverage_incomplete and not graph_exclusive:
        return CAUSE_GRAPH_EDGE_MISSING
    if answer_mode == "knowledge":
        return CAUSE_ANSWER_INCORRECT
    return CAUSE_UNKNOWN


SYSTEM_PROMPT = """你是一名 RAG 评测分析师。你分析的是一次完整评测，
不是某个样本。输入包含本次实际产出的各项指标、数据集切片、回答模式分布、
HTTP 失败、遗漏指标，以及最多 10 条 general 回答案例。案例直接从评测数据抽取，
不包含任何规则归因结论。

请写一份可直接交付的中文分析报告，要求：
1. 先总结整体表现，再逐项分析输入中实际存在的每个指标；没有的指标不要臆测。
2. 明确区分“指标直接说明的事实”和“潜在原因”。潜在原因必须使用可能、疑似、
   建议验证等审慎措辞，不能把相关性写成已证实因果。
3. 对 overall、knowledge_only、judge 等不同 scope 分开解读；注意样本数和省略指标。
4. EM/F1 受解释性长答案影响，只描述其表现，不能仅凭低分断言答案错误或归因根因。
5. Judge 指标可以辅助观察，但要说明它们来自模型判定，存在模型与提示词偏差。
6. 给出按优先级排序、可验证的下一步建议，并说明报告局限。
7. general 可能仍保留 retrievedSources 和 origin=graph 的图扩展证据。分析 general 案例时必须
   结合检索、引用和图指标，不得把 general 自动解释为没有召回。不要逐条复述或外推整体。
8. 不要声称看过未提供的原文、答案或日志。

只输出 JSON，不要用代码围栏：
{"report": "使用简短标题和分段组织的完整纯文本分析报告"}"""


def build_report_prompt(
    eval_run: dict[str, Any],
    metric_summaries: list[dict[str, Any]],
    dataset_summaries: list[dict[str, Any]],
    general_samples: list[dict[str, Any]],
) -> tuple[str, str]:
    definitions: dict[str, dict[str, Any]] = {}
    for row in metric_summaries:
        name = str(row["metric"])
        try:
            definition = registry.get_metric(name)
        except KeyError:
            continue
        definitions[name] = {
            "family": definition.family,
            "kind": definition.kind,
            "higher_is_better": definition.higher_is_better,
            "description": definition.description,
        }

    payload = {
        "evaluation": {
            "id": eval_run.get("id"),
            "name": eval_run.get("name"),
        },
        "metric_definitions": definitions,
        "metric_summaries": metric_summaries,
        "dataset_summaries": dataset_summaries,
        "general_answer_examples": general_samples[:10],
    }
    return SYSTEM_PROMPT, json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
