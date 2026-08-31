#!/usr/bin/env bash

# Inject the routing policy and the full Skill at session boundaries, matching
# the bootstrap pattern used by Superpowers. This avoids a first-turn race in
# which the model must discover the Skill before it can read its rules.
set -euo pipefail

plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
skill_file="${plugin_root}/skills/akasha/SKILL.md"
skill_content="$(cat "$skill_file")"

escape_for_json() {
  local input="$1" output="" i char
  for ((i=0; i<${#input}; i++)); do
    char="${input:i:1}"
    case "$char" in
      $'\\') output+='\\' ;;
      '"') output+='\"' ;;
      $'\n') output+='\n' ;;
      $'\r') output+='\r' ;;
      $'\t') output+='\t' ;;
      *) output+="$char" ;;
    esac
  done
  printf '%s' "$output"
}

skill_escaped="$(escape_for_json "$skill_content")"

cat <<JSON
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "<EXTREMELY_IMPORTANT>\nAkasha is the locally configured company and personal knowledge base.\n\nBefore drafting each answer, decide whether information outside general model knowledge may be needed. When Akasha may contain the needed information, use the mcp__akasha__query_knowledge tool before answering. Clearly stable general knowledge and simple calculations may be answered directly. When uncertain, prefer searching Akasha. Do not wait for the user to mention Akasha, and do not replace knowledge-base facts with model memory or general web knowledge. If the result is insufficient, say so explicitly.\n\n**The Akasha Skill is already loaded below. Follow it for this session; do not wait for a separate Skill discovery step.**\n\n${skill_escaped}\n\nThis routing rule is mandatory for the entire session, including after context compaction.\n</EXTREMELY_IMPORTANT>"
  }
}
JSON
