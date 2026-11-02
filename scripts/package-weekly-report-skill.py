#!/usr/bin/env python3
"""Build and verify the single-skill preview archive using Python's stdlib only."""

import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
NAME = "akasha-weekly-report"
SOURCE = ROOT / "skills" / NAME
FILES = (
    "SKILL.md",
    "references/content-rules.md",
    "references/mcp-contract.md",
)
STAMP = (1980, 1, 1, 0, 0, 0)
MODE = 0o100644 << 16
REQUIRED_FIELDS = (
    "name", "version", "display_name", "display_name_en", "description",
    "description_zh", "description_en", "author",
)


def validate_workbuddy_frontmatter(content):
    """Validate this package's one-line scalar metadata without external YAML deps.

    Only unindented keys count: metadata.version does not satisfy version.
    Quoted fields use JSON-compatible YAML strings or YAML single quotes.
    """
    lines = content.decode("utf-8").splitlines()
    if not lines or lines[0] != "---":
        raise ValueError("SKILL.md must have YAML frontmatter")
    try:
        end = lines.index("---", 1)
    except ValueError:
        raise ValueError("Unclosed SKILL.md frontmatter") from None
    fields = {}
    for line in lines[1:end]:
        match = re.fullmatch(r"([A-Za-z_][\w-]*):[ \t]*(.*)", line)
        if not match or match[1] not in REQUIRED_FIELDS:
            continue
        key, raw = match.groups()
        if key in fields:
            raise ValueError(f"Duplicate top-level Skill field: {key}")
        if raw.startswith('"'):
            value = json.loads(raw)
        elif raw.startswith("'"):
            if len(raw) < 2 or not raw.endswith("'"):
                raise ValueError(f"Unclosed quoted Skill field: {key}")
            value = raw[1:-1].replace("''", "'")
        else:
            value = raw.split(" #", 1)[0].strip()
            if (value.lower() in {"null", "~", "true", "false"}
                    or re.fullmatch(r"[+-]?\d+(?:\.\d+)?", value)
                    or value.startswith(("[", "{", "|", ">", "&", "*", "!"))
                    or re.search(r":(?:\s|$)", value)):
                raise ValueError(f"Skill field must be a one-line string: {key}")
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"Skill field must be a non-empty string: {key}")
        fields[key] = value
    missing = [key for key in REQUIRED_FIELDS if key not in fields]
    if missing:
        raise ValueError(f"Missing WorkBuddy top-level Skill fields: {', '.join(missing)}")
    if fields["name"] != NAME:
        raise ValueError(f"Skill name must match its package directory: {NAME}")
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", fields["version"]):
        raise ValueError("Skill version must be a semantic version string")
    return fields


def source_files():
    if SOURCE.is_symlink():
        raise ValueError("Skill source must not be a symlink")
    found = set()
    for path in SOURCE.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"Symlink not allowed: {path.relative_to(SOURCE)}")
        if path.is_file():
            found.add(path.relative_to(SOURCE).as_posix())
    if found != set(FILES):
        raise ValueError(f"Skill file allowlist mismatch: {sorted(found ^ set(FILES))}")
    data = {f"{NAME}/{name}": (SOURCE / name).read_bytes() for name in FILES}
    validate_workbuddy_frontmatter(data[f"{NAME}/SKILL.md"])
    return data


def verify(path, expected):
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if [entry.filename for entry in entries] != sorted(expected):
            raise ValueError("Archive has missing, duplicate, unordered or unexpected entries")
        if archive.comment or archive.testzip() is not None:
            raise ValueError("Archive comment or CRC verification failed")
        for entry in entries:
            if (entry.date_time != STAMP or entry.create_system != 3
                    or entry.external_attr != MODE
                    or entry.compress_type != zipfile.ZIP_STORED
                    or entry.extra or entry.comment or entry.flag_bits & 1):
                raise ValueError(f"Unexpected archive metadata: {entry.filename}")
            if archive.read(entry) != expected[entry.filename]:
                raise ValueError(f"Archive content mismatch: {entry.filename}")
        validate_workbuddy_frontmatter(archive.read(f"{NAME}/SKILL.md"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path,
                        default=ROOT / "dist/skills/akasha-weekly-report.zip")
    checks = parser.add_mutually_exclusive_group()
    checks.add_argument("--verify-only", action="store_true",
                        help="Verify existing archive against current allowlisted source")
    checks.add_argument("--check-source", action="store_true",
                        help="Validate source files and WorkBuddy frontmatter without creating an archive")
    args = parser.parse_args()
    output = args.output.resolve()
    if output == SOURCE or SOURCE in output.parents:
        parser.error("Output must be outside the skill directory")
    expected = source_files()
    metadata = validate_workbuddy_frontmatter(expected[f"{NAME}/SKILL.md"])
    if args.check_source:
        print(json.dumps({"skill": NAME, "version": metadata["version"],
                          "requiredFields": list(REQUIRED_FIELDS), "verified": True},
                         ensure_ascii=False, indent=2))
        return
    if not args.verify_only:
        output.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".weekly-report-", suffix=".zip",
                                         dir=output.parent)
        os.close(fd)
        try:
            # Stored entries avoid zlib-version differences; timestamps/modes/order are fixed.
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED) as archive:
                for name in sorted(expected):
                    entry = zipfile.ZipInfo(name, date_time=STAMP)
                    entry.create_system = 3
                    entry.external_attr = MODE
                    entry.compress_type = zipfile.ZIP_STORED
                    archive.writestr(entry, expected[name])
            verify(temporary, expected)
            os.replace(temporary, output)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    verify(output, expected)
    print(json.dumps({"archive": str(output), "version": metadata["version"], "files": sorted(expected),
                      "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                      "verified": True}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
