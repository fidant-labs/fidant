# Sourced by the Bash hooks. Matches a command where the shell would run it, not inside an argument or a string.

# Prefixes that still leave the next word in command position.
_prefix=$'(^|[;&|({`\n])[[:space:]]*(([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|then|do|else|if|while|until|!|time|command|env|exec|nohup|timeout[[:space:]]+[0-9.]+[smhd]?)[[:space:]]+)*'
_ropt=$'([[:space:]]+(-R|--repo)([[:space:]]+|=)[^[:space:]]+)*'
GH_PR="gh${_ropt}"$'[[:space:]]+pr'"${_ropt}"$'[[:space:]]+'
GIT_PUSH=$'git([[:space:]]+-[Cc][[:space:]]+[^[:space:]]+)*[[:space:]]+push'

# read_input: sets $cmd from the hook's JSON on stdin and moves into the session's folder.
read_input() {
  input=$(cat)
  cmd=$(jq -r '.tool_input.command // ""' <<<"$input")
  cd "$(jq -r '.cwd // "."' <<<"$input")" 2>/dev/null
}

# runs <regex>: true when $cmd runs <regex> as a command. Sets $match, $before (text before it)
# and $args (the rest of that one command).
runs() {
  local re="$_prefix$1"
  [[ $cmd =~ $re ]] || return 1
  match=${BASH_REMATCH[0]}
  before=${cmd%%"$match"*}
  args=${cmd#*"$match"}
  args=${args%%[;&|$'\n']*}
}

# enter_target: moves into the folder the command runs in: the last literal `cd` in $before,
# then `git -C <dir>` in $match. Returns 1 when a target holds a variable it cannot resolve.
enter_target() {
  local t
  t=$(grep -oE "(^|[;&|(])[[:space:]]*cd[[:space:]]+(\"[^\"]+\"|'[^']+'|[^[:space:];&|)]+)" <<<"$before" \
    | tail -1 | sed -E "s/^.*cd[[:space:]]+//")
  _enter "$t" || return 1
  [[ $match =~ -C[[:space:]]+([^[:space:]]+) ]] && { _enter "${BASH_REMATCH[1]}" || return 1; }
  return 0
}

_enter() {
  local t=${1#[\"\']}
  t=${t%[\"\']}
  [ -n "$t" ] || return 0
  case "$t" in *'$'*) unresolved=$t; return 1 ;; esac
  cd "${t/#\~/$HOME}" 2>/dev/null || true
}

# head_values <text>: the value of every --head/-H option in <text> (also --head=x, -Hx and grouped
# short flags like -dH x), one per line. Quotes and backslashes are stripped from the text first, so
# "--head" x and --he\ad x match as gh sees them. An option with no value prints an empty line.
# Prints nothing without one.
head_values() {
  local rest=${1//[\"\'\\]/} re=$'(^|[[:space:]])(--head(=|[[:space:]]+|$)|-[A-Za-z]*H(=|[[:space:]]*))([^[:space:]]*)'
  while [[ $rest =~ $re ]]; do
    printf '%s\n' "${BASH_REMATCH[5]}"
    rest=${rest#*"${BASH_REMATCH[0]}"}
  done
}
