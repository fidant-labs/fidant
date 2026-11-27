#!/usr/bin/env bash
set -uo pipefail

command -v jq >/dev/null || exit 0
source "$(dirname "${BASH_SOURCE[0]}")/command.sh"
read_input
if runs "${GH_PR}(create|new)"; then
  enter_target || true
  branch=$(head_values "$args" | head -1)
  branch=${branch##*:}
  [ -n "$branch" ] || branch=$(git branch --show-current 2>/dev/null)
  key=$(grep -oiE '^(fid|sig)-[0-9]+' <<<"$branch" | tr '[:lower:]' '[:upper:]')
  msg="Linear: link the new pull request in ${key:-its Linear issue} and keep the issue In Progress until it merges."
elif runs "${GH_PR}merge"; then
  [[ $args =~ (^|[[:space:]])--disable-auto($|[[:space:]]) ]] && exit 0
  if [[ $args =~ (^|[[:space:]])--auto($|[[:space:]]) ]]; then
    msg="Linear: auto-merge is only queued. Set the pull request's issue (the FID key in its title) to Done once it has merged."
  else
    msg="Linear: set the merged pull request's issue (the FID key in its title) to Done."
  fi
else
  exit 0
fi

jq -nc --arg m "$msg" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $m}}'
