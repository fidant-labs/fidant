#!/usr/bin/env bash
set -uo pipefail

# A guardrail against mistakes, not a security control: the box refuses commits not on main.
input=$(cat)
cmd=$(jq -r '.tool_input.command // ""' <<<"$input")
cwd=$(jq -r '.cwd // ""' <<<"$input")
# awk and tr, because bash 3.2's ${x//pattern/y} takes minutes on a long command, and a hook that times out doesn't block.
cmd=$(printf '%s\n' "$cmd" | awk '{ if (sub(/\\$/, " ")) printf "%s", $0; else print }')
cmd=$(printf '%s' "$cmd" | tr -d "\"'")
cmd=$(printf '%s' "$cmd" | tr ';&|()<>`' '\n\n\n\n\n\n\n\n')
opt='[[:space:]]+((-[Cc]|--(git-dir|work-tree|namespace|config-env|attr-source|shallow-file))[[:space:]]+[^[:space:]]+|-[^[:space:]]+)'
push="(^|[[:space:]/])git((${opt})*)[[:space:]]+push([[:space:]]|\$)"
refspec='[[:space:]][+]?([^[:space:]:]*:)?((refs/)?heads/)?production([[:space:]]|$)'
mirror='[[:space:]]--mirror([[:space:]]|$)'
chdir='^[[:space:]]*cd[[:space:]]+([^[:space:]]+)'
api='(^|[[:space:]/])gh[[:space:]]+api([[:space:]]|$)'
ref='(refs/heads/|=)production([^[:alnum:]._/-]|$)|branches/production/'
write='(^|[[:space:]])(-[[:alpha:]]*[fFX]|--field|--raw-field|--input|--method)'
get='(^|[[:space:]/])gh[[:space:]]+api[[:space:]]+(-X|--method)([[:space:]]+|=)?GET([[:space:]]|$)'
notget='(^|[[:space:]])(-[[:alpha:]]*X|--method)([[:space:]]+|=)?([^G=[:space:]]|G[^E]|GE[^T]|GET[^[:space:]])'
base='(^|[[:space:]/])gh[[:space:]]+pr[[:space:]]+(create|edit)[[:space:]](.*[[:space:]])?(-[[:alpha:]]*B|--base)(=|[[:space:]]+)?(refs/heads/)?production([[:space:]]|$)'
block() {
  echo "Blocked: agents never update the production branch, and a local production branch blocks every push; a maintainer promotes releases (AGENTS.md, Releasing). If the command only mentions it in text, pass that text in a file." >&2
  exit 2
}
gitcmd='(^|[[:space:]/])git[[:space:]]'
named=
pushes=
IFS=$'\n' read -rd '' -a parts <<<"$cmd"
# Every regex check covers all parts before the hook runs git, so a git that hangs can't hide a later part.
for part in ${parts[@]+"${parts[@]}"}; do
  [[ $part =~ $gitcmd && $part =~ $refspec ]] && named=1
  [[ $part =~ $push ]] && pushes=1 && [[ $part =~ $mirror ]] && block
  [[ $part =~ $api && $part =~ $ref && $part =~ $write ]] && [[ ! $part =~ $get || $part =~ $notget ]] && block
  [[ $part =~ $base ]] && block
done
[[ -n $named && -n $pushes ]] && block
for part in ${parts[@]+"${parts[@]}"}; do
  [[ -n $cwd && $part =~ $chdir ]] && d=$(cd "$cwd" 2>/dev/null && cd "${BASH_REMATCH[1]}" 2>/dev/null && pwd) && cwd=$d
  if [[ -n $cwd && $part =~ $push ]]; then
    read -ra opts <<<"${BASH_REMATCH[2]}"
    git -C "$cwd" ${opts[@]+"${opts[@]}"} show-ref --verify --quiet refs/heads/production </dev/null &>/dev/null && block
  fi
done
exit 0
