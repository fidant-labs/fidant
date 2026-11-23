#!/usr/bin/env bash
set -uo pipefail

input=$(cat)
cmd=$(jq -r '.tool_input.command // ""' <<<"$input")
case "$cmd" in
  *"gh pr create"*)
    cd "$(jq -r '.cwd // "."' <<<"$input")" 2>/dev/null || exit 0
    key=$(git branch --show-current 2>/dev/null | grep -oiE '^sig-[0-9]+' | tr '[:lower:]' '[:upper:]')
    msg="Linear: link the new pull request in ${key:-its Linear issue} and keep the issue In Progress until it merges."
    ;;
  *"gh pr merge"*)
    msg="Linear: set the merged pull request's issue (the SIG key in its title) to Done."
    ;;
  *) exit 0 ;;
esac

jq -nc --arg m "$msg" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $m}}'
