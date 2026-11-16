#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import posixpath
import re
from pathlib import Path
import tempfile
import zipfile


PLUGIN_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = PLUGIN_DIR.parent
SKILLS_DIR = PLUGIN_DIR / "skills"
ARCHIVE_NAME = "akasha-skills.zip"
EXCLUDED_TOPS = {"agents", "scripts"}
STAMP = (1980, 1, 1, 0, 0, 0)
MODE = 0o100644 << 16
REQUIRED_FIELDS = ("name", "description")
BLOCK_SCALARS = (">", ">-", "|", "|-")


def fail(message):
    raise ValueError(message)


def plugin_version():
    data = json.loads((PLUGIN_DIR / ".claude-plugin" / "plugin.json").read_text("utf-8"))
    return data["version"]


def parse_frontmatter(content, label):
    lines = content.decode("utf-8").splitlines()
    if not lines or lines[0] != "---":
        fail(f"{label} must start with YAML frontmatter")
    try:
        end = lines.index("---", 1)
    except ValueError:
        fail(f"{label} has unclosed frontmatter")

    fields = {}
    index = 1
    while index < end:
        line = lines[index]
        index += 1
        if not line.strip():
            continue
        match = re.fullmatch(r"([A-Za-z_][\w-]*):[ \t]*(.*)", line)
        if not match:
            fail(f"{label} has a non-scalar frontmatter line: {line!r}")
        key, raw = match.groups()
        if key in fields:
            fail(f"{label} repeats the {key} field")
        if raw.strip() in BLOCK_SCALARS:
            block = []
            while index < end and (not lines[index].strip() or lines[index].startswith((" ", "\t"))):
                block.append(lines[index].strip())
                index += 1
            value = " ".join(part for part in block if part)
        elif raw.startswith('"'):
            value = json.loads(raw)
        elif raw.startswith("'"):
            if len(raw) < 2 or not raw.endswith("'"):
                fail(f"{label} has an unclosed quoted field: {key}")
            value = raw[1:-1].replace("''", "'")
        else:
            value = raw.split(" #", 1)[0].strip()
        if not isinstance(value, str) or not value.strip():
            fail(f"{label} field must be a non-empty string: {key}")
        fields[key] = value

    missing = [key for key in REQUIRED_FIELDS if key not in fields]
    if missing:
        fail(f"{label} is missing fields: {', '.join(missing)}")
    return fields


def validate_skill(content, skill_name):
    fields = parse_frontmatter(content, f"{skill_name}/SKILL.md")
    if fields["name"] != skill_name:
        fail(f"{skill_name}/SKILL.md name must match its directory: {fields['name']}")
    return fields


def skill_dirs():
    found = sorted(path for path in SKILLS_DIR.iterdir()
                   if path.is_dir() and (path / "SKILL.md").is_file())
    if not found:
        fail("no Skill found under skills/")
    return found


def skill_files(skill):
    found = {}
    for path in sorted(skill.rglob("*")):
        if path.is_symlink():
            fail(f"symlink not allowed: {path.relative_to(PLUGIN_DIR).as_posix()}")
        if path.is_dir():
            continue
        relative = path.relative_to(skill).as_posix()
        if relative.split("/", 1)[0] in EXCLUDED_TOPS:
            continue
        if relative == "SKILL.md" or relative.startswith("references/"):
            found[relative] = path.read_bytes()
            continue
        fail(f"unexpected file in Skill package: {skill.name}/{relative}")
    return found


def expected_entries():
    entries = {}
    for skill in skill_dirs():
        for relative, data in skill_files(skill).items():
            entries[f"{skill.name}/{relative}"] = data
    check_pointers(entries)
    return entries


def check_pointers(entries):
    pattern = re.compile(r"\]\(([^)\s]+)\)")
    for name, data in entries.items():
        if not name.endswith("/SKILL.md"):
            continue
        base = posixpath.dirname(name)
        for target in pattern.findall(data.decode("utf-8")):
            if target.startswith(("http://", "https://", "/", "#")):
                continue
            resolved = posixpath.normpath(posixpath.join(base, target.split("#", 1)[0]))
            if resolved.startswith(".."):
                fail(f"{name} points outside the archive: {target}")
            if resolved not in entries:
                fail(f"{name} points at a missing file: {target}")


def build(path, entries):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".skills-", suffix=".zip", dir=path.parent)
    os.close(handle)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED) as archive:
            for name in sorted(entries):
                entry = zipfile.ZipInfo(name, date_time=STAMP)
                entry.create_system = 3
                entry.external_attr = MODE
                entry.compress_type = zipfile.ZIP_STORED
                archive.writestr(entry, entries[name])
        verify(temporary, entries)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def verify(path, entries):
    path = Path(path)
    if not path.is_file():
        fail(f"archive not found: {path}")
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        if [info.filename for info in infos] != sorted(entries):
            fail(f"{path.name} has missing, extra, duplicate or unordered entries")
        if archive.comment or archive.testzip() is not None:
            fail(f"{path.name} failed CRC verification")
        for info in infos:
            if (info.date_time != STAMP or info.create_system != 3
                    or info.external_attr != MODE
                    or info.compress_type != zipfile.ZIP_STORED
                    or info.extra or info.comment or info.flag_bits & 1):
                fail(f"unexpected archive metadata: {info.filename}")
            if archive.read(info) != entries[info.filename]:
                fail(f"archive content mismatch: {info.filename}")
    for name, data in entries.items():
        if name.endswith("/SKILL.md"):
            validate_skill(data, name.split("/")[-2])


def main():
    parser = argparse.ArgumentParser(
        description="Build and verify the Akasha Skill archive.")
    parser.add_argument("--output-dir", type=Path, default=PLUGIN_DIR / "dist",
                        help="Directory for the archive (default: akasha-plugin/dist)")
    checks = parser.add_mutually_exclusive_group()
    checks.add_argument("--check-source", action="store_true",
                        help="Validate sources without writing the archive")
    checks.add_argument("--verify-only", action="store_true",
                        help="Verify the existing archive against current sources")
    args = parser.parse_args()

    entries = expected_entries()
    if args.check_source:
        print(json.dumps({"skills": [{"name": skill.name,
                                      "description": validate_skill(
                                          skill_files(skill)["SKILL.md"], skill.name)["description"]}
                                     for skill in skill_dirs()],
                          "files": sorted(entries), "verified": True},
                         ensure_ascii=False, indent=2))
        return

    output = args.output_dir.resolve()
    for skill in skill_dirs():
        if output == skill or skill in output.parents:
            parser.error("Output must be outside the Skill directories")

    path = output / ARCHIVE_NAME
    if not args.verify_only:
        build(path, entries)
    verify(path, entries)
    print(json.dumps({"archive": str(path), "version": plugin_version(), "files": sorted(entries),
                      "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                      "verified": True}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
