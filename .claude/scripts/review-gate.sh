#!/usr/bin/env bash
set -uo pipefail

diff_id() {
  local base
  base=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null) || base=origin/main
  # -U0 keeps the id stable when merging the base branch only shifts context lines
  git diff -U0 "$(git merge-base "$base" HEAD)" HEAD | git patch-id --stable | cut -d' ' -f1
}

marker() { echo "$(git rev-parse --git-dir)/deep-review-clean"; }

if [ "${1:-}" = mark ]; then
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "not marked: commit the reviewed changes first" >&2
    exit 1
  fi
  id=$(diff_id)
  [ -n "$id" ] || { echo "not marked: branch has no diff against its base" >&2; exit 1; }
  echo "$id" > "$(marker)"
  echo "review marked clean: $id"
  exit 0
fi

input=$(cat)
cmd=$(jq -r '.tool_input.command // ""' <<<"$input")
pr_create=$'(^|[;&|({`\n])[[:space:]]*(([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|then|do|else|time|command|env|timeout[[:space:]]+[0-9.]+[smhd]?)[[:space:]]+)*gh[[:space:]]+pr[[:space:]]+create'
[[ $cmd =~ $pr_create ]] || exit 0
before_pr=${cmd%%"${BASH_REMATCH[0]}"*}
cd "$(jq -r '.cwd // "."' <<<"$input")" 2>/dev/null || exit 0

# The hook cwd is the session shell's, so honour the last `cd` the command runs before creating the PR.
target=$(grep -oE "(^|[;&|(])[[:space:]]*cd[[:space:]]+(\"[^\"]+\"|'[^']+'|[^[:space:];&|)]+)" <<<"$before_pr" \
  | tail -1 | sed -E "s/^.*cd[[:space:]]+//; s/^[\"']//; s/[\"']\$//")
if [ -n "$target" ]; then
  case "$target" in *'$'*)
    echo "Blocked: cannot resolve the cd target $target before gh pr create; cd into the worktree by literal path." >&2
    exit 2 ;;
  esac
  target="${target/#\~/$HOME}"
  cd "$target" 2>/dev/null || true
fi

id=$(diff_id)
[ -n "$id" ] && [ "$(cat "$(marker)" 2>/dev/null)" = "$id" ] && exit 0

echo "Blocked: this branch's diff has no clean review. Run the review-changes skill until it ends with 0 blockers and 0 majors; it marks the diff when clean. Then retry." >&2
exit 2
