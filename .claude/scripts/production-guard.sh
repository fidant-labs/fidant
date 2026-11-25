#!/usr/bin/env bash
set -uo pipefail

# A guardrail against mistakes, not a security control: the box refuses commits not on main.
input=$(cat)
cmd=$(jq -r '.tool_input.command // ""' <<<"$input")
cwd=$(jq -r '.cwd // ""' <<<"$input")
cmd=${cmd//$'\\\n'/ }
cmd=${cmd//[\"\']/}
cmd=${cmd//[;&|()<>\`]/$'\n'}
push='(^|[[:space:]/])git([[:space:]]+(-[Cc][[:space:]]+[^[:space:]]+|-[^[:space:]]+))*[[:space:]]+push([[:space:]]|$)'
refspec='[[:space:]][+]?([^[:space:]:]*:)?((refs/)?heads/)?production([[:space:]]|$)'
mirror='[[:space:]]--mirror([[:space:]]|$)'
chdir='^[[:space:]]*cd[[:space:]]+([^[:space:]]+)'
dashc='[[:space:]]-C[[:space:]]+([^[:space:]]+)'
api='(^|[[:space:]/])gh[[:space:]]+api([[:space:]]|$)'
ref='refs/heads/production([^[:alnum:]._/-]|$)'
write='(^|[[:space:]])(-[fFX]|--field|--raw-field|--input|--method)'
get='(^|[[:space:]])(-X|--method)([[:space:]]+|=)?GET([[:space:]]|$)'
block() {
  echo "Blocked: agents never update the production branch, and a local production branch blocks every push; a maintainer promotes releases (AGENTS.md, Releasing). If the command only mentions it in text, pass that text in a file." >&2
  exit 2
}
gitcmd='(^|[[:space:]/])git[[:space:]]'
named=
while IFS= read -r part; do
  [[ -n $cwd && $part =~ $chdir ]] && d=$(cd "$cwd" 2>/dev/null && cd "${BASH_REMATCH[1]}" 2>/dev/null && pwd) && cwd=$d
  [[ $part =~ $gitcmd && $part =~ $refspec ]] && named=1
  if [[ $part =~ $push ]]; then
    [[ -n $named || $part =~ $mirror ]] && block
    dir=.
    [[ $part =~ $dashc ]] && dir=${BASH_REMATCH[1]}
    [[ -n $cwd ]] && git -C "$cwd" -C "$dir" show-ref --verify --quiet refs/heads/production 2>/dev/null && block
  fi
  [[ $part =~ $api && $part =~ $ref && $part =~ $write && ! $part =~ $get ]] && block
done <<<"$cmd"
exit 0
