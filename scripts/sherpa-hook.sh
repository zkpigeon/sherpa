#!/bin/sh
# Prints the agent's board line, for a Claude Code or Codex hook to add to
# the agent's context. It never blocks the agent: if sherpa-server can't be
# reached, it says so and exits 0, because one outage shouldn't stop a night.
# Needs SHERPA_URL, SHERPA_AGENT_ID and SHERPA_AGENT_TOKEN, from the environment
# or from an env file beside it, as scripts/connect.sh sets up in .sherpa/.
#
# With no argument it prints plain text, which both tools add to the context
# only on SessionStart and UserPromptSubmit. Pass the hook event's name, such
# as PostToolBatch or PostToolUse, and it prints the line as that event's
# hookSpecificOutput.additionalContext, the JSON those events need.
event=$1
# Event names are letters only; anything else gets the plain line rather than broken JSON
case "$event" in *[!A-Za-z]*) event= ;; esac
here=$(dirname "$0")
if { [ -z "$SHERPA_URL" ] || [ -z "$SHERPA_AGENT_ID" ] || [ -z "$SHERPA_AGENT_TOKEN" ]; } && [ -f "$here/env" ]; then
  . "$here/env"
fi

say() {
  if [ -z "$event" ]; then
    printf '%s\n' "$1"
  else
    # A JSON string: control characters become spaces, then \ and " are escaped
    text=$(printf '%s' "$1" | tr '\000-\037' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')
    printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\n' "$event" "$text"
  fi
}

if [ -z "$SHERPA_URL" ] || [ -z "$SHERPA_AGENT_ID" ] || [ -z "$SHERPA_AGENT_TOKEN" ]; then
  say "Sherpa: set SHERPA_URL, SHERPA_AGENT_ID and SHERPA_AGENT_TOKEN to see your board line."
  exit 0
fi
# -w appends the status code on its own line, so a refusal can be told from an outage
if out=$(curl -sS --max-time 5 -w '\n%{http_code}' -H "Authorization: Bearer $SHERPA_AGENT_TOKEN" "$SHERPA_URL/agents/$SHERPA_AGENT_ID" 2>&1); then
  code=$(printf '%s\n' "$out" | tail -n 1)
  body=$(printf '%s\n' "$out" | sed '$d')
  if [ "$code" = 200 ]; then
    say "$body"
  else
    say "Sherpa: sherpa-server answered $code ($(printf '%s' "$body" | head -n 1)). Check SHERPA_URL and SHERPA_AGENT_TOKEN, and carry on with your current step meanwhile."
  fi
else
  say "Sherpa: sherpa-server didn't answer ($(printf '%s\n' "$out" | head -n 1)). Carry on with your current step, and keep your blurb current."
fi
exit 0
