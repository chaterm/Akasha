#!/usr/bin/env bash

# Keep a lightweight routing hint at session boundaries. The full Skill is
# discovered normally when relevant; this hook must not force a knowledge-base
# lookup for every answer.
set -euo pipefail


# plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# skill_file="${plugin_root}/skills/akasha/SKILL.md"
# skill_content="$(cat "$skill_file")"

# escape_for_json() {
#   local input="$1" output="" i char
#   for ((i=0; i<${#input}; i++)); do
#     char="${input:i:1}"
#     case "$char" in
#       $'\\') output+='\\' ;;
#       '"') output+='\"' ;;
#       $'\n') output+='\n' ;;
#       $'\r') output+='\r' ;;
#       $'\t') output+='\t' ;;
#       *) output+="$char" ;;
#     esac
#   done
#   printf '%s' "$output"
# }

# skill_escaped="$(escape_for_json "$skill_content")"
cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Akasha may be available as a company and personal knowledge base. Consider query_knowledge when a request likely depends on organization-specific or personal internal information, or when the user explicitly asks to query Akasha. Answer stable general/public questions and simple calculations directly; do not query merely because you are uncertain. Follow normal Skill discovery and the user's intent."
  }
}
JSON
