#!/usr/bin/env bash
# oakridge PreToolUse approval gate.
# Invoked by Claude Code as a PreToolUse hook. Reads the hook input JSON
# on stdin, forwards it to the oakridge server, blocks on the operator's
# decision, echoes the server's ready-to-emit hookSpecificOutput reply.
set -euo pipefail

PORT="${OAKRIDGE_PORT:-8788}"
SID="${OAKRIDGE_STAGE_INSTANCE:?OAKRIDGE_STAGE_INSTANCE must be set}"
INPUT="$(cat)"

# -sSf: silent but show curl's own errors on stderr; -f fails on HTTP 4xx/5xx
# so we can emit a structured deny below instead of piping a non-JSON error
# body into CC (which would blow up hook-output parsing).
# --max-time 3600: approval latency = time until the operator taps, which can
# be many minutes if the phone is asleep.
if RESPONSE=$(curl -sSf -X POST \
  -H "content-type: application/json" \
  --data-raw "$INPUT" \
  --max-time 3600 \
  "http://127.0.0.1:${PORT}/executors/session_agent/${SID}/hook/approval"); then
  printf '%s' "$RESPONSE"
else
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"oakridge gate could not reach server"}}'
fi
