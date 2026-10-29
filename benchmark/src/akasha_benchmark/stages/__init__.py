from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ..task import Stage
from . import (
    attribute,
    chain,
    compile,
    download,
    embed,
    evaluate,
    generate,
    normalize,
    query,
)


@dataclass(frozen=True)
class StageDefinition:
    label: str
    run: Stage

    params: dict[str, type] = field(default_factory=dict)
    verify: Callable[..., None] | None = None


STAGES: dict[str, StageDefinition] = {
    "download": StageDefinition(
        label="下载数据集",
        run=download.run,
        params={"datasets": list},
    ),
    "generate": StageDefinition(
        label="生成样本",
        run=generate.run,
        params={
            "dataset": str,
            "provider_id": int,
            "per_doc": int,
            "doc_limit": int,
            "concurrency": int,
            "seed": int,
        },
    ),
    "normalize": StageDefinition(
        label="归一化",
        run=normalize.run,
        params={"datasets": list},
    ),
    "compile": StageDefinition(
        label="编译",
        run=compile.run,
        params={
            "run_id": str,
            "datasets": list,
            "seed": int,
            "qa_limit": int,
            "sample_ids": list,
            "negatives_ratio": float,
            "full_corpus": bool,
            "import_concurrency": int,
            "schedule_at": str,
        },
    ),
    "embed": StageDefinition(
        label="嵌入",
        run=embed.run,
        params={"compile_id": int, "embedding_concurrency": int},
    ),
    "query": StageDefinition(
        label="查询",
        run=query.run,
        verify=chain.verify_query,
        params={
            "compile_id": int,
            "name": str,
            "datasets": list,
            "sample_limit": int,
            "concurrency": int,
            "retry_failed": bool,
            "follow_up": bool,
        },
    ),
    "evaluate": StageDefinition(
        label="评测",
        run=evaluate.run,
        verify=chain.verify_evaluate,
        params={
            "query_id": int,
            "name": str,
            "datasets": list,
            "ks": list,
            "metrics": list,
            "judge_provider_id": int,
            "concurrency": int,
        },
    ),
    "attribute": StageDefinition(
        label="归因",
        run=attribute.run,
        verify=chain.verify_attribute,
        params={
            "eval_id": int,
            "name": str,
            "use_model": bool,
            "provider_id": int,
        },
    ),
}


def clean_params(stage: str, args: dict[str, Any]) -> dict[str, Any]:
    spec = STAGES.get(stage)
    if spec is None:
        raise ValueError(f"未知阶段 {stage!r}；可用：{sorted(STAGES)}")

    cleaned: dict[str, Any] = {}
    for key, kind in spec.params.items():
        if key not in args:
            continue
        value = args[key]
        if value is None or value == "":
            continue
        try:
            if kind is list:
                if not isinstance(value, list):
                    raise ValueError("expected a JSON array")
                cleaned[key] = [int(v) for v in value] if key == "ks" else [str(v) for v in value]
            elif kind is bool:
                if not isinstance(value, bool):
                    raise ValueError("expected a JSON boolean")
                cleaned[key] = value
            else:
                cleaned[key] = kind(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{stage}.{key}: 需要 {kind.__name__}，收到 {value!r}") from exc
    return cleaned


__all__ = ["STAGES", "StageDefinition", "chain", "clean_params"]
