from __future__ import annotations

import pytest

from akasha_benchmark import attribution
from akasha_benchmark.datasets import DataDependency, DependencyError
from akasha_benchmark.metrics import attribution as citation
from akasha_benchmark.metrics import multihop, qa, registry, retrieval
from akasha_benchmark.metrics.interpretation import (
    build_metric_evidence,
    interpret_sample_metrics,
)


def test_unmapped_pages_keep_their_rank():
    retrieved = [{"sourcePageId": "unknown"}, {"sourcePageId": "p1"}]
    ranked = retrieval.ranked_doc_ids(retrieved, {"p1": "d1"})
    assert len(ranked) == 2
    assert ranked[1] == "d1"
    assert retrieval.mrr(ranked, ["d1"]) == pytest.approx(0.5)
    assert retrieval.unmapped_page_ids(retrieved, {"p1": "d1"}) == ["unknown"]


def test_recall_precision_and_full_coverage():
    gold = ["d1", "d2"]
    assert retrieval.recall_at_k(["d1", "x"], gold, 2) == pytest.approx(0.5)
    assert retrieval.full_coverage(["d1", "x"], gold, 2) == pytest.approx(0.0)
    assert retrieval.full_coverage(gold, gold, 2) == pytest.approx(1.0)
    assert retrieval.precision_at_k(["d1", "other"], gold, 5) == pytest.approx(0.5)
    assert retrieval.recall_at_k(["d1", "other"], gold, 5) == pytest.approx(0.5)
    assert retrieval.precision_at_k([], gold, 5) == 0.0
    with pytest.raises(ValueError):
        retrieval.recall_at_k(["d1"], [], 2)


def test_retrieval_f1_ignores_k_and_order():
    gold = ["d1", "d2"]
    early = ["d1", "d2", "x", "y", "z", "w", "v", "u"]
    late = ["x", "y", "z", "w", "v", "u", "d1", "d2"]

    assert retrieval.retrieval_f1(["d1", "other"], gold) == pytest.approx(0.5)
    assert retrieval.retrieval_f1(early, gold) == pytest.approx(0.4)
    assert retrieval.retrieval_f1(late, gold) == pytest.approx(0.4)
    assert retrieval.retrieval_f1(gold, gold) == pytest.approx(1.0)
    assert retrieval.retrieval_f1([], gold) == 0.0

    metrics = retrieval.evaluate_sample(early, gold, (2, 5, 10))
    assert "retrieval_f1" in metrics
    assert not any(name.startswith("retrieval_f1@") for name in metrics)


def test_ndcg_rewards_earlier_gold():
    early = retrieval.ndcg_at_k(["d1", "x", "y"], ["d1"], 3)
    late = retrieval.ndcg_at_k(["x", "y", "d1"], ["d1"], 3)
    assert early == pytest.approx(1.0)
    assert late < early


def test_registry_gate_is_set_comparison():
    gold = frozenset({DataDependency.GOLD_DOCS, DataDependency.REFERENCE_ANSWERS})
    assert registry.require("hotpotqa", gold, "recall").name == "recall"
    with pytest.raises(DependencyError):
        registry.require("narrativeqa", frozenset({DataDependency.REFERENCE_ANSWERS}), "recall")
    assert registry.require("narrativeqa", frozenset(), "faithfulness").kind == "judge"
    with pytest.raises(DependencyError):
        registry.require("narrativeqa", frozenset(), "answer_correctness")


def test_uncited_documents_separate_retrieval_from_citation():
    result = citation.evaluate_sample(
        citations=[{"sourcePageId": "p2"}],
        retrieved=[{"sourcePageId": "p1"}, {"sourcePageId": "p2"}],
        gold=["gold"],
        page_to_doc={"p1": "gold", "p2": "other"},
    )
    assert result["uncited_count"] == pytest.approx(1.0)
    assert result["uncited_gold_count"] == pytest.approx(1.0)
    assert result["citation_recall"] == pytest.approx(0.0)


def _snippet(page: str, origin: str, source_page: str, reasons=("semantic",)) -> dict:
    return {
        "id": f"chunk-{page}-{origin}",
        "knowledgePageId": page,
        "origin": origin,
        "retrievalReasons": list(reasons),
        "sourceWindows": [{"sourcePageId": source_page}],
    }


@pytest.mark.parametrize(
    ("snippets", "gold", "page_to_doc", "expected"),
    [
        pytest.param(
            [_snippet("kp-a", "direct", "p1"), _snippet("kp-b", "graph", "p2")],
            ["g1", "g2"],
            {"p1": "g1", "p2": "g2"},
            {"graph_exclusive_gold_share": 0.5},
            id="net-contribution",
        ),
        pytest.param(
            [_snippet("kp-1", "graph", "p1"), _snippet("kp-1", "direct", "p1")],
            ["g1"],
            {"p1": "g1"},
            {"graph_exclusive_gold_share": 1.0, "graph_neighbor_precision": 1.0},
            id="other-chunk-of-same-knowledge-page",
        ),
        pytest.param(
            [_snippet("kp-1", "graph", "p1"), {**_snippet("kp-1", "graph", "p1"), "origin": "direct"}],
            ["g1"],
            {"p1": "g1"},
            {"graph_exclusive_gold_share": 0.0},
            id="same-chunk-both-ways",
        ),
        pytest.param(
            [_snippet("kp-direct", "direct", "p1"), _snippet("kp-graph", "graph", "p1")],
            ["g1"],
            {"p1": "g1"},
            {"graph_exclusive_gold_share": 1.0},
            id="other-knowledge-page-of-same-gold",
        ),
        pytest.param(
            [_snippet("kp-g", "graph", "p1", reasons=("semantic", "lexical"))],
            ["g1"],
            {"p1": "g1"},
            {"graph_exclusive_gold_share": 1.0, "origin_doc_counts": {"graph": 1}},
            id="origin-decides-path",
        ),
        pytest.param(
            [
                _snippet("kp-gold", "graph", "gold-page"),
                *[_snippet(f"kp-other-{index}", "graph", "other-page") for index in range(3)],
            ],
            ["gold"],
            {"gold-page": "gold", "other-page": "other"},
            {"graph_neighbor_precision": 0.5, "origin_doc_counts": {"graph": 2}},
            id="neighbor-precision-deduplicates-documents",
        ),
    ],
)
def test_multihop_graph_contribution(snippets, gold, page_to_doc, expected):
    result = multihop.evaluate_sample(snippets, gold, page_to_doc)
    assert {key: result[key] for key in expected} == expected


def test_answer_scoring_takes_max_over_references():
    scored = qa.score_answer("Rita Moreno", ["someone else", "rita moreno"])
    assert scored["em"] == pytest.approx(1.0)
    assert scored["f1"] == pytest.approx(1.0)
    assert qa.normalize_answer("The  Answer!") == "answer"


def test_answer_mode_distribution():
    assert qa.answer_mode_distribution(["knowledge", "no_match", None]) == {
        "knowledge": pytest.approx(1 / 3),
        "missing": pytest.approx(1 / 3),
        "no_match": pytest.approx(1 / 3),
    }


def test_sample_metric_interpretations_explain_values_with_sample_counts():
    rows = interpret_sample_metrics(
        ["recall", "mrr", "uncited_gold_count", "faithfulness"],
        [5],
        {"recall@5": 0.5, "mrr": 0.5, "uncited_gold_count": 1.0, "faithfulness": 2 / 3},
        {"gold_doc_ids": ["g1", "g2"]},
        [
            {
                "metric": "faithfulness",
                "score": 2 / 3,
                "failure_kind": None,
                "detail": {"claim_count": 3, "supported": 2},
            }
        ],
        [],
    )
    by_name = {row["name"]: row for row in rows}
    assert by_name["recall@5"]["reason"] == "前 5 条检索结果命中 1/2 篇 gold 文档。"
    assert by_name["mrr"]["reason"] == "首个 gold 文档约位于第 2 名。"
    assert by_name["uncited_gold_count"]["status"] == "bad"
    assert by_name["faithfulness"]["reason"] == "2/3 条事实陈述有检索证据支持。"


def test_sample_metric_interpretations_explain_missing_and_failed_values():
    rows = interpret_sample_metrics(
        ["recall", "answer_relevancy", "answer_correctness"],
        [2],
        {},
        {},
        [
            {"metric": "answer_relevancy", "score": None, "failure_kind": None},
            {"metric": "answer_correctness", "score": None, "failure_kind": "timeout"},
        ],
        ["recall"],
    )
    by_name = {row["name"]: row for row in rows}
    assert "缺少" in by_name["recall@2"]["reason"]
    assert "无定义" in by_name["answer_relevancy"]["reason"]
    assert "timeout" in by_name["answer_correctness"]["reason"]
    assert all(row["status"] == "unavailable" for row in rows)


def test_citation_precision_evidence_matches_scoring_scope():
    evidence = build_metric_evidence(
        ["citation_precision"],
        [5],
        {"citation_precision": 0.5},
        {"gold_doc_ids": ["g1", "g2"], "reference_answers": []},
        {
            "citations": [
                {"sourcePageId": "p-gold", "title": "Gold"},
                {"sourcePageId": "p-other", "title": "Other"},
                {"sourcePageId": "p-gold", "title": "duplicate"},
                {"sourcePageId": "p-missing", "title": "Missing"},
            ],
            "snippets": [
                {
                    "id": "s1",
                    "title": "Gold chunk",
                    "text": "gold evidence text",
                    "retrievalReasons": ["semantic"],
                    "sourceWindows": [{"sourcePageId": "p-gold"}],
                }
            ],
            "citationEvidence": [
                {"sourcePageId": "p-gold", "excerpts": [{"text": "exact cited sentence"}]}
            ],
        },
        {"p-gold": "g1", "p-other": "d2"},
        {
            "g1": {"doc_id": "g1", "title": "Gold document"},
            "g2": {"doc_id": "g2", "title": "Uncited gold"},
            "d2": {"doc_id": "d2", "title": "Other document"},
        },
        [],
    )["citation_precision"]

    assert evidence["formula"] == "实际引用中命中 Gold（1）/ 实际引用（2）"
    assert [(doc["doc_id"], doc["is_gold"]) for doc in evidence["documents"]] == [
        ("g1", True),
        ("d2", False),
        (None, False),
    ]
    assert evidence["snippets"][0]["text"] == "gold evidence text"
    assert evidence["citation_excerpts"][0]["excerpts"] == ["exact cited sentence"]
    assert [(doc["doc_id"], doc["cited"]) for doc in evidence["gold_documents"]] == [
        ("g1", True),
        ("g2", False),
    ]


def test_every_registered_metric_has_structured_evidence_and_formula():
    configured = sorted(registry.METRIC_REGISTRY)
    actual_names = [f"{name}@2" if registry.get_metric(name).per_k else name for name in configured]
    evidence = build_metric_evidence(
        configured,
        [2],
        {name: 0.5 for name in actual_names},
        {"gold_doc_ids": ["g1"], "reference_answers": ["reference answer"]},
        {
            "answer": "answer",
            "retrievedSources": [{"sourcePageId": "p1"}],
            "citations": [{"sourcePageId": "p1"}],
            "citationEvidence": [{"sourcePageId": "p1", "excerpts": ["quote"]}],
            "snippets": [
                {
                    "id": "s1",
                    "knowledgePageId": "kp-gold",
                    "origin": "graph",
                    "title": "Gold",
                    "text": "evidence",
                    "retrievalReasons": ["semantic"],
                    "sourceWindows": [{"sourcePageId": "p1"}],
                }
            ],
        },
        {"p1": "g1"},
        {"g1": {"doc_id": "g1", "title": "Gold"}},
        [
            {"metric": name, "detail": {}}
            for name in configured
            if registry.get_metric(name).kind == registry.KIND_JUDGE
        ],
    )

    assert set(evidence) == set(actual_names)
    assert all(row.get("formula") for row in evidence.values())


def _sample(metrics: dict, mode="knowledge", correct=False, references=None, **overrides) -> dict:
    detail = {"gold_doc_ids": ["g1"], "question": "q"}
    if correct:
        detail["reference_answers"] = ["Rita Moreno"]
    if references is not None:
        detail["reference_answers"] = references
    detail.update(overrides.pop("detail", {}))
    sample = {
        "answer_mode": mode,
        "metrics": metrics,
        "answer": "The answer is Rita Moreno." if correct else "x",
        "detail": detail,
    }
    return sample | overrides


def _musique(metrics: dict, steps: list[dict], mode="general") -> dict:
    return _sample(metrics, mode=mode, dataset="musique", detail={"metadata": {"question_decomposition": steps}})


A = attribution
TERMS_LOST = [{"question_terms_lost": ["access"]}]
JUDGE_PERFECT = {"answer_correctness": 1.0, "faithfulness": 1.0, "answer_relevancy": 1.0, "context_relevancy": 1.0}


def case(id, sample, cause, lineage=(), chain=None, compiled=None, evidence=None, absent=()):
    lineage = list(lineage) if lineage is not None else None
    return pytest.param(sample, lineage, chain, compiled, cause, evidence or {}, absent, id=id)


@pytest.mark.parametrize(
    ("sample", "lineage", "chain", "compiled", "cause", "evidence", "absent"),
    [
        case("correct-despite-miss", _sample({"hit@5": 0.0}, correct=True), A.CAUSE_ANSWER_CORRECT),
        case(
            "correct-outranks-compiled-away",
            _sample({"hit@5": 0.0}, correct=True),
            A.CAUSE_ANSWER_CORRECT,
            lineage=[{"question_terms_lost": ["grammy"]}],
        ),
        case(
            "correct-outranks-citation-drop",
            _sample({"hit@5": 0.0, "uncited_gold_count": 1.0}, correct=True),
            A.CAUSE_ANSWER_CORRECT,
        ),
        case(
            "reference-token-coverage",
            _sample({"hit@5": 1.0}, answer="You would not see the Brooklyn Nets play there.", references=["Brooklyn Nets"]),
            A.CAUSE_ANSWER_CORRECT,
        ),
        case(
            "stopword-reference-is-not-coverage",
            _sample({"hit@5": 1.0}, answer="This is a complete explanation.", references=["in"]),
            A.CAUSE_ANSWER_INCORRECT,
        ),
        case(
            "fully-supported-long-answer",
            _sample(
                {"f1": 0.35, "faithfulness": 1.0, "hit@5": 1.0, "full_coverage@5": 1.0, "uncited_gold_count": 1.0},
                answer="Roger Capellani died during the Battle of Dunkirk, which was fought between the Allies and Nazi Germany.",
                references=["the Allies and Nazi Germany"],
            ),
            A.CAUSE_ANSWER_CORRECT,
            evidence={"reference_answer_contained": True},
        ),
        *[
            case(f"empty-answer-{index}", _sample({"hit@5": 1.0}, answer=answer, references=["expected answer"]), A.CAUSE_GENERATION_EMPTY)
            for index, answer in enumerate(["", None, A.query_store.ANSWER_GENERATION_UNAVAILABLE_ZH])
        ],
        case(
            "knowledge-empty-generation-is-not-citation-drop",
            _sample(
                {"hit@5": 1.0, "recall@5": 1.0, "full_coverage@5": 1.0, "uncited_gold_count": 2.0},
                answer="Relevant knowledge was retrieved, but the answer model did not produce a response.",
                dataset="musique",
            ),
            A.CAUSE_GENERATION_EMPTY,
            chain={"status": "complete", "steps": []},
        ),
        case(
            "judge-metrics-ignored",
            _sample({"hit@5": 0.0, **JUDGE_PERFECT}),
            A.CAUSE_RETRIEVAL_MISS,
            absent=("faithfulness",),
        ),
        case(
            "weak-metrics-faithful-but-wrong",
            _sample({"faithfulness": 1.0, "hit@5": 1.0, "full_coverage@5": 1.0}),
            A.CAUSE_ANSWER_INCORRECT,
            absent=("f1",),
        ),
        case("weak-metrics-high-f1-miss", _sample({"hit@5": 0.0, "f1": 0.9}), A.CAUSE_RETRIEVAL_MISS, absent=("f1",)),
        case(
            "weak-metrics-low-f1-hit",
            _sample({"hit@5": 1.0, "full_coverage@5": 1.0, "f1": 0.1}),
            A.CAUSE_ANSWER_INCORRECT,
            absent=("f1",),
        ),
        case("general-correct-is-fallback", _sample({"hit@5": 0.0}, mode="general", correct=True), A.CAUSE_GENERATION_FALLBACK, lineage=None),
        case("general-correct-with-hit", _sample({"hit@5": 1.0}, mode="general", correct=True), A.CAUSE_GENERATION_FALLBACK, lineage=None),
        case("fallback-before-retrieval", _sample({"hit@5": 0.0}, mode="general"), A.CAUSE_GENERATION_FALLBACK, lineage=None),
        case(
            "compiled-away-with-lineage",
            _sample({"hit@5": 0.0}),
            A.CAUSE_COMPILED_AWAY,
            lineage=[{"question_terms_lost": ["grammy"]}],
        ),
        case(
            "no-lineage-is-retrieval-miss",
            _sample({"hit@5": 0.0}),
            A.CAUSE_RETRIEVAL_MISS,
            lineage=None,
            evidence={"lineage_available": False},
        ),
        case(
            "compiled-away-needs-complete-miss",
            _sample({"hit@10": 1.0, "full_coverage@10": 1.0}),
            A.CAUSE_ANSWER_INCORRECT,
            lineage=TERMS_LOST,
        ),
        case(
            "uncited-gold-outranks-lost-terms",
            _sample({"hit@10": 1.0, "full_coverage@10": 1.0, "uncited_gold_count": 1.0}),
            A.CAUSE_CITATION_DROPPED,
            lineage=TERMS_LOST,
        ),
        case(
            "uncited-gold-outranks-retrieval-miss",
            _sample({"hit@5": 0.0, "uncited_gold_count": 1.0}),
            A.CAUSE_CITATION_DROPPED,
        ),
        case(
            "graph-edge-missing",
            _sample({"hit@5": 1.0, "full_coverage@5": 0.0, "graph_exclusive_gold_share": 0.0}),
            A.CAUSE_GRAPH_EDGE_MISSING,
        ),
        case(
            "general-with-retrieval-ignored",
            _sample({"hit@5": 1.0, "recall@5": 1.0, "full_coverage@5": 1.0}, mode="general"),
            A.CAUSE_GENERATION_IGNORED_RETRIEVAL,
        ),
        case(
            "general-partial-recall",
            _sample({"hit@5": 1.0, "recall@5": 0.5}, mode="general"),
            A.CAUSE_RETRIEVAL_EVIDENCE_INCOMPLETE,
        ),
        case(
            "general-uses-full-retrieval-detail",
            _sample({}, mode="general", detail={"retrieval": {"hit@5": 1.0, "recall@5": 1.0, "full_coverage@5": 1.0}}),
            A.CAUSE_GENERATION_IGNORED_RETRIEVAL,
        ),
        case(
            "general-incomplete-chain-before-correctness",
            _sample({"hit@10": 1.0}, mode="general", dataset="musique", answer="The answer is Acme.", references=["Acme"]),
            A.CAUSE_GENERATION_FALLBACK,
            chain={"status": "partial", "steps": []},
            evidence={"answer_correct": True},
        ),
        case(
            "general-complete-chain",
            _sample({"hit@10": 1.0, "recall@10": 1.0}, mode="general", dataset="musique"),
            A.CAUSE_GENERATION_IGNORED_RETRIEVAL,
            chain={"status": "complete", "steps": []},
        ),
        case(
            "compiled-answer-missing-outranks-symptoms",
            _sample({"hit@5": 1.0, "recall@5": 0.5, "uncited_gold_count": 1.0}),
            A.CAUSE_COMPILED_ANSWER_MISSING,
            chain={"status": "partial", "steps": []},
            compiled={"compiled_missing_count": 1, "steps": []},
        ),
    ],
)
def test_rule_attribution(sample, lineage, chain, compiled, cause, evidence, absent):
    ruling = attribution.classify(sample, lineage, chain, compiled_answers=compiled)
    assert ruling["root_cause"] == cause
    assert {key: ruling["evidence"][key] for key in evidence} == evidence
    assert not set(absent) & set(ruling["evidence"])


def test_partial_retrieval_is_not_compiled_away():
    ruling = attribution.classify(_sample({"hit@10": 1.0, "full_coverage@10": 0.0}), TERMS_LOST)
    assert ruling["root_cause"] != attribution.CAUSE_COMPILED_AWAY


def test_token_matching_survives_smart_quotes_and_hyphens():
    steps = [{"answer": "``Hey Jude ''", "support_doc_id": "g1"}]
    lineage = [
        {
            "doc_id": "g1",
            "source_text": "``Hey Jude '' is a Beatles song.",
            "compiled_text": "“Hey Jude” is a Beatles song.",
        }
    ]
    report = attribution.analyze_compiled_answers(_musique({}, steps), lineage)
    assert report["steps"][0]["status"] == "preserved"

    hyphen = [{"answer": "fleur - de-lis", "support_doc_id": "g1"}]
    lineage[0]["source_text"] = "the fleur - de-lis symbol"
    lineage[0]["compiled_text"] = "the fleur-de-lis is a symbol of New Orleans"
    report = attribution.analyze_compiled_answers(_musique({}, hyphen), lineage)
    assert report["steps"][0]["status"] == "preserved"


def test_attribution_token_normalization_removes_possessives():
    assert attribution._normalized_tokens("Avicenna's Canon") == ["avicenna", "canon"]
    assert attribution._normalized_tokens("Avicenna’s Canon") == ["avicenna", "canon"]
    assert attribution._normalized_tokens("the scholars' libraries") == ["scholars", "libraries"]


def test_musique_evidence_chain_marks_complete_context_as_false_negative_candidate():
    text = "X was made by Acme in 2020."
    sample = _musique(
        {"hit@10": 1.0},
        [
            {"id": 1, "question": "Who made X?", "answer": "Acme", "support_doc_id": "d1", "support_title": "X", "support_text": text},
            {"id": 2, "question": "When?", "answer": "2020", "support_doc_id": "d2", "support_title": "X history", "support_text": text},
        ],
    )
    response = {
        "answerMode": "general",
        "snippets": [{"title": "X", "text": text, "sourceWindows": [{"title": "X", "text": text}]}],
    }
    chain = attribution.analyze_evidence_chain(sample, response)
    assert chain["status"] == "complete"
    assert chain["model_false_negative_candidate"] is True
    assert all(step["status"] == "supported" for step in chain["steps"])
    assert all(step["claim_retrieved"] for step in chain["steps"])
    sources = {row["source_type"] for row in chain["steps"][0]["retrieved_evidence"]}
    assert sources == {"context", "source_window"}


def test_musique_evidence_chain_marks_missing_step():
    sample = _musique(
        {},
        [
            {"answer": "Acme", "support_title": "X", "support_text": "X was made by Acme."},
            {"answer": "2020", "support_title": "X history", "support_text": "The year was 2020."},
        ],
    )
    chain = attribution.analyze_evidence_chain(sample, {"snippets": [{"title": "X", "text": "X was made by Acme."}]})
    assert chain["status"] == "incomplete"
    assert chain["missing_step_count"] == 1
    assert chain["steps"][1]["claim_retrieved"] is False


def test_evidence_chain_does_not_treat_retrieved_source_title_as_claim():
    sample = _musique({}, [{"answer": "Acme", "support_title": "X", "support_text": "X was made by Acme."}])
    chain = attribution.analyze_evidence_chain(sample, {"retrievedSources": [{"title": "X was made by Acme."}]})
    assert chain["steps"][0]["claim_retrieved"] is False


def test_evidence_chain_keeps_all_matching_retrieved_evidence():
    sample = _musique(
        {}, [{"answer": "Acme", "support_title": "X", "support_text": "Acme was founded in 2020 by Jane."}]
    )
    texts = [
        "Acme was founded in 2020.",
        "Acme was founded by Jane.",
        "The company was founded in 2020 by Jane.",
        "Acme and Jane founded the company.",
    ]
    response = {"snippets": [{"title": f"candidate-{index}", "text": text} for index, text in enumerate(texts, 1)]}
    chain = attribution.analyze_evidence_chain(sample, response)
    assert len(chain["steps"][0]["retrieved_evidence"]) == 4


def test_compiled_answer_analysis_distinguishes_source_and_compilation_loss():
    sample = _musique(
        {},
        [
            {"question": "Who?", "answer": "Acme", "support_doc_id": "d1"},
            {"question": "When?", "answer": "2020", "support_doc_id": "d2"},
            {"question": "Where?", "answer": "Paris", "support_doc_id": "d3"},
        ],
        mode="knowledge",
    )
    analysis = attribution.analyze_compiled_answers(
        sample,
        [
            {"doc_id": "d1", "source_text": "Acme made it.", "compiled_text": "Acme made it."},
            {"doc_id": "d2", "source_text": "It happened in 2020.", "compiled_text": "The event happened."},
            {"doc_id": "d3", "source_text": "No location is stated.", "compiled_text": "No location is stated."},
        ],
    )
    assert analysis["status"] == "compiled_missing"
    assert (analysis["compiled_missing_count"], analysis["source_missing_count"]) == (1, 1)
    assert [step["status"] for step in analysis["steps"]] == ["preserved", "compiled_missing", "source_missing"]


def test_compiled_answer_analysis_uses_eighty_percent_token_recall():
    sample = _musique(
        {}, [{"question": "Where?", "answer": "Cairo Illinois river city county", "support_doc_id": "d1"}], mode="knowledge"
    )
    text = "The river meets at Cairo, Illinois city."
    analysis = attribution.analyze_compiled_answers(
        sample, [{"doc_id": "d1", "source_text": text, "compiled_text": text}]
    )
    step = analysis["steps"][0]
    assert step["source_answer_token_recall"] == 0.8
    assert step["compiled_answer_token_recall"] == 0.8
    assert step["status"] == "preserved"
