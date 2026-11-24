#!/usr/bin/env bash
set -uo pipefail

command -v jq >/dev/null || exit 0
source "$(dirname "${BASH_SOURCE[0]}")/command.sh"
read_input
runs "$GIT_PUSH" || runs "${GH_PR}create" || exit 0
enter_target || exit 0

base=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null) || base=origin/main
git fetch -q origin "${base#origin/}" 2>/dev/null
git rev-parse -q --verify "$base" >/dev/null || exit 0
git merge-base --is-ancestor "$base" HEAD 2>/dev/null && exit 0

jq -nc --arg b "$base" '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: ("This branch is behind " + $b + ". Run git merge --no-edit " + $b + " and rerun pnpm check before pushing. Never rebase.")}}'
