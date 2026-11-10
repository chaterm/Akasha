from __future__ import annotations

import json

import pytest
from conftest import make_compile_run
from conftest import make_context as context

from akasha_benchmark.datasets import DataDependency, get_adapter
from akasha_benchmark.datasets.hotpotqa import HotpotQAAdapter
from akasha_benchmark.judge.client import JudgeProvider, JudgeReply
from akasha_benchmark.metrics import registry
from akasha_benchmark.stages import (
    attribute,
    clean_params,
    compile,
    evaluate,
    normalize,
)
from akasha_benchmark.store import (
    attribution_store,
    compile_store,
    data_store,
    eval_store,
    query_store,
    run_store,
    task_store,
)
from akasha_benchmark.task import execute

PROVIDER = JudgeProvider("https://x", "m", "k")


def test_normalize_writes_samples_and_corpus(normalized):
    samples = data_store.samples_of(normalized, "hotpotqa")
    assert len(samples) == 2
    assert samples[0]["gold_doc_ids"], "hotpotqa 应当有 gold 标注"
    assert len(data_store.corpus_of(normalized, "hotpotqa")) == 4


def test_validate_catches_dangling_gold(normalized):
    assert normalize.validate_dataset(normalized, "hotpotqa") == []
    normalized.execute("DELETE FROM corpus_doc WHERE dataset='hotpotqa' AND doc_id='0'")
    normalized.commit()
    assert any("gold" in p for p in normalize.validate_dataset(normalized, "hotpotqa"))


def test_normalize_rejects_duplicate_sample_ids(db, dataset_dir, monkeypatch):
    monkeypatch.setattr(HotpotQAAdapter, "expected_qa_rows", lambda self: None)
    path = dataset_dir / "hotpotqa.json"
    rows = json.loads(path.read_text(encoding="utf-8"))
    path.write_text(json.dumps([*rows, rows[0]]), encoding="utf-8")
    with pytest.raises(ValueError, match="重复"):
        normalize.normalize_dataset(db, "hotpotqa", None, dataset_dir)


def _subset(connection, run_id="r", seed=1, qa_limit=2, negatives_ratio=1.0, **options):
    compile_id = make_compile_run(
        connection, run_id, ["hotpotqa"], seed=seed, qa_limit=qa_limit, negatives_ratio=negatives_ratio
    )
    stats = compile.build_subset(
        connection, compile_id, "hotpotqa", seed=seed, qa_limit=qa_limit, negatives_ratio=negatives_ratio, **options
    )
    return compile_id, stats, compile_store.compile_docs(connection, compile_id)


def test_subset_covers_every_gold(normalized):
    compile_id, stats, docs = _subset(normalized, seed=7)
    doc_ids = {d["doc_id"] for d in docs}
    gold = {d["doc_id"] for d in docs if d["is_gold"]}
    samples = compile_store.compile_samples(normalized, compile_id)
    assert stats["samples"] == len(samples) == 2
    assert all(set(sample["gold_doc_ids"]) <= doc_ids for sample in samples)
    assert stats["gold"] == len(gold)
    assert stats["negatives"] == len(doc_ids - gold)


def test_subset_is_seed_stable(normalized):
    def doc_ids(run_id):
        return {d["doc_id"] for d in _subset(normalized, run_id, seed=7, qa_limit=1)[2]}

    assert doc_ids("a") == doc_ids("b")


def test_subset_negatives_ratio_zero_keeps_only_gold(normalized):
    _, stats, docs = _subset(normalized, negatives_ratio=0.0)
    assert stats["negatives"] == 0
    assert all(d["is_gold"] for d in docs)


def test_subset_can_select_one_exact_sample(normalized):
    target = data_store.samples_of(normalized, "hotpotqa")[1]
    compile_id, stats, docs = _subset(normalized, qa_limit=1, sample_ids=[target["sample_id"]])
    assert stats["samples"] == 1
    samples = compile_store.compile_samples(normalized, compile_id)
    assert [row["sample_id"] for row in samples] == [target["sample_id"]]
    assert set(target["gold_doc_ids"]) <= {row["doc_id"] for row in docs}


def test_full_corpus_keeps_every_document(normalized):
    _, stats, docs = _subset(normalized, qa_limit=1, full_corpus=True)
    assert {doc["doc_id"] for doc in docs} == {"0", "1", "2", "3"}
    assert all(doc["title"] for doc in docs)
    assert stats["docs"] == 4
    assert stats["gold"] + stats["negatives"] == 4


def test_markdown_and_doc_id_rules(normalized):
    assert compile.markdown_of(normalized, "hotpotqa", "0").startswith("# Rita Moreno")
    with pytest.raises(ValueError):
        compile._safe_doc_id("../escape")
    assert not compile._has_indexable_text("# 标题\n\n![image](files/example.png)")
    assert compile._has_indexable_text("# 标题\n\n这里有可检索的正文。")


def _fixture_chain(connection, response: dict) -> tuple[int, int, int]:
    compile_id, _, docs = _subset(connection)
    for doc in docs:
        compile_store.record_page(
            connection, compile_id, doc["dataset"], doc["doc_id"], page_id=f"p{doc['doc_id']}", error=None
        )
    compile_store.update_compile_run(connection, compile_id, space_id="s", status=run_store.STATUS_SUCCEEDED)
    query_id = query_store.create_query_run(
        connection, name="q", compile_id=compile_id, concurrency=1, model_configs={}
    )
    for sample in compile_store.compile_samples(connection, compile_id):
        retrieved = (
            [{"sourcePageId": f"p{doc}"} for doc in sample["gold_doc_ids"]]
            if response.get("answerMode") == "knowledge"
            else []
        )
        query_store.record_response(
            connection, query_id, sample_id=sample["sample_id"], dataset="hotpotqa",
            question=sample["question"], http_status=200, latency_ms=100, error=None,
            response={**response, "retrievedSources": retrieved},
        )
    run_store.set_run_status(connection, "query", query_id, run_store.STATUS_SUCCEEDED)
    eval_id = eval_store.create_eval_run(
        connection, name="e", query_id=query_id, ks=[2], metrics=["recall", "hit", "em", "f1"], judge_provider_id=None
    )
    connection.commit()
    return compile_id, query_id, eval_id


def _evaluate(connection, response, metrics=("recall", "hit", "em", "f1")):
    compile_id, query_id, eval_id = _fixture_chain(connection, response)
    summary = evaluate.evaluate_dataset(
        connection, eval_id, query_id, compile_id, "hotpotqa", (2,), frozenset(metrics)
    )
    return summary, compile_id, query_id, eval_id


KNOWLEDGE = {"answerMode": "knowledge", "answer": "Rita Moreno", "citations": []}


def test_evaluate_scores_perfect_retrieval(normalized):
    summary, *_ = _evaluate(normalized, KNOWLEDGE)
    assert (summary["responses_evaluated"], summary["http_failures"]) == (2, 0)
    assert summary["overall"]["recall@2"] == pytest.approx(1.0)
    assert summary["overall"]["hit@2"] == pytest.approx(1.0)


def test_evaluate_separates_fallback_from_retrieval_failure(normalized):
    *_, eval_id = _evaluate(normalized, {"answerMode": "no_match", "answer": "", "citations": []}, ["recall"])
    summaries = {(row["scope"], row["metric"]): row for row in eval_store.metric_summaries(normalized, eval_id)}
    assert summaries[("overall", "recall@2")]["value"] == pytest.approx(0.0)
    assert ("knowledge_only", "recall@2") not in summaries
    modes = eval_store.dataset_evals(normalized, eval_id)[0]["answer_modes"]
    assert modes == {"no_match": pytest.approx(1.0)}


def test_evaluate_filters_to_selected_metrics(normalized):
    *_, eval_id = _evaluate(normalized, KNOWLEDGE, ["em"])
    sample = eval_store.sample_evals(normalized, eval_id)[0]
    assert set(eval_store.sample_metrics_of(normalized, eval_id, sample["sample_id"])) == {"em"}
    assert "retrieval" in sample["detail"]


def test_evaluate_rejects_rebuilt_subset(normalized):
    compile_id, query_id, eval_id = _fixture_chain(normalized, {**KNOWLEDGE, "answer": "x"})
    normalized.execute("UPDATE sample SET question = 'changed' WHERE sample_id LIKE 'hotpotqa%'")
    normalized.commit()
    with pytest.raises(ValueError, match="重建"):
        evaluate.evaluate_dataset(
            normalized, eval_id, query_id, compile_id, "hotpotqa", (2,), frozenset({"recall"})
        )


def test_attribution_processes_all_eval_samples_without_metric_selection(normalized):
    compile_id, _, eval_id = _fixture_chain(normalized, {"answerMode": "knowledge", "answer": "Rita Moreno"})
    samples = compile_store.compile_samples(normalized, compile_id)
    for sample in samples:
        eval_store.record_sample_eval(
            normalized, eval_id, sample_id=sample["sample_id"], dataset=sample["dataset"],
            answer_mode="knowledge", http_status=200, answer="Rita Moreno",
            detail={
                "metadata": sample["metadata"],
                "question": sample["question"],
                "gold_doc_ids": sample["gold_doc_ids"],
            },
            metrics={},
        )
    params = {"eval_id": eval_id, "metric": "missing_metric", "sample_limit": 1, "use_model": False}
    attribute.run(context(normalized, params))

    run = attribution_store.list_attribution_runs(normalized, eval_id)[0]
    assert "metric" not in run
    assert "sample_limit" not in run
    assert len(attribution_store.attribution_results(normalized, int(run["id"]))) == len(samples)


def test_attribution_model_writes_one_overall_report(normalized, monkeypatch):
    *_, eval_id = _evaluate(normalized, {"answerMode": "general", "answer": "A general answer", "citations": []})
    monkeypatch.setattr(attribute, "resolve_provider", lambda *args: type("Provider", (), {"provider_id": None})())
    calls: list[list[tuple[str, str]]] = []

    def fake_complete_many(_provider, prompts, concurrency, *, max_tokens):
        calls.append(prompts)
        assert (concurrency, max_tokens) == (1, 4096)
        user_prompt = prompts[0][1]
        for hidden in ("rule_root_cause_counts", "representative_rule_evidence", "root_cause", "sample_id"):
            assert hidden not in user_prompt
        assert '"general_answer_examples":[' in user_prompt
        assert user_prompt.count('"answer":"A general answer"') == 2
        assert "metric_summaries" in user_prompt
        content = '{"report":"整体表现\\n潜在原因\\n验证建议"}'
        return [JudgeReply(content=content, failure_kind=None, raw=None, status=200, latency_ms=123)]

    monkeypatch.setattr(attribute, "complete_many", fake_complete_many)
    attribute.run(context(normalized, {"eval_id": eval_id, "use_model": True}))

    run = attribution_store.list_attribution_runs(normalized, eval_id)[0]
    assert [len(prompts) for prompts in calls] == [1]
    assert run["report"] == "整体表现\n潜在原因\n验证建议"
    assert run["report_error"] is None
    assert run["report_latency_ms"] == 123
    results = attribution_store.attribution_results(normalized, int(run["id"]))
    assert all(set(row) >= {"root_cause", "evidence"} for row in results)


def test_omitted_metrics_are_not_faked_as_zero():
    adapter = get_adapter("narrativeqa")
    assert DataDependency.GOLD_DOCS not in adapter.provides
    omitted = {d.name for d in registry.omitted(adapter.provides)}
    assert {"recall", "ndcg", "citation_recall"} <= omitted
    assert "faithfulness" not in omitted


def test_resolve_metrics_rejects_unknown():
    with pytest.raises(ValueError, match="未知指标"):
        evaluate.resolve_metrics(["recall", "bogus"])
    assert evaluate.resolve_metrics([]) == sorted(registry.METRIC_REGISTRY)


@pytest.mark.parametrize(
    "stage,payload,expected",
    [
        ("query", {"compile_id": "3", "retry_failed": True, "evil": "x"}, {"compile_id": 3, "retry_failed": True}),
        ("attribute", {"eval_id": 3, "metric": "em", "sample_limit": 1}, {"eval_id": 3}),
        ("evaluate", {"ks": ["2", "5"]}, {"ks": [2, 5]}),
        ("evaluate", {"concurrency": "4"}, {"concurrency": 4}),
    ],
)
def test_clean_params_coerces_and_drops_undeclared_keys(stage, payload, expected):
    assert clean_params(stage, payload) == expected


@pytest.mark.parametrize(
    "stage,payload",
    [("query", {"compile_id": "not-a-number"}), ("normalize", {"datasets": "hotpotqa"}), ("bogus-stage", {})],
)
def test_clean_params_rejects_wrong_types(stage, payload):
    with pytest.raises(ValueError):
        clean_params(stage, payload)


def test_evaluate_resume_restores_judge_scores_and_summary(normalized, monkeypatch):
    compile_id, query_id, eval_id = _fixture_chain(normalized, {"answerMode": "knowledge", "answer": "a"})
    for sample in compile_store.compile_samples(normalized, compile_id):
        eval_store.record_judge_verdict(
            normalized, eval_id, sample_id=sample["sample_id"], metric="faithfulness",
            score=0.5, failure_kind=None, detail=None,
        )
    params = {"query_id": query_id, "name": "e", "metrics": ["em", "faithfulness"], "ks": [2]}
    task_id = task_store.create_task(normalized, stage="evaluate", params=params)
    task_store.set_task_target(normalized, task_id, "eval", eval_id)
    monkeypatch.setattr(evaluate, "resolve_provider", lambda *args: PROVIDER)

    def no_calls(*args, **kwargs):
        pytest.fail("续跑不应重复调用已完成的 Judge")

    monkeypatch.setattr(evaluate, "complete_many", no_calls)
    execute(evaluate.run, context(normalized, params, task_id=task_id))

    for sample in eval_store.sample_evals(normalized, eval_id):
        metrics = eval_store.sample_metrics_of(normalized, eval_id, sample["sample_id"])
        assert metrics["faithfulness"] == 0.5
    summaries = [r for r in eval_store.metric_summaries(normalized, eval_id) if r["scope"] == "judge"]
    assert [(r["value"], r["sample_count"]) for r in summaries] == [(0.5, 2)]


def test_judge_runs_all_metrics_for_each_sample_before_next(normalized, monkeypatch):
    *_, query_id, eval_id = _evaluate(normalized, {"answerMode": "knowledge", "answer": "a"}, ["em"])
    ctx = context(normalized)
    calls: list[list[tuple[str, str]]] = []

    def fake_complete_many(provider, prompts, concurrency):
        calls.append(list(prompts))
        return [JudgeReply(content="{}", failure_kind=None, raw="SECRET_RAW", status=200) for _ in prompts]

    monkeypatch.setattr(
        evaluate, "_judge_task", lambda metric, question, *_: ((metric, question), lambda payload: (1.0, {}))
    )
    monkeypatch.setattr(
        evaluate,
        "_answer_relevancy_task",
        lambda connection, question, *_: (("answer_relevancy", question), lambda payload: (1.0, {})),
    )
    monkeypatch.setattr(evaluate, "complete_many", fake_complete_many)

    evaluate._judge(ctx, eval_id, query_id, PROVIDER, ["faithfulness", "answer_relevancy"], 4)

    questions = [row["detail"]["question"] for row in eval_store.sample_evals(normalized, eval_id)]
    assert calls == [[("faithfulness", q), ("answer_relevancy", q)] for q in questions]
    task = task_store.get_task(normalized, ctx.task_id)
    assert (task["progress_done"], task["progress_total"]) == (2, 2)
    logs = task_store.task_logs(normalized, ctx.task_id)
    assert all("SECRET_RAW" not in entry["message"] for entry in logs)


def test_judge_resume_retries_failed_verdicts(normalized, monkeypatch):
    *_, query_id, eval_id = _evaluate(normalized, {"answerMode": "knowledge", "answer": "a"}, ["em"])
    rows = eval_store.sample_evals(normalized, eval_id)
    for row in rows:
        eval_store.record_judge_verdict(
            normalized, eval_id, sample_id=row["sample_id"], metric="answer_relevancy",
            score=None, failure_kind="parse_error", detail={"error": "invalid json"},
        )
    prompts_sent: list[int] = []

    def fake_complete_many(provider, prompts, concurrency):
        prompts_sent.append(len(prompts))
        return [JudgeReply("{}", None, "{}", 200) for _ in prompts]

    monkeypatch.setattr(
        evaluate, "_answer_relevancy_task", lambda *_: (("system", "user"), lambda payload: (1.0, {}))
    )
    monkeypatch.setattr(evaluate, "complete_many", fake_complete_many)
    evaluate._judge(context(normalized), eval_id, query_id, PROVIDER, ["answer_relevancy"], 1)

    assert sum(prompts_sent) == len(rows)
    verdicts = eval_store.judge_verdicts(normalized, eval_id)
    assert all(v["failure_kind"] is None for v in verdicts if v["metric"] == "answer_relevancy")
