#!/usr/bin/env bash
# UserPromptSubmit hook: names the session with the title the next-issue skill queued for it.
# Claude Code lets only a hook set the title, and only at session start or on a prompt, so the
# skill writes ~/.claude/session-titles/<session id> and the user's next message applies it once.
id=$(jq -r '.session_id // empty')
[[ "$id" =~ ^[A-Za-z0-9-]+$ ]] || exit 0
f="$HOME/.claude/session-titles/$id"
[ -s "$f" ] || exit 0
jq -n --rawfile t "$f" '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", sessionTitle: $t}}'
rm -f "$f"
