from __future__ import annotations

import httpx
import pytest

from akasha_benchmark.judge import (
    JudgeClient,
    JudgeProvider,
    answer_correctness,
    answer_relevancy,
    context_relevancy,
)
from akasha_benchmark.store import eval_store


def test_answer_relevancy_generated_question_embedding_helpers():
    assert answer_relevancy.build_prompt("") is None
    built = answer_relevancy.build_prompt("Paris is the capital of France.")
    assert built is not None
    assert "ANSWER" in built[1]
    question = "What is France's capital?"
    assert answer_relevancy.parse_generated_question({"question": question}) == question
    with pytest.raises(ValueError):
        answer_relevancy.parse_generated_question({"question": ""})
    assert answer_relevancy.cosine_similarity([1.0, 0.0], [1.0, 0.0]) == pytest.approx(1.0)
    assert answer_relevancy.cosine_similarity([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)


def test_context_relevancy_is_the_useful_share():
    passages = [{"index": 1, "verdict": "useful"}, {"index": 2, "verdict": "useless"}]
    score, detail = context_relevancy.parse_verdict({"passages": passages}, expected=2)
    assert score == pytest.approx(0.5)
    assert detail["useful"] == 1
    with pytest.raises(ValueError, match="expected 3 verdicts"):
        context_relevancy.parse_verdict({"passages": passages[:1]}, expected=3)


def test_context_relevancy_numbers_the_passages():
    built = context_relevancy.build_prompt(
        "q", {"snippets": [{"title": "T1", "text": "x"}, {"title": "T2", "text": "y"}]}
    )
    assert built is not None
    _, user, count = built
    assert count == 2
    assert "[1] T1" in user
    assert "[2] T2" in user
    assert context_relevancy.build_prompt("q", {}) is None


@pytest.mark.parametrize(
    ("verdict", "expected"),
    [("correct", 1.0), ("partial", 0.5), ("incorrect", 0.0), ("no_answer", None)],
)
def test_answer_correctness_scores_each_band(verdict, expected):
    score, detail = answer_correctness.parse_verdict({"verdict": verdict, "reason": "r"})
    assert score == expected
    assert detail["verdict"] == verdict


def test_answer_correctness_rejects_unknown_verdict_and_skips_without_reference():
    with pytest.raises(ValueError, match="unknown verdict"):
        answer_correctness.parse_verdict({"verdict": "mostly right"})
    assert answer_correctness.build_prompt("q", "a", "") is None
    assert answer_correctness.build_prompt("q", "", "ref") is None
    assert answer_correctness.build_prompt("q", "a", "ref") is not None


def test_verdicts_are_stored_per_metric(db, eval_id):
    for name, score in (("faithfulness", 0.5), ("answer_relevancy", 1.0)):
        eval_store.record_judge_verdict(
            db, eval_id, sample_id="s1", metric=name, score=score,
            failure_kind=None, detail={"raw_response": f"raw-{name}"},
        )
    assert eval_store.judged_sample_ids(db, eval_id, "faithfulness") == {"s1"}
    assert eval_store.judged_sample_ids(db, eval_id, "context_relevancy") == set()
    assert eval_store.judged_sample_ids(db, eval_id) == {"s1"}

    verdicts = {v["metric"]: v["score"] for v in eval_store.judge_verdicts(db, eval_id)}
    assert verdicts == {"faithfulness": 0.5, "answer_relevancy": 1.0}
    assert eval_store.judge_verdicts(db, eval_id)[0]["detail"]["raw_response"]
    assert eval_store.judge_verdicts(db, eval_id, include_detail=False)[0]["detail"] is None


@pytest.mark.parametrize("status", [200, 400], ids=["success", "failure"])
def test_judge_reply_carries_latency(status):
    provider = JudgeProvider(base_url="https://x/v1", model="m", api_key="k")
    transport = httpx.MockTransport(
        lambda request: httpx.Response(status, json={"choices": [{"message": {"content": "{}"}}]})
    )
    with JudgeClient(provider, client=httpx.Client(transport=transport)) as client:
        reply = client.complete("s", "u")
    assert (reply.failure_kind is None) == (status == 200)
    assert reply.latency_ms is not None and reply.latency_ms >= 0


def test_judge_summary_separates_scores_failures_and_skipped_calls(db, eval_id):
    for sample_id, metric, score, failure, latency in (
        ("s1", "faithfulness", 1.0, None, 2000),
        ("s2", "faithfulness", 0.5, None, 0),
        ("s3", "faithfulness", None, None, None),
        ("s1", "answer_relevancy", None, "rate_limit", 4000),
    ):
        eval_store.record_judge_verdict(
            db, eval_id, sample_id=sample_id, metric=metric, score=score,
            failure_kind=failure, latency_ms=latency, detail=None,
        )

    assert eval_store.judge_summary(db, eval_id) == {
        "total": 4, "scored": 2, "failed": 1, "mean": 0.75,
        "latency_mean": 2000, "failure_rate": 0.25,
        "failures_by_kind": {"rate_limit": 1},
    }
    faithfulness = eval_store.judge_summary(db, eval_id, "faithfulness")
    assert (faithfulness["total"], faithfulness["failure_rate"], faithfulness["latency_mean"]) == (3, 0.0, 1000)
    assert eval_store.judge_summary(db, eval_id, "answer_relevancy")["failure_rate"] == 1.0
