#!/usr/bin/env bash
set -uo pipefail

input=$(cat)
cmd=$(jq -r '.tool_input.command // ""' <<<"$input")
[[ $cmd =~ (git[[:space:]]+push|gh[[:space:]]+pr[[:space:]]+create) ]] || exit 0
cd "$(jq -r '.cwd // "."' <<<"$input")" 2>/dev/null || exit 0

base=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null) || base=origin/main
git fetch -q origin "${base#origin/}" 2>/dev/null
git rev-parse -q --verify "$base" >/dev/null || exit 0
git merge-base --is-ancestor "$base" HEAD 2>/dev/null && exit 0

jq -nc --arg b "$base" '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: ("This branch is behind " + $b + ". Run git merge --no-edit " + $b + " and rerun pnpm check before pushing. Never rebase.")}}'
