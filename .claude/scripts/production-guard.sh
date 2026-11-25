#!/usr/bin/env bash
set -uo pipefail

# A guardrail against mistakes, not a security control: the box refuses commits not on main.
cmd=$(jq -r '.tool_input.command // ""')
cmd=${cmd//$'\\\n'/ }
cmd=${cmd//[\"\']/}
cmd=${cmd//[;&|()<>\`]/$'\n'}
push='(^|[[:space:]/])git([[:space:]]+(-[Cc][[:space:]]+[^[:space:]]+|-[^[:space:]]+))*[[:space:]]+push([[:space:]]|$)'
refspec='[[:space:]][+]?([^[:space:]:]*:)?(refs/heads/)?production([[:space:]]|$)'
api='(^|[[:space:]/])gh[[:space:]]+api([[:space:]]|$)'
ref='refs/heads/production([^[:alnum:]._/-]|$)'
write='(^|[[:space:]])(-[fFX]|--field|--raw-field|--input|--method)'
get='(^|[[:space:]])(-X|--method)([[:space:]]+|=)?GET([[:space:]]|$)'
while IFS= read -r part; do
  if [[ $part =~ $push && $part =~ $refspec ]] ||
    [[ $part =~ $api && $part =~ $ref && $part =~ $write && ! $part =~ $get ]]; then
    echo "Blocked: agents never update the production branch; a maintainer promotes releases (AGENTS.md, Releasing). If the command only mentions it in text, pass that text in a file." >&2
    exit 2
  fi
done <<<"$cmd"
exit 0
