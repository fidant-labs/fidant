#!/usr/bin/env bash
set -uo pipefail

# The id of the branch's diff against its base. Known limit: patch-id ignores the line numbers in
# hunk headers, so moving an added line elsewhere in the same file after the mark keeps the id.
diff_id() {
  local base
  base=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null) || base=origin/main
  # -U0 keeps the id stable when merging the base branch only shifts context lines.
  # --no-color and --no-relative override user config that would change the output.
  git diff --no-ext-diff --no-textconv --no-color --no-relative -U0 "$(git merge-base "$base" HEAD)" HEAD \
    | git patch-id --verbatim | cut -d' ' -f1
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
  git rev-parse HEAD > "$(marker)-head"
  echo "review marked clean: $id"
  exit 0
fi

# From here on the hook fails closed: Claude Code treats exit 1 and the like as non-blocking.
trap 'rc=$?; [ "$rc" -eq 0 ] || [ "$rc" -eq 2 ] || exit 2' EXIT

if ! command -v jq >/dev/null; then
  input=$(cat)
  # Broad on purpose: `pr` then later `create` or `new` as words anywhere in the raw JSON, so -R o/r
  # between them is caught. A false block is fine, a false pass is not.
  re=$'(^|[^[:alnum:]_-])pr([^[:alnum:]_].*)?[^[:alnum:]_-](create|new)([^[:alnum:]_-]|$)'
  [[ $input =~ $re ]] || exit 0
  echo "Blocked: the review gate needs jq to read the command. Install jq and retry." >&2
  exit 2
fi

source "$(dirname "${BASH_SOURCE[0]}")/command.sh" || { echo "Blocked: cannot load command.sh." >&2; exit 2; }
read_input
runs "${GH_PR}(create|new)" || exit 0

# The hook cwd is the session shell's, so honour the last `cd` the command runs before creating the PR.
if ! enter_target; then
  echo "Blocked: cannot resolve the cd target $unresolved before gh pr create; cd into the worktree by literal path." >&2
  exit 2
fi

# Look for --head/-H in everything after the match, not the cut `args`: quotes, heredocs and
# line continuations hide it from that. Every occurrence must name the checked-out branch.
branch=$(git branch --show-current)
while IFS= read -r head; do
  if [ -z "$head" ] || [ "$head" != "$branch" ]; then
    echo "Blocked: --head '$head' is not the checked-out branch ($branch), or is a cross-repo head, so the gate cannot check its diff. cd into the worktree of the branch and retry without an owner prefix." >&2
    exit 2
  fi
done < <(head_values "${cmd#*"$match"}")

id=$(diff_id)
[ -n "$id" ] && [ "$(cat "$(marker)" 2>/dev/null)" = "$id" ] && exit 0

echo "Blocked: this branch's diff has no clean review. Run the review-changes skill until it ends with 0 blockers and 0 majors; it marks the diff when clean. Then retry." >&2
exit 2
