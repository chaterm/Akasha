#!/usr/bin/env bash
set -euo pipefail

cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Akasha may be available as a company and personal knowledge base. Use the akasha-query skill for company policies, internal projects, personal notes, or when the user explicitly asks to query Akasha; do not use it for ordinary public knowledge unless explicitly requested, since uncertainty alone is not a trigger. Use akasha-pages for Page changes and akasha-weekly-report for weekly reports."
  }
}
JSON
