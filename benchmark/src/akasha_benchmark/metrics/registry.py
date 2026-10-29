from __future__ import annotations

from dataclasses import dataclass

from ..datasets.models import DataDependency, DependencyError

FAMILY_RETRIEVAL = "retrieval"
FAMILY_QA = "qa"
FAMILY_ATTRIBUTION = "attribution"
FAMILY_MULTIHOP = "multihop"
FAMILY_JUDGE = "judge"

KIND_DETERMINISTIC = "deterministic"
KIND_JUDGE = "judge"


@dataclass(frozen=True)
class MetricDefinition:
    name: str
    family: str
    requires: frozenset[DataDependency]
    description: str
    kind: str = KIND_DETERMINISTIC
    higher_is_better: bool = True
    per_k: bool = False


_GOLD = frozenset({DataDependency.GOLD_DOCS})
_ANSWERS = frozenset({DataDependency.REFERENCE_ANSWERS})
_NONE: frozenset[DataDependency] = frozenset()

METRIC_DEFINITIONS: tuple[MetricDefinition, ...] = (
    MetricDefinition("precision", FAMILY_RETRIEVAL, _GOLD, "前 k 个实际返回文档中命中的 gold 占比", per_k=True),
    MetricDefinition("recall", FAMILY_RETRIEVAL, _GOLD, "前 k 个里命中的 gold 占比", per_k=True),
    MetricDefinition(
        "retrieval_f1",
        FAMILY_RETRIEVAL,
        _GOLD,
        "set F1：对系统实际返回的全部文档算一次，多返回和漏召都扣分，不看顺序也不随 k 变化",
    ),
    MetricDefinition("ndcg", FAMILY_RETRIEVAL, _GOLD, "二元相关性下的 nDCG", per_k=True),
    MetricDefinition("hit", FAMILY_RETRIEVAL, _GOLD, "前 k 个里至少命中一个 gold", per_k=True),
    MetricDefinition(
        "full_coverage",
        FAMILY_RETRIEVAL,
        _GOLD,
        "前 k 个里凑齐全部 gold 才算 1，比 recall 均值更贴近多跳的需求",
        per_k=True,
    ),
    MetricDefinition("mrr", FAMILY_RETRIEVAL, _GOLD, "首个 gold 的倒数排名"),
    MetricDefinition(
        "em",
        FAMILY_QA,
        _ANSWERS,
        "Exact Match：归一化后整串相等。解释性长答案得分偏低，需结合 F1 与证据解读",
    ),
    MetricDefinition(
        "f1",
        FAMILY_QA,
        _ANSWERS,
        "token F1。会被解释性 token 稀释，绝对值只可同配置比较",
    ),
    MetricDefinition("citation_precision", FAMILY_ATTRIBUTION, _GOLD, "被引文档里 gold 的占比"),
    MetricDefinition("citation_recall", FAMILY_ATTRIBUTION, _GOLD, "gold 里被引用的占比"),
    MetricDefinition(
        "uncited_count", FAMILY_ATTRIBUTION, _GOLD, "已检索但未被引用的文档数", higher_is_better=False
    ),
    MetricDefinition(
        "uncited_gold_count",
        FAMILY_ATTRIBUTION,
        _GOLD,
        "已检索但未被引用的 gold 文档数",
        higher_is_better=False,
    ),
    MetricDefinition(
        "graph_exclusive_gold_share",
        FAMILY_MULTIHOP,
        _GOLD,
        "有 chunk 只靠图扩展才到达的 gold 占比，即图边的净增量价值",
    ),
    MetricDefinition(
        "graph_neighbor_precision",
        FAMILY_MULTIHOP,
        _GOLD,
        "按文档去重后，图扩展命中的文档中 gold 所占比例",
    ),

    MetricDefinition(
        "graph_neighbor_gold_snippets", FAMILY_MULTIHOP, _GOLD, "图扩展 snippet 里命中 gold 的条数"
    ),
    MetricDefinition(
        "faithfulness",
        FAMILY_JUDGE,
        _NONE,
        "答案里的每条陈述能否由检索到的上下文支撑。不需要标注，narrativeqa 也可用",
        kind=KIND_JUDGE,
    ),
    MetricDefinition(
        "answer_relevancy",
        FAMILY_JUDGE,
        _NONE,
        "由答案反推问题，与原问题算 embedding 相似度，判「答没答到点上」而非「答得对不对」",
        kind=KIND_JUDGE,
    ),
    MetricDefinition(
        "context_relevancy",
        FAMILY_JUDGE,
        _NONE,
        "召回的上下文里有多少是这个问题用得上的，即检索的信噪比",
        kind=KIND_JUDGE,
    ),
    MetricDefinition(
        "answer_correctness",
        FAMILY_JUDGE,
        _ANSWERS,
        "答案与参考答案在事实上是否一致，不受措辞与长度影响。拒答无定义，不记 0",
        kind=KIND_JUDGE,
    ),
)

METRIC_REGISTRY: dict[str, MetricDefinition] = {d.name: d for d in METRIC_DEFINITIONS}


def get_metric(name: str) -> MetricDefinition:
    base = name.split("@", 1)[0]
    try:
        return METRIC_REGISTRY[base]
    except KeyError:
        raise KeyError(
            f"unknown metric {name!r}. Known: {', '.join(sorted(METRIC_REGISTRY))}"
        ) from None


def available(provides: frozenset[DataDependency]) -> list[MetricDefinition]:
    return [d for d in METRIC_DEFINITIONS if d.requires <= provides]


def omitted(provides: frozenset[DataDependency]) -> list[MetricDefinition]:
    return [d for d in METRIC_DEFINITIONS if not d.requires <= provides]


def require(dataset: str, provides: frozenset[DataDependency], metric: str) -> MetricDefinition:
    definition = get_metric(metric)
    missing = definition.requires - provides
    if missing:
        raise DependencyError(
            f"{dataset} cannot compute {metric!r}: missing data dependency "
            f"{sorted(m.value for m in missing)}"
        )
    return definition
