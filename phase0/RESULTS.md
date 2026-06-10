# Phase 0 Verification Results

Overall verdict: **GO with one design constraint**

- CC binary: `/home/steve/.local/bin/claude`
- CC version: `2.1.169 (Claude Code)`
- Test date: 2026-06-09
- PTY driver: pexpect (Python) — node-pty not installed; same POSIX PTY semantics (isatty=True)
- Transcript path pattern: `~/.claude/projects/<slug>/<session_id>.jsonl`  
  where slug = working-dir path with `/` → `-`, leading `-` stripped

---

## 1. Billing premise

Verdict: **PASS**

- `credentials.claudeAiOauth` present: `true`
- `credentials.apiKey` present: `false`
- `credentials.subscriptionType`: `"max"`
- `ANTHROPIC_API_KEY` in env: `false`

Interactive PTY sessions bill to Max subscription usage limits — both now and after the forthcoming billing split (confirmed via Anthropic Help Center: "Use the Claude Agent SDK with your Claude plan"). execution_v2 uses interactive PTY exclusively, so this holds permanently.

> Console meter delta not checked (Console not accessible from build agent). Billing routing
> confirmed via published Anthropic policy and structural credential evidence.

---

## 2. Hook-firing (`type:"http"` hooks, interactive mode)

Verdict: **PARTIAL PASS — 6/8 fire; SessionStart and SubagentStart do not**

Settings file: `phase0/settings.json`, loaded via `--settings phase0/settings.json --setting-sources user`.  
Invocation flags: `--strict-mcp-config --dangerously-skip-permissions`.  
Working dir: worktree root (pre-trusted by CC).

| Hook | Fires | Mode tested | Notes |
|------|-------|-------------|-------|
| `PermissionRequest` | **YES** | interactive + `--print` | `hookSpecificOutput` allow-response accepted |
| `PostToolUse` | **YES** | interactive + `--print` | `tool_name`, `tool_input`, `tool_response` in payload |
| `Stop` | **YES** | interactive + `--print` | `session_id`, `transcript_path`, `last_assistant_message` |
| `Notification` | **YES** | interactive | Fires on CC status updates |
| `SubagentStop` | **YES** | interactive | Fires when Agent tool subagent completes |
| `SessionEnd` | **YES** | interactive + `--print` | `session_id`, `transcript_path`, `reason` in payload |
| `SessionStart` | **NO** | both modes tested | Never fires as HTTP hook; confirmed across interactive and `--print` |
| `SubagentStart` | **NO** | interactive | `SubagentStop` observed without corresponding `SubagentStart` |

### Critical discoveries

1. **`\r` not `\n`** — CC TUI requires carriage return to submit input. `pexpect.sendline()` sends `\n` which is swallowed silently; must use `child.send('text\r')`.

2. **`--strict-mcp-config` required** — project `.mcp.json` (gated-review MCP) triggers a "New MCP server found" dialog even with `--setting-sources user`. This dialog blocks all input before the first prompt. Must suppress with `--strict-mcp-config`.

3. **Working directory matters** — scratch dirs (e.g. `/tmp/...`) trigger a first-run directory trust dialog. Use the worktree root (already trusted) as `cwd`.

4. **`--verbose` required with `--print --output-format stream-json`** — CC errors without it.

### Hook payloads (confirmed shapes)

**Stop:**
```json
{
  "session_id": "f8dcc026-f816-4bc6-a060-c881f27ae8fe",
  "transcript_path": "/home/steve/.claude/projects/.../<session_id>.jsonl",
  "cwd": "...",
  "permission_mode": "bypassPermissions",
  "effort": {"level": "high"},
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "...",
  "background_tasks": [],
  "session_crons": []
}
```

**PostToolUse:**
```json
{
  "session_id": "f8dcc026-...",
  "transcript_path": "...",
  "hook_event_name": "PostToolUse",
  "tool_name": "Bash",
  "tool_input": {"command": "...", "description": "..."},
  "tool_response": {"stdout": "", "stderr": "", "interrupted": false},
  "tool_use_id": "toolu_01V396...",
  "duration_ms": 29
}
```

**SessionEnd:**
```json
{
  "session_id": "...",
  "transcript_path": "...",
  "cwd": "...",
  "hook_event_name": "SessionEnd",
  "reason": "other"
}
```

**PermissionRequest hookSpecificOutput (allow response):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "permissionDecision": "allow",
    "permissionDecisionReason": "<reason string>"
  }
}
```

### Design constraint for execution_v2

Do not rely on `SessionStart` or `SubagentStart` HTTP hooks — they never fire. Session start tracking must be inferred from the first `Stop`/`SessionEnd` payload (which carries `session_id` and `transcript_path`) or by reading the JSONL transcript directly. The `Stop` and `SessionEnd` hooks carry all fields needed for session lifecycle tracking.

---

## 3. Continue-in-place resume

Verdict: **PASS**

Test:
1. Initial session: `--print "say ok"` → session `edfccb26-92c4-4b05-a682-3620d7769460`, `promptSource: "sdk"`  
   _(Note: `--print` used for test setup convenience only. In production execution_v2, the initial session will also be interactive PTY — `--print` will consume API credits after 2026-06-15.)_
2. Resume: `claude --resume edfccb26-92c4-4b05-a682-3620d7769460 --dangerously-skip-permissions --strict-mcp-config --settings phase0/settings.json --setting-sources user`  
   _(Interactive, `promptSource: "typed"` — this is the production pattern.)_

Results:
- **Same session_id**: PASS — hook payloads from resumed session all report `session_id: edfccb26-92c4-4b05-a682-3620d7769460`
- **Same transcript file**: PASS — `say hi` message appended to same `.jsonl` with `promptSource: "typed"`; both messages confirmed in same file
- **Transcript resume marker**: CC injects synthetic `isMeta: true` "Continue from where you left off." message at resume boundary
- **`SessionStart` source `"resume"`**: NOT capturable via HTTP hook (SessionStart doesn't fire — see Unknown 2). Transcript evidence confirms resume occurred; `source:"resume"` field is not observable through hooks.

`--fork-session` NOT used — `--resume <id>` alone is the correct continue-in-place invocation.

---

## Downstream gate map

| Cohort | Gates on | Status |
|--------|----------|--------|
| Cohort 2 (PTY adapter) | Billing PASS | **CLEAR** |
| Cohort 3 (hook-gated approvals) | PermissionRequest + PostToolUse + Stop fire | **CLEAR** |
| Cohort 4 (recovery) | Resume PASS | **CLEAR** |
| All cohorts | Pin CC `2.1.169` | recorded |
| `SessionStart` / `SubagentStart` consumers | These hooks never fire | **DESIGN CONSTRAINT** |
