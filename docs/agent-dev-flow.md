# agent-dev-flow: operator guide

The end-to-end loop now lives entirely inside kbbl. A `kbbl-start` server hosts
the task tracker, the review primitive, the orchestrator state machine, and the
PWA review surfaces. Dispatched stages (planner-1, planner-2, build) run as
kbbl agent sessions spawned via the existing `SessionManager` + Claude Code
adapter; their prompts are templated from `kbbl/prompts/{planner1,planner2,build}.md`.

The previous safir-based `safir-build` / `safir-decompose` CLI flow is
superseded by this; nothing here calls safir.

## Prerequisites

- kbbl running (e.g. `./kbbl/scripts/kbbl-start /path/to/your/repo --host=0.0.0.0`).
  Confirm with `curl -sI http://<host>:8788/ | head -1`.
- `ANTHROPIC_API_KEY` exported in the kbbl process environment — spawned CC
  subprocesses inherit it.
- Optional: `KBBL_PROMPTS_DIR` to override the prompt-template directory
  (defaults to `<kbbl-root>/prompts`).
- The repo you're dispatching against is on a branch you're willing to let the
  build agent commit and push from.

## The flow

```
POST /projects        (one-time per repo)
POST /specs           → spec.created → planner1 session spawns
                      → planner-1 POSTs /plans, /cohorts, /cohort-dependencies
review plan in PWA at #plan/<id>
PATCH /plans/:id/status {status:"approved"}
                      → plan freezes; leaf cohorts → planned
                      → cohort.entered_planned → planner2 session per leaf
                      → planner-2 POSTs /briefs
review brief in PWA at #brief/<id>
PATCH /briefs/:id/status {status:"approved"}
                      → brief freezes; cohort → building
click "Run build" in PWA  (POST /briefs/:id/build)
                      → build session spawns
                      → build agent opens PR + PATCHes /briefs/:id/debrief
merge PR on GitHub
PATCH /cohorts/:id/status {status:"done"}
                      → dependent cohorts → planned, next planner-2 fires
```

## 1. Bootstrap a project + spec

Open the PWA inbox and use the **Projects** sidebar on the left:

- **+ Project** in the sidebar header — opens a modal for the project
  name and an absolute `repo_path`. Creates the project; no dispatch
  fires yet.
- Expand the project, then click **+** next to **Plans / Epics** — opens
  a modal for the spec title and notes (the spec prose). Submitting this
  is what fires `spec.created` and spawns planner-1.

For scripting or remote setup the same endpoints work directly:

```bash
KBBL=http://<host>:8788

curl -sX POST "$KBBL/projects" -H 'content-type: application/json' \
  -d '{"name":"my-project","repo_path":"/abs/path/to/repo"}'
# → { "id":"<project_id>", ... }

curl -sX POST "$KBBL/specs" -H 'content-type: application/json' \
  -d '{"project_id":"<project_id>","title":"…","notes":"<full spec prose>"}'
# → { "id":"<spec_id>", "status":"draft", ... }

# Or load the prose from a file (mutually exclusive with `notes`). The path
# is resolved on the *server* (where kbbl runs) and must sit inside the
# project's `repo_path` — kbbl rejects anything outside it:
curl -sX POST "$KBBL/specs" -H 'content-type: application/json' \
  -d '{"project_id":"<project_id>","title":"…","notesPath":"<repo_path>/spec.md"}'
```

Either path emits `spec.created`; the dispatch hook spawns a planner-1
kbbl session against the project's `repo_path`. Watch the session in the
kbbl PWA inbox. Planner-1 reads the spec, drafts cohorts + dependencies
via the HTTP API, and exits.

## 2. Review the plan

Open `#plan/<plan_id>` in the PWA. The DAG editor renders cohorts + edges.

- **Comment** — hover any cohort title/notes or edge, click the comment
  affordance, open a thread. Other operators (or the responder) see it via SSE.
- **Direct edit** — `ModeToggle → edit`. Click an atom, inline-edit, submit.
  Editing on a frozen artifact is blocked.
- **Ping the plan-review-responder** — on any thread, click ping. A
  subprocess spawns, posts a reply, exits.
- **Approve** — gated on `status=pending_approval`. Posts
  `PATCH /plans/:id/status {status:"approved"}`. This freezes the plan,
  promotes leaf cohorts from `waiting` to `planned`, and triggers planner-2
  dispatches.
- **Reject** — `PATCH /plans/:id/status {status:"rejected", reason:"…"}`.
  Reopen later with `POST /plans/:id/reopen` to create a new
  `pending_approval` plan linked via `predecessor_plan_id`.

## 3. Review each brief

Each cohort that hits `planned` auto-transitions to `briefing` and spawns a
planner-2 session. When it POSTs `/briefs`, the cohort moves to `brief_review`
and the brief shows up in the PWA inbox.

Open `#brief/<brief_id>`. `StructuredDocEditor` renders the five sections
(`goal`, `files_in_scope`, `decisions_made`, `approaches_rejected`,
`next_action`) as per-atom hover targets.

- Same comment / edit / ping / approve / reject mechanics as plans.
- Approve → cohort moves to `building`; the **Run build** button enables.
- Reject + reopen creates a new pending brief via `predecessor_brief_id`.

## 4. Run the build

Click **Run build** in the brief view (or `POST /briefs/:id/build`). The
dispatcher spawns a build session, stamps `current_session_ref` onto the
cohort, and the build agent reads its rendered prompt. The agent commits,
opens a PR via `gh pr create`, and on completion writes back:

```bash
curl -sX PATCH "$KBBL/briefs/<brief_id>/debrief" \
  -H 'content-type: application/json' \
  -d '{"debrief":"<markdown report>","pr_url":"https://github.com/…/pull/N"}'
```

The PWA renders the debrief inline below the structured doc.

## 5. Merge + mark done

GitHub PR review and merge happen normally. After merging:

```bash
curl -sX PATCH "$KBBL/cohorts/<cohort_id>/status" \
  -H 'content-type: application/json' \
  -d '{"status":"done"}'
```

The orchestrator re-evaluates downstream cohorts; any whose predecessors are
all `done` transition `waiting → planned` and fire their planner-2 dispatches.

Webhook-driven `done` is not wired in v1 — `done` is operator-marked.

## Blocking and unblocking

If you need to pause a cohort:

```bash
curl -sX PATCH "$KBBL/cohorts/<id>/status" -d '{"status":"blocked"}'
curl -sX PATCH "$KBBL/cohorts/<id>/status" -d '{"status":"unblocked"}'
```

`blocked` stashes the prior status in `pre_block_status`; `unblocked` restores
it. The active agent session (if any) is unaffected — stop it manually via
`DELETE /sessions/:sid` if needed.

## Route quick reference

| Surface | Routes |
|---|---|
| Bootstrap | `POST /projects`, `POST /specs` |
| Plan | `POST /plans`, `POST /cohorts`, `POST /cohort-dependencies`, `PATCH /plans/:id/status`, `POST /plans/:id/reopen` |
| Brief | `POST /briefs`, `PATCH /briefs/:id/status`, `POST /briefs/:id/reopen`, `PATCH /briefs/:id/debrief`, `POST /briefs/:id/build` |
| Cohort | `PATCH /cohorts/:id/status` |
| Review | `POST /atoms/edits`, `POST /threads`, `POST /threads/:id/messages`, `POST /threads/:id/ping`, `PATCH /threads/:id`, `GET /review/frozen` |
| Inbox | `GET /plans?status=pending_approval`, `GET /briefs?status=pending_approval` |

For full request/response shapes see `kbbl/core/server/handlers/`.
