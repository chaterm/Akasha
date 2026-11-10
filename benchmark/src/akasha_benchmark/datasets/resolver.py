from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .base import DatasetAdapter
from .registry import dataset_dir as default_dir
from .registry import get_adapter


@dataclass(frozen=True)
class ResolvedDataset:
    adapter: DatasetAdapter
    qa_path: Path
    corpus_path: Path

    @property
    def name(self) -> str:
        return self.adapter.name


def resolve(name: str, dataset_dir: Path | None = None) -> ResolvedDataset:
    root = dataset_dir or default_dir()
    adapter = get_adapter(name)
    qa_path = root / adapter.qa_filename
    corpus_path = root / adapter.corpus_filename

    missing = [p.name for p in (qa_path, corpus_path) if not p.is_file()]
    if missing:
        action = "下载" if adapter.downloadable else "导入空间并生成样本"
        raise FileNotFoundError(
            f"{adapter.name}: 缺少原始文件 {missing}，请在数据集页先{action}。"
        )
    return ResolvedDataset(adapter=adapter, qa_path=qa_path, corpus_path=corpus_path)
