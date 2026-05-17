# Stages-as-data + KbblChatBackend + dispatch wiring — build brief

## Goal
Move stages from implicit to declared. `stages` table seeded with `planner1`, `planner2`, `build` rows. `ExecutionBackend` interface plus a `KbblChatBackend` implementation that calls `SessionManager.create()` with a rendered prompt and surfaces the session as the dispatch's `session_ref`. Dispatcher routes `(stage_name, input_artifact_id)` to the configured backend, persists `current_session_ref` on the input artifact, and writes the output artifact when the session ends. Dispatch hooks subscribe to `taskTrackerEvents` so `spec.created → planner1`, `cohort.entered_planned → planner2`, `brief.approved → build` happen automatically. Responders for plan-review and brief-review pings spawn as subprocesses. Builder writes `debrief` back via `PATCH /briefs/:id/debrief` at end-of-run. After this cohort the system runs itself end-to-end.

## Active subgoals
1. **Migration `007_stages_and_refs.sql`.** One commit.
   - `stages(name TEXT PRIMARY KEY, prompt_template_path TEXT NOT NULL, input_artifact_type TEXT NOT NULL CHECK (input_artifact_type IN ('spec','cohort','brief')), output_artifact_type TEXT NOT NULL CHECK (output_artifact_type IN ('plan','brief','pr')), gate TEXT NOT NULL CHECK (gate IN ('review_required','none')), default_backend TEXT NOT NULL)`.
   - Add columns: `ALTER TABLE specs ADD COLUMN current_session_ref TEXT;`, `ALTER TABLE cohorts ADD COLUMN current_session_ref TEXT;`. (Briefs have no `current_session_ref` — build dispatches against cohort; the brief is the input.)
   - (No seed in this migration — seed lands in 008 to keep schema and data separable.)
2. **Migration `008_seed_stages.sql`.** One commit.
   - `INSERT INTO stages (name, prompt_template_path, input_artifact_type, output_artifact_type, gate, default_backend) VALUES ('planner1', 'planner1.md', 'spec', 'plan', 'review_required', 'kbbl_chat'), ('planner2', 'planner2.md', 'cohort', 'brief', 'review_required', 'kbbl_chat'), ('build', 'build.md', 'brief', 'pr', 'none', 'kbbl_chat')`.
3. **Prompt template files.** One commit. Create:
   - `kbbl/prompts/planner1.md` — drafted from `comms/task-review/agent-dev-flow-narrative.md` §1 and the task-tracker/review specs. Includes slots: `{{SPEC_TITLE}}`, `{{SPEC_NOTES}}`, `{{REPO_PATH}}`, `{{SPEC_ID}}`, `{{KBBL_URL}}`. Instructions: "Read the codebase; surface discrepancies; emit cohorts via `POST {{KBBL_URL}}/cohorts` and dependencies via `POST {{KBBL_URL}}/cohort-dependencies`; on completion, the operator approves via the PWA."
   - `kbbl/prompts/planner2.md` — slots: `{{COHORT_ID}}`, `{{COHORT_TITLE}}`, `{{COHORT_NOTES}}`, `{{PLAN_CONTEXT}}` (a snippet listing sibling cohorts and the edges), `{{KBBL_URL}}`, `{{BRIEF_FORMAT_GUIDE}}` (a one-paragraph reminder that the brief must close every decision). Instructions to POST the brief via `POST {{KBBL_URL}}/briefs`.
   - `kbbl/prompts/build.md` — slots: `{{BRIEF_ID}}`, `{{BRIEF_RENDERED}}` (full brief text), `{{REPO_PATH}}`, `{{KBBL_URL}}`. Instructions: execute the brief commit-by-commit, open a PR, then `PATCH {{KBBL_URL}}/briefs/{{BRIEF_ID}}/debrief` with `{"debrief": "<markdown report>"}`.
4. **Prompt loader + renderer.** One commit. `kbbl/core/orchestrator/backends/prompt-loader.ts` exports `loadPrompt(name: string): string` that reads from `process.env.KBBL_PROMPTS_DIR ?? join(kbblRoot, 'prompts')` + the relative `prompt_template_path` from the `stages` row. `renderPrompt(template: string, slots: Record<string, string>): string` does literal `{{KEY}}` substitution; throws if the template contains an unfilled `{{…}}` token after substitution. Tests cover both functions.
5. **`ExecutionBackend` interface + types.** One commit. `kbbl/core/orchestrator/backends/interface.ts` exports:
   ```ts
   interface ExecutionBackend {
     id: string;
     dispatch(stage: StageRow, inputRef: { type: 'spec'|'cohort'|'brief', id: string }, renderedPrompt: string): Promise<{ session_ref: string }>;
     status(session_ref: string): Promise<'running' | 'completed' | 'failed'>;
   }
   ```
   `collect()` is omitted — agents POST their own output artifacts (plans, briefs, debriefs) directly to kbbl HTTP routes per the prompt instructions. The backend only owns lifecycle; the artifact write-back path is HTTP, not backend-side collection.
6. **`KbblChatBackend` implementation.** One commit. `kbbl/core/orchestrator/backends/kbbl-chat.ts` exports `createKbblChatBackend({ manager }): ExecutionBackend`.
   - `dispatch`: `manager.create({ workdir, … })` (workdir from the spec's project's repo_path; cohort and brief dispatches use the cohort's plan's spec's project repo_path); writes the rendered prompt as the first input via `session.writeInput(renderedPrompt)`; returns `{session_ref: session.oakridgeSid}`.
   - `status`: looks up the session in `manager.get(sid)`; maps `live` → 'running', `ended` → ('completed' if no failure metadata else 'failed'). Returns 'failed' if unknown.
   - No `model` selection logic in v1 — pass through `null` for now; the operator's CC default applies. (Future: stage row can carry a `model` column.)
7. **Dispatcher.** One commit. `kbbl/core/orchestrator/backends/dispatcher.ts` exports `createDispatcher({ db, backends }): { dispatch(stageName, inputId): Promise<string> }`.
   - Loads the `stages` row by name; loads the input artifact row; renders the prompt with the right slots; calls `backends[stage.default_backend].dispatch(...)`; writes `current_session_ref` onto the input artifact (specs for planner1, cohorts for planner2 and build).
   - For `build` stage, input is `brief` but `current_session_ref` is stored on the brief's parent `cohort` (briefs have no `current_session_ref` column). The dispatcher reads `briefs.cohort_id` and updates the cohort row.
   - Returns the `session_ref`.
8. **Dispatch hooks.** One commit. `kbbl/core/orchestrator/dispatch-hooks.ts` exports `wireDispatchHooks({ taskTrackerEvents, dispatcher }): void`. Subscribes:
   - `spec.created` → `dispatcher.dispatch('planner1', spec_id)`.
   - `cohort.entered_planned` → in same handler, transition cohort `planned → briefing` (extends cohort 3's flow — emit `taskTrackerEvents.emit('cohort.briefing_started', {cohort_id})` after dispatcher returns so cohort 3 transitions), then `dispatcher.dispatch('planner2', cohort_id)`. The state-transition responsibility stays with cohort 3; this hook just emits the event.
   - `brief.approved` → `dispatcher.dispatch('build', brief_id)`.
   Each handler awaits `dispatcher.dispatch` but isolates errors (`try/catch + console.error`) — a dispatch failure must not poison the bus. Called from `core/server.ts` after `bootstrapOrchestrator`.
9. **Cohort 3 add-on: `cohort.briefing_started` event.** Same commit as subgoal 8. Extend `TaskTrackerEventMap` to include `"cohort.briefing_started": {cohort_id}`. Cohort 3's `bootstrap` subscribes to it and transitions cohort `planned → briefing`. (Alternative: the dispatcher transitions directly. Rejected — state-machine ownership stays in cohort 3.)
10. **Responder subprocesses.** One commit. Files in `kbbl/core/orchestrator/responders/`:
    - `run.ts` — single CLI entry point invoked as `bun run kbbl/core/orchestrator/responders/run.ts --responder=<id> --thread-id=<id> --target-type=<t> --target-id=<i> --kbbl-url=<url>`. Reads the thread + messages via HTTP; reads anchored atom state; constructs a reply based on the responder kind; posts via `POST /threads/:id/messages`; exits. For v1, both responders use the same generic body: "(automated responder) I see comments on `<anchor>`; current live value is: `<live_value>`." This is intentionally minimal — the responder's value is to be a stand-in until cohort 6 dogfooding decides what real responders should do.
    - `spawn.ts` — exports `wireResponderSpawn({ reviewEvents })` that subscribes to `thread.ping_received` and `Bun.spawn`s `run.ts` with the right args. Subscribes only when called from `core/server.ts`.
    - Update cohort 3's `bootstrap.ts` to register `plan` with `responder_id: 'plan-review-responder'` and `build_brief` with `responder_id: 'brief-review-responder'`. (Backfill — cohort 3 left these empty.)
11. **`POST /briefs/:id/build` route + PWA wire-up.** One commit. `kbbl/core/server/handlers/builds.ts` exports `mountBuildsRoutes(app, {dispatcher, db})`:
    - `POST /briefs/:id/build`: 404 if brief missing; 409 if `brief.status !== 'approved'`; 409 if the cohort already has a non-null `current_session_ref` whose session is still `live`; else `dispatcher.dispatch('build', brief_id)` and return `{session_ref}`.
    Mount in `createApp`. In `kbbl/core/pwa/review/brief/BriefReviewView.tsx`, replace the cohort-4 `<RunBuildButton disabled />` stub with the wired version: `onClick` POSTs the route and renders status from the returned session_ref.
12. **End-to-end integration test (mock backend).** One commit. `kbbl/core/orchestrator/dispatch.test.ts`:
    - Builds an in-memory DB + app, registers a `MockBackend` that resolves `dispatch` to a fixed session_ref and lets the test simulate "planner-1 emitted these cohorts" by directly POSTing.
    - Drives: `POST /specs` → assert MockBackend.dispatch was called with `('planner1', spec_id)` → test posts plan + cohorts via HTTP → `PATCH /plans/:id/status='approved'` → assert MockBackend.dispatch called with `('planner2', leaf_cohort_id)` → test posts brief → `PATCH /briefs/:id/status='approved'` → assert MockBackend.dispatch called with `('build', brief_id)` → test POSTs `PATCH /briefs/:id/debrief` and asserts the row updated.

## Decisions made
- **`stages.prompt_template_path` is relative to `KBBL_PROMPTS_DIR`.** **Rationale:** Lets tests substitute a fixture dir without env-var ceremony; production resolves to the in-repo `kbbl/prompts/` directory.
- **Slot substitution is literal `{{KEY}}`, errors on unfilled tokens.** **Rationale:** Templating with Mustache/Handlebars adds a dep; literal substitution is enough since slot keys are stable and finite. Erroring on unfilled tokens catches typos at dispatch time.
- **`ExecutionBackend` has no `collect` method.** **Rationale:** Agents post their own artifacts directly via HTTP (planner-1 → `POST /cohorts`; planner-2 → `POST /briefs`; builder → `PATCH /briefs/:id/debrief`). A backend-side `collect` would duplicate the HTTP path and require parsing agent stdout for structured output — fragile.
- **`KbblChatBackend.dispatch` posts the rendered prompt via `session.writeInput`.** **Rationale:** Matches how operators kick off a kbbl session today; uses the existing well-tested input path. The agent reads its prompt the same way it'd read any operator message.
- **`current_session_ref` on cohort for build, not on brief.** **Rationale:** Builders work on cohorts (one PR per cohort); the brief is just the contract. Storing the ref on the cohort lets `/briefs/:id/build` block on "this cohort is already building."
- **Dispatch hooks isolate errors per-event with `console.error`.** **Rationale:** A failed planner-1 dispatch must not block other specs; structured-log the failure and continue. Operator-visible via existing kbbl error log.
- **`cohort.entered_planned → planner2 dispatch` flows through `cohort.briefing_started` event.** **Rationale:** Avoids having the dispatcher reach into the cohorts table to set status; cohort 3 owns the state machine and this keeps the seam clean.
- **Responder body is a placeholder.** **Rationale:** "Generic acknowledgement" is enough to prove the path. Real responder logic is a cohort-6 finding, not v1 engineering.
- **Responders are spawned subprocesses, not in-process functions.** **Rationale:** Spec: "Ping spawns the registered responder agent for the artifact type. The responder is a subprocess." Out-of-process means a long-running responder can't stall kbbl's event loop.
- **No `model` column on stages in v1.** **Rationale:** Spec lists fields without `model`. Future migration adds it when stage-specific model assignment matters; for now the operator's CC default is fine.
- **Mock backend lives only in tests.** **Rationale:** Production registers only `KbblChatBackend`; the mock-vs-real boundary stays test-local.

## Approaches rejected
- **Runtime seeding stages in `bootstrap` rather than a migration:** runtime seeding hides the schema-data coupling and would re-insert rows on every restart unless guarded; a migration is one-shot and idempotent for free.
- **Storing rendered prompts on the artifact row:** the rendered prompt is reproducible from the template + slots; storing it doubles storage and adds a stale-prompt risk on template edits.
- **Backend-side polling for completion:** the existing `SessionManager` already exposes status; querying it on demand in `status()` is cheaper than a polling loop.
- **Building the responder as a separate npm package:** the responder is ~50 lines of HTTP + string-template logic; pulling it into a package is overengineered.
- **Integrating the builder's PR creation into kbbl:** the builder agent creates the PR itself via `gh pr create`; kbbl shouldn't be in the GitHub-API path.

## Open questions (punted decisions)
1. **Where do we record stage failures?**
   **(a)** Add a `stage_runs` table or just rely on the kbbl session log + a `last_failure_at` column on the artifact?
   **(b)** Skip both for v1. A failed dispatch is observable via the kbbl session ending in a non-completed state; the operator inspects the session manually. Add `stage_runs` once retries are needed.
   **(c)** Deferred because dogfood (cohort 6) is where retry needs surface; speculative schema is YAGNI.
2. **Builder writing PR URL back to kbbl:**
   **(a)** Should the builder POST the PR URL somewhere so the PWA shows "PR opened: link"?
   **(b)** Yes — extend `PATCH /briefs/:id/debrief` to optionally accept `{ debrief, pr_url? }`. Add `briefs.pr_url TEXT` in this cohort's migration so the column exists end-to-end.
   **(c)** Deferred because the column adds rows to migration 007 — if the build agent for cohort 4 already shipped without it, this lands in 007 here; if it noticeably grows scope, defer to a cohort 5.1 follow-up.
3. **Concurrency limit per backend:**
   **(a)** `KbblChatBackend` spawns one CC subprocess per session; ten concurrent planner-2 dispatches across ten cohorts = ten subprocesses. Cap?
   **(b)** No cap in v1; the operator's machine handles it or doesn't. Cap as a config field when it bites in dogfood.
   **(c)** Deferred because parallel cohort count is small (the test plan has ~5 in parallel max) and adding a queue without measured contention is overengineering.

## Next action
Write migration `007_stages_and_refs.sql` per subgoal 1 and migration `008_seed_stages.sql` per subgoal 2, then assert via `openTestDb()` that the three stage rows land with the expected `prompt_template_path` values.

## Deviations from plan

- **Brief said:** `ExecutionBackend.dispatch(stage, inputRef: { type, id }, renderedPrompt)` — inputRef has `type` and `id` only.
  **Shipped:** `inputRef` also carries `workdir: string`.
  **Why:** `KbblChatBackend.dispatch` calls `manager.create({ workdir })` but the interface gives it no DB access; workdir must be resolved by the dispatcher (which has the DB) and passed through. Adding it to `inputRef` keeps the seam clean without coupling the backend to the DB.

- **Brief said:** `wireDispatchHooks(...): void`.
  **Shipped:** returns `() => void` cleanup function.
  **Why:** Tests need to unsubscribe dispatch hooks between runs; returning a cleanup follows the same pattern as `bootstrap` and prevents cross-test event leakage.

- **Brief said:** `mountBuildsRoutes(app, {dispatcher, db})`.
  **Shipped:** `mountBuildsRoutes(app, {dispatcher, db, manager})`.
  **Why:** The 409 "session still live" check requires `manager.get(session_ref)` to inspect session status. Without `manager`, the check would degrade to "any non-null `current_session_ref` = 409", which would block re-triggering after a failed build.

- **Brief said:** open question 2b — `pr_url` on briefs deferred if it grows scope.
  **Shipped:** included `pr_url TEXT` in migration 007 and extended `PATCH /briefs/:id/debrief` to accept it.
  **Why:** The brief explicitly said "if the build agent for cohort 4 already shipped without it, this lands in 007 here" — cohort 4 is not yet merged to main, so this is the right time.
