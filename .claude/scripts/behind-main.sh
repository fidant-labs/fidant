#!/usr/bin/env bash
set -uo pipefail

command -v jq >/dev/null || exit 0
source "$(dirname "${BASH_SOURCE[0]}")/command.sh"
read_input
runs "$GIT_PUSH" || runs "${GH_PR}(create|new)" || exit 0
enter_target || exit 0

# The target comes from the command text, and git fetch runs the repo's config (sshCommand,
# fsmonitor). Only go on inside the project, where that config is ours.
[ -n "${CLAUDE_PROJECT_DIR:-}" ] || exit 0
proj=$(cd "$CLAUDE_PROJECT_DIR" 2>/dev/null && pwd -P) || exit 0
here=$(pwd -P)
case "$here/" in "$proj/"*) ;; *) exit 0 ;; esac

base=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null) || base=origin/main
git fetch -q origin "${base#origin/}" 2>/dev/null
git rev-parse -q --verify "$base" >/dev/null || exit 0
git merge-base --is-ancestor "$base" HEAD 2>/dev/null && exit 0

jq -nc --arg b "$base" '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: ("This branch is behind " + $b + ". Run git merge --no-edit " + $b + " and rerun pnpm check before pushing. Never rebase.")}}'
