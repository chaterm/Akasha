from __future__ import annotations

import io
import json
import re
import zipfile
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import unquote

from .corpus import CorpusIndex
from .models import CorpusDoc

_UTF8_FLAG = 0x800
_UNSAFE = re.compile(r'[/\\:*?"<>|]+')
_HEADING = re.compile(r"^#\s+(.+?)\s*#*\s*$")
_METADATA = "akasha-metadata.json"


def _entry_name(info: zipfile.ZipInfo) -> str:
    if info.flag_bits & _UTF8_FLAG:
        return info.filename
    try:
        return info.filename.encode("cp437").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return info.filename


def _doc_id(path: PurePosixPath) -> str:
    return _UNSAFE.sub("_", str(path.with_suffix(""))).strip(" .")


def _title(text: str, fallback: str) -> str:
    match = _HEADING.match(text.splitlines()[0].strip())
    return match.group(1) if match else fallback


def parse_space_export(data: bytes) -> list[dict[str, Any]]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ValueError("不是有效的 zip 文件") from exc

    rows: list[dict[str, Any]] = []
    with archive:
        for info in archive.infolist():
            path = PurePosixPath(_entry_name(info))
            if info.is_dir() or path.suffix.lower() != ".md" or "__MACOSX" in path.parts:
                continue
            text = archive.read(info).decode("utf-8-sig").strip()
            if not text:
                continue
            rows.append({"id": _doc_id(path), "title": _title(text, path.stem), "text": text})

    if not rows:
        raise ValueError("压缩包里没有非空的 md 页面")
    rows.sort(key=lambda row: row["id"])
    CorpusIndex("space", [CorpusDoc(doc_id=r["id"], title=r["title"], text=r["text"]) for r in rows])
    return rows


def space_page_ids(data: bytes) -> dict[str, str]:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        try:
            pages = json.loads(archive.read(_METADATA)).get("pages") or {}
        except KeyError as exc:
            raise ValueError(f"导出里缺少 {_METADATA}") from exc
    return {
        _doc_id(PurePosixPath(unquote(path))): str(meta["pageId"])
        for path, meta in pages.items()
        if meta.get("pageId")
    }
